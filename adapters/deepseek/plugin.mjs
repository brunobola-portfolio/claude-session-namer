/**
 * session-namer for DeepSeek Harness (dsh): a `ctx.sessionTitle` provider.
 *
 * dsh documents one optional title provider per profile
 * (`ctx.sessionTitle.register(provider)`); its titles are durable
 * `session/title` log events shown in the session list, `/resume` and the Web
 * UI, and never reach the model. This provider replaces the shipped
 * `session-title-first-prompt-llm` and returns "<project> - <topic>":
 *
 *   - project: git repository of the session's cwd (worktree-aware, lib/title.js)
 *   - topic:   your own `claude -p` (lib/generate.js), so no DeepSeek tokens are spent
 *
 * Cadence is `all-prompts` so a trivial first prompt ("ok") does not burn the
 * only attempt; once a topic is accepted later prompts return the same title
 * without a model call. A user rename pins the title (dsh stops scheduling).
 */
import { createRequire } from 'node:module';

import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const childProcess = require('node:child_process');
const { makeTitle, projectTitle, defaultGit } = require('../_shared/make-title.js');
const { generateTopic } = require('../../lib/generate.js');
const state = require('../../lib/state.js');
const title = require('../../lib/title.js');

/** Log under $DSH_HOME/session-namer (default ~/.dsh/session-namer/log.txt). */
export function makeLogger(env = process.env) {
  const dshHome = (env.DSH_HOME && env.DSH_HOME.trim()) || path.join(env.USERPROFILE || env.HOME || os.homedir(), '.dsh');
  let dir = null;
  return (line) => {
    try {
      dir = dir || state.stateDir({ ...env, CLAUDE_CONFIG_DIR: dshHome });
      state.appendLog(dir, `[deepseek] ${line}`);
    } catch { /* logging never breaks titling */ }
  };
}

export const name = 'session-namer';
export const inject = ['sessionTitle'];
export const PROVIDER_ID = 'session-namer';

/** True when `snapshot` is a final (project + topic) title this provider produced. */
export function isOwnFinal(snapshot, project) {
  return !!snapshot && snapshot.source && snapshot.source.kind === 'provider'
    && snapshot.source.provider === PROVIDER_ID && typeof snapshot.title === 'string'
    && snapshot.title !== project;
}

/** Same budget as the Claude Code hook: 3 model calls per session, 60 s apart. */
export const MAX_ATTEMPTS = 3;
export const RETRY_INTERVAL_MS = 60_000;
const MAX_TRACKED = 500;

const abortError = () => new Error('session-namer: aborted');

/** Stop a `claude -p` child (and, on Windows, its tree). */
export function killChild(child, { platform = process.platform, spawn = childProcess.spawn } = {}) {
  try {
    if (platform === 'win32' && child.pid) {
      spawn('taskkill', ['/T', '/F', '/PID', String(child.pid)], { stdio: 'ignore', windowsHide: true }).on('error', () => {});
    }
    child.kill();
  } catch { /* already gone */ }
}

/**
 * Settle with `promise`, or reject as soon as `signal` aborts. dsh aborts a
 * provider call on a newer user message, a refresh or session disposal, and
 * drops any result that arrives afterwards. On teardown it waits for calls
 * that ignore the signal, and a running `claude -p` child keeps the process
 * alive, so a `dsh headless` run whose answer came first would wait for it.
 */
export function untilAborted(promise, signal) {
  if (!signal || typeof signal.addEventListener !== 'function') return promise;
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(abortError());
    signal.addEventListener('abort', onAbort, { once: true });
    const off = () => signal.removeEventListener('abort', onAbort);
    promise.then((v) => { off(); resolve(v); }, (e) => { off(); reject(e); });
  });
}

/**
 * git for one cwd, memoised: dsh calls the provider on every prompt
 * (`all-prompts`), and the repository of a cwd does not change mid-session.
 */
function memoGit(cwd) {
  const real = defaultGit(cwd);
  const cache = new Map();
  return (args) => {
    const key = args.join('\0');
    if (!cache.has(key)) cache.set(key, real(args));
    return cache.get(key);
  };
}

