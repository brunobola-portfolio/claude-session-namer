'use strict';
/**
 * OpenCode adapter core: turns OpenCode plugin events into
 * "<project> - <topic>" session titles, reusing the repository lib/.
 *
 * Topic sources (SESSION_NAMER_OPENCODE_TOPIC):
 *   claude  On session creation the title becomes the project name. That
 *           makes OpenCode's own title generator stand down (it only runs
 *           while the title still matches "New session - <ISO date>"). The
 *           first eligible user message is summarised by the headless
 *           `claude -p` call from lib/generate.js, in the background.
 *   native  The title is left alone so OpenCode's own small model names the
 *           session as usual; the first title it produces is prefixed once
 *           with the project name. No extra model call.
 *   auto    (default) `claude` when the Claude Code CLI is found, else `native`.
 *
 * Safety rules:
 *   - at most MAX_WRITES title writes per session, never in reaction to a
 *     title this adapter wrote itself (no session.updated loops);
 *   - a title that is neither OpenCode's default nor the last one written
 *     here is treated as manual and locks the session for good;
 *   - child (subagent) sessions are ignored, as OpenCode itself does;
 *   - SESSION_NAMER_NESTED=1 or a disabled config yields no hooks at all.
 */
const childProcess = require('node:child_process');
const fs = require('node:fs');
const title = require('../../lib/title');
const { generateTopic, findClaude } = require('../../lib/generate');
const { loadConfig } = require('../../lib/config');

/** Mirrors isDefaultTitle() in opencode/src/session/session.ts (v1.19.5). */
const DEFAULT_TITLE_RE = /^(?:New session - |Child session - )\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const MAX_ATTEMPTS = 3;
const RETRY_INTERVAL_MS = 60_000;
const MAX_WRITES = 3;
const SERVICE = 'session-namer';
/** Native mode: OpenCode's own title lands within this long after the first user message. */
const NATIVE_WINDOW_MS = 120_000;
/** OpenCode caps its generated titles at 100 characters. */
const NATIVE_MAX_CHARS = 100;

const isDefaultTitle = (t) => typeof t === 'string' && DEFAULT_TITLE_RE.test(t);
const collapse = (s) => String(s || '').replace(/\s+/g, ' ').trim();

function gitIn(cwd) {
  return (args) => {
    try {
      return childProcess.execFileSync('git', args, {
        cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, timeout: 3000,
      }).trim() || null;
    } catch {
      return null;
    }
  };
}

/** findClaude() falls back to a bare "claude" when nothing was found. */
function claudeFound(env) {
  const found = findClaude(env);
  return !(found.command === 'claude' && found.args.length === 0);
}

function resolveMode(env, hasClaude) {
  const raw = String(env.SESSION_NAMER_OPENCODE_TOPIC || 'auto').trim().toLowerCase();
  if (raw === 'claude' || raw === 'native') return raw;
  return hasClaude() ? 'claude' : 'native';
}

/** Text the user typed, without parts OpenCode injected itself. */
function promptText(parts) {
  if (!Array.isArray(parts)) return '';
  return parts
    .filter((p) => p && p.type === 'text' && !p.synthetic && !p.ignored && typeof p.text === 'string')
    .map((p) => p.text)
    .join('\n')
    .trim();
}

/**
 * @param {{client:object, directory:string, worktree?:string, env?:object,
 *          git?:Function, generate?:Function, hasClaude?:Function, now?:Function,
 *          log?:Function}} opts
 * @returns {object} OpenCode hooks (empty object when disabled)
 */
