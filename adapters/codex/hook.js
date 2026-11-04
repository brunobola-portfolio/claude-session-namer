#!/usr/bin/env node
'use strict';
/**
 * Codex CLI adapter (beta).
 *
 *   node hook.js SessionStart | UserPromptSubmit     (Codex command hook, JSON on stdin)
 *   node hook.js --worker                            (internal: detached background job)
 *
 * Codex hooks cannot return a title, so the hook only decides whether the
 * prompt deserves one and hands the slow part to a detached worker:
 *   1. thread/read via the Codex app server: skip exec/sub-agent/ephemeral
 *      threads and threads that already have a name we did not set;
 *   2. topic from `claude -p` (or opt-in `codex exec`, see SESSION_NAMER_CODEX_GENERATOR);
 *   3. thread/name/set "<project> - <topic>".
 * The hook prints nothing (plain stdout would be injected into the model
 * context) and always exits 0, so the user's turn is never delayed by the model call.
 */
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadConfig } = require('../../lib/config');
const state = require('../../lib/state');
const title = require('../../lib/title');
const { generateTopic: generateTopicClaude } = require('../../lib/generate');
const { generateTopicCodex, findCodex } = require('./generate');
const appServer = require('./appserver');

const STATE_VERSION = 1;
const MAX_ATTEMPTS = 3;
const RETRY_INTERVAL_MS = 60_000;
const EVENTS = new Set(['SessionStart', 'UserPromptSubmit']);
const JOB_ENV = 'SESSION_NAMER_CODEX_JOB';
const SAFE_ID = /^[A-Za-z0-9._-]{1,128}$/;

const truthy = (v) => ['1', 'true', 'yes', 'on'].includes(String(v || '').trim().toLowerCase());

/** Codex home: $CODEX_HOME or ~/.codex. State lives in <codexHome>/session-namer. */
const codexHome = (env) => (env.CODEX_HOME && env.CODEX_HOME.trim())
  || path.join(env.HOME || env.USERPROFILE || os.homedir(), '.codex');
const stateDirFor = (env) => state.stateDir({ ...env, CLAUDE_CONFIG_DIR: codexHome(env) });

function defaultGit(cwd) {
  return (args) => {
    try {
      const r = childProcess.spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 2000, windowsHide: true });
      return r.status === 0 ? r.stdout.trim() : null;
    } catch {
      return null;
    }
  };
}

/**
 * Best-effort read of the rollout's session_meta (first line) for
 * `source`/`originator`. `codex exec` threads have source "exec".
 * @returns {{source:string|null, originator:string|null}|null}
 */
function readSessionMeta(transcriptPath) {
  if (typeof transcriptPath !== 'string' || !transcriptPath) return null;
  let fd;
  try {
    fd = fs.openSync(transcriptPath, 'r');
    const buf = Buffer.alloc(8192);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    const head = buf.slice(0, n).toString('utf8');
    if (!head.includes('"session_meta"')) return null;
    const src = head.match(/"source":"([^"]*)"/);
    const orig = head.match(/"originator":"([^"]*)"/);
    return { source: src ? src[1] : (/"source":\{/.test(head) ? 'object' : null), originator: orig ? orig[1] : null };
  } catch {
    return null;
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch { /* ignore */ }
  }
}

const isHeadlessMeta = (meta) => !!meta && (meta.source === 'exec' || meta.originator === 'codex_exec');

/** Spawn the worker detached so it outlives the hook and never holds Codex's pipes. */
function dispatchDetached(job, env) {
  const child = childProcess.spawn(process.execPath, [__filename, '--worker'], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: { ...env, [JOB_ENV]: JSON.stringify(job) },
  });
  child.on('error', () => {});
  child.unref();
}

/**
 * Hook decision. Never generates inline unless SESSION_NAMER_CODEX_INLINE=1.
 * @returns {Promise<{action:string, job?:object}>}
 */
