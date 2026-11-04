#!/usr/bin/env node
'use strict';
/**
 * Cline CLI adapter: "<project> - <topic>" session titles.
 *
 * Cline (3.x, SDK-based CLI) discovers hook files by name in its hook
 * directories (~/.cline/hooks, ~/Documents/Cline/Hooks, <workspace>/.clinerules/hooks,
 * <workspace>/.cline/hooks). A file called TaskStart.js or UserPromptSubmit.js
 * is run as `node <file>` with the hook payload on stdin. install.js writes two
 * such one-line stubs that require this file.
 *
 * Flow:
 *   1. The stub process reads the payload and re-spawns this file detached
 *      (`--worker`), then exits at once. Cline already runs these two hooks
 *      fire-and-forget, so this only matters if a host turns on blocking
 *      run-start hooks; either way the task is never held up.
 *   2. The worker finds the history record whose sessionId equals
 *      payload.sessionContext.rootSessionId (the hook's taskId is a different
 *      "conv_..." id), takes the prompt, asks lib/generate.js for a topic and
 *      sets the title with the documented `cline history update --session-id
 *      <id> --title <title>`.
 *
 * Safety: at most MAX_ATTEMPTS generations per session (RETRY_INTERVAL_MS
 * apart), a title that is neither Cline's prompt-derived default nor the one
 * written here is treated as the user's and never touched, subagent payloads
 * are ignored, and every path exits 0.
 */
const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const title = require('../../lib/title');
const state = require('../../lib/state');
const { loadConfig } = require('../../lib/config');
const { generateTopic } = require('../../lib/generate');
const safeSpawn = require('../_shared/safe-spawn');

const STATE_VERSION = 1;
const MAX_ATTEMPTS = 3;
const RETRY_INTERVAL_MS = 60_000;
/**
 * A claim younger than this belongs to a worker that is still running. It is
 * longer than RETRY_INTERVAL_MS and than one worker's worst case (two CLI
 * calls of 20 s plus a 22 s generation), so a slow worker is never doubled.
 */
const INFLIGHT_MS = 90_000;
const EVENTS = new Set(['agent_start', 'prompt_submit']);
const PAYLOAD_ENV = 'SESSION_NAMER_CLINE_PAYLOAD';
const STATE_PREFIX = 'cline-';

const collapse = (s) => String(s || '').replace(/\s+/g, ' ').trim();

/** Cline stores the first prompt wrapped as <user_input mode="act">...</user_input>. */
function stripPrompt(raw) {
  let s = String(raw || '');
  s = s.replace(/<user_input\b[^>]*>/gi, '').replace(/<\/user_input>/gi, '');
  return s.trim();
}

/**
 * Cline's default title is derived from the prompt (its first line, cut to a
 * fixed length). Accept the title as "default" when it is a prefix of the
 * prompt's first line or the other way round, whitespace-insensitively.
 */
function isDefaultTitle(current, prompt) {
  const t = collapse(current).toLowerCase();
  if (!t) return true;
  const first = collapse(stripPrompt(prompt).split(/\r?\n/)[0]).toLowerCase();
  if (!first) return false;
  return first.startsWith(t) || t.startsWith(first);
}

function gitIn(cwd) {
  return (args) => {
    try {
      const r = childProcess.spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 3000, windowsHide: true });
      return r.status === 0 ? r.stdout.trim() || null : null;
    } catch {
      return null;
    }
  };
}

/**
 * How to invoke the Cline CLI, always without a shell: a title passed through
 * cmd.exe would have `%VAR%` expanded (leaking environment values into the
 * title) and `&`/`"` treated as syntax. Cline exports CLINE_WRAPPER_PATH (its
 * Node launcher script) to hooks, so `node <wrapper>` reaches the same
 * install. A `cline.cmd` npm shim is resolved to the script behind it.
 * Returns null when only cmd.exe could run it (the caller then refuses).
 */
function clineCommand(env = process.env, platform = process.platform, opts = {}) {
  const o = { platform, ...opts };
  const explicit = env.SESSION_NAMER_CLINE_PATH && env.SESSION_NAMER_CLINE_PATH.trim();
  if (explicit) return safeSpawn.toCommand(explicit, o);
  const wrapper = env.CLINE_WRAPPER_PATH && env.CLINE_WRAPPER_PATH.trim();
  if (wrapper) return { command: process.execPath, args: [wrapper] };
  return safeSpawn.findOnPath('cline', env, o) || (platform === 'win32' ? null : { command: 'cline', args: [] });
}