function createSessionNamer({
  client, directory, worktree = null, env = process.env,
  git = gitIn(directory), generate = generateTopic, hasClaude = () => claudeFound(env),
  now = Date.now, log = null,
}) {
  if (env.SESSION_NAMER_NESTED === '1') return {};
  const cfg = loadConfig({ env, repoRoot: worktree && worktree !== '/' ? worktree : directory });
  if (!cfg.enabled || !client || !client.session) return {};

  const mode = resolveMode(env, hasClaude);
  const project = title.resolveProject({ cwd: directory, projectSource: cfg.projectSource, git, override: cfg.projectOverride });
  const sessions = new Map();
  const logFile = env.SESSION_NAMER_OPENCODE_LOG && String(env.SESSION_NAMER_OPENCODE_LOG).trim();
  // Calling the client while OpenCode is still loading plugins can deadlock
  // its bootstrap (seen live with a global-config install), so client logging
  // only starts once the first event has arrived.
  let clientReady = false;
  const write = log || ((level, message) => {
    if (logFile) {
      try { fs.appendFileSync(logFile, `${new Date(now()).toISOString()} ${level} ${message}\n`); } catch { /* ignore */ }
    }
    if (!clientReady) return;
    try {
      const p = client.app && client.app.log && client.app.log({ body: { service: SERVICE, level, message } });
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } catch { /* logging must never break OpenCode */ }
  });
  const say = (id, msg, level = 'info') => write(level, `${String(id).slice(0, 12)} ${msg}`);

  const stateFor = (id) => {
    let s = sessions.get(id);
    if (!s) {
      s = { known: false, skip: false, locked: false, done: false, lastSet: null, writes: 0, attempts: 0, lastAttempt: 0, inflight: false, sawUser: false, firstUserAt: 0 };
      sessions.set(id, s);
    }
    return s;
  };

  /** Learn title/parent of a session this instance has not seen created (e.g. resumed). */
  async function learn(id, s, info) {
    if (s.known) return;
    let data = info;
    if (!data) {
      try {
        const r = await client.session.get({ path: { id } });
        data = r && r.data;
      } catch { data = null; }
    }
    if (!data) return;
    s.known = true;
    if (data.parentID) { s.skip = true; return; }
    if (typeof data.title === 'string' && !isDefaultTitle(data.title)) {
      // Already titled before we saw it: a manual title, an imported one, or ours from an earlier run.
      s.locked = true;
      say(id, `existing title kept "${data.title}"`);
    }
  }

  /** Re-read the stored title right before overwriting it. */
  async function stillOurs(id, s) {
    let current = null;
    try {
      const r = await client.session.get({ path: { id } });
      current = r && r.data ? r.data.title : null;
    } catch { return false; }
    if (current === s.lastSet || isDefaultTitle(current)) return true;
    s.locked = true;
    say(id, `title changed elsewhere to "${current}", locked`);
    return false;
  }

  async function setTitle(id, s, value) {
    if (s.writes >= MAX_WRITES || s.locked) return false;
    s.writes += 1;
    s.lastSet = value;
    try {
      const r = await client.session.update({ path: { id }, body: { title: value } });
      if (r && r.error) { say(id, `update failed: ${JSON.stringify(r.error).slice(0, 200)}`, 'warn'); return false; }
      if (r && r.data && typeof r.data.title === 'string') s.lastSet = r.data.title;
      say(id, `title "${s.lastSet}"`);
      return true;
    } catch (err) {
      say(id, `update threw: ${err && err.message}`, 'warn');
      return false;
    }
  }

  async function runTopic(id, s, prompt) {
    s.inflight = true;
    s.attempts += 1;
    s.lastAttempt = now();
    try {
      let raw = null;
      try {
        raw = await generate({ prompt, model: cfg.model, timeoutMs: cfg.timeoutMs, env, log: (m) => say(id, `generate: ${m}`, 'debug') });
      } catch (err) {
        say(id, `generate threw: ${err && err.message}`, 'warn');
      }
      const topic = title.sanitizeTopic(raw, { maxWords: cfg.maxWords });
      if (!topic) {
        say(id, `no usable topic (attempt ${s.attempts}): ${JSON.stringify(String(raw ?? '').slice(0, 80))}`, 'warn');
        return;
      }
      if (s.locked || s.done || !(await stillOurs(id, s))) return;
      if (await setTitle(id, s, title.formatTitle(project, topic, { separator: cfg.separator }))) s.done = true;
    } finally {
      s.inflight = false;
    }
  }

  async function onCreated(info) {
    if (!info || !info.id) return;
    const s = stateFor(info.id);
    if (s.known) return;
    await learn(info.id, s, info);
    if (s.skip || s.locked || mode !== 'claude') return;
    if (!s.lastSet) await setTitle(info.id, s, project);
  }

  /**
   * Native mode: does this first non-default title look like OpenCode's own?
   * Its generator runs once, right after the first user message, and writes
   * one line of at most NATIVE_MAX_CHARS. A title arriving later, or longer,
   * is a rename by the user and is never prefixed.
   * Residual risk: a rename typed within NATIVE_WINDOW_MS of the first
   * message, before OpenCode's own title lands, cannot be told apart and is
   * prefixed once (the user can rename again; that one is kept).
   */
  function looksNative(s, t) {
    if (!s.firstUserAt || now() - s.firstUserAt > NATIVE_WINDOW_MS) return false;
    return t.length <= NATIVE_MAX_CHARS && !/[\r\n]/.test(t);
  }

  async function onUpdated(info) {
    if (!info || !info.id || typeof info.title !== 'string') return;
    const s = stateFor(info.id);
    if (!s.known) await learn(info.id, s, info);
    if (s.skip || s.locked) return;
    const t = info.title;
    if (t === s.lastSet || isDefaultTitle(t)) return; // our own write, or nothing yet
    if (mode === 'native' && !s.done && s.sawUser && looksNative(s, t)) {
      // OpenCode's own generator just named the session: prefix it once.
      s.done = true;
      const prefix = `${project}${cfg.separator}`;
      if (t.startsWith(prefix)) { s.lastSet = t; return; }
      await setTitle(info.id, s, title.formatTitle(project, collapse(t), { separator: cfg.separator }));
      return;
    }
    s.locked = true;
    say(info.id, `manual title "${t}", locked`);
  }

  async function onMessage(input, output) {
    const id = input && input.sessionID;
    if (!id) return;
    const s = stateFor(id);
    await learn(id, s, null);
    if (!s.sawUser) s.firstUserAt = now();
    s.sawUser = true;
    if (s.skip || s.locked || s.done || mode !== 'claude') return;
    // Awaited on purpose: OpenCode re-reads the session after this hook and
    // only auto-titles while the title is still the default one.
    if (!s.lastSet) {
      if (!(await stillOurs(id, s))) return;
      await setTitle(id, s, project);
    }
    const prompt = promptText(output && output.parts);
    if (!title.isEligiblePrompt(prompt)) return;
    if (s.inflight || s.attempts >= MAX_ATTEMPTS) return;
    if (s.lastAttempt && now() - s.lastAttempt < RETRY_INTERVAL_MS) return;
    // Fire and forget: the model call must never delay the user's turn.
    s.pending = runTopic(id, s, prompt).catch(() => {});
  }

  const guard = (fn) => async (...args) => {
    try { await fn(...args); } catch (err) { write('warn', `hook error: ${err && err.message}`); }
  };

  write('info', `ready: project "${project}", topic source ${mode}`);

  const hooks = {
    event: guard(async ({ event }) => {
      clientReady = true;
      if (!event || !event.type) return;
      const props = event.properties || {};
      if (event.type === 'session.created') return onCreated(props.info);
      if (event.type === 'session.updated') return onUpdated(props.info);
      if (event.type === 'session.deleted') {
        const id = (props.info && props.info.id) || props.sessionID;
        if (id) sessions.delete(id);
      }
      return undefined;
    }),
    'chat.message': guard(onMessage),
  };
  // Per-session state for tests; non-enumerable so OpenCode never sees it as a hook.
  Object.defineProperty(hooks, '_sessions', { value: sessions, enumerable: false });
  return hooks;
}

module.exports = { createSessionNamer, isDefaultTitle, promptText, resolveMode, DEFAULT_TITLE_RE, NATIVE_WINDOW_MS, NATIVE_MAX_CHARS };
