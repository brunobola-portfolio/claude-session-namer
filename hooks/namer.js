#!/usr/bin/env node
'use strict';
/**
 * Hook entry point: `node namer.js <SessionStart|UserPromptSubmit|Stop>`.
 * Reads the hook JSON from stdin, prints a JSON object with
 * hookSpecificOutput.sessionTitle when a title should change, nothing
 * otherwise. Always exits 0.
 */
const childProcess = require('node:child_process');
const { loadConfig } = require('../lib/config');
const state = require('../lib/state');
const title = require('../lib/title');
const { generateTopic } = require('../lib/generate');

const STATE_VERSION = 1;
const MAX_ATTEMPTS = 3;
const RETRY_INTERVAL_MS = 60_000;
const EVENTS = new Set(['SessionStart', 'UserPromptSubmit', 'Stop']);

const output = (event, sessionTitle) => ({ hookSpecificOutput: { hookEventName: event, sessionTitle } });

/**
 * Recognise `/session-name ...` prompts (the plugin's own slash command; the
 * hook sees it before Claude does, and Claude Code passes plugin commands
 * through as `/session-name` or `/session-namer:session-name`).
 * @returns {{kind:'set',topic:string}|{kind:'regenerate'}|{kind:'other'}|null}
 */
function parseCommand(prompt) {
  if (typeof prompt !== 'string') return null;
  const m = prompt.trim().match(/^\/(?:session-namer:)?session-name(?:\s+([\s\S]*))?$/i);
  if (!m) return null;
  const arg = (m[1] || '').trim();
  if (!arg || /^--regenerate$/i.test(arg)) return { kind: 'regenerate' };
  if (/^--/.test(arg)) return { kind: 'other' };
  const topic = title.sanitizeTopic(arg) || arg.replace(/\s+/g, ' ').slice(0, 60).trim();
  return topic ? { kind: 'set', topic } : { kind: 'regenerate' };
}

/** Run `git <args>` in cwd, returning trimmed stdout or null. Never throws. */
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

function repoRootFrom(cwd, git) {
  try {
    return git(['rev-parse', '--show-toplevel']) || null;
  } catch {
    return null;
  }
}

/**
 * @param {string} event
 * @param {object} input hook JSON
 * @param {{env?:object, git?:Function, generate?:Function, now?:Function}} deps
 * @returns {Promise<object|null>}
 */
async function run(event, input, deps = {}) {
  if (!EVENTS.has(event) || !input || typeof input !== 'object') return null;
  const env = deps.env || process.env;
  if (env.SESSION_NAMER_NESTED === '1') return null;
  const cwd = typeof input.cwd === 'string' && input.cwd ? input.cwd : process.cwd();
  const git = deps.git || defaultGit(cwd);
  const now = deps.now || Date.now;
  const generate = deps.generate || generateTopic;
  const sessionId = String(input.session_id || '');
  if (!sessionId) return null;

  const repoRoot = repoRootFrom(cwd, git);
  const cfg = loadConfig({ env, repoRoot });
  if (!cfg.enabled) return null;

  const dir = state.stateDir(env);
  const log = (msg) => state.appendLog(dir, `${event} ${sessionId.slice(0, 8)} ${msg}`);
  const project = title.resolveProject({ cwd, projectSource: cfg.projectSource, git, override: cfg.projectOverride });
  const current = state.readState(dir, sessionId);
  const st = current && current.v === STATE_VERSION ? current : null;
  const save = (patch) => state.writeState(dir, sessionId, { v: STATE_VERSION, project, attempts: 0, ...(st || {}), ...patch, ts: now() });

  if (event === 'SessionStart') {
    if (input.agent_type) return null;
    if (!['startup', 'resume', 'fork'].includes(input.source)) return null;
    state.pruneOld(dir);
    const existing = typeof input.session_title === 'string' ? input.session_title.trim() : '';
    if (existing) {
      if (st && existing === st.title) return null; // our own title, nothing to do
      save({ stage: 'user', title: existing });
      log('user-titled, leaving alone');
      return null;
    }
    if (st && st.stage === 'user') return null;
    save({ stage: 'provisional', title: project });
    log(`provisional "${project}"`);
    return output(event, project);
  }

  if (event === 'UserPromptSubmit') {
    const command = parseCommand(input.prompt);
    if (command) {
      if (command.kind === 'set') {
        const full = title.formatTitle(project, command.topic, { separator: cfg.separator });
        save({ stage: 'user', title: full, reasserted: true });
        log(`manual "${full}"`);
        return output(event, full);
      }
      if (command.kind === 'regenerate') {
        save({ stage: 'provisional', title: project, attempts: 0, lastAttemptTs: 0, reasserted: false });
        log('re-armed by /session-name');
        return output(event, project);
      }
      return null; // --remote / --doctor: handled by the command's markdown
    }
    if (st && st.stage !== 'provisional') return null;
    if (!title.isEligiblePrompt(input.prompt)) return null;
    const attempts = (st && st.attempts) || 0;
    if (attempts >= MAX_ATTEMPTS) return null;
    if (st && st.lastAttemptTs && now() - st.lastAttemptTs < RETRY_INTERVAL_MS) return null;
    save({ stage: 'provisional', title: (st && st.title) || project, attempts: attempts + 1, lastAttemptTs: now() });
    let raw = null;
    try {
      raw = await generate({ prompt: input.prompt, model: cfg.model, timeoutMs: cfg.timeoutMs, env, log: (m) => log(`generate: ${m}`) });
    } catch (err) {
      log(`generate threw: ${err && err.message}`);
    }
    const topic = title.sanitizeTopic(raw);
    if (!topic) {
      log(`generation failed (attempt ${attempts + 1})`);
      return null;
    }
    const full = title.formatTitle(project, topic, { separator: cfg.separator });
    save({ stage: 'final', title: full, attempts: attempts + 1, lastAttemptTs: now(), reasserted: false });
    log(`final "${full}"`);
    return output(event, full);
  }

  if (event === 'Stop') {
    if (!st || st.stage !== 'final' || st.reasserted) return null;
    save({ reasserted: true });
    log('re-asserted final title');
    return output(event, st.title);
  }
  return null;
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
  const event = process.argv[2];
  let input = null;
  try {
    input = JSON.parse(await readStdin());
  } catch {
    input = null;
  }
  let result = null;
  try {
    result = await run(event, input);
  } catch (err) {
    try { state.appendLog(state.stateDir(process.env), `fatal ${event}: ${err && err.stack}`); } catch { /* ignore */ }
  }
  if (result) process.stdout.write(JSON.stringify(result));
  process.exitCode = 0;
}

if (require.main === module) main();

module.exports = { run, STATE_VERSION, MAX_ATTEMPTS, RETRY_INTERVAL_MS };