async function run(event, input, deps = {}) {
  const none = (why) => ({ action: 'none', why });
  if (!EVENTS.has(event) || !input || typeof input !== 'object') return none('bad input');
  const env = deps.env || process.env;
  if (env.SESSION_NAMER_NESTED === '1') return none('nested');
  const sessionId = String(input.session_id || '');
  if (!SAFE_ID.test(sessionId)) return none('no session id');
  const cwd = typeof input.cwd === 'string' && input.cwd ? input.cwd : process.cwd();
  const git = deps.git || defaultGit(cwd);
  const now = deps.now || Date.now;
  let repoRoot = null;
  try { repoRoot = git(['rev-parse', '--show-toplevel']) || null; } catch { repoRoot = null; }
  const cfg = loadConfig({ env, repoRoot });
  if (!cfg.enabled) return none('disabled');

  const dir = stateDirFor(env);
  const log = (msg) => state.appendLog(dir, `codex ${event} ${sessionId.slice(0, 8)} ${msg}`);

  if (event === 'SessionStart') {
    state.pruneOld(dir);
    return none('session start');
  }

  // UserPromptSubmit
  const current = state.readState(dir, sessionId);
  const st = current && current.v === STATE_VERSION ? current : null;
  if (st && (st.stage === 'final' || st.stage === 'user' || st.stage === 'skip')) return none(`stage ${st.stage}`);
  if (!title.isEligiblePrompt(input.prompt)) return none('ineligible prompt');
  const attempts = (st && st.attempts) || 0;
  if (attempts >= MAX_ATTEMPTS) return none('max attempts');
  if (st && st.lastAttemptTs && now() - st.lastAttemptTs < RETRY_INTERVAL_MS) return none('retry interval');
  const meta = (deps.readSessionMeta || readSessionMeta)(input.transcript_path);
  if (isHeadlessMeta(meta) && !cfg.nameHeadless) {
    state.writeState(dir, sessionId, { v: STATE_VERSION, stage: 'skip', reason: 'exec', ts: now() });
    log('codex exec session, skipped');
    return none('headless');
  }
  const project = title.resolveProject({ cwd, projectSource: cfg.projectSource, git, override: cfg.projectOverride });
  state.writeState(dir, sessionId, {
    v: STATE_VERSION, project, ...(st || {}), stage: 'pending', attempts: attempts + 1, lastAttemptTs: now(), ts: now(),
  });
  const job = { sessionId, cwd, project, prompt: input.prompt };
  log(`dispatch attempt ${attempts + 1}`);
  if (truthy(env.SESSION_NAMER_CODEX_INLINE)) {
    await (deps.worker || worker)(job, deps);
    return { action: 'inline', job };
  }
  (deps.dispatch || dispatchDetached)(job, env);
  return { action: 'dispatched', job };
}

/**
 * Pick the topic generator: claude (default), codex, or auto (claude, then codex).
 * `claude -p` runs with no tools at all. `codex exec` is an agent with tools;
 * generate.js switches them off, but that relies on feature flags of one
 * Codex version, so it is opt-in (SESSION_NAMER_CODEX_GENERATOR=codex|auto).
 */
async function generate(job, cfg, env, deps, log) {
  const which = String(env.SESSION_NAMER_CODEX_GENERATOR || 'claude').trim().toLowerCase();
  const codexGen = deps.generateCodex || generateTopicCodex;
  const claudeGen = deps.generateClaude || generateTopicClaude;
  const codexModel = (env.SESSION_NAMER_CODEX_MODEL || '').trim() || null;
  const viaCodex = () => codexGen({
    prompt: job.prompt, model: codexModel, timeoutMs: cfg.timeoutMs, env, codex: deps.codex, log: (m) => log(`generate: ${m}`),
  });
  const viaClaude = () => claudeGen({ prompt: job.prompt, model: cfg.model, timeoutMs: cfg.timeoutMs, env, log: (m) => log(`generate(claude): ${m}`) });
  const order = which === 'codex' ? [viaCodex] : which === 'auto' ? [viaClaude, viaCodex] : [viaClaude];
  for (const fn of order) {
    let raw = null;
    // eslint-disable-next-line no-await-in-loop
    try { raw = await fn(); } catch (err) { log(`generate threw: ${err && err.message}`); }
    const topic = title.sanitizeTopic(raw, { maxWords: cfg.maxWords });
    if (topic) return topic;
  }
  return null;
}

/** Why a thread must not be (re)named, or null when naming is allowed. */
function refusal(thread, st, cfg) {
  if (!thread) return null;
  if (thread.ephemeral) return 'ephemeral';
  if (thread.parentThreadId || (thread.source && typeof thread.source === 'object')) return 'sub-agent';
  if (thread.source === 'exec' && !cfg.nameHeadless) return 'exec';
  const existing = (thread.name || '').trim();
  if (existing && !(st && st.title && existing === st.title)) return 'user';
  return null;
}

