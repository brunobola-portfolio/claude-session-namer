'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const gemini = require('../adapters/gemini/hook');
const hook = require('../adapters/_shared/tab-title-hook');
const osc = require('../adapters/_shared/osc-title');
const state = require('../lib/state');

const tmpSpec = () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sn-gemini-'));
  return { ...gemini.spec({ GEMINI_CLI_HOME: home }), homeDir: path.join(home, '.gemini') };
};
const project = () => ({ cfg: { enabled: true }, project: 'arcva' });
const input = (event, extra = {}) => ({ hook_event_name: event, session_id: 'g-1', cwd: '/repos/arcva', ...extra });

test('gemini: spec maps Gemini events and honours GEMINI_CLI_HOME', () => {
  const s = gemini.spec({ GEMINI_CLI_HOME: '/sandbox' });
  assert.equal(s.homeDir, path.join('/sandbox', '.gemini'));
  assert.deepEqual([s.startEvents, s.promptEvents, s.reassertEvents], [['SessionStart'], ['BeforeAgent'], ['AfterAgent']]);
  assert.ok(!s.consoleless);
  assert.equal(path.basename(s.script), 'hook.js');
});

test('gemini (posix): SessionStart shows the project, BeforeAgent hands generation to a worker', async () => {
  const spec = tmpSpec();
  const writes = [];
  const jobs = [];
  const deps = { platform: 'linux', project, write: (t) => { writes.push(t); return true; }, spawnJob: async (j) => { jobs.push(j); return true; }, now: 1_000 };
  assert.deepEqual(await hook.handleHook(spec, input('SessionStart'), deps), { action: 'title', title: 'arcva' });
  const r = await hook.handleHook(spec, input('BeforeAgent', { prompt: 'Fix the login redirect loop on Safari' }), deps);
  assert.equal(r.action, 'generating');
  assert.deepEqual(writes, ['arcva', 'arcva']);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].prompt, 'Fix the login redirect loop on Safari');
  assert.equal(jobs[0].title, undefined);
  const again = await hook.handleHook(spec, input('BeforeAgent', { prompt: 'Another real request here' }), { ...deps, now: 2_000 });
  assert.equal(again.action, 'no-generation');
});

test('gemini (win32): every title change goes through the worker (wrapper shells restore titles)', async () => {
  const spec = tmpSpec();
  const jobs = [];
  const deps = { platform: 'win32', project, write: () => { throw new Error('hook must not set it directly'); }, spawnJob: async (j) => { jobs.push(j); return true; }, now: 5 };
  await hook.handleHook(spec, input('SessionStart'), deps);
  await hook.handleHook(spec, input('BeforeAgent', { prompt: 'Fix the login redirect loop on Safari' }), deps);
  assert.deepEqual(jobs.map((j) => [j.title, j.prompt]), [['arcva', undefined], ['arcva', 'Fix the login redirect loop on Safari']]);
  assert.equal(jobs[0].startPid, undefined, 'Gemini hooks own a console: no ancestor attach');
});

test('gemini: trivial prompts, unknown events and bad session ids never generate', async () => {
  const spec = tmpSpec();
  const deps = { platform: 'linux', project, write: () => true, spawnJob: async () => { throw new Error('no'); } };
  assert.equal((await hook.handleHook(spec, input('BeforeAgent', { prompt: 'ok' }), deps)).action, 'no-generation');
  assert.equal((await hook.handleHook(spec, input('BeforeTool'), deps)).action, 'ignore');
  assert.equal((await hook.handleHook(spec, input('BeforeAgent', { session_id: 'a/b' }), deps)).action, 'skip-no-session');
  const off = () => ({ cfg: { enabled: false }, project: 'arcva' });
  assert.equal((await hook.handleHook(spec, input('SessionStart'), { ...deps, project: off })).action, 'disabled');
});

