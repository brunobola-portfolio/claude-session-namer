'use strict';
/**
 * Crush adapter core: "<project> - <topic>" session titles for Charm Crush,
 * reusing the repository lib/.
 *
 * Crush has no hook output that sets a title, but it has a documented CLI:
 *   crush session show <id> --json      -> { meta: { title }, messages: [...] }
 *   crush session rename <id> <title>   -> renames; a running TUI re-renders it
 * and a `TurnStart` hook whose payload carries `session_id` and `cwd`.
 *
 * Flow (all in a detached background worker, so the turn is never delayed):
 *   1. read the session; take the newest user message as the prompt;
 *   2. skip trivial prompts (lib/title isEligiblePrompt), retry rules as in
 *      hooks/namer.js (3 attempts, 60 s apart);
 *   3. topic: `claude -p` via lib/generate (mode "claude"), or Crush's own
 *      generated title (mode "native"); "auto" = claude, falling back to native;
 *   4. wait until Crush's own one-shot title generation has landed (title is no
 *      longer the default), so it cannot overwrite ours afterwards;
 *   5. rename once, verify, re-assert at most once.
 * After that the session is final and never touched again; a title that is
 * not ours on a later check means the user renamed it (stage "user").
 */
const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const title = require('../../lib/title');
const state = require('../../lib/state');
const { loadConfig } = require('../../lib/config');
const { generateTopic, findClaude } = require('../../lib/generate');

const DEFAULT_TITLES = new Set(['', 'New Session', 'Untitled Session']);
const MAX_ATTEMPTS = 3;
const RETRY_INTERVAL_MS = 60_000;
const MESSAGE_WAIT_MS = 10_000;
const NATIVE_WAIT_MS = 30_000;
const VERIFY_DELAY_MS = 3_000;
const POLL_MS = 1_000;
const KEY_PREFIX = 'crush-';

const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

/** Locate crush.exe without a shell (titles must never pass through cmd.exe). */
function findCrush(env = process.env, {
  platform = process.platform,
  exists = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } },
} = {}) {
  const explicit = env.SESSION_NAMER_CRUSH_PATH && env.SESSION_NAMER_CRUSH_PATH.trim();
  if (explicit) return explicit;
  const joiner = platform === 'win32' ? path.win32 : path.posix;
  const sep = platform === 'win32' ? ';' : ':';
  const dirs = String(env.PATH || env.Path || '').split(sep).filter(Boolean);
  for (const dir of dirs) {
    if (platform === 'win32') {
      const exe = joiner.join(dir, 'crush.exe');
      if (exists(exe)) return exe;
      // npm shim: <prefix>\crush.cmd -> <prefix>\node_modules\@charmland\crush\bin\crush.exe
      if (exists(joiner.join(dir, 'crush.cmd'))) {
        const real = joiner.join(dir, 'node_modules', '@charmland', 'crush', 'bin', 'crush.exe');
        if (exists(real)) return real;
      }
    } else {
      const bin = joiner.join(dir, 'crush');
      if (exists(bin)) return bin;
    }
  }
  return null;
}

function gitIn(cwd) {
  return (args) => {
    try {
      const r = childProcess.spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 3000, windowsHide: true });
      return r.status === 0 ? r.stdout.trim() : null;
    } catch {
      return null;
    }
  };
}

/** Run the crush CLI (argv, no shell). Resolves { code, stdout, stderr }. */
function runCrush(crushPath, args, { cwd, timeoutMs = 15_000 } = {}) {
  return new Promise((resolve) => {
    childProcess.execFile(crushPath, args, {
      cwd, encoding: 'utf8', timeout: timeoutMs, windowsHide: true, maxBuffer: 32 * 1024 * 1024,
    }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout: stdout || '', stderr: stderr || '' });
    });
  });
}

