'use strict';
/**
 * Amp adapter core (CommonJS, Bun- and Node-compatible): turns Amp plugin
 * events into "<project> - <topic>" thread titles, reusing the repository lib/.
 *
 * Amp's plugin API exposes the thread title read-only
 * (`ctx.thread.title.get()`), so the title is written with Amp's documented
 * CLI command `amp threads rename <thread> <title>` ("Rename replaces the
 * title the agent chose", https://ampcode.com/docs/threads).
 *
 * Flow per thread (state lives in memory for the plugin process lifetime):
 *   agent.start  first eligible prompt of a thread whose title is still unset
 *                (or still the agent's own auto-title) -> generate the topic in
 *                the background with lib/generate.js (`claude -p`), then rename.
 *                The handler returns immediately; the turn is never delayed.
 *   agent.end    if Amp's own auto-title replaced ours shortly after we wrote
 *                it, re-assert once (REASSERT_WINDOW_MS).
 *   any title we did not write and that is not the agent's auto-title means
 *   the user renamed the thread: hands off for good.
 */
const childProcess = require('node:child_process');
const path = require('node:path');
const title = require('../../lib/title');
const { generateTopic } = require('../../lib/generate');
const { loadConfig } = require('../../lib/config');
const safeSpawn = require('../_shared/safe-spawn');

const MAX_ATTEMPTS = 3;
const RETRY_INTERVAL_MS = 60_000;
const REASSERT_WINDOW_MS = 120_000;
const RENAME_TIMEOUT_MS = 20_000;
/** Threads remembered per plugin process; the oldest idle ones are dropped first. */
const MAX_THREADS = 200;

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

const isNodeLike = (p) => /^(node|bun)(\.exe)?$/i.test(path.basename(String(p || '')));

/**
 * The Amp CLI as a shell-free { command, args }, or null when only cmd.exe
 * could run it. Order: SESSION_NAMER_AMP_PATH, the running amp executable,
 * then PATH (`amp.exe`, or the npm `amp.cmd` shim resolved to its target).
 * Titles must never pass through cmd.exe: it expands %VAR% and treats `&`
 * and `"` as syntax inside arguments, so a folder name or a model answer
 * could run commands.
 */
function resolveAmp(env = process.env, execPath = process.execPath, { platform = process.platform, exists, read } = {}) {
  const nodePath = isNodeLike(execPath) ? execPath : 'node';
  const opts = { platform, nodePath, ...(exists ? { exists } : {}), ...(read ? { read } : {}) };
  const explicit = env.SESSION_NAMER_AMP_PATH && env.SESSION_NAMER_AMP_PATH.trim();
  if (explicit) return safeSpawn.toCommand(explicit, opts);
  const base = path.basename(String(execPath || '')).toLowerCase();
  if (base === 'amp' || base === 'amp.exe') return { command: execPath, args: [] };
  return safeSpawn.findOnPath('amp', env, opts) || (platform === 'win32' ? null : { command: 'amp', args: [] });
}

