'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const hook = require('../adapters/cline/hook.js');
const installer = require('../adapters/cline/install.js');

const SID = '1793745632223_gzimr';
const PROMPT = 'Fix the login redirect loop on Safari';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sn-cline-'));
}

function payload(over = {}) {
  return {
    clineVersion: '', hookName: 'agent_start', timestamp: '2026-11-03T22:40:33.000Z',
    taskId: 'conv_1793745632230_abcdefg',
    sessionContext: { rootSessionId: SID },
    workspaceRoots: ['C:/work/webapp'],
    workspaceInfo: { rootPath: 'C:\\work\\webapp', hint: 'webapp' },
    userId: 'unknown', agent_id: 'agent_1', parent_agent_id: null,
    taskStart: { taskMetadata: {} },
    ...over,
  };
}

function deps(over = {}) {
  const writes = [];
  const record = {
    sessionId: SID,
    prompt: `<user_input mode="act">${PROMPT}</user_input>`,
    metadata: { title: PROMPT },
  };
  let t = 1_000_000;
  const d = {
    env: { HOME: os.tmpdir(), SESSION_NAMER_MODEL: 'haiku' },
    stateDir: tmpDir(),
    git: (args) => (args[1] === '--git-common-dir' ? 'C:/work/webapp/.git' : 'C:/work/webapp'),
    generate: async () => 'Fix Safari login redirect loop',
    getSession: (id) => (id === SID ? record : null),
    setTitle: (id, t2) => { writes.push([id, t2]); record.metadata.title = t2; return true; },
    now: () => (t += 1000),
    ...over,
  };
  return { d, writes, record };
}

test('stripPrompt removes the user_input wrapper', () => {
  assert.equal(hook.stripPrompt(`<user_input mode="act">${PROMPT}</user_input>`), PROMPT);
  assert.equal(hook.stripPrompt(undefined), '');
});

test('isDefaultTitle accepts the prompt and its truncations only', () => {
  assert.equal(hook.isDefaultTitle(PROMPT, PROMPT), true);
  assert.equal(hook.isDefaultTitle('Fix the login redirect', PROMPT), true);
  assert.equal(hook.isDefaultTitle('', PROMPT), true);
  assert.equal(hook.isDefaultTitle('My own name', PROMPT), false);
});

test('agent_start: titles the session through cline history update', async () => {
  const { d, writes } = deps();
  const out = await hook.run(payload(), d);
  assert.equal(out, 'webapp - Fix Safari login redirect loop');
  assert.deepEqual(writes, [[SID, 'webapp - Fix Safari login redirect loop']]);
});

test('uses sessionContext.rootSessionId, not taskId', async () => {
  const seen = [];
  const { d } = deps({ getSession: (id) => { seen.push(id); return null; } });
  await hook.run(payload(), d);
  assert.deepEqual(seen, [SID]);
});

test('runs once per session: later agent_start events are ignored', async () => {
  const { d, writes } = deps();
  await hook.run(payload(), d);
  await hook.run(payload(), d);
  await hook.run(payload({ hookName: 'prompt_submit', userPromptSubmit: { prompt: 'Now add tests for it please', attachments: [] } }), d);
  assert.equal(writes.length, 1);
});

test('prompt_submit prompt wins over the stored first prompt', async () => {
  let got = null;
  const { d, record } = deps({ generate: async ({ prompt }) => { got = prompt; return 'Paginate customer list view'; } });
  record.prompt = 'ok';
  record.metadata.title = 'ok';
  await hook.run(payload({ hookName: 'prompt_submit', userPromptSubmit: { prompt: 'Add pagination to the customer list', attachments: [] } }), d);
  assert.equal(got, 'Add pagination to the customer list');
});

test('a title the user set is never overwritten', async () => {
  const { d, writes, record } = deps();
  record.metadata.title = 'Release prep';
  assert.equal(await hook.run(payload(), d), null);
  record.metadata.title = PROMPT; // even if it later looks default again
  assert.equal(await hook.run(payload(), d), null);
  assert.equal(writes.length, 0);
});

test('trivial prompts, subagents, other events and nested runs do nothing', async () => {
  const { d, writes, record } = deps();
  record.prompt = 'ok';
  record.metadata.title = 'ok';
  assert.equal(await hook.run(payload(), d), null);
  const b = deps();
  assert.equal(await hook.run(payload({ parent_agent_id: 'agent_0' }), b.d), null);
  assert.equal(await hook.run(payload({ hookName: 'tool_call' }), b.d), null);
  assert.equal(await hook.run(payload(), { ...b.d, env: { SESSION_NAMER_NESTED: '1' } }), null);
  assert.equal(await hook.run(payload({ sessionContext: {} }), b.d), null);
  assert.equal(writes.length + b.writes.length, 0);
});

test('disabled config does nothing', async () => {
  const { d, writes } = deps();
  d.env = { ...d.env, CLAUDE_SESSION_NAMER: 'off' };
  assert.equal(await hook.run(payload(), d), null);
  assert.equal(writes.length, 0);
});

test('failed generation retries later, at most MAX_ATTEMPTS times', async () => {
  let calls = 0;
  let t = 0;
  const { d, writes } = deps({ generate: async () => { calls += 1; return null; }, now: () => t });
  for (let i = 0; i < 6; i += 1) {
    t += 120_000;
    await hook.run(payload(), d);
  }
  assert.equal(calls, hook.MAX_ATTEMPTS);
  assert.equal(writes.length, 0);
});

