'use strict';
/**
 * Minimal JSON-RPC client for the Codex app server. EXPERIMENTAL: the
 * app-server protocol is marked experimental by OpenAI and may change between
 * Codex releases.
 *
 * Transport order:
 *   1. `codex app-server proxy`  -> the shared local daemon, when it runs
 *      (`codex app-server daemon start`). The proxy pipes raw bytes to the
 *      daemon's control socket, which speaks WebSocket (GET /rpc, one JSON-RPC
 *      message per text frame), so this mode does the WebSocket handshake and
 *      framing itself. Clients attached to the daemon (TUI, IDE) receive
 *      `thread/name/updated` live and redraw.
 *   2. `codex app-server`        -> a short-lived private server,
 *      newline-delimited JSON over stdio. The name is persisted to $CODEX_HOME,
 *      but a TUI that is already open (it runs its own embedded server) keeps
 *      showing its old name until the thread is opened again.
 *
 * Every failure resolves (never rejects) so the hook can never break a session.
 */
const childProcess = require('node:child_process');
const crypto = require('node:crypto');
const { killTree } = require('./generate');

const CLIENT_INFO = { name: 'session-namer', title: 'session-namer', version: '1' };

// ------------------------------------------------------------ WebSocket (RFC 6455), client side

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const WS_PATH = '/rpc'; // what Codex's own client sends over the control socket

const wsHandshake = (key) => `GET ${WS_PATH} HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\n`
  + `Connection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`;
const wsAccept = (key) => crypto.createHash('sha1').update(key + WS_GUID).digest('base64');

/** One masked client frame (clients must mask). opcode 1 = text, 9 = ping, 10 = pong, 8 = close. */
function encodeFrame(payload, opcode = 1, mask = crypto.randomBytes(4)) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
  let head;
  if (data.length < 126) {
    head = Buffer.from([0x80 | opcode, 0x80 | data.length]);
  } else if (data.length < 65536) {
    head = Buffer.alloc(4);
    head[0] = 0x80 | opcode; head[1] = 0x80 | 126; head.writeUInt16BE(data.length, 2);
  } else {
    head = Buffer.alloc(10);
    head[0] = 0x80 | opcode; head[1] = 0x80 | 127; head.writeBigUInt64BE(BigInt(data.length), 2);
  }
  const body = Buffer.alloc(data.length);
  for (let i = 0; i < data.length; i += 1) body[i] = data[i] ^ mask[i % 4];
  return Buffer.concat([head, mask, body]);
}

/**
 * Incremental frame decoder. push(bytes) returns complete messages:
 * { opcode: 1|2 (text/binary, continuation frames joined) | 8 | 9 | 10, payload: Buffer }.
 */
function createFrameDecoder() {
  let buf = Buffer.alloc(0);
  let fragments = null; // { opcode, parts }
  return {
    push(chunk) {
      buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
      const out = [];
      for (;;) {
        if (buf.length < 2) break;
        const fin = (buf[0] & 0x80) !== 0;
        const opcode = buf[0] & 0x0f;
        const masked = (buf[1] & 0x80) !== 0;
        let len = buf[1] & 0x7f;
        let off = 2;
        if (len === 126) { if (buf.length < 4) break; len = buf.readUInt16BE(2); off = 4; }
        else if (len === 127) { if (buf.length < 10) break; len = Number(buf.readBigUInt64BE(2)); off = 10; }
        const maskKey = masked ? buf.slice(off, off + 4) : null;
        if (masked) off += 4;
        if (buf.length < off + len) break;
        let payload = buf.slice(off, off + len);
        buf = buf.slice(off + len);
        if (maskKey) payload = Buffer.from(payload.map((b, i) => b ^ maskKey[i % 4]));
        if (opcode >= 8) { out.push({ opcode, payload }); continue; } // control frames are never fragmented
        if (opcode !== 0) fragments = { opcode, parts: [payload] };
        else if (fragments) fragments.parts.push(payload);
        else continue; // stray continuation
        if (fin) { out.push({ opcode: fragments.opcode, payload: Buffer.concat(fragments.parts) }); fragments = null; }
      }
      return out;
    },
  };
}

/**
 * Message codec for one transport: `send(obj)` frames a JSON-RPC message,
 * `receive(chunk)` returns { messages, error? }. stdio = newline JSON;
 * proxy = WebSocket handshake first, then frames (queued until upgraded).
 */
function createCodec(mode, write) {
  if (mode !== 'proxy') {
    let buf = '';
    return {
      start() {},
      send(obj) { write(`${JSON.stringify(obj)}\n`); },
      receive(chunk) {
        buf += chunk.toString('utf8');
        const messages = [];
        let idx;
        while ((idx = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 1);
          if (line) messages.push(line);
        }
        return { messages };
      },
    };
  }
  const key = crypto.randomBytes(16).toString('base64');
  let head = Buffer.alloc(0);
  let upgraded = false;
  const queue = [];
  const decoder = createFrameDecoder();
  return {
    start() { write(wsHandshake(key)); },
    send(obj) {
      const frame = encodeFrame(JSON.stringify(obj));
      if (upgraded) write(frame); else queue.push(frame);
    },
    receive(chunk) {
      let rest = chunk;
      if (!upgraded) {
        head = Buffer.concat([head, chunk]);
        const end = head.indexOf('\r\n\r\n');
        if (end < 0) {
          return head.length > 8192 || (head.length >= 12 && !/^HTTP\/1\.1 /.test(head.toString('latin1')))
            ? { messages: [], error: 'websocket handshake failed' } : { messages: [] };
        }
        const response = head.slice(0, end).toString('latin1');
        const accept = (response.match(/^sec-websocket-accept:\s*(\S+)/im) || [])[1];
        if (!/^HTTP\/1\.1 101\b/.test(response) || accept !== wsAccept(key)) {
          return { messages: [], error: `websocket handshake failed: ${response.split('\r\n')[0].slice(0, 80)}` };
        }
        upgraded = true;
        rest = head.slice(end + 4);
        for (const frame of queue.splice(0)) write(frame);
      }
      const messages = [];
      for (const { opcode, payload } of decoder.push(rest)) {
        if (opcode === 1) messages.push(payload.toString('utf8'));
        else if (opcode === 9) write(encodeFrame(payload, 10));
        else if (opcode === 8) return { messages, error: 'websocket closed by server' };
      }
      return { messages };
    },
  };
}

