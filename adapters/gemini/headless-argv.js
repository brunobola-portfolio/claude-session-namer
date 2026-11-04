'use strict';
/**
 * Headless checks for the terminal-tab adapters (Gemini CLI, Qwen Code) that
 * go beyond `-p` / `--prompt` (adapters/_shared/headless.js). Used by
 * adapters/gemini/hook.js and adapters/qwen/hook.js; it belongs in
 * _shared/headless.js and can move there unchanged.
 *
 * Neither agent tells a hook how it was started. Checked in the bundles:
 *  - Gemini CLI 0.66.0 hook input is session_id, transcript_path, cwd,
 *    hook_event_name, timestamp plus the event's own fields; the hook env adds
 *    only GEMINI_PROJECT_DIR, GEMINI_CWD, GEMINI_SESSION_ID, GEMINI_PLANS_DIR
 *    and CLAUDE_PROJECT_DIR to Gemini's (by default unfiltered) environment.
 *  - Qwen Code 0.26.6 adds permission_mode and prompt_id; prompt_id has the
 *    same "<session>########<n>" form in interactive and non-interactive runs,
 *    and source_type is set only for daemon/ACP sessions.
 * What a hook can still tell reliably:
 *  - A positional prompt. Both agents run `agent "fix the bug"` (no -i)
 *    non-interactively, and the first prompt hook then carries exactly those
 *    words (Gemini puts piped stdin or hook context before them, separated by
 *    a blank line). So the first prompt is compared with the plain arguments
 *    on the agent's own command line, read once per session as before.
 *  - CI (Gemini only): Gemini's own isHeadlessMode() treats CI=true or
 *    GITHUB_ACTIONS=true as headless unless GEMINI_CLI_INTEGRATION_TEST=true.
 * Not detectable: a prompt piped on stdin with no prompt argument.
 */
const state = require('../../lib/state');
const shared = require('../_shared/tab-title-hook');
const { ancestorCommandLines, isHeadlessRun } = require('../_shared/headless');

const SAFE_ID = /^[A-Za-z0-9._-]{1,120}$/;
/** Same rules as _shared/headless.js (not exported there). */
const INTERACTIVE_RE = /(?:^|\s)(?:-i|--prompt-interactive)(?:=|\s|$)/;
const OWN_RE = /session-namer|[\\/]adapters[\\/](?:gemini|qwen)[\\/]hook\.js/i;
const MAX_TOKENS = 64;
const MAX_TOKEN_CHARS = 2000;
/** Sidecar state id holding the agent's arguments until the first prompt decides. */
const argvId = (sessionId) => `${sessionId}.argv`;

/** Windows command line to argv (CommandLineToArgvW / MSVCRT rules). */
function splitWindows(cmd) {
  const out = [];
  let cur = '';
  let has = false;
  let quoted = false;
  const s = String(cmd || '');
  for (let i = 0; i < s.length;) {
    const c = s[i];
    if (c === '\\') {
      let n = 0;
      while (s[i] === '\\') { n += 1; i += 1; }
      if (s[i] === '"') {
        cur += '\\'.repeat(Math.floor(n / 2));
        if (n % 2) { cur += '"'; i += 1; }
      } else cur += '\\'.repeat(n);
      has = true;
    } else if (c === '"') {
      if (quoted && s[i + 1] === '"') { cur += '"'; i += 2; } else { quoted = !quoted; i += 1; }
      has = true;
    } else if (!quoted && (c === ' ' || c === '\t')) {
      if (has) { out.push(cur); cur = ''; has = false; }
      i += 1;
    } else {
      cur += c;
      has = true;
      i += 1;
    }
  }
  if (has) out.push(cur);
  return out;
}

/** /proc and `ps` lines are argv joined with spaces: split on whitespace, no quoting. */
const splitPosix = (line) => String(line || '').split(/\s+/).filter(Boolean);

/** The nearest ancestor line of `agent` that is not this adapter's own hook. */
function agentLine(agent, lines) {
  const name = new RegExp(String(agent).replace(/[^A-Za-z0-9-]/g, ''), 'i');
  return (lines || []).find((l) => name.test(l) && !OWN_RE.test(l)) || null;
}

/**
 * The agent's arguments as tokens, or null when there is no agent line or it
 * asks for the interactive UI (-i / --prompt-interactive).
 */
function agentArgs(agent, lines, { platform = process.platform } = {}) {
  const line = agentLine(agent, lines);
  if (!line || INTERACTIVE_RE.test(line)) return null;
  return (platform === 'win32' ? splitWindows(line) : splitPosix(line))
    .slice(0, MAX_TOKENS).map((t) => t.slice(0, MAX_TOKEN_CHARS));
}

const squash = (s) => String(s).replace(/\s+/g, ' ').trim();

