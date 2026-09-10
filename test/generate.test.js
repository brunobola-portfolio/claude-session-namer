'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { generateTopic, findClaude, buildArgs, SYSTEM_PROMPT } = require('../lib/generate');

/** Build a fake spawn that returns a child which emits the given script. */
function fakeSpawn(script) {
  const calls = [];
  const spawn = (command, args, options) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.pid = 4242;
    child.killed = false;
    child.kill = () => { child.killed = true; child.emit('close', null, 'SIGTERM'); };
    calls.push({ command, args, options, child });
    setImmediate(() => script(child));
    return child;
  };
  spawn.calls = calls;
  return spawn;
}

const base = { prompt: 'Migra as faturas para a V10', model: 'haiku', timeoutMs: 500, claudePath: { command: 'claude', args: [] } };

test('success: parses --output-format json result', async () => {
  const spawn = fakeSpawn((c) => { c.stdout.emit('data', Buffer.from(JSON.stringify({ result: 'Migração de faturas para V10' }))); c.emit('close', 0); });
  const topic = await generateTopic({ ...base, env: {}, spawn });
  assert.equal(topic, 'Migração de faturas para V10');
  const { command, args, options } = spawn.calls[0];
  assert.equal(command, 'claude');
  assert.ok(args.includes('--bare') && args.includes('-p') && args.includes('--no-session-persistence'));
  assert.equal(args[args.indexOf('--model') + 1], 'haiku');
  assert.equal(args[args.indexOf('--output-format') + 1], 'json');
  assert.equal(args[args.indexOf('--system-prompt') + 1], SYSTEM_PROMPT);
  assert.equal(args[args.length - 1], 'Migra as faturas para a V10');
  assert.equal(options.env.SESSION_NAMER_NESTED, '1');
  assert.equal(options.windowsHide, true);
});

test('non-JSON stdout falls back to raw text', async () => {
  const spawn = fakeSpawn((c) => { c.stdout.emit('data', Buffer.from('Fix login bug\n')); c.emit('close', 0); });
  assert.equal(await generateTopic({ ...base, env: {}, spawn }), 'Fix login bug');
});

test('non-zero exit or is_error JSON yields null', async () => {
  const s1 = fakeSpawn((c) => { c.stderr.emit('data', Buffer.from('boom')); c.emit('close', 1); });
  assert.equal(await generateTopic({ ...base, env: {}, spawn: s1 }), null);
  const s2 = fakeSpawn((c) => { c.stdout.emit('data', Buffer.from(JSON.stringify({ is_error: true, result: 'rate limited' }))); c.emit('close', 0); });
  assert.equal(await generateTopic({ ...base, env: {}, spawn: s2 }), null);
});

test('timeout kills the child and resolves null', async () => {
  const spawn = fakeSpawn(() => { /* never answers */ });
  const started = Date.now();
  const topic = await generateTopic({ ...base, env: {}, spawn, timeoutMs: 120 });
  assert.equal(topic, null);
  assert.ok(spawn.calls[0].child.killed);
  assert.ok(Date.now() - started < 1000);
});

test('spawn error resolves null instead of throwing', async () => {
  const spawn = fakeSpawn((c) => c.emit('error', new Error('ENOENT')));
  assert.equal(await generateTopic({ ...base, env: {}, spawn }), null);
});

test('SESSION_NAMER_FAKE_RESULT short-circuits without spawning', async () => {
  const spawn = fakeSpawn(() => { throw new Error('must not spawn'); });
  assert.equal(await generateTopic({ ...base, env: { SESSION_NAMER_FAKE_RESULT: 'Fake topic here' }, spawn }), 'Fake topic here');
  assert.equal(spawn.calls.length, 0);
});

test('buildArgs truncates huge prompts', () => {
  const args = buildArgs({ prompt: 'x'.repeat(10000), model: 'haiku' });
  assert.ok(args[args.length - 1].length < 2000);
});

test('findClaude honours SESSION_NAMER_CLAUDE_PATH and wraps .cmd on Windows', () => {
  assert.deepEqual(findClaude({ SESSION_NAMER_CLAUDE_PATH: '/opt/claude' }, { platform: 'linux', exists: () => true }), { command: '/opt/claude', args: [] });
  const win = findClaude({ SESSION_NAMER_CLAUDE_PATH: 'C:\\x\\claude.cmd' }, { platform: 'win32', exists: () => true });
  assert.deepEqual(win, { command: 'cmd.exe', args: ['/d', '/s', '/c', 'C:\\x\\claude.cmd'] });
  const exe = findClaude({ SESSION_NAMER_CLAUDE_PATH: 'C:\\x\\claude.exe' }, { platform: 'win32', exists: () => true });
  assert.deepEqual(exe, { command: 'C:\\x\\claude.exe', args: [] });
});

test('findClaude searches PATH, then well-known locations, else plain "claude"', () => {
  const sep = ':';
  const found = findClaude({ PATH: `/usr/bin${sep}/home/u/.local/bin` }, {
    platform: 'linux', pathSep: sep, exists: (p) => p === '/home/u/.local/bin/claude',
  });
  assert.deepEqual(found, { command: '/home/u/.local/bin/claude', args: [] });
  const fallback = findClaude({ PATH: '/nowhere', APPDATA: 'C:\\Users\\u\\AppData\\Roaming' }, {
    platform: 'win32', pathSep: ';', exists: (p) => p === 'C:\\Users\\u\\AppData\\Roaming\\npm\\claude.cmd',
  });
  assert.deepEqual(fallback, { command: 'cmd.exe', args: ['/d', '/s', '/c', 'C:\\Users\\u\\AppData\\Roaming\\npm\\claude.cmd'] });
  const none = findClaude({ PATH: '' }, { platform: 'linux', pathSep: ':', exists: () => false });
  assert.deepEqual(none, { command: 'claude', args: [] });
});