/** Run the Cline CLI (argv only). Kills the whole tree on timeout. */
async function runCline(args, { env = process.env, timeoutMs = 20000, run = safeSpawn.runCommand } = {}) {
  const c = clineCommand(env);
  if (!c) return { status: 1, stdout: '', stderr: 'no shell-free cline command (set SESSION_NAMER_CLINE_PATH to its Node script)' };
  const r = await run(c, args, { env: { ...env, SESSION_NAMER_NESTED: '1' }, timeoutMs });
  return { status: r.timedOut ? 1 : r.code, stdout: r.stdout || '', stderr: r.stderr || '' };
}

/** Default dependency: the session record from `cline history --json`. */
async function getSession(sessionId, env) {
  const r = await runCline(['history', '--json', '--limit', '200'], { env });
  if (r.status !== 0) return null;
  try {
    const list = JSON.parse(r.stdout);
    return Array.isArray(list) ? list.find((s) => s && s.sessionId === sessionId) || null : null;
  } catch {
    return null;
  }
}

/** Default dependency: the documented title update. */
async function setTitle(sessionId, newTitle, env) {
  const r = await runCline(['history', 'update', '--session-id', sessionId, '--title', newTitle], { env });
  return r.status === 0;
}

/**
 * Exclusive per-session claim. TaskStart and UserPromptSubmit fire together
 * for the first prompt, so two workers start at once; the `wx` open lets only
 * one of them through. A claim older than INFLIGHT_MS is stale (crashed
 * worker) and is taken over.
 * @returns {Function|null} release function, or null when another worker holds it
 */
function claim(dir, key, now) {
  const file = path.join(dir, 'state', `${key}.lock`);
  try { fs.mkdirSync(path.dirname(file), { recursive: true }); } catch { /* writeState reports */ }
  const release = () => { try { fs.unlinkSync(file); } catch { /* gone */ } };
  for (let i = 0; i < 2; i += 1) {
    try {
      fs.writeFileSync(file, String(now()), { flag: 'wx' });
      return release;
    } catch (err) {
      if (!err || err.code !== 'EEXIST') return () => {}; // no lock possible: proceed unguarded
      let age = 0;
      try { age = now() - Number(fs.readFileSync(file, 'utf8')); } catch { age = Infinity; }
      if (!(age > INFLIGHT_MS)) return null;
      release(); // stale: take it over
    }
  }
  return null;
}

/**
 * @param {object} payload Cline hook payload
 * @param {{env?:object, git?:Function, generate?:Function, getSession?:Function,
 *          setTitle?:Function, now?:Function, stateDir?:string}} deps
 * @returns {Promise<string|null>} the title written, or null
 */
async function run(payload, deps = {}) {
  if (!payload || typeof payload !== 'object') return null;
  const env = deps.env || process.env;
  if (env.SESSION_NAMER_NESTED === '1') return null;
  if (!EVENTS.has(payload.hookName)) return null;
  if (payload.parent_agent_id) return null; // subagent / teammate run
  const sessionId = String((payload.sessionContext && payload.sessionContext.rootSessionId) || '');
  if (!sessionId || !/^[A-Za-z0-9._-]{1,100}$/.test(sessionId)) return null;

  const roots = Array.isArray(payload.workspaceRoots) ? payload.workspaceRoots : [];
  const cwd = (payload.workspaceInfo && payload.workspaceInfo.rootPath) || roots[0] || process.cwd();
  const git = deps.git || gitIn(cwd);
  const now = deps.now || Date.now;
  const generate = deps.generate || generateTopic;
  const lookup = deps.getSession || getSession;
  const write = deps.setTitle || setTitle;

  let repoRoot = null;
  try { repoRoot = git(['rev-parse', '--show-toplevel']); } catch { repoRoot = null; }
  const cfg = loadConfig({ env, repoRoot });
  if (!cfg.enabled) return null;

  const dir = deps.stateDir || state.stateDir(env);
  const key = `${STATE_PREFIX}${sessionId}`;
  const log = (m) => state.appendLog(dir, `cline ${payload.hookName} ${sessionId.slice(0, 18)} ${m}`);
  const readSt = () => {
    const current = state.readState(dir, key);
    return current && current.v === STATE_VERSION ? current : {};
  };
  const blocked = (s) => s.stage === 'final' || s.stage === 'user' || (s.attempts || 0) >= MAX_ATTEMPTS
    || (s.lastAttemptTs && now() - s.lastAttemptTs < RETRY_INTERVAL_MS);
  if (blocked(readSt())) return null;

  // Claim the session before the slow lookup, then re-read: the other event's
  // worker may have finished between our first read and the claim.
  const release = (deps.claim || claim)(dir, key, now);
  if (!release) { log('another worker is naming this session'); return null; }
  try {
    const st = readSt();
    if (blocked(st)) return null;
    return await nameSession({ st, payload, sessionId, cwd, git, env, cfg, dir, key, log, now, generate, lookup, write });
  } finally {
    release();
  }
}

