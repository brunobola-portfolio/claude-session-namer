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
const { makeTitle, projectTitle, defaultGit } = require('../_shared/make-title.js');
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
 * @param {{make?:Function, project?:Function, env?:object, fallbackCwd?:string,
 *          now?:Function, gitFor?:Function}} deps
 */
export function createProvider({
  make = makeTitle, project = projectTitle, env = process.env, fallbackCwd = process.cwd(), log = () => {},
  now = Date.now, gitFor = memoGit,
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
        t.attempts += 1;
        t.lastAttempt = now();
        const r = await make({ prompt: msg.text, cwd, env, git, log: (l) => log(`${sid}: generate ${l}`) });
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
