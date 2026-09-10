'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { run } = require('../hooks/namer');
const { readState, writeState } = require('../lib/state');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'namer-run-'));

/** Deps with a temp state dir, no git, and a stubbed generator. */
function makeDeps({ topic = 'Migração de faturas para V10', env = {}, generateCalls = [] } = {}) {
  const cfgDir = tmp();
  return {
    dir: path.join(cfgDir, 'session-namer'),
    deps: {
      env: { CLAUDE_CONFIG_DIR: cfgDir, ...env },
      git: () => null,
      generate: async (opts) => { generateCalls.push(opts); return topic; },
      now: () => 1_700_000_000_000,
    },
    generateCalls,
  };
}

const startup = (over = {}) => ({ session_id: 's1', cwd: 'D:/repos/arcva-2.0', hook_event_name: 'SessionStart', source: 'startup', ...over });
const prompt = (text, over = {}) => ({ session_id: 's1', cwd: 'D:/repos/arcva-2.0', hook_event_name: 'UserPromptSubmit', prompt: text, ...over });
const stop = (over = {}) => ({ session_id: 's1', cwd: 'D:/repos/arcva-2.0', hook_event_name: 'Stop', ...over });

test('startup without title emits the provisional project title', async () => {
  const { dir, deps } = makeDeps();
  const out = await run('SessionStart', startup(), deps);
  assert.deepEqual(out, { hookSpecificOutput: { hookEventName: 'SessionStart', sessionTitle: 'arcva-2.0' } });
  assert.equal(readState(dir, 's1').stage, 'provisional');
});

test('startup with a user-set title records stage user and stays silent', async () => {
  const { dir, deps } = makeDeps();
  assert.equal(await run('SessionStart', startup({ session_title: 'my own name' }), deps), null);
  assert.equal(readState(dir, 's1').stage, 'user');
  assert.equal(await run('UserPromptSubmit', prompt('Migra as faturas para a V10 por favor'), deps), null);
});

test('resume with our own title keeps stage; resume untitled becomes provisional', async () => {
  const { dir, deps } = makeDeps();
  writeState(dir, 's1', { stage: 'final', title: 'arcva-2.0 - Algo', attempts: 1, v: 1 });
  assert.equal(await run('SessionStart', startup({ source: 'resume', session_title: 'arcva-2.0 - Algo' }), deps), null);
  assert.equal(readState(dir, 's1').stage, 'final');
  const out = await run('SessionStart', startup({ session_id: 's2', source: 'resume' }), deps);
  assert.equal(out.hookSpecificOutput.sessionTitle, 'arcva-2.0');
});

test('clear, compact, subagents and disabled plugin produce nothing', async () => {
  const { deps } = makeDeps();
  assert.equal(await run('SessionStart', startup({ source: 'clear' }), deps), null);
  assert.equal(await run('SessionStart', startup({ source: 'compact' }), deps), null);
  assert.equal(await run('SessionStart', startup({ agent_type: 'reviewer' }), deps), null);
  const off = makeDeps({ env: { CLAUDE_SESSION_NAMER: 'off' } });
  assert.equal(await run('SessionStart', startup(), off.deps), null);
  assert.equal(await run('UserPromptSubmit', prompt('Migra as faturas para a V10 por favor'), off.deps), null);
  const nested = makeDeps({ env: { SESSION_NAMER_NESTED: '1' } });
  assert.equal(await run('UserPromptSubmit', prompt('Migra as faturas para a V10 por favor'), nested.deps), null);
});

