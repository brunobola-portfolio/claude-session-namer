'use strict';
/**
 * Minimal JSON-RPC client for the Codex app server (`codex app-server`,
 * newline-delimited JSON over stdio). EXPERIMENTAL: the app-server protocol
 * is marked experimental by OpenAI and may change between Codex releases.
 *
 * Transport order:
 *   1. `codex app-server proxy`  -> the shared local daemon, when it runs.
 *      Clients attached to the daemon (TUI, IDE) receive
 *      `thread/name/updated` live.
 *   2. `codex app-server`        -> a short-lived private server. The name is
 *      persisted to $CODEX_HOME (session index), but already-open clients may
 *      only show it after they reload the thread list.
 *
 * Every failure resolves (never rejects) so the hook can never break a session.
 */
const childProcess = require('node:child_process');
const { killTree } = require('./generate');

const CLIENT_INFO = { name: 'session-namer', title: 'session-namer', version: '1' };

/**
 * Open one app-server connection, run `script(request)` and close it.
 * @param {{codex:{command:string,args:string[]}, mode:'proxy'|'stdio', script:(request:Function)=>Promise<any>,
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
    let buf = '';
    const errOut = [];
    child.stdout.on('data', (d) => {
      buf += d.toString('utf8');
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg && msg.id !== undefined && msg.method === undefined && pending.has(msg.id)) {
          const cb = pending.get(msg.id);
          pending.delete(msg.id);
          cb(msg);
        }
      }
    });
    child.stderr.on('data', (d) => { if (errOut.length < 20) errOut.push(String(d)); });
    child.on('error', (err) => finish({ ok: false, error: `spawn error: ${err && err.message}` }));
    child.on('close', (code) => finish({ ok: false, error: `${mode} exited ${code}: ${errOut.join('').trim().slice(0, 200)}` }));
    try { child.stdin.on('error', () => {}); } catch { /* ignore */ }

    const write = (msg) => { try { child.stdin.write(`${JSON.stringify(msg)}\n`); } catch { /* closed */ } };
    const request = (method, params) => new Promise((res, rej) => {
      if (settled) { rej(new Error('closed')); return; }
      nextId += 1;
      const id = nextId;
      pending.set(id, (msg) => (msg.error ? rej(new Error(`${method}: ${msg.error.message || JSON.stringify(msg.error)}`)) : res(msg.result)));
      write({ id, method, params });
    });

    (async () => {
      try {
        await request('initialize', { clientInfo: CLIENT_INFO });
        write({ method: 'initialized' });
        const value = await script(request);
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

/** thread/read without turns: { name, source, ephemeral, parentThreadId } or null. */
async function readThread(request, threadId) {
  const res = await request('thread/read', { threadId, includeTurns: false });
  const t = res && res.thread;
  if (!t || typeof t !== 'object') return null;
  return {
    name: typeof t.name === 'string' ? t.name : null,
    source: t.source === undefined ? null : t.source,
    ephemeral: t.ephemeral === true,
    parentThreadId: t.parentThreadId || null,
  };
}

const setThreadName = (request, threadId, name) => request('thread/name/set', { threadId, name });

module.exports = { withAppServer, callAppServer, readThread, setThreadName, CLIENT_INFO };