test('gemini: worker generates, stores the final title and re-shows it on later events', async () => {
  const spec = tmpSpec();
  const writes = [];
  const waits = [];
  const r = await hook.runWorker(spec, { sessionId: 'g-1', cwd: '/r', prompt: 'x', title: 'arcva' }, {
    platform: 'win32', wait: async (ms) => { waits.push(ms); },
    make: async () => ({ reason: 'ok', title: 'arcva - Fix Safari login redirect loop' }),
    write: (t) => { writes.push(t); return true; },
  });
  assert.equal(r.title, 'arcva - Fix Safari login redirect loop');
  assert.deepEqual(writes, ['arcva', 'arcva', 'arcva - Fix Safari login redirect loop', 'arcva - Fix Safari login redirect loop']);
  assert.deepEqual(waits, [400, 1500, 400, 1500]);
  const st = state.readState(state.stateDir({ CLAUDE_CONFIG_DIR: spec.homeDir }), 'g-1');
  assert.equal(st.stage, 'final');
  const seen = [];
  const after = await hook.handleHook(spec, input('AfterAgent'), { platform: 'linux', project, write: (t) => { seen.push(t); return true; } });
  assert.deepEqual(after, { action: 'title', title: 'arcva - Fix Safari login redirect loop' });
  assert.deepEqual(seen, ['arcva - Fix Safari login redirect loop']);
});

test('gemini: worker keeps the project title when generation fails', async () => {
  const spec = tmpSpec();
  const writes = [];
  const r = await hook.runWorker(spec, { sessionId: 'g-2', cwd: '/r', prompt: 'x' }, {
    platform: 'linux', make: async () => ({ reason: 'generation-failed' }), write: (t) => { writes.push(t); return true; },
  });
  assert.equal(r.reason, 'generation-failed');
  assert.deepEqual(writes, []);
});

test('workerCommand: Windows goes through cmd start /b, POSIX runs node directly', () => {
  const w = hook.workerCommand('C:\\x\\hook.js', { platform: 'win32', execPath: 'C:\\node\\node.exe' });
  assert.equal(w.command, 'cmd.exe');
  assert.equal(w.verbatim, true);
  assert.equal(w.args[0], '/d /s /c "start "" /b "C:\\node\\node.exe" "C:\\x\\hook.js" --worker"');
  assert.deepEqual(hook.workerCommand('/x/hook.js', { platform: 'linux', execPath: '/usr/bin/node' }), { command: '/usr/bin/node', args: ['/x/hook.js', '--worker'], verbatim: false });
});

test('readInput and promptOf tolerate junk and alternative keys', () => {
  assert.deepEqual(hook.readInput('not json'), {});
  assert.deepEqual(hook.readInput(''), {});
  assert.equal(hook.promptOf({ user_prompt: 'abc' }), 'abc');
  assert.equal(hook.promptOf({}), '');
});

test('osc: sequences are sanitised and bounded', () => {
  assert.equal(osc.oscTitleSequence('arcva - Topic'), '\u001b]0;arcva - Topic\u0007');
  assert.equal(osc.oscTitleSequence('a\u001b]0;evil\u0007b'), '\u001b]0;a ]0;evil b\u0007');
  assert.equal(osc.oscTitleSequence('   '), '');
  assert.equal(osc.cleanTitle('x'.repeat(500)).length, 120);
});

test('osc: Windows sets process.title, or attaches to an ancestor console when given startPid', () => {
  const proc = {};
  assert.equal(osc.writeTerminalTitle('arcva - T', { platform: 'win32', proc }), true);
  assert.equal(proc.title, 'arcva - T');
  const calls = [];
  const spawnSync = (cmd, args, opts) => { calls.push({ cmd, args, opts }); return { status: 0 }; };
  assert.equal(osc.writeTerminalTitle('arcva - T', { platform: 'win32', startPid: 4242, spawnSync }), true);
  assert.equal(calls[0].cmd, 'powershell.exe');
  assert.ok(calls[0].args.includes(osc.ANCESTOR_SCRIPT));
  assert.equal(calls[0].opts.env.SN_TITLE, 'arcva - T');
  assert.equal(calls[0].opts.env.SN_START_PID, '4242');
  assert.equal(calls[0].opts.windowsHide, true);
  assert.equal(osc.writeTerminalTitle('', { platform: 'win32', proc }), false);
});

