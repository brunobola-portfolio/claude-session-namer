#!/usr/bin/env node
'use strict';
/**
 * goose hook entry point (UserPromptSubmit). Reads the hook JSON from stdin
 * and, when the session still needs a name, starts a detached background
 * worker and exits at once, printing nothing. Always exits 0.
 *
 *   node hook.js                 hook mode (stdin = goose hook payload)
 *   node hook.js --worker <b64>  background worker (spawned by hook mode)
 */
const { spawn, spawnSync } = require('node:child_process');
const state = require('../../lib/state');
const { truncatePrompt } = require('../../lib/title');
const { work, shouldSpawn } = require('./namer');

function readStdin() {
  return new Promise((resolve) => {
    const chunks = [];
    process.stdin.on('data', (c) => chunks.push(c));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    process.stdin.on('error', () => resolve(''));
    setTimeout(() => resolve(Buffer.concat(chunks).toString('utf8')), 5000).unref();
  });
}

/**
 * Constant PowerShell command: every value comes from the environment, so no
 * data (a folder name, a path) is ever parsed as PowerShell. Quoting is not
 * an option: PowerShell also treats U+2018..U+201B as single quotes.
 */
const PS_COMMAND = 'Start-Process -WindowStyle Hidden -WorkingDirectory $env:SN_GOOSE_CWD'
  + ' -FilePath $env:SN_GOOSE_NODE -ArgumentList $env:SN_GOOSE_ARGS';

/** Windows command-line quoting for one argument (CommandLineToArgvW rules). */
function winArg(a) {
  const s = String(a);
  if (s && !/[\s"]/.test(s)) return s;
  return `"${s.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"`;
}

/**
 * Start the worker so that goose does not wait for it.
 *
 * goose reads hook stdout/stderr until EOF (`wait_with_output`) and awaits
 * UserPromptSubmit hooks inline. On Windows a child created by Node inherits
 * the hook's pipe handles, so a plain detached spawn keeps goose (and the
 * user's turn) waiting until the worker ends; measured: 12.3 s for a 12 s
 * worker. `Start-Process` goes through ShellExecute, which inherits no
 * handles: goose returned in 0.5 s. Elsewhere a detached spawn is enough.
 */
function spawnWorker(payload, cwd, {
  platform = process.platform, spawnFn = spawn, spawnSyncFn = spawnSync, log = () => {},
} = {}) {
  const args = [__filename, '--worker', payload];
  if (platform === 'win32') {
    // Synchronous on purpose: Start-Process returns as soon as the worker has
    // started (about 0.5 s), and the launcher must not outlive this hook.
    // -ArgumentList as one pre-quoted string: the worker's argv is exactly `args`.
    const r = spawnSyncFn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', PS_COMMAND], {
      stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true, timeout: 8000, encoding: 'utf8',
      env: {
        ...process.env, SN_GOOSE_CWD: String(cwd), SN_GOOSE_NODE: process.execPath, SN_GOOSE_ARGS: args.map(winArg).join(' '),
      },
    });
    if (r.error || r.status !== 0) log(`worker launch failed: ${(r.error && r.error.message) || String(r.stderr || '').trim().slice(0, 200)}`);
    return r;
  }
  const child = spawnFn(process.execPath, args, { detached: true, stdio: 'ignore', cwd });
  child.on('error', () => {});
  child.unref();
  return child;
}

async function main() {
  if (process.argv[2] === '--worker') {
    try {
      const input = JSON.parse(Buffer.from(String(process.argv[3] || ''), 'base64').toString('utf8'));
      await work(input);
    } catch (err) {
      try { state.appendLog(state.stateDir(process.env), `goose worker fatal: ${err && err.stack}`); } catch { /* ignore */ }
    }
    return;
  }
  let input = null;
  try { input = JSON.parse(await readStdin()); } catch { input = null; }
  try {
    if (shouldSpawn(input)) {
      // Keep argv well under the Windows 32 K command-line limit.
      const payload = Buffer.from(JSON.stringify({
        event: input.event, session_id: input.session_id, working_dir: input.working_dir,
        message: truncatePrompt(input.message, 1500, 300),
      })).toString('base64');
      const dir = state.stateDir(process.env);
      spawnWorker(payload, input.working_dir || process.cwd(), {
        log: (m) => state.appendLog(dir, `goose ${String(input.session_id).slice(0, 15)} ${m}`),
      });
    }
  } catch (err) {
    try { state.appendLog(state.stateDir(process.env), `goose hook fatal: ${err && err.stack}`); } catch { /* ignore */ }
  }
  process.exitCode = 0;
}

if (require.main === module) main();

module.exports = { spawnWorker, winArg, PS_COMMAND };