test('first eligible prompt produces the final title and records it', async () => {
  const { dir, deps, generateCalls } = makeDeps();
  await run('SessionStart', startup(), deps);
  const out = await run('UserPromptSubmit', prompt('Migra as faturas para a V10 e valida os testes'), deps);
  assert.deepEqual(out, { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', sessionTitle: 'arcva-2.0 - Migração de faturas para V10' } });
  const st = readState(dir, 's1');
  assert.equal(st.stage, 'final');
  assert.equal(st.title, 'arcva-2.0 - Migração de faturas para V10');
  assert.equal(generateCalls.length, 1);
  assert.equal(generateCalls[0].model, 'haiku');
  // Second prompt: nothing more.
  assert.equal(await run('UserPromptSubmit', prompt('Agora corrige os testes que falharam'), deps), null);
  assert.equal(generateCalls.length, 1);
});

test('ineligible prompts keep the provisional stage without calling the model', async () => {
  const { dir, deps, generateCalls } = makeDeps();
  await run('SessionStart', startup(), deps);
  assert.equal(await run('UserPromptSubmit', prompt('/resume'), deps), null);
  assert.equal(await run('UserPromptSubmit', prompt('ok'), deps), null);
  assert.equal(generateCalls.length, 0);
  assert.equal(readState(dir, 's1').stage, 'provisional');
});

test('generation failure stays provisional, counts attempts, rate-limits and caps at 3', async () => {
  const calls = [];
  const cfgDir = tmp();
  const dir = path.join(cfgDir, 'session-namer');
  let clock = 1_700_000_000_000;
  const deps = { env: { CLAUDE_CONFIG_DIR: cfgDir }, git: () => null, generate: async () => { calls.push(1); return null; }, now: () => clock };
  await run('SessionStart', startup(), deps);
  const p = prompt('Migra as faturas para a V10 e valida os testes');
  assert.equal(await run('UserPromptSubmit', p, deps), null);
  assert.equal(readState(dir, 's1').attempts, 1);
  assert.equal(await run('UserPromptSubmit', p, deps), null); // within 60 s: no call
  assert.equal(calls.length, 1);
  clock += 61_000; await run('UserPromptSubmit', p, deps);
  clock += 61_000; await run('UserPromptSubmit', p, deps);
  clock += 61_000; await run('UserPromptSubmit', p, deps);
  assert.equal(calls.length, 3);
  assert.equal(readState(dir, 's1').attempts, 3);
});

test('unusable model answers are treated as failures', async () => {
  const { deps } = makeDeps({ topic: 'one' });
  await run('SessionStart', startup(), deps);
  assert.equal(await run('UserPromptSubmit', prompt('Migra as faturas para a V10 e valida os testes'), deps), null);
});

test('plugin enabled mid-session: no state, first prompt goes straight to final', async () => {
  const { deps } = makeDeps();
  const out = await run('UserPromptSubmit', prompt('Migra as faturas para a V10 e valida os testes'), deps);
  assert.equal(out.hookSpecificOutput.sessionTitle, 'arcva-2.0 - Migração de faturas para V10');
});

test('Stop re-asserts the final title exactly once', async () => {
  const { deps } = makeDeps();
  await run('SessionStart', startup(), deps);
  assert.equal(await run('Stop', stop(), deps), null); // still provisional: nothing
  await run('UserPromptSubmit', prompt('Migra as faturas para a V10 e valida os testes'), deps);
  assert.deepEqual(await run('Stop', stop(), deps), { hookSpecificOutput: { hookEventName: 'Stop', sessionTitle: 'arcva-2.0 - Migração de faturas para V10' } });
  assert.equal(await run('Stop', stop(), deps), null);
});

test('pending title from /session-name is applied on the next prompt even when final', async () => {
  const { dir, deps, generateCalls } = makeDeps();
  await run('SessionStart', startup(), deps);
  await run('UserPromptSubmit', prompt('Migra as faturas para a V10 e valida os testes'), deps);
  const st = readState(dir, 's1');
  writeState(dir, 's1', { ...st, pendingTitle: 'arcva-2.0 - Nome manual' });
  const out = await run('UserPromptSubmit', prompt('ok'), deps);
  assert.equal(out.hookSpecificOutput.sessionTitle, 'arcva-2.0 - Nome manual');
  assert.equal(readState(dir, 's1').pendingTitle, undefined);
  assert.equal(readState(dir, 's1').stage, 'user');
  assert.equal(generateCalls.length, 1);
});

test('config: separator, project override via repo file and cwd source', async () => {
  const repo = tmp();
  fs.writeFileSync(path.join(repo, '.session-namer.json'), JSON.stringify({ project: 'ARCVA' }));
  const { deps } = makeDeps({ env: { CLAUDE_PLUGIN_OPTION_SEPARATOR: ' | ' } });
  const repoPosix = repo.replace(/\\/g, '/');
  deps.git = (args) => (args.includes('--show-toplevel') ? repoPosix : `${repoPosix}/.git`);
  const out = await run('SessionStart', startup({ cwd: repo }), deps);
  assert.equal(out.hookSpecificOutput.sessionTitle, 'ARCVA');
  const out2 = await run('UserPromptSubmit', prompt('Migra as faturas para a V10 e valida os testes', { cwd: repo }), deps);
  assert.equal(out2.hookSpecificOutput.sessionTitle, 'ARCVA | Migração de faturas para V10');
});

test('CLI wrapper: malformed stdin exits 0 with empty stdout; valid input prints JSON', () => {
  const script = path.join(__dirname, '..', 'hooks', 'namer.js');
  const dir = tmp();
  const bad = spawnSync(process.execPath, [script, 'SessionStart'], { input: '{nope', env: { ...process.env, CLAUDE_CONFIG_DIR: dir } });
  assert.equal(bad.status, 0);
  assert.equal(bad.stdout.toString(), '');
  const good = spawnSync(process.execPath, [script, 'SessionStart'], {
    input: JSON.stringify(startup({ cwd: dir })),
    env: { ...process.env, CLAUDE_CONFIG_DIR: dir, SESSION_NAMER_PROJECT_SOURCE: 'cwd' },
  });
  assert.equal(good.status, 0);
  assert.equal(JSON.parse(good.stdout.toString()).hookSpecificOutput.sessionTitle, path.basename(dir));
  const unknown = spawnSync(process.execPath, [script, 'Bogus'], { input: '{}', env: { ...process.env, CLAUDE_CONFIG_DIR: dir } });
  assert.equal(unknown.status, 0);
  assert.equal(unknown.stdout.toString(), '');
});

test('CLI wrapper with fake result produces a final title end to end', () => {
  const script = path.join(__dirname, '..', 'hooks', 'namer.js');
  const dir = tmp();
  const env = { ...process.env, CLAUDE_CONFIG_DIR: dir, SESSION_NAMER_PROJECT_SOURCE: 'cwd', SESSION_NAMER_FAKE_RESULT: 'Título simulado aqui' };
  const r = spawnSync(process.execPath, [script, 'UserPromptSubmit'], { input: JSON.stringify(prompt('Migra as faturas para a V10 e valida os testes', { cwd: dir })), env });
  assert.equal(r.status, 0);
  assert.equal(JSON.parse(r.stdout.toString()).hookSpecificOutput.sessionTitle, `${path.basename(dir)} - Título simulado aqui`);
  assert.match(fs.readFileSync(path.join(dir, 'session-namer', 'log.txt'), 'utf8'), /final/);
});
