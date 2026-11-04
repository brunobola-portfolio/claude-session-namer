#!/usr/bin/env node
'use strict';
/**
 * Grok Build (xAI `grok` CLI) adapter.
 *
 *   node hook.js            Grok command hook: UserPromptSubmit (JSON on stdin)
 *   node hook.js --worker   internal: detached generation + rename
 *
 * Grok hooks cannot return a title (an allowing UserPromptSubmit hook's stdout
 * is discarded), so the hook prints nothing, exits at once and hands off to a
 * detached worker that:
 *   1. generates the topic with `claude -p` (lib/generate.js);
 *   2. renames the session through Grok's ACP extension `_x.ai/session/rename`
 *      (see acp.js), the same store `/resume`, the dashboard and
 *      `grok sessions list` read.
 * Grok then treats the title as manual and stops auto-titling that session.
 * Once a session is named the adapter never touches it again.
 */
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const state = require('../../lib/state');
const title = require('../../lib/title');
const { makeTitle, projectTitle } = require('../_shared/make-title');
const { renameSession } = require('./acp');

const MAX_ATTEMPTS = 3;
const RETRY_INTERVAL_MS = 60_000;
const SAFE_ID = /^[A-Za-z0-9._-]{1,128}$/;
const JOB_ENV = 'SESSION_NAMER_GROK_JOB';

const grokHome = (env) => (env.GROK_HOME && env.GROK_HOME.trim()) || path.join(env.USERPROFILE || env.HOME || os.homedir(), '.grok');
const stateDirFor = (env) => state.stateDir({ ...env, CLAUDE_CONFIG_DIR: grokHome(env) });

const truthy = (v) => ['1', 'true', 'yes', 'on'].includes(String(v || '').trim().toLowerCase());

function readInput(raw) {
  try {
    const data = JSON.parse(String(raw || '').trim() || '{}');
    return data && typeof data === 'object' ? data : {};
  } catch {
    return {};
  }
}

/** Grok sends Claude-style and camelCase keys; accept both. */
function normalize(input, env = process.env) {
  const ev = String(input.hook_event_name || input.hookEventName || env.GROK_HOOK_EVENT || '');
  const event = /^user_?prompt_?submit$/i.test(ev) || ev === 'UserPromptSubmit' ? 'UserPromptSubmit' : ev;
  const prompt = [input.prompt, input.userPrompt, input.user_prompt].find((p) => typeof p === 'string') || '';
  return {
    event,
    sessionId: String(input.sessionId || input.session_id || env.GROK_SESSION_ID || ''),
    cwd: input.cwd || input.workspaceRoot || env.GROK_WORKSPACE_ROOT || process.cwd(),
    prompt,
    subagent: !!(input.subagentType || input.agentType || input.parentSessionId),
  };
}

