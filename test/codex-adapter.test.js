'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const gen = require('../adapters/codex/generate');
const appServer = require('../adapters/codex/appserver');
const hook = require('../adapters/codex/hook');
const { readState, writeState } = require('../lib/state');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'namer-codex-'));

/** Fake child_process.spawn; `script(child, call)` drives the child. */
function fakeSpawn(script) {
  const calls = [];
  const spawn = (command, args, options) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = Object.assign(new EventEmitter(), {
      written: '',
      chunks: [], // raw writes (Buffers stay binary: WebSocket frames)
      write(data) { this.written += String(data); this.chunks.push(data); this.emit('chunk', data); return true; },
      end(data) { if (data) this.written += data; },
    });
    child.pid = 0; // keeps killTree away from taskkill
    child.kill = () => { if (!child.closed) { child.closed = true; setImmediate(() => child.emit('close', null)); } };
    const call = { command, args, options, child };
    calls.push(call);
    setImmediate(() => script(child, call));
    return child;
  };
  spawn.calls = calls;
  return spawn;
}

/** A fake app server that answers JSON-RPC requests with `handlers[method](params)`. */
function fakeAppServer(handlers, seen = []) {
  return (child) => {
    const onData = (data) => {
      for (const line of String(data).split('\n').filter(Boolean)) {
        const msg = JSON.parse(line);
        seen.push(msg);
        if (msg.id === undefined) continue;
        const h = handlers[msg.method];
        const reply = h ? h(msg.params) : { error: { message: `unknown ${msg.method}` } };
        const out = reply && reply.error ? { id: msg.id, error: reply.error } : { id: msg.id, result: reply };
        child.stdout.emit('data', Buffer.from(`{"method":"noise/notification","params":{}}\n${JSON.stringify(out)}\n`));
      }
    };
    child.stdin.on('chunk', onData);
    if (child.stdin.written) onData(child.stdin.written); // requests written before we attached
  };
}

/** Unmasked server frame; fin=false starts or continues a fragmented message. */
function serverFrame(payload, opcode = 1, fin = true) {
  const data = Buffer.from(payload);
  const b0 = (fin ? 0x80 : 0) | opcode;
  if (data.length < 126) return Buffer.concat([Buffer.from([b0, data.length]), data]);
  const head = Buffer.from([b0, 126, 0, 0]);
  head.writeUInt16BE(data.length, 2);
  return Buffer.concat([head, data]);
}

/** Decode one masked client frame (the client writes exactly one frame per write). */
function clientFrame(buf) {
  assert.ok(buf[1] & 0x80, 'client frames must be masked');
  let len = buf[1] & 0x7f;
  let off = 2;
  if (len === 126) { len = buf.readUInt16BE(2); off = 4; }
  const mask = buf.slice(off, off + 4);
  const body = Buffer.from(buf.slice(off + 4, off + 4 + len).map((b, i) => b ^ mask[i % 4]));
  return { fin: (buf[0] & 0x80) !== 0, opcode: buf[0] & 0x0f, text: body.toString('utf8') };
}

/**
 * A fake `codex app-server proxy` talking to the daemon's WebSocket control
 * socket: checks the upgrade request, answers 101, then JSON-RPC over frames.
 * It pings right after the upgrade and fragments + splits the thread/read reply.
 */
