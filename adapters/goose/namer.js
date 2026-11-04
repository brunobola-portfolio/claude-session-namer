'use strict';
/**
 * Goose adapter core: "<project> - <topic>" session names for goose
 * (aaif-goose, formerly block/goose), reusing the repository lib/.
 *
 * goose hooks are observe-only (no output can set a name), but goose ships a
 * documented CLI:
 *   goose session list --format json [-w <dir>]   -> [{ id, name, user_set_name, ... }]
 *   goose session rename --session-id <id> -n <name>
 * and a `UserPromptSubmit` hook whose payload carries `session_id`, `message`
 * and `working_dir`.
 *
 * goose names sessions itself, asynchronously, for each of the first three
 * user messages while `user_set_name` is false, and that write is
 * unconditional (it also resets `user_set_name`). A CLI rename sets
 * `user_set_name = true`, which stops goose's auto-naming for good. So the
 * background worker:
 *   1. generates the topic (`claude -p` via lib/generate, or goose's own name
 *      in "native" mode; "auto" = claude, falling back to native);
 *   2. renames at once, then watches for 15 s: if goose's in-flight auto-name
 *      lands afterwards (visible as user_set_name back to false), it renames
 *      again, at most 3 writes in total;
 *   3. marks the session final; goose stops auto-naming once user_set_name
 *      stays true.
 * A session that already has `user_set_name = true` with a name we did not
 * write was renamed by the user and is never touched.
 */
const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const title = require('../../lib/title');
const state = require('../../lib/state');
const { loadConfig } = require('../../lib/config');
const { generateTopic, findClaude } = require('../../lib/generate');

const MAX_ATTEMPTS = 3;
const RETRY_INTERVAL_MS = 60_000;
const NATIVE_WAIT_MS = 30_000;
/** How long to watch for goose's in-flight auto-name after each rename. */
const WATCH_MS = 15_000;
const MAX_WRITES = 3;
const POLL_MS = 1_000;
const KEY_PREFIX = 'goose-';

const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

/** Locate the goose executable (argv only, never a shell). */
function findGoose(env = process.env, {
  platform = process.platform,
  exists = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } },
} = {}) {
  const explicit = env.SESSION_NAMER_GOOSE_PATH && env.SESSION_NAMER_GOOSE_PATH.trim();
  if (explicit) return explicit;
  const win = platform === 'win32';
  const joiner = win ? path.win32 : path.posix;
  const name = win ? 'goose.exe' : 'goose';
  const home = env.USERPROFILE || env.HOME || '';
  const dirs = String(env.PATH || env.Path || '').split(win ? ';' : ':').filter(Boolean);
  // Official installers: %USERPROFILE%\goose (Windows), ~/.local/bin (Unix).
  if (home) dirs.push(win ? joiner.join(home, 'goose') : joiner.join(home, '.local', 'bin'));
  for (const dir of dirs) {
    const candidate = joiner.join(dir, name);
    if (exists(candidate)) return candidate;
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

function runGoose(goosePath, args, { cwd, timeoutMs = 20_000 } = {}) {
  return new Promise((resolve) => {
    childProcess.execFile(goosePath, args, {
      cwd, encoding: 'utf8', timeout: timeoutMs, windowsHide: true, maxBuffer: 64 * 1024 * 1024,
    }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout: stdout || '', stderr: stderr || '' });
    });
  });
}

/** Find one session in `goose session list --format json` output. */
function parseList(stdout, sessionId) {
  let data;
  try { data = JSON.parse(String(stdout || '')); } catch { return null; }
  if (!Array.isArray(data)) return null;
  const s = data.find((x) => x && x.id === sessionId);
  if (!s) return null;
  return { name: typeof s.name === 'string' ? s.name.trim() : '', userSet: s.user_set_name === true };
}

function resolveMode(env, hasClaude) {
  const raw = String(env.SESSION_NAMER_GOOSE_TOPIC || 'auto').trim().toLowerCase();
  if (raw === 'claude' || raw === 'native') return raw;
  return hasClaude() ? 'claude' : 'native';
}

const claudeFound = (env) => {
  const found = findClaude(env);
  return !(found.command === 'claude' && found.args.length === 0);
};

/** Cheap gate inside the hook process: is a background worker worth it? */
function shouldSpawn(input, { env = process.env } = {}) {
  if (!input || typeof input !== 'object') return false;
  if (env.SESSION_NAMER_NESTED === '1') return false;
  if (String(input.event || input.hook_event_name || '') !== 'UserPromptSubmit') return false;
  const sid = String(input.session_id || '');
  if (!sid) return false;
  if (!title.isEligiblePrompt(input.message)) return false;
  const st = state.readState(state.stateDir(env), KEY_PREFIX + sid);
  return !(st && (st.stage === 'final' || st.stage === 'user'));
}

/**
 * Background worker; all dependencies injectable for tests.
 * @returns {Promise<string>} outcome tag
 */