test('osc: POSIX writes OSC 0 to /dev/tty and survives a missing terminal', () => {
  const written = [];
  const ok = osc.writeTerminalTitle('arcva - T', { platform: 'linux', openSync: (p) => { written.push(p); return 7; }, writeSync: (fd, s) => written.push(s), closeSync: () => {} });
  assert.equal(ok, true);
  assert.deepEqual(written, ['/dev/tty', '\u001b]0;arcva - T\u0007']);
  assert.equal(osc.writeTerminalTitle('x', { platform: 'linux', openSync: () => { throw new Error('ENXIO'); } }), false);
});

test('osc: resolveConsoleOwner parses the PowerShell answer', () => {
  assert.equal(osc.resolveConsoleOwner(10, { spawnSync: () => ({ status: 0, stdout: '4321' }) }), 4321);
  assert.equal(osc.resolveConsoleOwner(10, { spawnSync: () => ({ status: 1, stdout: '' }) }), null);
  assert.equal(osc.resolveConsoleOwner(0), null);
});

test('headless: `gemini -p` / `qwen -p` command lines are detected, interactive ones are not', () => {
  const { isHeadlessRun } = require('../adapters/_shared/headless');
  const hookLine = 'powershell.exe -Command node "C:/Users/me/.session-namer/app/1.0.0/adapters/gemini/hook.js"';
  assert.equal(isHeadlessRun('gemini', [hookLine, 'node C:/npm/node_modules/@google/gemini-cli/bundle/gemini.js -p "fix it"']), true);
  assert.equal(isHeadlessRun('gemini', [hookLine, 'node /usr/lib/gemini-cli/gemini.js --prompt=hello']), true);
  assert.equal(isHeadlessRun('gemini', [hookLine, 'node gemini.js']), false);
  assert.equal(isHeadlessRun('gemini', [hookLine, 'node gemini.js -i "start here"']), false);
  assert.equal(isHeadlessRun('qwen', ['node /x/@qwen-code/qwen-code/cli-entry.js -p "x"']), true);
  assert.equal(isHeadlessRun('gemini', []), false);
});

test('headless runs are skipped (checked once per session) unless name_headless is on', async () => {
  const spec = tmpSpec();
  let checks = 0;
  const jobs = [];
  const deps = {
    platform: 'linux', project, now: 1_000, write: () => true, spawnJob: async (j) => { jobs.push(j); return true; },
    detectHeadless: () => { checks += 1; return true; },
  };
  assert.equal((await hook.handleHook(spec, input('SessionStart'), deps)).action, 'skip-headless');
  assert.equal((await hook.handleHook(spec, input('BeforeAgent', { prompt: 'Fix the login redirect loop on Safari' }), deps)).action, 'skip-headless');
  assert.equal(checks, 1);
  assert.equal(jobs.length, 0);
  const on = () => ({ cfg: { enabled: true, nameHeadless: true }, project: 'arcva' });
  const spec2 = tmpSpec();
  const r = await hook.handleHook(spec2, input('BeforeAgent', { prompt: 'Fix the login redirect loop on Safari' }), { ...deps, project: on });
  assert.equal(r.action, 'generating');
  assert.equal(checks, 1, 'no detection when name_headless is on');
});

const argvHeadless = require('../adapters/gemini/headless-argv');
const HOOK_LINE = 'powershell.exe -NoProfile -Command node "C:/Users/me/.session-namer/app/1.2.0/adapters/gemini/hook.js"; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }';
const SAFARI = 'Fix the login redirect loop on Safari';

test('headless-argv: Windows command lines split like CommandLineToArgvW', () => {
  const { splitWindows } = argvHeadless;
  assert.deepEqual(
    splitWindows('"C:\\Program Files\\nodejs\\node.exe" --max-old-space-size=8192 "C:\\npm\\node_modules\\@google\\gemini-cli\\bundle\\gemini.js" "Fix the login redirect loop on Safari"'),
    ['C:\\Program Files\\nodejs\\node.exe', '--max-old-space-size=8192', 'C:\\npm\\node_modules\\@google\\gemini-cli\\bundle\\gemini.js', SAFARI],
  );
  assert.deepEqual(splitWindows('gemini.js "say \\"hi\\" now" a\\\\b "c\\\\" ""'), ['gemini.js', 'say "hi" now', 'a\\\\b', 'c\\', '']);
  assert.deepEqual(splitWindows('  node   gemini.js\tfix  '), ['node', 'gemini.js', 'fix']);
  assert.deepEqual(argvHeadless.splitPosix('node /usr/lib/gemini.js say "hi"'), ['node', '/usr/lib/gemini.js', 'say', '"hi"']);
});

