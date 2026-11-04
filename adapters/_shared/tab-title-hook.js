'use strict';
/**
 * Terminal-tab fallback for harnesses whose hooks cannot set a session title
 * (Gemini CLI, Qwen Code). The hook reads the Claude-style hook JSON on
 * stdin, prints nothing, exits at once, and sets the terminal tab title with
 * OSC 0 ("<project>" first, then "<project> - <topic>"). The slow topic
 * generation runs in a worker that keeps the console (so SetConsoleTitle / /dev/tty
 * still reach the terminal) but none of the harness's pipes, so the user's
 * turn is never delayed.
 *
 * It does NOT rename the harness's saved session: neither harness offers a
 * supported way to do that from a hook. See each adapter README.
 */
const childProcess = require('node:child_process');
const state = require('../../lib/state');
const title = require('../../lib/title');
const { makeTitle, projectTitle } = require('./make-title');
const { writeTerminalTitle, resolveConsoleOwner } = require('./osc-title');
const { ancestorCommandLines, isHeadlessRun } = require('./headless');

/** Give up on stdin after this long (some agents never close it). */
const STDIN_TIMEOUT_MS = 5000;

const MAX_ATTEMPTS = 3;
const RETRY_INTERVAL_MS = 60_000;
const SAFE_ID = /^[A-Za-z0-9._-]{1,128}$/;
const JOB_ENV = 'SESSION_NAMER_TAB_JOB';

/**
 * @typedef {object} HarnessSpec
 * @property {string} name           e.g. 'gemini'
 * @property {string} homeDir        harness config dir; state lives in <homeDir>/session-namer
 * @property {string[]} startEvents  e.g. ['SessionStart']
 * @property {string[]} promptEvents e.g. ['BeforeAgent'] or ['UserPromptSubmit']
 * @property {string[]} reassertEvents events that just re-apply the current title
 * @property {string} script         absolute path of the adapter hook (re-run with --worker)
 */

const stateDirFor = (spec, env) => state.stateDir({ ...env, CLAUDE_CONFIG_DIR: spec.homeDir });

function readInput(raw) {
  try {
    const data = JSON.parse(String(raw || '').trim() || '{}');
    return data && typeof data === 'object' ? data : {};
  } catch {
    return {};
  }
}

const eventOf = (input, argvEvent) => argvEvent || input.hook_event_name || input.hookEventName || '';
const promptOf = (input) => [input.prompt, input.user_prompt, input.userPrompt].find((p) => typeof p === 'string') || '';

/**
 * Command line that starts the worker. On Windows it goes through
 * `cmd /c start "" /b`: the worker keeps the hook's console (needed for
 * SetConsoleTitle) but is not a direct child, so it escapes the
 * kill-on-close job object libuv puts non-detached children in, and outlives
 * the hook. (`detached: true` or `windowsHide` would drop the console.)
 */
function workerCommand(script, { platform = process.platform, execPath = process.execPath } = {}) {
  if (platform === 'win32') {
    return { command: 'cmd.exe', args: [`/d /s /c "start "" /b "${execPath}" "${script}" --worker"`], verbatim: true };
  }
  return { command: execPath, args: [script, '--worker'], verbatim: false };
}

/**
 * Start the console-attached worker; it never inherits the harness's pipes.
 * On Windows this resolves once `cmd` has handed off to `start` (a few ms):
 * exiting earlier would let the job object kill `cmd` before it launches.
 * @returns {Promise<boolean>}
 */
function spawnWorker(spec, job, { env = process.env, spawn = childProcess.spawn, platform = process.platform } = {}) {
  return new Promise((resolve) => {
    try {
      const { command, args, verbatim } = workerCommand(spec.script, { platform });
      const child = spawn(command, args, {
        env: { ...env, [JOB_ENV]: JSON.stringify(job) },
        stdio: 'ignore',
        detached: false,
        windowsVerbatimArguments: verbatim,
        cwd: job.cwd,
      });
      child.on('error', () => resolve(false));
      if (platform !== 'win32') {
        child.unref();
        resolve(true);
        return;
      }
      const timer = setTimeout(() => resolve(true), 3000);
      child.on('exit', (code) => { clearTimeout(timer); resolve(code === 0); });
    } catch {
      resolve(false);
    }
  });
}

const delay = (ms) => new Promise((r) => { setTimeout(r, ms); });

/**
 * Hook entry. Pure with respect to its deps, for tests.
 * @returns {Promise<{action:string, title?:string}>}
 */