function spawnWorker(job, { env = process.env, spawn = childProcess.spawn } = {}) {
  try {
    const child = spawn(process.execPath, [__filename, '--worker'], {
      env: { ...env, [JOB_ENV]: JSON.stringify(job) },
      stdio: 'ignore', detached: true, windowsHide: true, cwd: job.cwd,
    });
    child.on('error', () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}

/** @returns {{action:string}} */
function handleHook(input, { env = process.env, now = Date.now(), spawnJob = (job) => spawnWorker(job, { env }), project = projectTitle } = {}) {
  if (truthy(env.SESSION_NAMER_NESTED)) return { action: 'skip-nested' };
  const n = normalize(input, env);
  if (n.event !== 'UserPromptSubmit') return { action: 'ignore' };
  if (n.subagent) return { action: 'skip-subagent' };
  if (!SAFE_ID.test(n.sessionId)) return { action: 'skip-no-session' };
  const dir = stateDirFor(env);
  const st = state.readState(dir, n.sessionId) || { stage: 'provisional', attempts: 0, lastAttemptAt: 0 };
  if (st.stage !== 'provisional') return { action: `skip-${st.stage}` };
  const { cfg } = project({ cwd: n.cwd, env });
  if (!cfg.enabled) return { action: 'disabled' };
  if (!title.isEligiblePrompt(n.prompt)) return { action: 'ineligible' };
  if (st.attempts >= MAX_ATTEMPTS) return { action: 'gave-up' };
  if (st.lastAttemptAt && now - st.lastAttemptAt < RETRY_INTERVAL_MS) return { action: 'wait' };
  st.attempts += 1;
  st.lastAttemptAt = now;
  state.writeState(dir, n.sessionId, st);
  const ok = spawnJob({ sessionId: n.sessionId, cwd: n.cwd, prompt: title.truncatePrompt(n.prompt) });
  state.appendLog(dir, `[grok] ${n.sessionId}: ${ok ? `worker started (attempt ${st.attempts})` : 'worker spawn failed'}`);
  return { action: ok ? 'generating' : 'spawn-failed' };
}

/**
 * Grok's own record of a session: <grokHome>/sessions/<urlencoded cwd>/<id>/summary.json
 * (`generated_title`, `title_is_manual`). Null when it cannot be read.
 */
function readSummary(env, cwd, sessionId, { read = (p) => fs.readFileSync(p, 'utf8') } = {}) {
  if (!SAFE_ID.test(String(sessionId)) || !cwd) return null;
  try {
    const data = JSON.parse(read(path.join(grokHome(env), 'sessions', encodeURIComponent(String(cwd)), sessionId, 'summary.json')));
    return data && typeof data === 'object' ? data : null;
  } catch {
    return null;
  }
}

/**
 * Why the session must not be renamed, or null. `listed` is the session/list
 * entry (or null), `summary` Grok's summary.json (or null), `own` the title
 * this adapter wrote earlier (if any).
 *  - title_is_manual with a title that is not ours: the user named it;
 *  - no summary (manual flag unknown) and a title that is not ours: assume
 *    the user's, since Grok's auto-title cannot be told apart.
 */
function refusal({ listed, summary, own = null }) {
  const current = String((listed && listed.title) || (summary && summary.generated_title) || '').trim();
  if (!current || current === own) return null;
  if (summary && typeof summary.title_is_manual === 'boolean') return summary.title_is_manual ? 'user' : null;
  return 'user';
}

async function runWorker(job, {
  env = process.env, make = makeTitle, rename = renameSession, summaryOf = readSummary,
} = {}) {
  const dir = stateDirFor(env);
  const log = (l) => state.appendLog(dir, `[grok] ${job.sessionId}: ${l}`);
  const r = await make({ prompt: job.prompt, cwd: job.cwd, env, log: (l) => log(`generate ${l}`) });
  if (r.reason !== 'ok') {
    log(`no topic (${r.reason})`);
    return { ok: false, reason: r.reason };
  }
  const st = state.readState(dir, job.sessionId) || { stage: 'provisional', attempts: 1, lastAttemptAt: Date.now() };
  if (st.stage !== 'provisional') return { ok: false, reason: `stage ${st.stage}` };
  // Read the session right before writing: never replace a title the user chose.
  const check = (listed) => refusal({
    listed, summary: summaryOf(env, (listed && listed.cwd) || job.cwd, job.sessionId), own: st.title || null,
  });
  const res = await rename({ sessionId: job.sessionId, title: r.title, cwd: job.cwd, env, check });
  if (res.skipped) {
    st.stage = res.skipped === 'user' ? 'user' : 'skip';
    st.title = res.title || null;
    state.writeState(dir, job.sessionId, st);
    log(`not renaming: ${res.skipped}${res.title ? ` ("${res.title}")` : ''}`);
    return { ok: false, reason: res.skipped };
  }
  if (!res.ok) {
    log(`rename failed: ${res.error}`);
    return { ok: false, reason: res.error };
  }
  st.stage = 'final';
  st.title = r.title;
  state.writeState(dir, job.sessionId, st);
  log(`renamed "${r.title}"`);
  return { ok: true, title: r.title };
}

function main(argv = process.argv.slice(2)) {
  const done = () => process.exit(0);
  if (argv[0] === '--worker') {
    let job = null;
    try { job = JSON.parse(process.env[JOB_ENV] || 'null'); } catch { job = null; }
    if (!job || !SAFE_ID.test(String(job.sessionId || ''))) return done();
    runWorker(job).catch(() => {}).finally(done);
    return undefined;
  }
  const chunks = [];
  process.stdin.on('data', (d) => chunks.push(d));
  process.stdin.on('error', done);
  process.stdin.on('end', () => {
    try { handleHook(readInput(Buffer.concat(chunks).toString('utf8'))); } catch { /* never block a prompt */ }
    done();
  });
  return undefined;
}

if (require.main === module) main();

module.exports = { handleHook, runWorker, refusal, readSummary, normalize, readInput, spawnWorker, grokHome, JOB_ENV, MAX_ATTEMPTS };