test('headless-argv: a prompt given on the command line is recognised, a typed one is not', () => {
  const { promptOnCommandLine } = argvHeadless;
  const tok = (s) => argvHeadless.splitWindows(s);
  assert.equal(promptOnCommandLine(tok(`node gemini.js "${SAFARI}"`), SAFARI), true);
  assert.equal(promptOnCommandLine(tok(`node gemini.js --model gemini-2.5-pro ${SAFARI}`), SAFARI), true, 'unquoted words are joined with spaces');
  assert.equal(promptOnCommandLine(tok(`node gemini.js "${SAFARI}" --yolo`), SAFARI), true, 'a positional before options');
  assert.equal(promptOnCommandLine(tok(`node gemini.js "${SAFARI}"`), `piped file contents\n\n${SAFARI}`), true, 'stdin or hook context before the query');
  assert.equal(promptOnCommandLine(tok(`node gemini.js "${SAFARI}"`), `${SAFARI}\r\n`), true);
  assert.equal(promptOnCommandLine(tok('node gemini.js --model gemini-2.5-pro'), SAFARI), false);
  assert.equal(promptOnCommandLine(tok(`node gemini.js "${SAFARI}"`), 'Fix the login redirect loop'), false, 'a prefix is not enough');
  assert.equal(promptOnCommandLine(tok('node gemini.js --model gemini-2.5-pro'), 'tell me about gemini-2.5-pro'), false, 'an option value at the end of a typed prompt');
  assert.equal(promptOnCommandLine(tok(`node gemini.js "${SAFARI}"`), '   '), false);
  assert.equal(promptOnCommandLine(null, SAFARI), false);
});

test('headless-argv: agent line, -i and Gemini\'s CI rule', () => {
  const lines = [HOOK_LINE, 'node C:/npm/node_modules/@google/gemini-cli/bundle/gemini.js "x y z"', 'cmd.exe /c gemini.cmd'];
  assert.equal(argvHeadless.agentLine('gemini', lines), lines[1]);
  assert.deepEqual(argvHeadless.agentArgs('gemini', lines, { platform: 'win32' }), ['node', 'C:/npm/node_modules/@google/gemini-cli/bundle/gemini.js', 'x y z']);
  assert.equal(argvHeadless.agentArgs('gemini', [HOOK_LINE, 'node gemini.js -i "x y z"'], { platform: 'win32' }), null);
  assert.equal(argvHeadless.agentArgs('gemini', [HOOK_LINE], { platform: 'win32' }), null);
  const { ciHeadless } = argvHeadless;
  assert.equal(ciHeadless({ CI: 'true' }, 'node gemini.js'), true);
  assert.equal(ciHeadless({ GITHUB_ACTIONS: 'true' }, null), true);
  assert.equal(ciHeadless({ CI: '1' }, 'node gemini.js'), false, 'Gemini compares with "true"');
  assert.equal(ciHeadless({ CI: 'true', GEMINI_CLI_INTEGRATION_TEST: 'true' }, 'node gemini.js'), false);
  assert.equal(ciHeadless({ CI: 'true' }, 'node gemini.js -i "x"'), false);
  assert.equal(ciHeadless({ CI: 'true' }, 'node gemini.js --acp'), false);
  assert.equal(ciHeadless({}, 'node gemini.js'), false);
});

test('gemini: `gemini "<prompt>"` (positional, non-interactive) is skipped; the command line is read once', async () => {
  const spec = tmpSpec();
  let reads = 0;
  const jobs = [];
  const line = `"C:\\Program Files\\nodejs\\node.exe" --max-old-space-size=8192 "C:\\npm\\node_modules\\@google\\gemini-cli\\bundle\\gemini.js" "${SAFARI}"`;
  const opts = {
    platform: 'win32', ci: true, env: {}, getLines: () => { reads += 1; return [HOOK_LINE, line]; },
    deps: { project, now: 1_000, spawnJob: async (j) => { jobs.push(j); return true; } },
  };
  assert.equal((await argvHeadless.handleHook(spec, input('SessionStart'), opts)).action, 'title');
  assert.equal((await argvHeadless.handleHook(spec, input('BeforeAgent', { prompt: SAFARI }), opts)).action, 'skip-headless');
  assert.equal((await argvHeadless.handleHook(spec, input('AfterAgent'), opts)).action, 'skip-headless');
  assert.equal(reads, 1);
  assert.equal(jobs.filter((j) => j.prompt).length, 0, 'no topic generation');
  const log = fs.readFileSync(path.join(spec.homeDir, 'session-namer', 'log.txt'), 'utf8');
  assert.match(log, /headless run \(prompt given on the command line\), skipped/);
});