function fakeWsAppServer(handlers, seen = { requests: [], frames: [], handshake: null }) {
  return (child) => {
    const onData = (data) => {
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'latin1');
      if (!seen.handshake) {
        seen.handshake = buf.toString('latin1');
        const key = (seen.handshake.match(/^Sec-WebSocket-Key: (\S+)/im) || [])[1];
        const accept = require('node:crypto').createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
        child.stdout.emit('data', Buffer.concat([
          Buffer.from(`HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: Upgrade\r\nsec-websocket-accept: ${accept}\r\n\r\n`, 'latin1'),
          serverFrame('hi', 9), // ping in the same chunk as the 101
        ]));
        return;
      }
      const frame = clientFrame(buf);
      seen.frames.push(frame.opcode);
      if (frame.opcode !== 1) return;
      const msg = JSON.parse(frame.text);
      seen.requests.push(msg);
      if (msg.id === undefined) return;
      const h = handlers[msg.method];
      const reply = h ? h(msg.params) : { error: { message: `unknown ${msg.method}` } };
      const out = JSON.stringify(reply && reply.error ? { id: msg.id, error: reply.error } : { id: msg.id, result: reply });
      child.stdout.emit('data', serverFrame('{"method":"account/updated","params":{}}'));
      if (msg.method !== 'thread/read') { child.stdout.emit('data', serverFrame(out)); return; }
      const bytes = Buffer.concat([serverFrame(out.slice(0, 10), 1, false), serverFrame(out.slice(10), 0, true)]);
      child.stdout.emit('data', bytes.slice(0, 7));
      child.stdout.emit('data', bytes.slice(7));
    };
    child.stdin.on('chunk', onData);
    for (const c of child.stdin.chunks.slice()) onData(c); // written before we attached
  };
}

// ---------------------------------------------------------------- generate

test('codex exec args carry every recursion/persistence guard', () => {
  const args = gen.buildExecArgs({ model: 'gpt-x' });
  for (const flag of ['exec', '--ephemeral', '--skip-git-repo-check', '--ignore-user-config', '--json', '-']) assert.ok(args.includes(flag), flag);
  assert.equal(args[args.indexOf('--disable') + 1], 'hooks');
  assert.equal(args[args.indexOf('-s') + 1], 'read-only');
  assert.equal(args[args.indexOf('-m') + 1], 'gpt-x');
  assert.ok(!gen.buildExecArgs().includes('-m'), 'no -m unless configured');
});

test('codex exec args switch off every tool that can read files (prompt-injection leak)', () => {
  const args = gen.buildExecArgs();
  const disabled = args.filter((a, i) => args[i - 1] === '--disable');
  for (const f of ['shell_tool', 'unified_exec', 'code_mode_host', 'view_image', 'browser_use', 'computer_use', 'apps']) {
    assert.ok(disabled.includes(f), f);
  }
  assert.ok(args.includes('web_search="disabled"'));
});

test('parseExecJson returns the last agent_message and ignores noise', () => {
  const out = [
    '2026-11-03T22:17:43Z ERROR rmcp: something',
    '{"type":"thread.started","thread_id":"t"}',
    '{"type":"item.completed","item":{"type":"error","message":"warn"}}',
    '{"type":"item.completed","item":{"type":"agent_message","text":"Fix Safari login loop"}}',
    '{"type":"turn.completed"}',
  ].join('\n');
  assert.equal(gen.parseExecJson(out), 'Fix Safari login loop');
  assert.equal(gen.parseExecJson('not json'), null);
});

test('generateTopicCodex: prompt on stdin, nested env, cwd outside the repo', async () => {
  const spawn = fakeSpawn((c) => {
    c.stdout.emit('data', Buffer.from('{"type":"item.completed","item":{"type":"agent_message","text":"Paginação de clientes"}}\n'));
    c.emit('close', 0);
  });
  const topic = await gen.generateTopicCodex({ prompt: 'Añade paginación al listado de clientes', env: { PATH: '' }, spawn, codex: { command: 'codex', args: [] }, cwd: 'X:/tmp' });
  assert.equal(topic, 'Paginação de clientes');
  const { args, options, child } = spawn.calls[0];
  assert.equal(args[0], 'exec');
  assert.equal(options.env.SESSION_NAMER_NESTED, '1');
  assert.equal(options.cwd, 'X:/tmp');
  assert.match(child.stdin.written, /short session titles/);
  assert.match(child.stdin.written, /Añade paginación/);
});