/**
 * Open one app-server connection, run `script(request, {mode})` and close it.
 * @param {{codex:{command:string,args:string[]}, mode:'proxy'|'stdio',
 *          script:(request:Function, conn:{mode:string})=>Promise<any>,
 *          timeoutMs?:number, env?:object, spawn?:Function, platform?:string}} opts
 * @returns {Promise<{ok:boolean, value?:any, error?:string}>}
 */
function withAppServer({
  codex, mode, script, timeoutMs = 8000, env = process.env, spawn = childProcess.spawn, platform = process.platform,
}) {
  return new Promise((resolve) => {
    let settled = false;
    let child;
    let timer;
    const pending = new Map();
    let nextId = 0;
    const finish = (res) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      for (const p of pending.values()) p({ error: { message: 'connection closed' } });
      pending.clear();
      try { child.stdin.end(); } catch { /* gone */ }
      if (child) killTree(child, platform);
      resolve(res);
    };
    try {
      const sub = mode === 'proxy' ? ['app-server', 'proxy'] : ['app-server'];
      child = spawn(codex.command, [...codex.args, ...sub], {
        env: { ...env, SESSION_NAMER_NESTED: '1' },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (err) {
      resolve({ ok: false, error: `spawn threw: ${err && err.message}` });
      return;
    }
    timer = setTimeout(() => finish({ ok: false, error: `timeout ${timeoutMs} ms (${mode})` }), timeoutMs);
    const errOut = [];
    const codec = createCodec(mode, (bytes) => { try { child.stdin.write(bytes); } catch { /* closed */ } });
    child.stdout.on('data', (d) => {
      const { messages, error } = codec.receive(Buffer.isBuffer(d) ? d : Buffer.from(String(d), 'utf8'));
      for (const text of messages) {
        let msg;
        try { msg = JSON.parse(text); } catch { continue; }
        if (msg && msg.id !== undefined && msg.method === undefined && pending.has(msg.id)) {
          const cb = pending.get(msg.id);
          pending.delete(msg.id);
          cb(msg);
        }
      }
      if (error) finish({ ok: false, error: `${mode}: ${error}` });
    });
    child.stderr.on('data', (d) => { if (errOut.length < 20) errOut.push(String(d)); });
    child.on('error', (err) => finish({ ok: false, error: `spawn error: ${err && err.message}` }));
    child.on('close', (code) => finish({ ok: false, error: `${mode} exited ${code}: ${errOut.join('').trim().slice(0, 200)}` }));
    try { child.stdin.on('error', () => {}); } catch { /* ignore */ }

    const write = (msg) => codec.send(msg);
    const request = (method, params) => new Promise((res, rej) => {
      if (settled) { rej(new Error('closed')); return; }
      nextId += 1;
      const id = nextId;
      pending.set(id, (msg) => (msg.error ? rej(new Error(`${method}: ${msg.error.message || JSON.stringify(msg.error)}`)) : res(msg.result)));
      write({ id, method, params });
    });

    codec.start();
    (async () => {
      try {
        await request('initialize', { clientInfo: CLIENT_INFO });
        write({ method: 'initialized' });
        const value = await script(request, { mode });
        finish({ ok: true, value });
      } catch (err) {
        finish({ ok: false, error: String(err && err.message) });
      }
    })();
  });
}

/**
 * Run `script` against the daemon if reachable, else a private stdio server.
 * @returns {Promise<{ok:boolean, value?:any, error?:string, mode?:string}>}
 */
async function callAppServer(opts) {
  const log = opts.log || (() => {});
  const modes = opts.modes || ['proxy', 'stdio'];
  let last = { ok: false, error: 'no transport' };
  for (const mode of modes) {
    // eslint-disable-next-line no-await-in-loop
    const res = await withAppServer({ ...opts, mode });
    if (res.ok) return { ...res, mode };
    log(`app-server ${mode}: ${res.error}`);
    last = { ...res, mode };
  }
  return last;
}

/**
 * thread/read without turns: { name, source, ephemeral, parentThreadId, loaded } or null.
 * `loaded` is true when the server answering runs the thread now (status other
 * than notLoaded), null when the server did not say.
 */
async function readThread(request, threadId) {
  const res = await request('thread/read', { threadId, includeTurns: false });
  const t = res && res.thread;
  if (!t || typeof t !== 'object') return null;
  const status = t.status && typeof t.status === 'object' ? t.status.type : t.status;
  return {
    name: typeof t.name === 'string' ? t.name : null,
    source: t.source === undefined ? null : t.source,
    ephemeral: t.ephemeral === true,
    parentThreadId: t.parentThreadId || null,
    loaded: typeof status === 'string' ? status !== 'notLoaded' : null,
  };
}

const setThreadName = (request, threadId, name) => request('thread/name/set', { threadId, name });

module.exports = {
  withAppServer, callAppServer, readThread, setThreadName, CLIENT_INFO,
  encodeFrame, createFrameDecoder, wsAccept, WS_PATH,
};
