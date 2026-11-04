'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createAmpNamer, resolveAmp, defaultRename, REASSERT_WINDOW_MS } = require('../adapters/amp/namer');

const TID = 'T-11111111-2222-3333-4444-555555555555';
const env = { SESSION_NAMER_PROJECT_SOURCE: 'cwd' };

function setup({ generate = async () => 'Fix Safari login redirect loop', renameOk = true, envExtra = {} } = {}) {
  let clock = 1_000_000;
  const renames = [];
  let currentTitle = null;
  const namer = createAmpNamer({
    cwd: '/repos/webapp', env: { ...env, ...envExtra }, git: () => null, generate,
    now: () => clock,
    rename: async (id, t) => { renames.push([id, t]); if (renameOk) currentTitle = t; return { ok: renameOk, detail: renameOk ? '' : 'Error: 401' }; },
  });
  const ctx = { thread: { title: { get: async () => currentTitle } } };
  return {
    namer, renames, ctx,
    setTitle: (t) => { currentTitle = t; },
    advance: (ms) => { clock += ms; },
    start: async (message) => { await namer.onAgentStart({ thread: { id: TID }, message }, ctx); const job = namer.pending.get(TID); if (job) await job; },
    end: () => namer.onAgentEnd({ thread: { id: TID } }, ctx),
  };
}

test('names an untitled thread on the first eligible prompt', async () => {
  const s = setup();
  await s.start('Fix the login redirect loop on Safari');
  assert.deepEqual(s.renames, [[TID, 'webapp - Fix Safari login redirect loop']]);
  assert.equal(s.namer.threads.get(TID).stage, 'final');
});

test('agent.start returns immediately without awaiting generation', async () => {
  let release;
  const s = setup({ generate: () => new Promise((r) => { release = r; }) });
  const out = await s.namer.onAgentStart({ thread: { id: TID }, message: 'Fix the login redirect loop on Safari' }, s.ctx);
  assert.equal(out, undefined);
  assert.equal(s.renames.length, 0);
  assert.ok(s.namer.pending.has(TID));
  release('Fix Safari login redirect loop');
  await s.namer.pending.get(TID);
  assert.equal(s.renames.length, 1);
});

test('trivial prompts never trigger generation', async () => {
  let calls = 0;
  const s = setup({ generate: async () => { calls += 1; return 'x y z'; } });
  await s.start('ok');
  await s.start('/help');
  assert.equal(calls, 0);
  assert.equal(s.renames.length, 0);
});

test('a thread that already has a title when first seen is left alone', async () => {
  const s = setup();
  s.setTitle('Existing thread title');
  await s.start('Fix the login redirect loop on Safari');
  assert.equal(s.renames.length, 0);
  assert.equal(s.namer.threads.get(TID).stage, 'foreign');
});

test("the agent's own auto-title does not count as a user rename", async () => {
  const s = setup();
  await s.start('ok');
  s.setTitle('Greeting the user');
  await s.end();
  await s.start('Fix the login redirect loop on Safari');
  assert.deepEqual(s.renames, [[TID, 'webapp - Fix Safari login redirect loop']]);
});

test('a title change that is neither ours nor the agent auto-title locks the thread', async () => {
  const s = setup();
  await s.start('ok');
  s.setTitle('My own name');
  await s.start('Fix the login redirect loop on Safari');
  assert.equal(s.renames.length, 0);
  assert.equal(s.namer.threads.get(TID).stage, 'user');
});

test('re-asserts once when Amp overwrites the title right after naming, then hands off', async () => {
  const s = setup();
  await s.start('Fix the login redirect loop on Safari');
  s.setTitle('Safari redirect bug');
  await s.end();
  assert.equal(s.renames.length, 2);
  s.setTitle('Renamed by me');
  await s.end();
  assert.equal(s.renames.length, 2);
  assert.equal(s.namer.threads.get(TID).stage, 'user');
});

test('a change after the re-assert window is treated as the user', async () => {
  const s = setup();
  await s.start('Fix the login redirect loop on Safari');
  s.advance(REASSERT_WINDOW_MS + 1);
  s.setTitle('Renamed by me');
  await s.end();
  assert.equal(s.renames.length, 1);
  assert.equal(s.namer.threads.get(TID).stage, 'user');
});

test('failed generation retries at most 3 times, 60 s apart', async () => {
  let calls = 0;
  const s = setup({ generate: async () => { calls += 1; return null; } });
  await s.start('Fix the login redirect loop on Safari');
  await s.start('Fix the login redirect loop on Safari');
  assert.equal(calls, 1);
  for (let i = 0; i < 4; i += 1) { s.advance(61_000); await s.start('Fix the login redirect loop on Safari'); }
  assert.equal(calls, 3);
  assert.equal(s.renames.length, 0);
});

test('a failed rename (e.g. not logged in) keeps the thread a candidate', async () => {
  const s = setup({ renameOk: false });
  await s.start('Fix the login redirect loop on Safari');
  assert.equal(s.renames.length, 1);
  assert.equal(s.namer.threads.get(TID).stage, 'candidate');
});

test('disabled by SESSION_NAMER_NESTED or CLAUDE_SESSION_NAMER=off', async () => {
  for (const extra of [{ SESSION_NAMER_NESTED: '1' }, { CLAUDE_SESSION_NAMER: 'off' }]) {
    const s = setup({ envExtra: extra });
    assert.equal(s.namer.enabled, false);
    await s.start('Fix the login redirect loop on Safari');
    assert.equal(s.renames.length, 0);
  }
});