test('generateTopicCodex: failures and timeouts resolve to null', async () => {
  const failing = fakeSpawn((c) => { c.stderr.emit('data', Buffer.from('not logged in')); c.emit('close', 1); });
  assert.equal(await gen.generateTopicCodex({ prompt: 'x', env: {}, spawn: failing, codex: { command: 'codex', args: [] } }), null);
  const hanging = fakeSpawn(() => {});
  const t0 = Date.now();
  assert.equal(await gen.generateTopicCodex({ prompt: 'x', env: {}, spawn: hanging, codex: { command: 'codex', args: [] }, timeoutMs: 50 }), null);
  assert.ok(Date.now() - t0 < 2000);
  const throwing = () => { throw new Error('ENOENT'); };
  assert.equal(await gen.generateTopicCodex({ prompt: 'x', env: {}, spawn: throwing, codex: { command: 'codex', args: [] } }), null);
});

test('findCodex prefers the npm script over the .cmd shim on Windows', () => {
  const files = new Set([
    'C:\\npm\\codex.cmd', 'C:\\npm\\node_modules\\@openai\\codex\\bin\\codex.js', 'D:\\pkg\\bin\\codex.js',
  ]);
  const exists = (p) => files.has(p);
  const opts = { platform: 'win32', pathSep: ';', exists, nodePath: 'node.exe' };
  assert.deepEqual(gen.findCodex({ PATH: 'C:\\npm' }, opts), { command: 'node.exe', args: ['C:\\npm\\node_modules\\@openai\\codex\\bin\\codex.js'] });
  assert.deepEqual(gen.findCodex({ PATH: 'C:\\npm', CODEX_MANAGED_PACKAGE_ROOT: 'D:\\pkg' }, opts), { command: 'node.exe', args: ['D:\\pkg\\bin\\codex.js'] });
  assert.deepEqual(gen.findCodex({ SESSION_NAMER_CODEX_PATH: 'E:\\codex.exe' }, opts), { command: 'E:\\codex.exe', args: [] });
  assert.deepEqual(gen.findCodex({ PATH: '' }, opts), { command: 'codex', args: [] });
  assert.deepEqual(gen.findCodex({ PATH: '/usr/bin' }, { platform: 'linux', pathSep: ':', exists: (p) => p === '/usr/bin/codex' }), { command: '/usr/bin/codex', args: [] });
});

// ---------------------------------------------------------------- app server

test('withAppServer: initialize handshake, then the script, over stdio', async () => {
  const seen = [];
  const spawn = fakeSpawn(fakeAppServer({
    initialize: () => ({ userAgent: 'x' }),
    'thread/read': () => ({ thread: { id: 't1', name: null, source: 'cli', ephemeral: false } }),
    'thread/name/set': () => ({}),
  }, seen));
  const res = await appServer.withAppServer({
    codex: { command: 'codex', args: [] }, mode: 'stdio', spawn,
    script: async (request) => {
      const t = await appServer.readThread(request, 't1');
      await appServer.setThreadName(request, 't1', 'repo - Topic here');
      return t;
    },
  });
  assert.equal(res.ok, true);
  assert.deepEqual(res.value, { name: null, source: 'cli', ephemeral: false, parentThreadId: null, loaded: null });
  assert.deepEqual(spawn.calls[0].args, ['app-server']);
  assert.equal(spawn.calls[0].options.env.SESSION_NAMER_NESTED, '1');
  assert.deepEqual(seen.map((m) => m.method), ['initialize', 'initialized', 'thread/read', 'thread/name/set']);
  assert.deepEqual(seen[3].params, { threadId: 't1', name: 'repo - Topic here' });
});

test('callAppServer falls back from the daemon proxy to a private server', async () => {
  const spawn = fakeSpawn((child, call) => {
    if (call.args.includes('proxy')) {
      child.stderr.emit('data', Buffer.from('failed to connect to socket'));
      child.emit('close', 1);
      return;
    }
    fakeAppServer({ initialize: () => ({}), 'thread/name/set': () => ({}) })(child);
  });
  const logs = [];
  const res = await appServer.callAppServer({
    codex: { command: 'codex', args: [] }, spawn, log: (m) => logs.push(m),
    script: (request) => appServer.setThreadName(request, 't1', 'n'),
  });
  assert.equal(res.ok, true);
  assert.equal(res.mode, 'stdio');
  assert.deepEqual(spawn.calls.map((c) => c.args), [['app-server', 'proxy'], ['app-server']]);
  assert.match(logs[0], /proxy/);
});