async function handleHook(spec, input, {
  argvEvent = null, env = process.env, now = Date.now(), write = writeTerminalTitle,
  spawnJob = (job) => spawnWorker(spec, job, { env }), project = projectTitle, platform = process.platform,
  ppid = process.ppid, resolveOwner = resolveConsoleOwner,
  detectHeadless = (pid) => isHeadlessRun(spec.name, ancestorCommandLines(pid, { platform })),
} = {}) {
  const event = eventOf(input, argvEvent);
  const sessionId = String(input.session_id || input.sessionId || '');
  if (!SAFE_ID.test(sessionId)) return { action: 'skip-no-session' };
  const cwd = input.cwd || process.cwd();
  const dir = stateDirFor(spec, env);
  const log = (l) => state.appendLog(dir, `[${spec.name}] ${sessionId}: ${l}`);
  const st = state.readState(dir, sessionId) || { stage: 'provisional', attempts: 0, lastAttemptAt: 0 };

  const { cfg, project: proj } = project({ cwd, env });
  if (!cfg.enabled) return { action: 'disabled' };
  // Headless runs (`gemini -p`, `qwen -p`) are skipped unless name_headless is on.
  // Checked once per session (it reads the agent's command line) and remembered.
  if (!cfg.nameHeadless) {
    if (typeof st.headless !== 'boolean') {
      let headless = false;
      try { headless = !!detectHeadless(ppid); } catch { headless = false; }
      st.headless = headless;
      state.writeState(dir, sessionId, st);
      if (headless) log('headless run, skipped');
    }
    if (st.headless) return { action: 'skip-headless' };
  }
  if (!st.title) st.title = proj;
  // Windows: the harness may run the hook inside a shell (Gemini uses PowerShell) that
  // restores the console title when it exits, so the worker sets it after we are gone.
  // `consoleless` harnesses (Qwen spawns hooks with CREATE_NO_WINDOW): the worker attaches
  // to the console of our nearest ancestor that has one. That PID is resolved once per
  // session here, while our parent chain is alive (the worker outlives it).
  if (platform === 'win32' && spec.consoleless && !Number.isInteger(st.consolePid)) {
    const owner = resolveOwner(ppid);
    if (owner) st.consolePid = owner;
  }
  const winExtra = spec.consoleless ? { startPid: Number.isInteger(st.consolePid) ? st.consolePid : ppid } : {};
  const show = (t, extra = {}) => (platform === 'win32'
    ? spawnJob({ sessionId, cwd, title: t, ...winExtra, ...extra })
    : (write(t), true));

  if (spec.startEvents.includes(event) || spec.reassertEvents.includes(event)) {
    state.writeState(dir, sessionId, st);
    await show(st.title);
    return { action: 'title', title: st.title };
  }
  if (!spec.promptEvents.includes(event)) return { action: 'ignore' };

  const prompt = promptOf(input);
  let generate = st.stage !== 'final' && title.isEligiblePrompt(prompt)
    && st.attempts < MAX_ATTEMPTS && !(st.lastAttemptAt && now - st.lastAttemptAt < RETRY_INTERVAL_MS);
  if (generate) {
    st.attempts += 1;
    st.lastAttemptAt = now;
  }
  state.writeState(dir, sessionId, st);
  if (!generate) {
    await show(st.title);
    return { action: st.stage === 'final' ? 'title' : 'no-generation', title: st.title };
  }
  let ok;
  if (platform === 'win32') {
    ok = await show(st.title, { prompt: title.truncatePrompt(prompt) });
  } else {
    write(st.title);
    ok = await spawnJob({ sessionId, cwd, prompt: title.truncatePrompt(prompt) });
  }
  generate = ok;
  log(ok ? `worker started (attempt ${st.attempts})` : 'worker spawn failed');
  return { action: generate ? 'generating' : 'spawn-failed', title: st.title };
}

/**
 * Worker: optionally show `job.title`, optionally generate from `job.prompt`,
 * then title the tab and remember the final title.
 */
async function runWorker(spec, job, {
  env = process.env, make = makeTitle, platform = process.platform, wait = delay,
  write = (t) => writeTerminalTitle(t, { startPid: Number.isInteger(job.startPid) ? job.startPid : null }),
} = {}) {
  const dir = stateDirFor(spec, env);
  const log = (l) => state.appendLog(dir, `[${spec.name}] ${job.sessionId}: ${l}`);
  // Land after the hook's wrapper shell has exited (and restored its title), then once more.
  const show = async (t) => {
    if (platform === 'win32') await wait(400);
    const wrote = write(t);
    if (platform === 'win32') { await wait(1500); write(t); }
    return wrote;
  };
  if (job.title && !job.prompt) {
    await show(job.title);
    return { title: job.title, reason: 'shown' };
  }
  const early = job.title ? show(job.title) : Promise.resolve(false); // project title meanwhile
  const r = await make({ prompt: job.prompt, cwd: job.cwd, env, log: (l) => log(`generate ${l}`) });
  await early;
  if (r.reason !== 'ok') {
    log(`no topic (${r.reason})`);
    return r;
  }
  const st = state.readState(dir, job.sessionId) || { stage: 'provisional', attempts: 1, lastAttemptAt: Date.now() };
  st.stage = 'final';
  st.title = r.title;
  state.writeState(dir, job.sessionId, st);
  const wrote = await show(r.title);
  log(`tab title "${r.title}"${wrote ? '' : ' (no terminal)'}`);
  return r;
}

/** CLI glue shared by the adapters' hook.js files. */
function main(spec, argv = process.argv.slice(2)) {
  const done = () => process.exit(0);
  if (argv[0] === '--worker') {
    let job = null;
    try { job = JSON.parse(process.env[JOB_ENV] || 'null'); } catch { job = null; }
    if (!job || !SAFE_ID.test(String(job.sessionId || ''))) return done();
    runWorker(spec, job).catch(() => {}).finally(done);
    return undefined;
  }
  const chunks = [];
  let handled = false;
  const handle = () => {
    if (handled) return;
    handled = true;
    handleHook(spec, readInput(Buffer.concat(chunks).toString('utf8')), { argvEvent: argv[0] || null })
      .catch(() => {}).finally(done);
  };
  process.stdin.on('data', (d) => chunks.push(d));
  process.stdin.on('error', done);
  process.stdin.on('end', handle);
  setTimeout(handle, STDIN_TIMEOUT_MS).unref();
  return undefined;
}

module.exports = { handleHook, runWorker, spawnWorker, workerCommand, main, readInput, promptOf, JOB_ENV, MAX_ATTEMPTS, STDIN_TIMEOUT_MS };