/**
 * Background job: check the thread, generate the topic, set the name.
 * @returns {Promise<{ok:boolean, title?:string, why?:string}>}
 */
async function worker(job, deps = {}) {
  const env = deps.env || process.env;
  const now = deps.now || Date.now;
  const dir = stateDirFor(env);
  const { sessionId } = job || {};
  if (!job || !SAFE_ID.test(String(sessionId))) return { ok: false, why: 'bad job' };
  const log = (msg) => state.appendLog(dir, `codex worker ${sessionId.slice(0, 8)} ${msg}`);
  const git = deps.git || defaultGit(job.cwd);
  let repoRoot = null;
  try { repoRoot = git(['rev-parse', '--show-toplevel']) || null; } catch { repoRoot = null; }
  const cfg = loadConfig({ env, repoRoot });
  const codex = deps.codex || findCodex(env);
  const call = deps.callAppServer || appServer.callAppServer;
  const rpc = (script) => call({ codex, script, env, timeoutMs: 10000, log });
  const current = state.readState(dir, sessionId) || {};
  const save = (patch) => state.writeState(dir, sessionId, { ...current, v: STATE_VERSION, project: job.project, ...patch, ts: now() });

  const pre = await rpc((request) => appServer.readThread(request, sessionId));
  if (pre.ok) {
    const why = refusal(pre.value, current, cfg);
    if (why) {
      save({ stage: why === 'user' ? 'user' : 'skip', reason: why, title: pre.value && pre.value.name });
      log(`not naming: ${why}`);
      return { ok: false, why };
    }
  } else {
    log(`thread/read failed: ${pre.error}`);
  }

  const topic = await generate(job, cfg, env, deps, log);
  if (!topic) {
    save({ stage: 'provisional' });
    log(`generation failed (attempt ${current.attempts || 1})`);
    return { ok: false, why: 'generation failed' };
  }
  const full = title.formatTitle(job.project, topic, { separator: cfg.separator });
  const res = await rpc(async (request) => {
    // Re-check right before writing: the user may have renamed meanwhile.
    const thread = await appServer.readThread(request, sessionId).catch(() => null);
    const why = refusal(thread, current, cfg);
    if (why) return { skipped: why, name: thread && thread.name };
    await appServer.setThreadName(request, sessionId, full);
    return { skipped: null };
  });
  if (!res.ok) {
    save({ stage: 'provisional' });
    log(`thread/name/set failed: ${res.error}`);
    return { ok: false, why: 'set failed' };
  }
  if (res.value && res.value.skipped) {
    save({ stage: res.value.skipped === 'user' ? 'user' : 'skip', reason: res.value.skipped, title: res.value.name });
    log(`not naming: ${res.value.skipped}`);
    return { ok: false, why: res.value.skipped };
  }
  save({ stage: 'final', title: full });
  log(`final "${full}" via ${res.mode || 'app-server'}`);
  return { ok: true, title: full };
}

function readStdin() {
  return new Promise((resolve) => {
    const chunks = [];
    process.stdin.on('data', (c) => chunks.push(c));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    process.stdin.on('error', () => resolve(''));
    setTimeout(() => resolve(Buffer.concat(chunks).toString('utf8')), 5000).unref();
  });
}

async function main() {
  const arg = process.argv[2];
  try {
    if (arg === '--worker') {
      const job = JSON.parse(process.env[JOB_ENV] || 'null');
      const env = { ...process.env };
      delete env[JOB_ENV];
      await worker(job, { env });
    } else {
      let input = null;
      try { input = JSON.parse(await readStdin()); } catch { input = null; }
      await run(arg, input);
    }
  } catch (err) {
    try { state.appendLog(stateDirFor(process.env), `codex fatal ${arg}: ${err && err.stack}`); } catch { /* ignore */ }
  }
  process.exitCode = 0;
}

if (require.main === module) main();

module.exports = {
  run, worker, refusal, readSessionMeta, isHeadlessMeta, codexHome, stateDirFor,
  STATE_VERSION, MAX_ATTEMPTS, RETRY_INTERVAL_MS, JOB_ENV,
};