test('WebSocket frames: masked encode, decode across chunks, 16-bit lengths, fragments', () => {
  const mask = Buffer.from([1, 2, 3, 4]);
  const frame = appServer.encodeFrame('{"id":1}', 1, mask);
  assert.deepEqual([...frame.slice(0, 6)], [0x81, 0x80 | 8, 1, 2, 3, 4]);
  assert.equal(clientFrame(frame).text, '{"id":1}');
  const long = 'x'.repeat(300);
  assert.equal(clientFrame(appServer.encodeFrame(long)).text, long);
  const dec = appServer.createFrameDecoder();
  const bytes = Buffer.concat([serverFrame('ab', 1, false), serverFrame('cd', 0, true), serverFrame(long), serverFrame('', 9)]);
  const out = [];
  for (let i = 0; i < bytes.length; i += 5) out.push(...dec.push(bytes.slice(i, i + 5)));
  assert.deepEqual(out.map((m) => [m.opcode, m.payload.toString()]), [[1, 'abcd'], [1, long], [9, '']]);
  assert.deepEqual(dec.push(appServer.encodeFrame('masked')).map((m) => m.payload.toString()), ['masked'], 'masked frames decode too');
});

test('withAppServer proxy: WebSocket upgrade to /rpc, JSON-RPC in frames, pong, fragmented replies', async () => {
  const seen = { requests: [], frames: [], handshake: null };
  const spawn = fakeSpawn(fakeWsAppServer({
    initialize: () => ({ userAgent: 'x' }),
    'thread/read': () => ({ thread: { id: 't1', name: null, source: 'vscode', ephemeral: false, status: { type: 'idle' } } }),
    'thread/name/set': () => ({}),
  }, seen));
  const res = await appServer.withAppServer({
    codex: { command: 'codex', args: [] }, mode: 'proxy', spawn,
    script: async (request, conn) => {
      const t = await appServer.readThread(request, 't1');
      await appServer.setThreadName(request, 't1', 'repo - Topic here');
      return { t, mode: conn.mode };
    },
  });
  assert.equal(res.ok, true, res.error);
  assert.deepEqual(res.value, { t: { name: null, source: 'vscode', ephemeral: false, parentThreadId: null, loaded: true }, mode: 'proxy' });
  assert.deepEqual(spawn.calls[0].args, ['app-server', 'proxy']);
  assert.match(seen.handshake, /^GET \/rpc HTTP\/1\.1\r\n/);
  assert.match(seen.handshake, /\r\nUpgrade: websocket\r\n/);
  assert.match(seen.handshake, /\r\nSec-WebSocket-Version: 13\r\n\r\n$/);
  assert.ok(seen.frames.includes(10), 'answers the ping with a pong');
  assert.deepEqual(seen.requests.map((m) => m.method), ['initialize', 'initialized', 'thread/read', 'thread/name/set']);
  assert.deepEqual(seen.requests[3].params, { threadId: 't1', name: 'repo - Topic here' });
});

test('withAppServer proxy: a non-WebSocket answer fails fast, then the private server is used', async () => {
  const spawn = fakeSpawn((child, call) => {
    if (!call.args.includes('proxy')) { fakeAppServer({ initialize: () => ({}), 'thread/name/set': () => ({}) })(child); return; }
    child.stdin.on('chunk', () => {});
    setImmediate(() => child.stdout.emit('data', Buffer.from('{"error":{"message":"parse error"}}\n')));
  });
  const t0 = Date.now();
  const res = await appServer.callAppServer({
    codex: { command: 'codex', args: [] }, spawn, timeoutMs: 5000, log: () => {},
    script: (request) => appServer.setThreadName(request, 't1', 'n'),
  });
  assert.equal(res.ok, true);
  assert.equal(res.mode, 'stdio');
  assert.ok(Date.now() - t0 < 2000, 'no wait for the timeout');
});

