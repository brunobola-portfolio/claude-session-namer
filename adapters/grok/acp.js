'use strict';
/**
 * Minimal ACP (JSON-RPC over stdio) client for Grok Build's session rename.
 *
 *   grok agent --no-leader stdio
 *     -> initialize
 *     -> _x.ai/session/rename { sessionId, title }   => { success: true }
 *
 * `_x.ai/session/rename` is a Grok ACP extension method (ACP reserves the
 * leading underscore for extensions; Grok documents its `x.ai/` methods as
 * discoverable and non-exhaustive). It needs no model login, validates the
 * title ("title must not be blank") and the session ("session not found"),
 * and records the title as manual, so Grok's own auto-titling then leaves it.
 *
 * Notifications from the agent are ignored and never logged: they can carry
 * MCP server configuration, including secrets from other tools' configs.
 */
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const RENAME_METHOD = '_x.ai/session/rename';

/** Grok executable: $SESSION_NAMER_GROK_PATH, ~/.grok/bin/grok(.exe), then PATH. */
function findGrok(env = process.env, { platform = process.platform, exists = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } } } = {}) {
  const explicit = env.SESSION_NAMER_GROK_PATH && env.SESSION_NAMER_GROK_PATH.trim();
  if (explicit) return explicit;
  const home = env.USERPROFILE || env.HOME || os.homedir();
  const local = path.join(home, '.grok', 'bin', platform === 'win32' ? 'grok.exe' : 'grok');
  return exists(local) ? local : 'grok';
}

const LIST_METHOD = 'session/list';
const MAX_LIST_PAGES = 5;

/**
 * Rename a session. With `check`, the session is read first in the same
 * connection (ACP `session/list`, filtered by cwd) and `check(listed)` is
 * called with the listed entry ({sessionId, cwd, title, ...}) or null. A
 * non-null return value is a refusal: nothing is renamed and the result is
 * { ok:false, skipped:<reason>, title:<current title> }.
 * @param {{sessionId:string, title:string, cwd?:string, env?:object, grokPath?:string,
 *          spawn?:Function, timeoutMs?:number, check?:Function}} opts
 * @returns {Promise<{ok:boolean, error?:string, skipped?:string, title?:string|null}>}
 */
function renameSession({
  sessionId, title, cwd = process.cwd(), env = process.env, grokPath = findGrok(env), spawn = childProcess.spawn,
  timeoutMs = 30000, check = null,
}) {
  return new Promise((resolve) => {
    let child;
    let settled = false;
    let timer;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.stdin.end(); } catch { /* gone */ }
      try { child.kill(); } catch { /* gone */ }
      resolve(result);
    };
    try {
      child = spawn(grokPath, ['agent', '--no-leader', 'stdio'], { cwd, env, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    } catch (err) {
      resolve({ ok: false, error: `spawn: ${err && err.message}` });
      return;
    }
    timer = setTimeout(() => finish({ ok: false, error: `timeout ${timeoutMs} ms` }), timeoutMs);
    child.on('error', (err) => finish({ ok: false, error: `spawn: ${err && err.message}` }));
    child.on('exit', (code) => finish({ ok: false, error: `agent exited (${code})` }));
    const send = (id, method, params) => {
      try { child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`); } catch { /* handled by exit */ }
    };
    let buf = '';
    let pages = 0;
    const sendRename = () => send(2, RENAME_METHOD, { sessionId, title });
    const decide = (listed) => {
      let why = null;
      try { why = check(listed); } catch (err) { why = `check failed: ${err && err.message}`; }
      if (why) return finish({ ok: false, skipped: why, title: listed && typeof listed.title === 'string' ? listed.title : null });
      sendRename();
      return undefined;
    };
    child.stdout.on('data', (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (!msg || msg.method || msg.id === undefined) continue; // notifications: ignored on purpose
        if (msg.id === 1) {
          if (msg.error) return finish({ ok: false, error: `initialize: ${msg.error.message}` });
          if (typeof check === 'function') {
            pages += 1;
            send(3, LIST_METHOD, { cwd });
          } else sendRename();
        } else if (msg.id === 3) {
          // session/list unavailable: decide without it (check gets null).
          if (msg.error) return decide(null);
          const res = msg.result || {};
          const found = (Array.isArray(res.sessions) ? res.sessions : []).find((s) => s && s.sessionId === sessionId);
          if (found) return decide(found);
          if (res.nextCursor && pages < MAX_LIST_PAGES) {
            pages += 1;
            send(3, LIST_METHOD, { cwd, cursor: res.nextCursor });
          } else return decide(null);
        } else if (msg.id === 2) {
          if (msg.error) return finish({ ok: false, error: `rename: ${msg.error.message}${msg.error.data ? ` (${String(msg.error.data).slice(0, 120)})` : ''}` });
          return finish({ ok: !!(msg.result && msg.result.success), error: msg.result && msg.result.success ? undefined : 'rename: no success flag' });
        }
      }
      return undefined;
    });
    send(1, 'initialize', { protocolVersion: 1, clientCapabilities: {} });
  });
}

module.exports = { renameSession, findGrok, RENAME_METHOD, LIST_METHOD };