test('failed history update is not recorded as final', async () => {
  let t = 0;
  const { d } = deps({ setTitle: () => false, now: () => (t += 120_000) });
  assert.equal(await hook.run(payload(), d), null);
  let wrote = false;
  d.setTitle = () => { wrote = true; return true; };
  await hook.run(payload(), d);
  assert.equal(wrote, true);
});

test('clineCommand prefers explicit path, then CLINE_WRAPPER_PATH, then PATH, and never needs a shell', () => {
  const shim = 'C:\\x\\cline.cmd';
  const script = 'C:\\x\\node_modules\\cline\\bin\\cline';
  const shimText = '@ECHO off\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\cline\\bin\\cline" %*\r\n';
  const fsOpts = { exists: (p) => p === shim || p === script, read: (p) => (p === shim ? shimText : null) };
  // The npm shim is resolved to its Node script, so no cmd.exe is involved.
  assert.deepEqual(hook.clineCommand({ SESSION_NAMER_CLINE_PATH: shim }, 'win32', fsOpts), { command: process.execPath, args: [script] });
  assert.deepEqual(hook.clineCommand({ PATH: 'C:\\x' }, 'win32', fsOpts), { command: process.execPath, args: [script] });
  // Unresolvable shim: null (refuse) instead of shell: true.
  assert.equal(hook.clineCommand({ SESSION_NAMER_CLINE_PATH: shim }, 'win32', { exists: () => true, read: () => 'nothing' }), null);
  assert.equal(hook.clineCommand({ PATH: '' }, 'win32', { exists: () => false }), null);
  const w = hook.clineCommand({ CLINE_WRAPPER_PATH: '/npm/cline/bin/cline' }, 'linux');
  assert.equal(w.command, process.execPath);
  assert.deepEqual(w.args, ['/npm/cline/bin/cline']);
  assert.deepEqual(hook.clineCommand({ PATH: '' }, 'linux'), { command: 'cline', args: [] });
});

test('runCline passes %VAR% in a title through literally (no shell expansion)', async () => {
  const dir = tmpDir();
  const script = path.join(dir, 'fake-cline.js');
  fs.writeFileSync(script, 'process.stdout.write(JSON.stringify(process.argv.slice(2)));\n');
  const evil = 'webapp - %USERPROFILE% & echo PWNED "quoted"';
  const r = await hook.runCline(['history', 'update', '--title', evil], { env: { ...process.env, SESSION_NAMER_CLINE_PATH: script } });
  assert.equal(r.status, 0);
  assert.deepEqual(JSON.parse(r.stdout), ['history', 'update', '--title', evil]);
});

test('TaskStart and UserPromptSubmit racing: only one worker generates', async () => {
  let calls = 0;
  let release;
  const gate = new Promise((r) => { release = r; });
  const { d, writes } = deps({ generate: async () => { calls += 1; await gate; return 'Fix Safari login redirect loop'; } });
  const a = hook.run(payload(), d);
  const b = hook.run(payload({ hookName: 'prompt_submit', userPromptSubmit: { prompt: PROMPT, attachments: [] } }), d);
  await new Promise((r) => { setTimeout(r, 20); });
  release();
  await Promise.all([a, b]);
  assert.equal(calls, 1);
  assert.equal(writes.length, 1);
  assert.ok(hook.INFLIGHT_MS >= hook.RETRY_INTERVAL_MS);
});

test('a stale claim from a crashed worker is taken over', () => {
  const dir = tmpDir();
  let t = 1_000;
  const first = hook.claim(dir, 'cline-x', () => t);
  assert.equal(typeof first, 'function');
  assert.equal(hook.claim(dir, 'cline-x', () => t), null);
  t += hook.INFLIGHT_MS + 1;
  const second = hook.claim(dir, 'cline-x', () => t);
  assert.equal(typeof second, 'function');
  second();
});

test('spawnWorker detaches a --worker child with the payload in the env', () => {
  let call = null;
  const fake = { on() {}, unref() { call.unref = true; } };
  hook.spawnWorker('{"a":1}', { env: {}, spawn: (cmd, args, opts) => { call = { cmd, args, opts }; return fake; } });
  assert.equal(call.cmd, process.execPath);
  assert.equal(call.args[1], '--worker');
  assert.equal(call.opts.detached, true);
  assert.equal(Buffer.from(call.opts.env.SESSION_NAMER_CLINE_PAYLOAD, 'base64').toString('utf8'), '{"a":1}');
  assert.equal(call.unref, true);
});

test('installer writes marked stubs, keeps foreign hooks, uninstalls only its own', () => {
  const ws = tmpDir();
  const dir = installer.hooksDir({ workspace: ws });
  assert.equal(dir, path.join(ws, '.clinerules', 'hooks'));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'UserPromptSubmit.js'), '// mine\n');
  installer.install(dir, '/x/hook.js');
  const stub = fs.readFileSync(path.join(dir, 'TaskStart.js'), 'utf8');
  assert.match(stub, new RegExp(installer.MARKER));
  assert.match(stub, /require\("\/x\/hook\.js"\)\.main\(\)/);
  assert.equal(fs.readFileSync(path.join(dir, 'UserPromptSubmit.js'), 'utf8'), '// mine\n');
  installer.uninstall(dir);
  assert.equal(fs.existsSync(path.join(dir, 'TaskStart.js')), false);
  assert.equal(fs.existsSync(path.join(dir, 'UserPromptSubmit.js')), true);
  assert.equal(installer.hooksDir({ env: { CLINE_DIR: '/c' } }), path.join('/c', 'hooks'));
});
