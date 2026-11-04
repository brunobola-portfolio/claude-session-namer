'use strict';
/**
 * Pi (pi-coding-agent) adapter for claude-session-namer.
 *
 *   session_start  -> session name becomes "<project>"            (0 ms, no network)
 *   input          -> first eligible prompt starts topic generation in the
 *                     background (the prompt is never delayed); when it
 *                     resolves the name becomes "<project> - <topic>"
 *   session_info_changed -> a name we did not set (/name, RPC) locks us out
 *   session_shutdown -> waits (bounded) for a pending generation so that
 *                     `pi -p` runs still get their name written
 *
 * Plain CommonJS on purpose: Pi loads extensions through jiti, which accepts
 * `module.exports = function (pi) {}`, and `node --test` can require this
 * file without a TypeScript toolchain. The shared logic is required from the
 * repository's lib/ (relative path), so the adapter must be loaded in place
 * (`pi install <repo>/adapters/pi`, a local source that Pi does not copy).
 */
const childProcess = require('node:child_process');
const os = require('node:os');
const path = require('node:path');
const { loadConfig } = require('../../lib/config');
const { appendLog } = require('../../lib/state');
const title = require('../../lib/title');
const { generateTopic, promptForStdin, SYSTEM_PROMPT } = require('../../lib/generate');

const MAX_ATTEMPTS = 3;
/** Upper bound for waiting on a pending generation when the session is replaced (/new, /resume, /fork). */
const SWITCH_WAIT_MS = 3000;
/** Upper bound for waiting on a pending generation when Pi quits (`pi -p` runs included). */
const QUIT_WAIT_MS = 5000;
const BACKENDS = new Set(['auto', 'pi', 'claude']);
/**
 * Cheap sibling models, best first. Matched against the id within the active
 * provider. The generic words are anchored to id separators, so "gemini"
 * does not count as "mini" and "ministral" is not "mini" either.
 */
const word = (w) => new RegExp(`(?:^|[-_/.:])${w}(?:$|[-_/.:])`, 'i');
const CHEAP_MODEL_PATTERNS = [/haiku/i, /flash-lite/i, /flash/i, word('nano'), word('mini'), word('small')];
const NOT_CHAT = /audio|realtime|tts|image|embed|transcri|search|vision-preview|moderation/i;

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

function logDir(env) {
  const agentDir = env.PI_CODING_AGENT_DIR && env.PI_CODING_AGENT_DIR.trim()
    ? env.PI_CODING_AGENT_DIR.trim()
    : path.join(env.HOME || env.USERPROFILE || os.homedir(), '.pi', 'agent');
  return path.join(agentDir, 'session-namer');
}

const modelKey = (m) => (m ? `${m.provider}/${m.id}` : 'none');

/**
 * Choose the Pi model used for the topic: SESSION_NAMER_PI_MODEL ("provider/id"),
 * else a cheap model of the active provider, else the active model. Only models
 * with configured auth qualify. Returns null when Pi has nothing usable.
 */
function pickPiModel(ctx, env) {
  const reg = ctx && ctx.modelRegistry;
  if (!reg || typeof reg.streamSimple !== 'function') return null;
  const authed = (m) => {
    try { return Boolean(m) && reg.hasConfiguredAuth(m); } catch { return false; }
  };
  const wanted = env.SESSION_NAMER_PI_MODEL && env.SESSION_NAMER_PI_MODEL.trim();
  if (wanted) {
    const slash = wanted.indexOf('/');
    const m = slash > 0 ? reg.find(wanted.slice(0, slash), wanted.slice(slash + 1)) : null;
    return authed(m) ? m : null;
  }
  const active = ctx.model;
  if (!active) return null;
  let available = [];
  try { available = reg.getAvailable() || []; } catch { available = []; }
  const siblings = available.filter((m) => m && m.provider === active.provider && !NOT_CHAT.test(m.id));
  for (const re of CHEAP_MODEL_PATTERNS) {
    const hit = siblings.find((m) => re.test(m.id) && authed(m));
    if (hit) return hit;
  }
  return authed(active) ? active : null;
}