/** Colour escapes: Amp paints "Error: " red when colour is forced (FORCE_COLOR). */
const ANSI_RE = /\x1b\[[0-9;]*[A-Za-z]/g;

/**
 * `amp threads rename <id> <title>`, argv only, never a shell. Resolves {ok, detail}.
 * Amp 0.0.1793736138: success prints `✓ Thread <url> renamed to "<title>"` and exits 0.
 * Every failure exits 1: `Error: ...` on stderr (not logged in: `Error: Failed to rename
 * thread: API request for getThreadTail failed: 401`), or, for an unknown thread,
 * `Thread <url> does not exist.` with no prefix. The text check is a guard only.
 */
function defaultRename({ amp, threadId, newTitle, run = safeSpawn.runCommand, env = process.env }) {
  if (!amp || !amp.command || safeSpawn.isShim(amp.command)) {
    return Promise.resolve({ ok: false, detail: 'no shell-free amp executable found (set SESSION_NAMER_AMP_PATH to amp.exe)' });
  }
  return run(amp, ['threads', 'rename', threadId, newTitle], {
    timeoutMs: RENAME_TIMEOUT_MS, env: { ...env, SESSION_NAMER_NESTED: '1' },
  }).then((r) => {
    const text = `${r.stdout || ''}${r.stderr || ''}`.replace(ANSI_RE, '').trim();
    if (r.code !== 0 || r.timedOut || /^error\b/im.test(text)) {
      return { ok: false, detail: (text || (r.timedOut ? 'timeout' : `exit ${r.code}`)).slice(0, 200) };
    }
    return { ok: true, detail: text.slice(0, 200) };
  }, (err) => ({ ok: false, detail: String(err && err.message) }));
}

/**
 * @param {{cwd?:string, env?:object, git?:Function, generate?:Function, rename?:Function,
 *          now?:Function, log?:Function, ampPath?:string}} opts
 * @returns {{enabled:boolean, onAgentStart:Function, onAgentEnd:Function, threads:Map, pending:Map}}
 */
function createAmpNamer({
  cwd = process.cwd(), env = process.env, git, generate = generateTopic, rename,
  now = Date.now, log = () => {}, ampPath,
} = {}) {
  const threads = new Map();
  /** threadId -> the running naming job (a Promise). */
  const pending = new Map();
  const disabled = { enabled: false, onAgentStart: async () => undefined, onAgentEnd: async () => undefined, threads, pending };
  if (env.SESSION_NAMER_NESTED === '1') return disabled;
  const runGit = git || gitIn(cwd);
  let repoRoot = null;
  try { repoRoot = runGit(['rev-parse', '--show-toplevel']); } catch { repoRoot = null; }
  const cfg = loadConfig({ env, repoRoot });
  if (!cfg.enabled) return disabled;
  const project = title.resolveProject({ cwd, projectSource: cfg.projectSource, git: runGit, override: cfg.projectOverride });
  const amp = ampPath ? safeSpawn.toCommand(ampPath) : resolveAmp(env);
  const doRename = rename || ((threadId, newTitle) => defaultRename({ amp, threadId, newTitle, env }));

  /** Bound the threads Map: drop the oldest entries that have no job running. */
  const prune = () => {
    if (threads.size <= MAX_THREADS) return;
    for (const id of threads.keys()) {
      if (threads.size <= MAX_THREADS) break;
      if (!pending.has(id)) threads.delete(id);
    }
  };

  const readTitle = async (ctx) => {
    try {
      const t = ctx && ctx.thread && ctx.thread.title && typeof ctx.thread.title.get === 'function'
        ? await ctx.thread.title.get() : null;
      return typeof t === 'string' && t.trim() ? t.trim() : null;
    } catch {
      return null;
    }
  };

  const write = async (threadId, st, newTitle) => {
    log(`${threadId} renaming to "${newTitle}"`);
    const res = await doRename(threadId, newTitle);
    if (res && res.ok) {
      st.written = newTitle;
      st.writtenAt = now();
      log(`${threadId} renamed "${newTitle}"`);
      return true;
    }
    log(`${threadId} rename failed: ${res && res.detail}`);
    return false;
  };

  async function nameThread(threadId, st, prompt) {
    st.attempts += 1;
    st.lastAttemptTs = now();
    let raw = null;
    try {
      raw = await generate({ prompt, model: cfg.model, timeoutMs: cfg.timeoutMs, env, log: (m) => log(`${threadId} generate: ${m}`) });
    } catch (err) {
      log(`${threadId} generate threw: ${err && err.message}`);
    }
    const topic = title.sanitizeTopic(raw, { maxWords: cfg.maxWords });
    if (!topic) { log(`${threadId} generation failed (attempt ${st.attempts})`); return; }
    if (st.stage === 'user') return; // user renamed while we were generating
    const full = title.formatTitle(project, topic, { separator: cfg.separator });
    if (await write(threadId, st, full)) st.stage = 'final';
  }

  /** agent.start handler body. Never awaits generation; returns undefined. */
  async function onAgentStart(event, ctx) {
    const threadId = event && event.thread && event.thread.id;
    if (!threadId || typeof threadId !== 'string') return undefined;
    let st = threads.get(threadId);
    const current = await readTitle(ctx);
    if (!st) {
      // Only threads we see untitled are ours; an existing titled thread is left alone.
      st = { stage: current ? 'foreign' : 'candidate', attempts: 0, lastAttemptTs: 0, written: null, writtenAt: 0, agentTitle: null, reasserted: false };
      threads.set(threadId, st);
      prune();
      if (current) log(`${threadId} already titled, leaving alone`);
    }
    if (st.stage === 'foreign' || st.stage === 'user' || st.stage === 'final') {
      if (st.stage === 'final' && current && current !== st.written && st.reasserted) { st.stage = 'user'; log(`${threadId} user-renamed, leaving alone`); }
      return undefined;
    }
    // candidate: a title we did not write and that is not the agent's own -> user rename.
    if (current && current !== st.written && current !== st.agentTitle) {
      st.stage = 'user';
      log(`${threadId} user-renamed before naming, leaving alone`);
      return undefined;
    }
    if (pending.has(threadId)) return undefined;
    if (!title.isEligiblePrompt(event.message)) return undefined;
    if (st.attempts >= MAX_ATTEMPTS) return undefined;
    if (st.lastAttemptTs && now() - st.lastAttemptTs < RETRY_INTERVAL_MS) return undefined;
    const job = nameThread(threadId, st, event.message)
      .catch((err) => log(`${threadId} fatal: ${err && err.message}`))
      .finally(() => pending.delete(threadId));
    pending.set(threadId, job);
    return undefined;
  }

  /** agent.end handler body: learn the agent's auto-title, re-assert ours once. */
  async function onAgentEnd(event, ctx) {
    const threadId = event && event.thread && event.thread.id;
    const st = threadId && threads.get(threadId);
    if (!st) return undefined;
    const current = await readTitle(ctx);
    if (st.stage === 'candidate') {
      if (current && current !== st.written) st.agentTitle = current; // Amp's own auto-title
      return undefined;
    }
    if (st.stage !== 'final' || !current || current === st.written) return undefined;
    if (!st.reasserted && now() - st.writtenAt <= REASSERT_WINDOW_MS) {
      st.reasserted = true;
      log(`${threadId} title replaced by "${current}" right after naming, re-asserting`);
      await write(threadId, st, st.written);
      return undefined;
    }
    st.stage = 'user';
    log(`${threadId} user-renamed, leaving alone`);
    return undefined;
  }

  return { enabled: true, onAgentStart, onAgentEnd, threads, pending, project };
}

module.exports = { createAmpNamer, resolveAmp, defaultRename, MAX_ATTEMPTS, RETRY_INTERVAL_MS, REASSERT_WINDOW_MS, MAX_THREADS };