/**
 * Pure-ish provider factory (dependencies injectable for tests).
 * `generate` (lib/generate.js) is handed to `make` with a `spawn` that records
 * the `claude -p` child, so an aborted call can stop it.
 * @param {{make?:Function, project?:Function, env?:object, fallbackCwd?:string,
 *          now?:Function, gitFor?:Function, generate?:Function, spawn?:Function, kill?:Function}} deps
 */
export function createProvider({
  make = makeTitle, project = projectTitle, env = process.env, fallbackCwd = process.cwd(), log = () => {},
  now = Date.now, gitFor = memoGit, generate = generateTopic, spawn = childProcess.spawn, kill = killChild,
} = {}) {
  const gits = new Map(); // cwd -> memoised git
  const tries = new Map(); // session id -> { attempts, lastAttempt }
  const gitOf = (cwd) => {
    if (!gits.has(cwd)) gits.set(cwd, gitFor(cwd));
    return gits.get(cwd);
  };
  const triesOf = (sid) => {
    const key = String(sid);
    if (!tries.has(key)) {
      tries.set(key, { attempts: 0, lastAttempt: 0 });
      if (tries.size > MAX_TRACKED) tries.delete(tries.keys().next().value);
    }
    return tries.get(key);
  };
  return {
    id: PROVIDER_ID,
    automatic: 'all-prompts',
    async generate(request) {
      const messages = request.messages || [];
      if (messages.length === 0) throw new Error('session-namer: no eligible message');
      const sid = request.session && request.session.id;
      const cwd = (request.session && request.session.header && request.session.header.cwd) || fallbackCwd;
      const git = gitOf(cwd);
      const { cfg, project: proj } = project({ cwd, env, git });
      if (cfg && cfg.enabled === false) throw new Error('session-namer: disabled');
      const current = request.currentTitle;
      if (isOwnFinal(current, proj)) {
        log(`${sid}: keep "${current.title}"`);
        return { title: current.title, messageSeqs: [...current.messageSeqs] };
      }
      // Newest eligible prompt first: the most recent real request names the session best
      // when earlier ones were trivial. Trivial prompts never count as an attempt.
      const t = triesOf(sid);
      for (let i = messages.length - 1; i >= 0; i -= 1) {
        if (request.signal && request.signal.aborted) throw new Error('session-namer: aborted');
        const msg = messages[i];
        if (!title.isEligiblePrompt(msg.text)) continue;
        if (t.attempts >= MAX_ATTEMPTS) { log(`${sid}: ${MAX_ATTEMPTS} attempts used, project only`); break; }
        if (t.lastAttempt && now() - t.lastAttempt < RETRY_INTERVAL_MS) { log(`${sid}: retry later`); break; }
        const previous = t.lastAttempt;
        t.attempts += 1;
        t.lastAttempt = now();
        const children = [];
        const tracked = (...args) => { const c = spawn(...args); children.push(c); return c; };
        const job = Promise.resolve(make({
          prompt: msg.text, cwd, env, git, log: (l) => log(`${sid}: generate ${l}`),
          generate: (opts) => generate({ ...opts, spawn: tracked }),
        }));
        let r;
        try {
          r = await untilAborted(job, request.signal);
        } catch (err) {
          if (request.signal && request.signal.aborted) {
            // dsh will drop this result: stop `claude -p` now, and do not count the attempt,
            // so the call dsh makes for the newer message generates at once.
            for (const c of children) kill(c);
            job.catch(() => {});
            t.attempts -= 1;
            t.lastAttempt = previous;
            log(`${sid}: aborted by dsh while generating${children.length ? '; claude -p stopped' : ''}`);
          }
          throw err;
        }
        if (r.reason === 'disabled') throw new Error('session-namer: disabled');
        if (r.reason === 'ok') {
          log(`${sid}: title "${r.title}"`);
          return { title: r.title, messageSeqs: [msg.seq] };
        }
        if (r.reason === 'generation-failed') { log(`${sid}: generation failed (attempt ${t.attempts})`); break; }
      }
      // Nothing usable yet: show the project name until a real prompt arrives.
      log(`${sid}: project-only "${proj}"`);
      return { title: proj, messageSeqs: [messages[messages.length - 1].seq] };
    },
  };
}

export function apply(ctx) {
  const log = makeLogger();
  log('provider registered');
  ctx.sessionTitle.register(createProvider({ log }));
}