test('readThread maps status to loaded: notLoaded=false, idle/active=true, missing=null', async () => {
  const read = (status) => appServer.readThread(async () => ({ thread: { id: 't', name: 'n', status } }), 't');
  assert.equal((await read({ type: 'notLoaded' })).loaded, false);
  assert.equal((await read({ type: 'idle' })).loaded, true);
  assert.equal((await read({ type: 'active', activeFlags: [] })).loaded, true);
  assert.equal((await read(undefined)).loaded, null);
});

test('withAppServer: RPC errors and timeouts resolve with ok=false', async () => {
  const erroring = fakeSpawn(fakeAppServer({ initialize: () => ({}), 'thread/name/set': () => ({ error: { message: 'thread not found' } }) }));
  const res = await appServer.withAppServer({ codex: { command: 'c', args: [] }, mode: 'stdio', spawn: erroring, script: (r) => appServer.setThreadName(r, 't', 'n') });
  assert.equal(res.ok, false);
  assert.match(res.error, /thread not found/);
  const silent = fakeSpawn(() => {});
  const res2 = await appServer.withAppServer({ codex: { command: 'c', args: [] }, mode: 'stdio', spawn: silent, timeoutMs: 50, script: async () => 1 });
  assert.equal(res2.ok, false);
  assert.match(res2.error, /timeout/);
});

// ---------------------------------------------------------------- hook (decision)

function hookDeps({ env = {}, meta = null } = {}) {
  const home = tmp();
  const dispatched = [];
  return {
    dir: path.join(home, 'session-namer'),
    dispatched,
    deps: {
      env: { CODEX_HOME: home, ...env },
      git: () => null,
      now: () => 1_700_000_000_000,
      readSessionMeta: () => meta,
      dispatch: (job) => dispatched.push(job),
    },
  };
}
const prompt = (text, over = {}) => ({ session_id: 'thr1', cwd: 'D:/repos/arcva-2.0', hook_event_name: 'UserPromptSubmit', prompt: text, transcript_path: 'x.jsonl', ...over });

test('hook: eligible prompt dispatches a background job and records the attempt', async () => {
  const h = hookDeps();
  const res = await hook.run('UserPromptSubmit', prompt('Migra as faturas para a V10 e valida os testes'), h.deps);
  assert.equal(res.action, 'dispatched');
  assert.deepEqual(h.dispatched, [{ sessionId: 'thr1', cwd: 'D:/repos/arcva-2.0', project: 'arcva-2.0', prompt: 'Migra as faturas para a V10 e valida os testes' }]);
  const st = readState(h.dir, 'thr1');
  assert.equal(st.stage, 'pending');
  assert.equal(st.attempts, 1);
});

test('hook: state lives under $CODEX_HOME/session-namer, not ~/.claude', () => {
  assert.equal(hook.codexHome({ CODEX_HOME: 'Z:/cx' }), 'Z:/cx');
  assert.equal(hook.codexHome({ HOME: '/home/u' }), path.join('/home/u', '.codex'));
});

test('hook: skips trivial prompts, nested calls, disabled config and bad ids', async () => {
  const h = hookDeps();
  assert.equal((await hook.run('UserPromptSubmit', prompt('ok'), h.deps)).action, 'none');
  assert.equal((await hook.run('UserPromptSubmit', prompt('/status please now'), h.deps)).action, 'none');
  assert.equal((await hook.run('UserPromptSubmit', prompt('Fix the login redirect loop', { session_id: '../evil' }), h.deps)).action, 'none');
  const nested = hookDeps({ env: { SESSION_NAMER_NESTED: '1' } });
  assert.equal((await hook.run('UserPromptSubmit', prompt('Fix the login redirect loop'), nested.deps)).why, 'nested');
  const off = hookDeps({ env: { CLAUDE_SESSION_NAMER: 'off' } });
  assert.equal((await hook.run('UserPromptSubmit', prompt('Fix the login redirect loop'), off.deps)).why, 'disabled');
  assert.equal(h.dispatched.length + nested.dispatched.length + off.dispatched.length, 0);
});