/**
 * True when `prompt` is a run of consecutive plain (non-option) arguments,
 * joined with spaces as both agents join a positional query, optionally after
 * a blank-line-separated prefix (piped stdin, hook context).
 */
function promptOnCommandLine(tokens, prompt) {
  if (!Array.isArray(tokens) || typeof prompt !== 'string') return false;
  const raw = prompt.replace(/\r\n/g, '\n');
  const p = squash(raw);
  if (!p) return false;
  for (let i = 0; i < tokens.length; i += 1) {
    if (typeof tokens[i] !== 'string' || tokens[i].startsWith('-')) continue;
    let joined = '';
    for (let j = i; j < tokens.length && typeof tokens[j] === 'string' && !tokens[j].startsWith('-'); j += 1) {
      joined = j === i ? tokens[j] : `${joined} ${tokens[j]}`;
      const q = squash(joined);
      if (q.length > p.length) break;
      if (q === p || raw.endsWith(`\n\n${joined}`)) return true;
    }
  }
  return false;
}

/** Gemini's own CI rule (packages/core isHeadlessMode), minus the -i/ACP cases. */
function ciHeadless(env, line) {
  if (String(env.GEMINI_CLI_INTEGRATION_TEST) === 'true') return false;
  if (env.CI !== 'true' && env.GITHUB_ACTIONS !== 'true') return false;
  return !(line && (INTERACTIVE_RE.test(line) || /(?:^|\s)--(?:experimental-)?acp(?:=|\s|$)/.test(line)));
}

/**
 * Hook entry: the shared tab-title hook, with the extra headless checks.
 * The agent's command line is still read at most once per session (in the
 * shared hook's detectHeadless call); no extra process is started.
 */
async function handleHook(spec, input, {
  argvEvent = null, env = process.env, platform = process.platform, ci = false,
  getLines = (pid) => ancestorCommandLines(pid, { platform }), base = shared.handleHook, deps = {},
} = {}) {
  const sessionId = String(input.session_id || input.sessionId || '');
  const event = argvEvent || input.hook_event_name || input.hookEventName || '';
  if (!SAFE_ID.test(sessionId)) return base(spec, input, { argvEvent, env, platform, ...deps });
  const dir = state.stateDir({ ...env, CLAUDE_CONFIG_DIR: spec.homeDir });
  const log = (l) => state.appendLog(dir, `[${spec.name}] ${sessionId}: ${l}`);
  const prompt = spec.promptEvents.includes(event) ? shared.promptOf(input) : null;

  // First prompt of a session whose start hook kept the agent's arguments.
  if (prompt !== null) {
    const pending = state.readState(dir, argvId(sessionId));
    if (pending && Array.isArray(pending.argv)) {
      state.writeState(dir, argvId(sessionId), { decided: true });
      const st = state.readState(dir, sessionId);
      if (st && st.headless === false && promptOnCommandLine(pending.argv, prompt)) {
        st.headless = true;
        state.writeState(dir, sessionId, st);
        log('headless run (prompt given on the command line), skipped');
      }
    }
  }

  const detectHeadless = (pid) => {
    const lines = getLines(pid);
    if (isHeadlessRun(spec.name, lines)) return true;
    if (ci && ciHeadless(env, agentLine(spec.name, lines))) { log('headless: CI=true'); return true; }
    const tokens = agentArgs(spec.name, lines, { platform });
    if (!tokens) return false;
    if (prompt !== null) {
      // The session's first hook is the prompt itself: decide now.
      const yes = promptOnCommandLine(tokens, prompt);
      if (yes) log('headless: prompt given on the command line');
      return yes;
    }
    state.writeState(dir, argvId(sessionId), { argv: tokens });
    return false;
  };
  return base(spec, input, { argvEvent, env, platform, detectHeadless, ...deps });
}

/** CLI glue: like _shared/tab-title-hook main(), with handleHook above. */
function main(spec, { ci = false } = {}, argv = process.argv.slice(2)) {
  if (argv[0] === '--worker') return shared.main(spec, argv);
  const done = () => process.exit(0);
  const chunks = [];
  let handled = false;
  const handle = () => {
    if (handled) return;
    handled = true;
    handleHook(spec, shared.readInput(Buffer.concat(chunks).toString('utf8')), { argvEvent: argv[0] || null, ci })
      .catch(() => {}).finally(done);
  };
  process.stdin.on('data', (d) => chunks.push(d));
  process.stdin.on('error', done);
  process.stdin.on('end', handle);
  setTimeout(handle, shared.STDIN_TIMEOUT_MS).unref();
  return undefined;
}

module.exports = { handleHook, main, splitWindows, splitPosix, agentLine, agentArgs, promptOnCommandLine, ciHeadless, argvId };