/** One short completion through Pi's own provider/auth stack. Resolves to text or null. */
async function generateWithPi({ prompt, ctx, env, timeoutMs, log }) {
  const model = pickPiModel(ctx, env);
  if (!model) {
    log('pi: no model with configured auth');
    return null;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();
  try {
    const stream = ctx.modelRegistry.streamSimple(model, {
      systemPrompt: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: [{ type: 'text', text: promptForStdin(prompt) }], timestamp: Date.now() }],
    }, { maxTokens: 256, signal: controller.signal });
    const msg = await stream.result();
    if (!msg || msg.stopReason === 'error' || msg.stopReason === 'aborted') {
      log(`pi: ${modelKey(model)} ${msg ? msg.stopReason : 'no result'} ${(msg && msg.errorMessage) || ''} after ${Date.now() - started} ms`);
      return null;
    }
    const text = (msg.content || []).filter((c) => c && c.type === 'text').map((c) => c.text).join(' ').trim();
    log(`pi: ${modelKey(model)} ok after ${Date.now() - started} ms`);
    return text || null;
  } catch (err) {
    log(`pi: ${modelKey(model)} threw ${err && err.message}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Extension factory. `deps` exists for tests only.
 * @param {import('@earendil-works/pi-coding-agent').ExtensionAPI} pi
 * @param {{env?:object, git?:Function, generateClaude?:Function, log?:Function}} [deps]
 */
function sessionNamer(pi, deps = {}) {
  const env = deps.env || process.env;
  // Recursion guard: never act inside a process spawned by the namer itself.
  if (env.SESSION_NAMER_NESTED === '1') return;

  const generateClaude = deps.generateClaude || generateTopic;
  const s = { cfg: null, project: null, own: null, locked: true, attempts: 0, pending: null, done: false, alive: false };
  let log = deps.log || ((msg) => appendLog(logDir(env), `pi ${msg}`));

  const currentName = () => {
    try { return pi.getSessionName() || undefined; } catch { return undefined; }
  };
  const setName = (name) => {
    s.own = name; // before the call: session_info_changed fires synchronously with our own name
    try { pi.setSessionName(name); return true; } catch (err) { log(`setSessionName threw ${err && err.message}`); return false; }
  };

  pi.on('session_start', async (event, ctx) => {
    try {
      const cwd = (ctx && ctx.cwd) || process.cwd();
      const git = deps.git || defaultGit(cwd);
      let repoRoot = null;
      try { repoRoot = git(['rev-parse', '--show-toplevel']) || null; } catch { repoRoot = null; }
      const cfg = loadConfig({ env, repoRoot });
      s.cfg = cfg;
      const sid = (() => { try { return String(ctx.sessionManager.getSessionId()).slice(-8); } catch { return '?'; } })();
      if (!deps.log) log = (msg) => appendLog(logDir(env), `pi ${sid} ${msg}`);
      if (!cfg.enabled) return;
      const headless = ctx && (ctx.mode === 'print' || ctx.mode === 'json');
      if (headless && !cfg.nameHeadless) return;
      s.project = title.resolveProject({ cwd, projectSource: cfg.projectSource, git, override: cfg.projectOverride });
      const existing = currentName();
      if (existing && existing !== s.project) {
        log(`session already named "${existing}" (${event && event.reason}), leaving alone`);
        return; // --name, /name, or a finished title from an earlier run: hands off
      }
      s.alive = true;
      s.locked = false;
      if (!existing) setName(s.project);
      else s.own = existing;
      log(`provisional "${s.project}" (${event && event.reason}, ${ctx && ctx.mode})`);
    } catch (err) {
      log(`session_start failed: ${err && err.stack}`);
    }
  });

  pi.on('session_info_changed', (event) => {
    const name = event && typeof event.name === 'string' ? event.name : undefined;
    if (s.locked || name === s.own) return;
    s.locked = true;
    log(`renamed by user to "${name}", leaving alone`);
  });

  const runGeneration = async (prompt, ctx) => {
    const { cfg } = s;
    const backendRaw = String(env.SESSION_NAMER_PI_BACKEND || 'auto').trim().toLowerCase();
    const backend = BACKENDS.has(backendRaw) ? backendRaw : 'auto';
    let topic = null;
    if (backend !== 'claude') {
      topic = title.sanitizeTopic(await generateWithPi({ prompt, ctx, env, timeoutMs: cfg.timeoutMs, log }), { maxWords: cfg.maxWords });
    }
    if (!topic && backend !== 'pi' && s.alive && !s.locked) {
      let raw = null;
      try {
        raw = await generateClaude({ prompt, model: cfg.model, timeoutMs: cfg.timeoutMs, env, log: (m) => log(`claude: ${m}`) });
      } catch (err) {
        log(`claude: threw ${err && err.message}`);
      }
      topic = title.sanitizeTopic(raw, { maxWords: cfg.maxWords });
    }
    if (!topic) {
      log(`generation failed (attempt ${s.attempts})`);
      return;
    }
    // Re-check: the user may have renamed the session while we were waiting.
    if (!s.alive || s.locked || currentName() !== s.own) {
      log('name changed while generating, leaving alone');
      return;
    }
    const full = title.formatTitle(s.project, topic, { separator: cfg.separator });
    if (setName(full)) {
      s.done = true;
      log(`final "${full}"`);
    }
  };

  pi.on('input', (event, ctx) => {
    try {
      if (!s.alive || s.locked || s.done || s.pending) return undefined;
      if (!event || event.source === 'extension') return undefined;
      if (!title.isEligiblePrompt(event.text)) return undefined;
      if (s.attempts >= MAX_ATTEMPTS) return undefined;
      if (currentName() !== s.own) { s.locked = true; return undefined; }
      s.attempts += 1;
      // Fire and forget: the user's prompt continues immediately.
      s.pending = runGeneration(event.text, ctx)
        .catch((err) => log(`generation threw ${err && err.message}`))
        .finally(() => { s.pending = null; });
    } catch (err) {
      log(`input failed: ${err && err.message}`);
    }
    return undefined; // never transform or swallow the prompt
  });

  pi.on('session_shutdown', async (event) => {
    const pending = s.pending;
    if (pending) {
      const cap = event && event.reason === 'quit' ? QUIT_WAIT_MS : SWITCH_WAIT_MS;
      let timer;
      await Promise.race([pending, new Promise((r) => { timer = setTimeout(r, cap); })]);
      clearTimeout(timer);
    }
    s.alive = false;
  });
}

module.exports = sessionNamer;
module.exports.default = sessionNamer;
module.exports._internals = { pickPiModel, generateWithPi, logDir, MAX_ATTEMPTS, CHEAP_MODEL_PATTERNS, QUIT_WAIT_MS };