test('hook: codex exec sessions are skipped unless name_headless is on', async () => {
  const h = hookDeps({ meta: { source: 'exec', originator: 'codex_exec' } });
  assert.equal((await hook.run('UserPromptSubmit', prompt('Fix the login redirect loop'), h.deps)).why, 'headless');
  assert.equal(readState(h.dir, 'thr1').stage, 'skip');
  assert.equal(h.dispatched.length, 0);
  const on = hookDeps({ meta: { source: 'exec' }, env: { SESSION_NAMER_NAME_HEADLESS: '1' } });
  assert.equal((await hook.run('UserPromptSubmit', prompt('Fix the login redirect loop'), on.deps)).action, 'dispatched');
});

test('hook: final/user stages, max attempts and the retry interval stop dispatching', async () => {
  for (const stage of ['final', 'user', 'skip']) {
    const h = hookDeps();
    writeState(h.dir, 'thr1', { v: hook.STATE_VERSION, stage });
    assert.equal((await hook.run('UserPromptSubmit', prompt('Fix the login redirect loop'), h.deps)).action, 'none', stage);
  }
  const maxed = hookDeps();
  writeState(maxed.dir, 'thr1', { v: hook.STATE_VERSION, stage: 'provisional', attempts: hook.MAX_ATTEMPTS });
  assert.equal((await hook.run('UserPromptSubmit', prompt('Fix the login redirect loop'), maxed.deps)).why, 'max attempts');
  const recent = hookDeps();
  writeState(recent.dir, 'thr1', { v: hook.STATE_VERSION, stage: 'provisional', attempts: 1, lastAttemptTs: 1_700_000_000_000 - 1000 });
  assert.equal((await hook.run('UserPromptSubmit', prompt('Fix the login redirect loop'), recent.deps)).why, 'retry interval');
});

test('hook: SessionStart never dispatches', async () => {
  const h = hookDeps();
  const res = await hook.run('SessionStart', { session_id: 'thr1', cwd: 'D:/r', source: 'startup' }, h.deps);
  assert.equal(res.action, 'none');
  assert.equal(h.dispatched.length, 0);
});

test('readSessionMeta reads source/originator from the rollout head', () => {
  const dir = tmp();
  const file = path.join(dir, 'rollout.jsonl');
  fs.writeFileSync(file, `${JSON.stringify({ type: 'session_meta', payload: { id: 't', originator: 'codex_exec', source: 'exec', base_instructions: { text: 'x'.repeat(20000) } } })}\n{"type":"event_msg"}\n`);
  const meta = hook.readSessionMeta(file);
  assert.deepEqual(meta, { source: 'exec', originator: 'codex_exec' });
  assert.equal(hook.isHeadlessMeta(meta), true);
  assert.equal(hook.readSessionMeta(path.join(dir, 'missing.jsonl')), null);
  assert.equal(hook.isHeadlessMeta({ source: 'cli', originator: 'codex_cli_rs' }), false);
});

// ---------------------------------------------------------------- worker

/** Worker deps with an in-memory thread and a scripted app server. */
function workerDeps({ thread = { name: null, source: 'cli', ephemeral: false, parentThreadId: null }, topic = 'Migração de faturas para V10', claudeTopic = 'Tópico via Claude agora', env = {}, renameBeforeSet = null, mode = 'stdio' } = {}) {
  const home = tmp();
  const calls = { reads: 0, sets: [], generate: [], claude: [] };
  const live = { ...thread };
  const request = async (method, params) => {
    if (method === 'thread/read') {
      calls.reads += 1;
      if (calls.reads === 2 && renameBeforeSet) live.name = renameBeforeSet;
      return { thread: { id: params.threadId, ...live } };
    }
    if (method === 'thread/name/set') { calls.sets.push(params); live.name = params.name; return {}; }
    throw new Error(`unexpected ${method}`);
  };
  return {
    home, calls, live,
    dir: path.join(home, 'session-namer'),
    deps: {
      env: { CODEX_HOME: home, ...env },
      git: () => null,
      now: () => 1_700_000_000_000,
      codex: { command: 'codex', args: [] },
      callAppServer: async ({ script }) => {
        try { return { ok: true, value: await script(request, { mode }), mode }; } catch (err) { return { ok: false, error: err.message }; }
      },
      generateCodex: async (opts) => { calls.generate.push(opts); return topic; },
      generateClaude: async (opts) => { calls.claude.push(opts); return claudeTopic; },
    },
  };
}
const job = { sessionId: 'thr1', cwd: 'D:/repos/arcva-2.0', project: 'arcva-2.0', prompt: 'Migra as faturas para a V10' };