async function nameSession({ st, payload, sessionId, cwd, git, env, cfg, dir, key, log, now, generate, lookup, write }) {
  const attempts = st.attempts || 0;
  const record = await lookup(sessionId, env);
  if (!record) { log('session not found in cline history'); return null; }
  const firstPrompt = stripPrompt(record.prompt);
  const prompt = stripPrompt(payload.userPromptSubmit && payload.userPromptSubmit.prompt) || firstPrompt;
  const currentTitle = record.metadata && typeof record.metadata.title === 'string' ? record.metadata.title : '';
  if (currentTitle && currentTitle !== st.title && !isDefaultTitle(currentTitle, firstPrompt) && !isDefaultTitle(currentTitle, prompt)) {
    state.writeState(dir, key, { v: STATE_VERSION, stage: 'user', title: currentTitle, ts: now() });
    log('user-titled, leaving alone');
    return null;
  }
  if (!title.isEligiblePrompt(prompt)) return null;

  const project = title.resolveProject({ cwd, projectSource: cfg.projectSource, git, override: cfg.projectOverride });
  state.writeState(dir, key, { v: STATE_VERSION, stage: 'provisional', attempts: attempts + 1, lastAttemptTs: now(), ts: now() });
  let raw = null;
  try {
    raw = await generate({ prompt, model: cfg.model, timeoutMs: cfg.timeoutMs, env, log: (m) => log(`generate: ${m}`) });
  } catch (err) {
    log(`generate threw: ${err && err.message}`);
  }
  const topic = title.sanitizeTopic(raw, { maxWords: cfg.maxWords });
  if (!topic) {
    state.writeState(dir, key, { v: STATE_VERSION, stage: 'provisional', attempts: attempts + 1, lastAttemptTs: now(), ts: now() });
    log(`generation failed (attempt ${attempts + 1})`);
    return null;
  }
  const full = title.formatTitle(project, topic, { separator: cfg.separator });
  if (!(await write(sessionId, full, env))) {
    state.writeState(dir, key, { v: STATE_VERSION, stage: 'provisional', attempts: attempts + 1, lastAttemptTs: now(), ts: now() });
    log('cline history update failed');
    return null;
  }
  state.writeState(dir, key, { v: STATE_VERSION, stage: 'final', title: full, attempts: attempts + 1, lastAttemptTs: now(), ts: now() });
  log(`final "${full}"`);
  return full;
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

/** Hand the payload to a detached copy of this script and return at once. */
function spawnWorker(raw, { spawn = childProcess.spawn, env = process.env } = {}) {
  const child = spawn(process.execPath, [path.resolve(__filename), '--worker'], {
    detached: true, stdio: 'ignore', windowsHide: true,
    env: { ...env, [PAYLOAD_ENV]: Buffer.from(raw, 'utf8').toString('base64') },
  });
  child.on('error', () => {});
  child.unref();
}

async function main() {
  try {
    if (process.env.SESSION_NAMER_NESTED === '1') return;
    if (process.argv.includes('--worker')) {
      const raw = Buffer.from(process.env[PAYLOAD_ENV] || '', 'base64').toString('utf8');
      await run(JSON.parse(raw));
      return;
    }
    const raw = await readStdin();
    const payload = JSON.parse(raw);
    if (!EVENTS.has(payload && payload.hookName)) return;
    spawnWorker(raw);
  } catch (err) {
    try { state.appendLog(state.stateDir(process.env), `cline fatal: ${err && err.message}`); } catch { /* ignore */ }
  } finally {
    process.exitCode = 0;
  }
}

if (require.main === module) main();

module.exports = { run, stripPrompt, isDefaultTitle, clineCommand, runCline, claim, spawnWorker, main, MAX_ATTEMPTS, STATE_PREFIX, INFLIGHT_MS, RETRY_INTERVAL_MS };