async function work(input, deps = {}) {
  const env = deps.env || process.env;
  const sid = String((input && input.session_id) || '');
  const cwd = String((input && input.working_dir) || process.cwd());
  const prompt = String((input && input.message) || '');
  if (!sid) return 'no-session';
  const git = deps.git || gitIn(cwd);
  const now = deps.now || Date.now;
  const wait = deps.sleep || sleep;
  const generate = deps.generate || generateTopic;
  const goosePath = deps.goosePath !== undefined ? deps.goosePath : findGoose(env);
  const run = deps.run || ((args) => runGoose(goosePath, args, { cwd }));
  const dir = deps.stateDir || state.stateDir(env);
  const key = KEY_PREFIX + sid;
  const log = deps.log || ((m) => state.appendLog(dir, `goose ${sid.slice(0, 15)} ${m}`));
  if (!goosePath) { log('goose executable not found (set SESSION_NAMER_GOOSE_PATH)'); return 'no-goose'; }
  if (!title.isEligiblePrompt(prompt)) return 'trivial-prompt';

  let repoRoot = null;
  try { repoRoot = git(['rev-parse', '--show-toplevel']) || null; } catch { repoRoot = null; }
  const cfg = loadConfig({ env, repoRoot });
  if (!cfg.enabled) return 'disabled';
  const project = title.resolveProject({ cwd, projectSource: cfg.projectSource, git, override: cfg.projectOverride });
  const st = state.readState(dir, key) || {};
  if (st.stage === 'final' || st.stage === 'user') return 'done-already';
  const save = (patch) => state.writeState(dir, key, { project, attempts: 0, ...st, ...patch, ts: now() });

  const lookup = async () => {
    const r = await run(['session', 'list', '--format', 'json', '-w', cwd]);
    let found = r.code === 0 ? parseList(r.stdout, sid) : null;
    if (!found) {
      const all = await run(['session', 'list', '--format', 'json']);
      found = all.code === 0 ? parseList(all.stdout, sid) : null;
    }
    return found;
  };

  const before = await lookup();
  if (!before) { log('session not found in goose session list'); return 'no-session-data'; }
  if (before.userSet && before.name !== st.title) {
    save({ stage: 'user', title: before.name });
    log('user-named, leaving alone');
    return 'user-named';
  }

  const attempts = st.attempts || 0;
  if (attempts >= MAX_ATTEMPTS) return 'max-attempts';
  if (st.lastAttemptTs && now() - st.lastAttemptTs < RETRY_INTERVAL_MS) return 'retry-later';
  save({ stage: 'provisional', attempts: attempts + 1, lastAttemptTs: now() });

  const mode = resolveMode(env, deps.hasClaude || (() => claudeFound(env)));
  let topic = null;
  if (mode === 'claude') {
    let raw = null;
    try {
      raw = await generate({ prompt, model: cfg.model, timeoutMs: cfg.timeoutMs, env, log: (m) => log(`generate: ${m}`) });
    } catch (err) { log(`generate threw: ${err && err.message}`); }
    topic = title.sanitizeTopic(raw, { maxWords: cfg.maxWords });
    if (!topic) log('claude topic unavailable, falling back to goose\'s own name');
  }

  let current = (await lookup()) || before;
  if (current.userSet && current.name !== st.title) {
    save({ stage: 'user', title: current.name });
    log('user renamed meanwhile, leaving alone');
    return 'user-named';
  }
  if (!topic) {
    // Native mode: goose's own name is the topic; wait for it if it is still empty.
    for (let waited = 0; !current.name && waited < NATIVE_WAIT_MS; waited += POLL_MS) {
      await wait(POLL_MS);
      current = (await lookup()) || current;
    }
    topic = current.name ? (title.sanitizeTopic(current.name) || current.name.slice(0, 60).trim()) : null;
  }
  if (!topic) { log(`no topic (attempt ${attempts + 1})`); return 'no-topic'; }

  // Rename now, then watch: goose's in-flight auto-name may still land, and it
  // resets user_set_name when it does. Re-assert up to MAX_WRITES times.
  const full = title.formatTitle(project, topic, { separator: cfg.separator });
  for (let write = 1; write <= MAX_WRITES; write += 1) {
    const r = await run(['session', 'rename', '--session-id', sid, '-n', full]);
    if (r.code !== 0) { log(`rename failed: ${(r.stderr || r.stdout).trim().slice(0, 200)}`); return 'rename-failed'; }
    let overwritten = false;
    for (let waited = 0; waited < WATCH_MS; waited += POLL_MS) {
      await wait(POLL_MS);
      const check = await lookup();
      if (!check || (check.name === full && check.userSet)) continue;
      if (check.userSet) {
        // Someone set a different name on purpose: the user. Hands off.
        save({ stage: 'user', title: check.name });
        log(`user renamed to "${check.name}", leaving alone`);
        return 'user-named';
      }
      log(`goose auto-name "${check.name}" overwrote ours (write ${write})`);
      overwritten = true;
      break;
    }
    if (!overwritten) {
      save({ stage: 'final', title: full, attempts: attempts + 1, lastAttemptTs: now() });
      log(`final "${full}" (${mode})`);
      return 'final';
    }
  }
  save({ stage: 'final', title: full, attempts: attempts + 1, lastAttemptTs: now() });
  log(`gave up re-asserting after ${MAX_WRITES} writes`);
  return 'overwritten';
}

module.exports = { work, shouldSpawn, parseList, findGoose, resolveMode, KEY_PREFIX };