test('worker: names an unnamed thread "<project> - <topic>"', async () => {
  const w = workerDeps({ claudeTopic: 'Migração de faturas para V10' });
  const res = await hook.worker(job, w.deps);
  assert.deepEqual(res, { ok: true, title: 'arcva-2.0 - Migração de faturas para V10' });
  assert.deepEqual(w.calls.sets, [{ threadId: 'thr1', name: 'arcva-2.0 - Migração de faturas para V10' }]);
  const st = readState(w.dir, 'thr1');
  assert.equal(st.stage, 'final');
  assert.equal(st.title, 'arcva-2.0 - Migração de faturas para V10');
  assert.equal(w.calls.generate.length, 0, 'codex exec is opt-in, not the default');
  assert.equal(w.calls.claude.length, 1, 'claude -p (no tools) is the default');
});

test('worker: never overwrites a name it did not set', async () => {
  const w = workerDeps({ thread: { name: 'My own name', source: 'cli' } });
  const res = await hook.worker(job, w.deps);
  assert.equal(res.why, 'user');
  assert.equal(w.calls.generate.length, 0, 'no model call wasted');
  assert.equal(w.calls.sets.length, 0);
  assert.equal(readState(w.dir, 'thr1').stage, 'user');
});

test('worker: a rename during generation wins over our title', async () => {
  const w = workerDeps({ renameBeforeSet: 'Renamed meanwhile' });
  const res = await hook.worker(job, w.deps);
  assert.equal(res.why, 'user');
  assert.equal(w.calls.sets.length, 0);
  assert.equal(w.live.name, 'Renamed meanwhile');
});

test('worker: exec, ephemeral and sub-agent threads are refused', async () => {
  for (const thread of [{ source: 'exec' }, { ephemeral: true }, { parentThreadId: 'p' }, { source: { subAgent: 'review' } }]) {
    const w = workerDeps({ thread });
    const res = await hook.worker(job, w.deps);
    assert.equal(res.ok, false, JSON.stringify(thread));
    assert.equal(w.calls.sets.length, 0);
    assert.equal(w.calls.generate.length, 0);
  }
  assert.equal(hook.refusal({ source: 'exec', name: null }, {}, { nameHeadless: true }), null);
});

test('worker: generation failure leaves the thread unnamed and retryable', async () => {
  const w = workerDeps({ topic: '   ', claudeTopic: '   ' });
  const res = await hook.worker(job, w.deps);
  assert.equal(res.why, 'generation failed');
  assert.equal(w.calls.sets.length, 0);
  assert.equal(readState(w.dir, 'thr1').stage, 'provisional');
});

test('worker: SESSION_NAMER_CODEX_GENERATOR=codex opts in to codex exec; auto = claude, then codex', async () => {
  const w = workerDeps({ env: { SESSION_NAMER_CODEX_GENERATOR: 'codex', SESSION_NAMER_CODEX_MODEL: 'gpt-x' } });
  const res = await hook.worker(job, w.deps);
  assert.equal(res.title, 'arcva-2.0 - Migração de faturas para V10');
  assert.equal(w.calls.generate[0].model, 'gpt-x');
  assert.equal(w.calls.claude.length, 0);
  const auto = workerDeps({ env: { SESSION_NAMER_CODEX_GENERATOR: 'auto' } });
  auto.deps.generateClaude = async (opts) => { auto.calls.claude.push(opts); return null; };
  const r2 = await hook.worker(job, auto.deps);
  assert.equal(r2.title, 'arcva-2.0 - Migração de faturas para V10');
  assert.equal(auto.calls.claude.length, 1);
  assert.equal(auto.calls.generate.length, 1);
  const only = workerDeps({ env: { SESSION_NAMER_CODEX_GENERATOR: 'claude' } });
  await hook.worker(job, only.deps);
  assert.equal(only.calls.generate.length, 0);
  assert.equal(only.calls.claude.length, 1);
});