test('resolveAmp prefers override, then the running amp executable, never a .cmd', () => {
  const none = { exists: () => false, read: () => null };
  assert.deepEqual(resolveAmp({ SESSION_NAMER_AMP_PATH: 'X:/amp.exe' }, 'C:/node.exe', { platform: 'win32', ...none }), { command: 'X:/amp.exe', args: [] });
  assert.deepEqual(resolveAmp({}, 'C:/tools/amp.exe', { platform: 'win32', ...none }), { command: 'C:/tools/amp.exe', args: [] });
  // npm shim on PATH: resolved to the real amp.exe behind it.
  const shim = 'C:\\npm\\amp.cmd';
  const real = 'C:\\npm\\node_modules\\@ampcode\\cli\\bin\\amp.exe';
  const opts = {
    platform: 'win32',
    exists: (p) => p === shim || p === real,
    read: (p) => (p === shim ? '@ECHO off\r\nCALL :find_dp0\r\n"%dp0%\\node_modules\\@ampcode\\cli\\bin\\amp.exe"   %*\r\n' : null),
  };
  assert.deepEqual(resolveAmp({ PATH: 'C:\\npm' }, 'C:/node/node.exe', opts), { command: real, args: [] });
  // A shim that cannot be resolved yields null (refuse), not cmd.exe.
  assert.equal(resolveAmp({ PATH: 'C:\\npm' }, 'C:/node/node.exe', { platform: 'win32', exists: (p) => p === shim, read: () => 'garbage' }), null);
  assert.equal(resolveAmp({ SESSION_NAMER_AMP_PATH: shim }, 'C:/node/node.exe', { platform: 'win32', exists: (p) => p === shim, read: () => 'x' }), null);
});

test('defaultRename passes argv without a shell and detects "Error:" output', async () => {
  const calls = [];
  const runOk = async (cmd, args, opts) => { calls.push([cmd.command, args, opts]); return { code: 0, stdout: '', stderr: '' }; };
  const ok = await defaultRename({ amp: { command: 'C:/amp.exe', args: [] }, threadId: TID, newTitle: 'a "b" & c', run: runOk });
  assert.equal(ok.ok, true);
  assert.deepEqual(calls[0].slice(0, 2), ['C:/amp.exe', ['threads', 'rename', TID, 'a "b" & c']]);
  const runErr = async () => ({ code: 0, stdout: '', stderr: 'Error: Failed to rename thread: API request for getThreadTail failed: 401\n' });
  const bad = await defaultRename({ amp: { command: 'C:/amp.exe', args: [] }, threadId: TID, newTitle: 't t', run: runErr });
  assert.equal(bad.ok, false);
  assert.match(bad.detail, /401/);
});

test('defaultRename classifies the real amp 0.0.1793736138 outputs', async () => {
  const amp = { command: 'C:/amp.exe', args: [] };
  const url = `https://ampcode.com/threads/${TID}`;
  // Observed without a login (exit 1, stderr), plus the success line from Amp's rename command.
  const cases = [
    [{ code: 1, stdout: '', stderr: 'Error: Failed to rename thread: API request for getThreadTail failed: 401\n' }, false, /getThreadTail failed: 401/],
    [{ code: 1, stdout: '', stderr: 'Error: Thread name cannot be empty\n' }, false, /cannot be empty/],
    [{ code: 1, stdout: '', stderr: `Thread ${url} does not exist.\n` }, false, /does not exist/],
    [{ code: 1, stdout: '', stderr: '\x1b[31m\x1b[1mError: \x1b[22m\x1b[39mFailed to rename thread: API request for getThreadTail failed: 401\n' }, false, /^Error: Failed to rename thread/],
    [{ code: 0, stdout: `\x1b[32m✓ Thread ${url} renamed to "arcva - Fix Safari login loop"\n\x1b[39m`, stderr: '' }, true, /^✓ Thread .* renamed to "arcva - Fix Safari login loop"$/],
  ];
  for (const [result, ok, detail] of cases) {
    // eslint-disable-next-line no-await-in-loop
    const r = await defaultRename({ amp, threadId: TID, newTitle: 'arcva - Fix Safari login loop', run: async () => result });
    assert.equal(r.ok, ok, JSON.stringify(result));
    assert.match(r.detail, detail);
    assert.doesNotMatch(r.detail, /\x1b/);
  }
});

test('defaultRename refuses to run anything through a .cmd shim (cmd.exe injection)', async () => {
  let ran = false;
  const run = async () => { ran = true; return { code: 0, stdout: '', stderr: '' }; };
  for (const amp of [null, { command: 'C:/npm/amp.cmd', args: [] }]) {
    const r = await defaultRename({ amp, threadId: TID, newTitle: 'x"&echo PWNED>PWNED.txt&" - topic', run });
    assert.equal(r.ok, false);
  }
  assert.equal(ran, false);
});

test('an injection-shaped title reaches a real child process as one literal argument', async () => {
  const { runCommand } = require('../adapters/_shared/safe-spawn');
  const evil = 'x"&echo PWNED>PWNED.txt&" - a "mid" quote %PATH%';
  const r = await runCommand({ command: process.execPath, args: ['-e', 'process.stdout.write(JSON.stringify(process.argv.slice(1)))'] },
    ['threads', 'rename', TID, evil], { timeoutMs: 10000 });
  assert.equal(r.code, 0);
  assert.deepEqual(JSON.parse(r.stdout), ['threads', 'rename', TID, evil]);
});

test('the threads map is pruned to MAX_THREADS', async () => {
  const { MAX_THREADS } = require('../adapters/amp/namer');
  const s = setup();
  for (let i = 0; i < MAX_THREADS + 25; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await s.namer.onAgentStart({ thread: { id: `T-${i}` }, message: 'ok' }, s.ctx);
  }
  assert.ok(s.namer.threads.size <= MAX_THREADS);
  assert.ok(!s.namer.threads.has('T-0'));
});
