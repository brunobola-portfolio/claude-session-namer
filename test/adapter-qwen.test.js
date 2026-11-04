'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const qwen = require('../adapters/qwen/hook');
const hook = require('../adapters/_shared/tab-title-hook');
const state = require('../lib/state');

const tmpSpec = () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sn-qwen-'));
  return qwen.spec({ QWEN_HOME: home });
};
const project = () => ({ cfg: { enabled: true }, project: 'arcva' });
// Payload shape captured live from Qwen Code 0.26.6.
const input = (event, extra = {}) => ({
  session_id: 'q-1', transcript_path: '/t.jsonl', cwd: '/repos/arcva', hook_event_name: event,
  timestamp: '2026-11-03T22:59:30Z', permission_mode: 'auto', ...extra,
});

test('qwen: QWEN_HOME is the .qwen directory itself; events and consoleless flag', () => {
  assert.equal(qwen.qwenHome({ QWEN_HOME: '/sandbox/q' }), '/sandbox/q');
  assert.equal(qwen.qwenHome({ HOME: '/h', USERPROFILE: '' }), path.join('/h', '.qwen'));
  const s = qwen.spec({ QWEN_HOME: '/x' });
  assert.deepEqual([s.startEvents, s.promptEvents, s.reassertEvents], [['SessionStart'], ['UserPromptSubmit'], ['Stop']]);
  assert.equal(s.consoleless, true);
});

test('qwen (win32): console owner is resolved once per session and passed to every worker', async () => {
  const spec = tmpSpec();
  const jobs = [];
  let resolves = 0;
  const deps = {
    platform: 'win32', project, ppid: 111, now: 10,
    resolveOwner: (pid) => { resolves += 1; assert.equal(pid, 111); return 9999; },
    spawnJob: async (j) => { jobs.push(j); return true; },
  };
  await hook.handleHook(spec, input('SessionStart', { source: 'startup', model: 'm' }), deps);
  await hook.handleHook(spec, input('UserPromptSubmit', { prompt_id: 'p1', prompt: 'Fix the login redirect loop on Safari', submitted_prompt: 'Fix the login redirect loop on Safari' }), deps);
  await hook.handleHook(spec, input('Stop'), deps);
  assert.equal(resolves, 1);
  assert.deepEqual(jobs.map((j) => j.startPid), [9999, 9999, 9999]);
  assert.equal(jobs[1].prompt, 'Fix the login redirect loop on Safari');
  const st = state.readState(state.stateDir({ CLAUDE_CONFIG_DIR: spec.homeDir }), 'q-1');
  assert.equal(st.consolePid, 9999);
});

test('qwen (win32): unresolved owner falls back to the parent PID and retries next time', async () => {
  const spec = tmpSpec();
  const jobs = [];
  let calls = 0;
  const deps = { platform: 'win32', project, ppid: 222, resolveOwner: () => { calls += 1; return null; }, spawnJob: async (j) => { jobs.push(j); return true; } };
  await hook.handleHook(spec, input('SessionStart'), deps);
  await hook.handleHook(spec, input('Stop'), deps);
  assert.equal(calls, 2);
  assert.deepEqual(jobs.map((j) => j.startPid), [222, 222]);
});

test('qwen (posix): no console resolution, title written directly', async () => {
  const spec = tmpSpec();
  const writes = [];
  const r = await hook.handleHook(spec, input('SessionStart'), {
    platform: 'linux', project, write: (t) => { writes.push(t); return true; },
    resolveOwner: () => { throw new Error('posix must not resolve'); }, spawnJob: async () => { throw new Error('no worker'); },
  });
  assert.deepEqual(r, { action: 'title', title: 'arcva' });
  assert.deepEqual(writes, ['arcva']);
});

test('qwen: worker writes through the ancestor console when the job carries startPid', async () => {
  const spec = tmpSpec();
  const titles = [];
  const r = await hook.runWorker(spec, { sessionId: 'q-9', cwd: '/r', prompt: 'x', startPid: 9999 }, {
    platform: 'linux', make: async () => ({ reason: 'ok', title: 'arcva - Topic words' }),
    write: (t) => { titles.push(t); return true; },
  });
  assert.equal(r.reason, 'ok');
  assert.deepEqual(titles, ['arcva - Topic words']);
});