// Codex 0.163+ TUIs title a new thread themselves ~2 s after the first prompt
// unless it already has a name; the claim is how we get there first.
const inDaemon = { name: null, source: 'vscode', ephemeral: false, parentThreadId: null, status: { type: 'idle' } };

test('worker: a thread running in the daemon is claimed with "<project>" first, then named', async () => {
  const w = workerDeps({ thread: inDaemon, mode: 'proxy', claudeTopic: 'Migração de faturas para V10' });
  const res = await hook.worker(job, w.deps);
  assert.deepEqual(res, { ok: true, title: 'arcva-2.0 - Migração de faturas para V10' });
  assert.deepEqual(w.calls.sets.map((s) => s.name), ['arcva-2.0', 'arcva-2.0 - Migração de faturas para V10']);
  assert.equal(readState(w.dir, 'thr1').stage, 'final');
});

test('worker: once claimed, Codex\'s own title can no longer land (it only titles unnamed threads)', async () => {
  const w = workerDeps({ thread: inDaemon, mode: 'proxy' });
  let codexTitleApplied = false;
  w.deps.generateClaude = async () => {
    // What the TUI does when its own title is ready: thread/read, set only if unnamed.
    if (!w.live.name) { w.live.name = 'Explain regex basics'; codexTitleApplied = true; }
    return 'Regex in one sentence';
  };
  const res = await hook.worker(job, w.deps);
  assert.equal(codexTitleApplied, false);
  assert.equal(res.title, 'arcva-2.0 - Regex in one sentence');
});

test('worker: no claim on the private server or for a thread the daemon does not run', async () => {
  for (const [thread, mode] of [[inDaemon, 'stdio'], [{ ...inDaemon, status: { type: 'notLoaded' } }, 'proxy'], [{ ...inDaemon, status: undefined }, 'proxy']]) {
    const w = workerDeps({ thread, mode });
    const res = await hook.worker(job, w.deps);
    assert.equal(res.ok, true);
    assert.equal(w.calls.sets.length, 1, `${mode} ${JSON.stringify(thread.status)}`);
  }
  assert.equal(hook.shouldClaim({ ...inDaemon, loaded: true, name: 'x' }, { mode: 'proxy' }, {}), false, 'never over a name');
  assert.equal(hook.shouldClaim({ ...inDaemon, loaded: true }, { mode: 'proxy' }, { title: 'arcva-2.0' }), false, 'claimed already');
});

test('worker: a claimed thread whose topic failed keeps "<project>" and is named on a later attempt', async () => {
  const w = workerDeps({ thread: inDaemon, mode: 'proxy', claudeTopic: '  ' });
  assert.equal((await hook.worker(job, w.deps)).why, 'generation failed');
  const st = readState(w.dir, 'thr1');
  assert.deepEqual([st.stage, st.title, w.live.name], ['provisional', 'arcva-2.0', 'arcva-2.0']);
  w.deps.generateClaude = async () => 'Segunda tentativa ok';
  const res = await hook.worker(job, w.deps);
  assert.equal(res.title, 'arcva-2.0 - Segunda tentativa ok');
});

test('worker: a name that beat the claim (Codex or /rename) still wins', async () => {
  const w = workerDeps({ thread: { ...inDaemon, name: 'Explain regex basics' }, mode: 'proxy' });
  assert.equal((await hook.worker(job, w.deps)).why, 'user');
  assert.equal(w.calls.sets.length, 0);
});

test('worker: our own earlier title is not mistaken for a user name', async () => {
  const w = workerDeps({ thread: { name: 'arcva-2.0 - Old topic', source: 'cli' } });
  writeState(w.dir, 'thr1', { v: hook.STATE_VERSION, stage: 'pending', title: 'arcva-2.0 - Old topic', attempts: 1 });
  const res = await hook.worker(job, w.deps);
  assert.equal(res.ok, true);
});