/** Parse `crush session show --json`. Returns { title, prompt } or null. */
function parseShow(stdout) {
  let data;
  try { data = JSON.parse(String(stdout || '')); } catch { return null; }
  if (!data || typeof data !== 'object' || !data.meta) return null;
  const users = (Array.isArray(data.messages) ? data.messages : []).filter((m) => m && m.role === 'user');
  const last = users[users.length - 1];
  const prompt = last && Array.isArray(last.parts)
    ? last.parts.filter((p) => p && p.type === 'text' && typeof p.text === 'string').map((p) => p.text).join('\n').trim()
    : '';
  return { title: typeof data.meta.title === 'string' ? data.meta.title.trim() : '', prompt, userCount: users.length };
}

function resolveMode(env, hasClaude) {
  const raw = String(env.SESSION_NAMER_CRUSH_TOPIC || 'auto').trim().toLowerCase();
  if (raw === 'claude' || raw === 'native') return raw;
  return hasClaude() ? 'claude' : 'native';
}

const claudeFound = (env) => {
  const found = findClaude(env);
  return !(found.command === 'claude' && found.args.length === 0);
};

/**
 * True when the session's current title must be the user's.
 *  - no state at all (first time we see the session), a non-default title and
 *    more than one user message: Crush's auto-title only follows the first
 *    prompt, and we would have seen that turn, so someone renamed it;
 *  - we saw it on a trivial turn with a non-default title, and it has changed
 *    since: Crush titles a session only once, so the change is a rename.
 */
function userTitled(st, info) {
  if (!info || DEFAULT_TITLES.has(info.title)) return false;
  if (!st || !st.stage) return info.userCount > 1;
  if (st.stage === 'seen') return !!st.seenTitle && !DEFAULT_TITLES.has(st.seenTitle) && st.seenTitle !== info.title;
  return false;
}

/**
 * Cheap, synchronous gate run inside the hook process itself: decides whether
 * a background worker is worth spawning at all.
 */
function shouldSpawn(input, { env = process.env } = {}) {
  if (!input || typeof input !== 'object') return false;
  if (env.SESSION_NAMER_NESTED === '1') return false;
  const event = String(input.hook_event_name || input.event || '');
  if (event && !/^turn_?start$/i.test(event)) return false;
  const sid = String(input.session_id || '');
  if (!sid) return false;
  const st = state.readState(state.stateDir(env), KEY_PREFIX + sid);
  return !(st && (st.stage === 'final' || st.stage === 'user'));
}

/**
 * The background worker. Every dependency is injectable for tests.
 * @returns {Promise<string>} outcome tag (for logs and tests)
 */