test('gemini: an interactive session still generates; a typed first prompt never matches', async () => {
  const spec = tmpSpec();
  const jobs = [];
  const opts = {
    platform: 'linux', ci: true, env: {}, getLines: () => [HOOK_LINE, 'node /usr/lib/node_modules/@google/gemini-cli/bundle/gemini.js --model gemini-2.5-pro'],
    deps: { project, now: 1_000, write: () => true, spawnJob: async (j) => { jobs.push(j); return true; } },
  };
  assert.equal((await argvHeadless.handleHook(spec, input('SessionStart'), opts)).action, 'title');
  assert.equal((await argvHeadless.handleHook(spec, input('BeforeAgent', { prompt: SAFARI }), opts)).action, 'generating');
  assert.equal(jobs.length, 1);
  // `gemini -i "<prompt>"` runs the TUI: generates too.
  const spec2 = tmpSpec();
  const i = { ...opts, getLines: () => [HOOK_LINE, `node gemini.js -i "${SAFARI}"`] };
  await argvHeadless.handleHook(spec2, input('SessionStart'), i);
  assert.equal((await argvHeadless.handleHook(spec2, input('BeforeAgent', { prompt: SAFARI }), i)).action, 'generating');
});

test('gemini: CI=true is headless (Gemini\'s rule); first hook being the prompt decides at once', async () => {
  const deps = { project, now: 1_000, write: () => true, spawnJob: async () => true };
  const ci = { platform: 'linux', ci: true, env: { CI: 'true' }, getLines: () => [HOOK_LINE, 'node gemini.js'], deps };
  assert.equal((await argvHeadless.handleHook(tmpSpec(), input('SessionStart'), ci)).action, 'skip-headless');
  assert.equal((await argvHeadless.handleHook(tmpSpec(), input('SessionStart'), { ...ci, ci: false })).action, 'title', 'Qwen has no CI rule');
  const first = { platform: 'linux', ci: true, env: {}, getLines: () => [HOOK_LINE, `node gemini.js ${SAFARI}`], deps };
  assert.equal((await argvHeadless.handleHook(tmpSpec(), input('BeforeAgent', { prompt: SAFARI }), first)).action, 'skip-headless');
  // name_headless on: the command line is never read.
  let reads = 0;
  const on = () => ({ cfg: { enabled: true, nameHeadless: true }, project: 'arcva' });
  const r = await argvHeadless.handleHook(tmpSpec(), input('BeforeAgent', { prompt: SAFARI }), { ...first, getLines: () => { reads += 1; return []; }, deps: { ...deps, project: on } });
  assert.equal(r.action, 'generating');
  assert.equal(reads, 0);
});

test('osc-title PowerShell helpers are bounded well under the hook timeout', () => {
  assert.ok(osc.PS_TIMEOUT_MS <= 5000);
  assert.ok(hook.STDIN_TIMEOUT_MS <= 5000);
});

test('the hook exits even when the agent never closes stdin', async () => {
  const { spawn } = require('node:child_process');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sn-gemini-stdin-'));
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'adapters', 'gemini', 'hook.js')], {
    stdio: ['pipe', 'ignore', 'ignore'], env: { ...process.env, GEMINI_CLI_HOME: home, CLAUDE_SESSION_NAMER: 'off' },
  });
  child.stdin.write('{"hook_event_name":"SessionStart"');
  const t0 = Date.now();
  const code = await new Promise((r) => { child.on('exit', r); setTimeout(() => { child.kill(); r('killed'); }, 15000); });
  assert.equal(code, 0);
  assert.ok(Date.now() - t0 < 10000);
});
