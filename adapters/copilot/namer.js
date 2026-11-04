'use strict';
/**
 * GitHub Copilot CLI adapter core: turns Copilot CLI extension events into
 * "<project> - <topic>" session names, reusing the repository lib/.
 *
 * Copilot CLI (1.0.105) exposes the session name to extensions through the
 * SDK RPC `session.name.get` / `session.name.set` (the same store `/rename`
 * and `--name` write: workspace.yaml `name`, `user_named: true`). The CLI
 * then emits `session.title_changed`, so the title shows in the session list,
 * `copilot --resume <name>` and the terminal tab ("<name> - GitHub Copilot").
 *
 * Flow per session (one extension process per foreground session):
 *   join        no name yet           -> name = project, stage provisional
 *               a name we did not set -> stage user, never touched
 *   user.message (typed by the user, eligible, provisional)
 *               -> lib/generate.js topic in the background -> name.set
 *   /session-name <topic>             -> manual name, stage user
 *   /session-name [--regenerate]      -> back to project, re-armed
 * Before every write the live name is re-read; one we did not set means the
 * user renamed the session (/rename) and the adapter steps aside for good.
 *
 * Every entry point swallows errors: the adapter must never break a session.
 */
const childProcess = require('node:child_process');
const path = require('node:path');
const title = require('../../lib/title');
const { generateTopic } = require('../../lib/generate');
const { loadConfig } = require('../../lib/config');
const stateLib = require('../../lib/state');

const STATE_VERSION = 1;
const MAX_ATTEMPTS = 3;
const RETRY_INTERVAL_MS = 60_000;
/** Copilot's validateSessionName: 1-100 chars, no control chars, no double quotes. */
const NAME_MAX = 100;

const collapse = (s) => String(s || '').replace(/\s+/g, ' ').trim();