async function work(input, deps = {}) {
  const env = deps.env || process.env;
  const sid = String((input && input.session_id) || '');
  const cwd = String((input && input.cwd) || env.CRUSH_CWD || process.cwd());
  if (!sid) return 'no-session';
  const git = deps.git || gitIn(cwd);
  const now = deps.now || Date.now;
  const wait = deps.sleep || sleep;
  const generate = deps.generate || generateTopic;
  const crushPath = deps.crushPath !== undefined ? deps.crushPath : findCrush(env);
  const run = deps.run || ((args) => runCrush(crushPath, args, { cwd }));
  const dir = deps.stateDir || state.stateDir(env);
  const key = KEY_PREFIX + sid;
  const log = deps.log || ((m) => state.appendLog(dir, `crush ${sid.slice(0, 8)} ${m}`));
  if (!crushPath) { log('crush executable not found (set SESSION_NAMER_CRUSH_PATH)'); return 'no-crush'; }

  let repoRoot = null;
  try { repoRoot = git(['rev-parse', '--show-toplevel']) || null; } catch { repoRoot = null; }
  const cfg = loadConfig({ env, repoRoot });
  if (!cfg.enabled) return 'disabled';
  const project = title.resolveProject({ cwd, projectSource: cfg.projectSource, git, override: cfg.projectOverride });
  const st = state.readState(dir, key) || {};
  if (st.stage === 'final' || st.stage === 'user') return 'done-already';
  const save = (patch) => state.writeState(dir, key, { project, attempts: 0, ...st, ...patch, ts: now() });

  const show = async () => {
    const r = await run(['session', 'show', sid, '--json']);
    return r.code === 0 ? parseShow(r.stdout) : null;
  };

  // 1. The user message of this turn (TurnStart may fire just before it is stored).
  let info = await show();
  for (let waited = 0; (!info || !info.prompt) && waited < MESSAGE_WAIT_MS; waited += POLL_MS) {
    await wait(POLL_MS);
    info = await show();
  }
  if (!info) { log('session not readable'); return 'no-session-data'; }
  // A title that is not Crush's default and not the auto-title of the first
  // prompt belongs to the user. Crush writes its own title once, after the
  // first prompt, so a non-default title on a session we have never seen with
  // more than one prompt is a rename (or predates the hook): leave it.
  if (userTitled(st, info)) {
    save({ stage: 'user', title: info.title });
    log(`existing title "${info.title}" is the user's, leaving alone`);
    return 'user-titled';
  }
  if (!title.isEligiblePrompt(info.prompt)) {
    // Remember what we saw, so a later turn can tell Crush's title from a rename.
    if (!st.stage || st.stage === 'seen') save({ stage: 'seen', seenTitle: info.title });
    return 'trivial-prompt';
  }

  // 2. Retry rules.
  const attempts = st.attempts || 0;
  if (attempts >= MAX_ATTEMPTS) return 'max-attempts';
  if (st.lastAttemptTs && now() - st.lastAttemptTs < RETRY_INTERVAL_MS) return 'retry-later';
  save({ stage: 'provisional', attempts: attempts + 1, lastAttemptTs: now() });

  // 3. Topic.
  const mode = resolveMode(env, deps.hasClaude || (() => claudeFound(env)));
  let topic = null;
  if (mode === 'claude') {
    let raw = null;
    try {
      raw = await generate({ prompt: info.prompt, model: cfg.model, timeoutMs: cfg.timeoutMs, env, log: (m) => log(`generate: ${m}`) });
    } catch (err) { log(`generate threw: ${err && err.message}`); }
    topic = title.sanitizeTopic(raw, { maxWords: cfg.maxWords });
    if (!topic) log('claude topic unavailable, falling back to Crush\'s own title');
  }

  // 4. Let Crush's one-shot title generation land first (it would overwrite us).
  let current = info.title;
  for (let waited = 0; DEFAULT_TITLES.has(current) && waited < NATIVE_WAIT_MS; waited += POLL_MS) {
    await wait(POLL_MS);
    const again = await show();
    if (again) current = again.title;
  }
  if (!topic) topic = DEFAULT_TITLES.has(current) ? null : title.sanitizeTopic(current) || current.slice(0, 60).trim();
  if (!topic) { log(`no topic (attempt ${attempts + 1})`); return 'no-topic'; }
  if (current.startsWith(`${project}${cfg.separator}`)) {
    // Already prefixed (e.g. the user typed it that way): keep it, mark as user's.
    save({ stage: 'user', title: current });
    return 'already-prefixed';
  }

  // 5. Rename, verify, re-assert once.
  const full = title.formatTitle(project, topic, { separator: cfg.separator });
  for (let write = 1; write <= 2; write += 1) {
    const r = await run(['session', 'rename', sid, full, '--json']);
    if (r.code !== 0) { log(`rename failed: ${(r.stderr || r.stdout).trim().slice(0, 200)}`); return 'rename-failed'; }
    await wait(VERIFY_DELAY_MS);
    const check = await show();
    if (!check || check.title === full) {
      save({ stage: 'final', title: full, attempts: attempts + 1, lastAttemptTs: now() });
      log(`final "${full}" (${mode})`);
      return 'final';
    }
    log(`title changed to "${check.title}" after rename (write ${write})`);
  }
  save({ stage: 'user', title: full });
  return 'overwritten';
}

module.exports = { work, shouldSpawn, parseShow, findCrush, resolveMode, userTitled, DEFAULT_TITLES, KEY_PREFIX };