/** Make a title acceptable to Copilot's session name validator. */
function toCopilotName(s) {
  const out = collapse(String(s || '').replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/"/g, "'"));
  return out.slice(0, NAME_MAX).trim();
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

/** Only text the user typed: no skill/agent injections, no autopilot continuations. */
function userPromptOf(data) {
  if (!data || typeof data !== 'object') return null;
  if (data.source || data.isAutopilotContinuation) return null;
  return typeof data.content === 'string' ? data.content : null;
}

/** `/session-name ...` argument parsing, same semantics as the Claude Code command. */
function parseCommandArgs(args) {
  const arg = collapse(args);
  if (!arg || /^--regenerate$/i.test(arg)) return { kind: 'regenerate' };
  if (/^--/.test(arg)) return { kind: 'other' };
  const topic = title.sanitizeTopic(arg) || arg.slice(0, 60).trim();
  return topic ? { kind: 'set', topic } : { kind: 'regenerate' };
}

/**
 * @param {{session:{sessionId:string, rpc:{name:{get:Function,set:Function}}, log?:Function},
 *          cwd?:string, env?:object, git?:Function, generate?:Function, now?:Function,
 *          stateDir?:string}} opts
 */
function createCopilotNamer({
  session, cwd = process.cwd(), env = process.env, git, generate = generateTopic,
  now = Date.now, stateDir,
}) {
  const sessionId = String((session && session.sessionId) || '');
  const dir = stateDir || path.join(stateLib.stateDir(env), 'copilot');
  const log = (m) => { try { stateLib.appendLog(dir, `copilot ${sessionId.slice(0, 8)} ${m}`); } catch { /* ignore */ } };
  let currentCwd = cwd;
  let inflight = null;
  let started = Promise.resolve();
  /** Names this process wrote or is writing (title_changed can arrive before set() resolves). */
  const ours = new Set();

  const disabled = () => env.SESSION_NAMER_NESTED === '1' || !sessionId;
  const ctx = () => {
    const g = git || gitIn(currentCwd);
    let repoRoot = null;
    try { repoRoot = g(['rev-parse', '--show-toplevel']); } catch { repoRoot = null; }
    const cfg = loadConfig({ env, repoRoot });
    const project = title.resolveProject({ cwd: currentCwd, projectSource: cfg.projectSource, git: g, override: cfg.projectOverride });
    return { cfg, project };
  };
  const read = () => {
    const st = stateLib.readState(dir, sessionId);
    return st && st.v === STATE_VERSION ? st : null;
  };
  const save = (st, patch) => {
    const next = { v: STATE_VERSION, attempts: 0, ...(st || {}), ...patch, ts: now() };
    stateLib.writeState(dir, sessionId, next);
    return next;
  };
  /**
   * Current name and whether the user chose it. workspaces.getWorkspace()
   * exposes `user_named` (false for Copilot's own auto-name from the first
   * prompt); name.get() is the fallback, where any name counts as the user's.
   */
  const liveName = async () => {
    const rpc = session.rpc;
    try {
      const r = rpc.workspaces && await rpc.workspaces.getWorkspace();
      const ws = r && r.workspace;
      if (ws && typeof ws === 'object' && 'user_named' in ws) {
        const name = typeof ws.name === 'string' && ws.name.trim() ? ws.name.trim() : null;
        return { name, userNamed: ws.user_named === true };
      }
    } catch { /* older CLI: fall back */ }
    const r = await rpc.name.get();
    const name = r && typeof r.name === 'string' && r.name.trim() ? r.name.trim() : null;
    return { name, userNamed: name !== null };
  };
  const setName = async (name) => {
    const clean = toCopilotName(name);
    if (!clean) return null;
    // Only a name that was actually written counts as ours: if set() fails,
    // the same text typed later by the user must still be the user's.
    await session.rpc.name.set({ name: clean });
    ours.add(clean);
    return clean;
  };
  /** True when the live name is not one this adapter wrote: the user owns it. */
  const userOwns = (live, st) => Boolean(live.name && live.userNamed && !ours.has(live.name) && !(st && live.name === st.title));

  function start() {
    started = doStart();
    return started;
  }

  async function doStart() {
    if (disabled()) return null;
    try {
      const { cfg, project } = ctx();
      if (!cfg.enabled) return null;
      const st = read();
      const live = await liveName();
      if (userOwns(live, st)) {
        if (!st || st.stage !== 'user' || st.title !== live.name) save(st, { stage: 'user', title: live.name });
        log('user-named, leaving alone');
        return null;
      }
      if (st && st.stage !== 'provisional') return null; // final (resumed) or user
      if (live.name === project && st) return null;
      // No name yet, or only Copilot's auto-name: the project name replaces it.
      const written = await setName(project);
      save(st, { stage: 'provisional', title: written, project });
      log(`provisional "${written}"`);
      return written;
    } catch (err) {
      log(`start failed: ${err && err.message}`);
      return null;
    }
  }

  async function nameFromPrompt(prompt) {
    const { cfg, project } = ctx();
    if (!cfg.enabled) return null;
    let st = read();
    if (!st || st.stage !== 'provisional') return null;
    if (!title.isEligiblePrompt(prompt)) return null;
    const attempts = st.attempts || 0;
    if (attempts >= MAX_ATTEMPTS) return null;
    if (st.lastAttemptTs && now() - st.lastAttemptTs < RETRY_INTERVAL_MS) return null;
    st = save(st, { attempts: attempts + 1, lastAttemptTs: now() });
    let raw = null;
    try {
      raw = await generate({ prompt, model: cfg.model, timeoutMs: cfg.timeoutMs, env, log: (m) => log(`generate: ${m}`) });
    } catch (err) {
      log(`generate threw: ${err && err.message}`);
    }
    const topic = title.sanitizeTopic(raw, { maxWords: cfg.maxWords });
    if (!topic) {
      log(`generation failed (attempt ${attempts + 1}): ${JSON.stringify(String(raw == null ? '' : raw).slice(0, 80))}`);
      return null;
    }
    // The user may have renamed the session while the model was thinking.
    const live = await liveName();
    if (userOwns(live, st)) {
      save(st, { stage: 'user', title: live.name });
      log('renamed by the user during generation, leaving alone');
      return null;
    }
    const written = await setName(title.formatTitle(project, topic, { separator: cfg.separator }));
    if (!written) return null;
    save(st, { stage: 'final', title: written });
    log(`final "${written}"`);
    return written;
  }

  /** Handler for `user.message` events. Generation runs once at a time, in the background. */
  function onUserMessage(event) {
    if (disabled() || inflight) return inflight;
    const prompt = userPromptOf(event && event.data);
    if (!prompt) return null;
    inflight = started.then(() => nameFromPrompt(prompt))
      .catch((err) => { log(`naming failed: ${err && err.message}`); return null; })
      .finally(() => { inflight = null; });
    return inflight;
  }

  /** Handler for `session.title_changed`: detect /rename by the user. */
  async function onTitleChanged() {
    if (disabled()) return null;
    try {
      const st = read();
      if (!st || st.stage === 'user') return null;
      const live = await liveName();
      if (userOwns(live, st)) {
        save(st, { stage: 'user', title: live.name });
        log('user-titled mid-session, leaving alone');
        return live.name;
      }
    } catch (err) {
      log(`title check failed: ${err && err.message}`);
    }
    return null;
  }

  function onContextChanged(event) {
    const c = event && event.data && event.data.cwd;
    if (typeof c === 'string' && c) currentCwd = c;
  }

  /** `/session-name` slash command. Returns the message to show the user. */
  async function command(args) {
    if (disabled()) return 'session-namer is disabled.';
    try {
      const { cfg, project } = ctx();
      const st = read();
      const cmd = parseCommandArgs(args);
      if (cmd.kind === 'set') {
        const written = await setName(title.formatTitle(project, cmd.topic, { separator: cfg.separator }));
        save(st, { stage: 'user', title: written });
        log(`manual "${written}"`);
        return `Session renamed to "${written}".`;
      }
      if (cmd.kind === 'regenerate') {
        const written = await setName(project);
        save(st, { stage: 'provisional', title: written, attempts: 0, lastAttemptTs: 0 });
        log('re-armed by /session-name');
        return `Session renamed to "${written}"; your next message will generate a topic.`;
      }
      return 'Usage: /session-name <topic> | /session-name --regenerate';
    } catch (err) {
      log(`command failed: ${err && err.message}`);
      return `session-namer: ${err && err.message}`;
    }
  }

  return { start, onUserMessage, onTitleChanged, onContextChanged, command, get inflight() { return inflight; } };
}

module.exports = { createCopilotNamer, toCopilotName, userPromptOf, parseCommandArgs, STATE_VERSION, MAX_ATTEMPTS };
