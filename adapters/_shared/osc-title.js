'use strict';
/**
 * Set the terminal tab title from a hook process.
 *
 * Hooks run with piped stdio, so stdout goes to the harness, not the
 * terminal. Instead:
 *   - POSIX: write OSC 0 (ESC ] 0 ; text BEL) to /dev/tty. A hook started
 *     `detached` (Qwen Code does: setsid, so no controlling terminal) cannot
 *     open /dev/tty; it then writes to the terminal of its nearest ancestor
 *     that has one (`ps`, then an ownership check), and leaves that device in
 *     SESSION_NAMER_TTY for the worker it starts, which outlives the hook
 *     and so loses that ancestor chain.
 *   - Windows: set `process.title`, which libuv implements with
 *     SetConsoleTitleW on the console the hook inherited; ConPTY turns that
 *     into OSC 0 for Windows Terminal / VS Code. Verified live: a raw escape
 *     written to CONOUT$ is not interpreted (no VT processing on that handle)
 *     and `cmd /c title` is reverted when cmd exits.
 * With no terminal (CI, a detached process) nothing visible happens.
 */
const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

// C0/C1 controls (incl. ESC and BEL) would end or corrupt the sequence.
const UNSAFE_RE = /[\u0000-\u001f\u007f-\u009f]/g;
const MAX_CHARS = 120;

const cleanTitle = (title) => String(title == null ? '' : title)
  .replace(UNSAFE_RE, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_CHARS);

/** Sanitised OSC 0 sequence, or '' when nothing printable is left. */
function oscTitleSequence(title) {
  const clean = cleanTitle(title);
  return clean ? `\u001b]0;${clean}\u0007` : '';
}

const ANCESTOR_SCRIPT = path.join(__dirname, 'console-title.ps1');
/** PowerShell helper bound: well inside the agents' 10 s hook timeout. */
const PS_TIMEOUT_MS = 5000;

/**
 * Windows, for hooks spawned without a console (CREATE_NO_WINDOW): attach to
 * the console of the nearest ancestor of `startPid` that has one and set its
 * title (console-title.ps1, inputs via environment only).
 */
function setAncestorConsoleTitle(clean, startPid, { spawnSync = childProcess.spawnSync, env = process.env } = {}) {
  if (!Number.isInteger(startPid) || startPid <= 0) return false;
  try {
    const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', ANCESTOR_SCRIPT], {
      env: { ...env, SN_TITLE: clean, SN_START_PID: String(startPid) },
      stdio: 'ignore', windowsHide: true, timeout: PS_TIMEOUT_MS,
    });
    return r.status === 0;
  } catch {
    return false;
  }
}

/**
 * Windows: PID of the nearest ancestor of `startPid` (inclusive) that owns a
 * console, or null. Call it while the process chain is still alive.
 */
function resolveConsoleOwner(startPid, { spawnSync = childProcess.spawnSync, env = process.env } = {}) {
  if (!Number.isInteger(startPid) || startPid <= 0) return null;
  try {
    const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', ANCESTOR_SCRIPT], {
      env: { ...env, SN_MODE: 'resolve', SN_START_PID: String(startPid) },
      stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, timeout: PS_TIMEOUT_MS, encoding: 'utf8',
    });
    const pid = Number.parseInt(String(r.stdout || '').trim(), 10);
    return r.status === 0 && Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

/** POSIX: where a hook leaves the terminal device it found, for the worker it starts. */
const TTY_ENV = 'SESSION_NAMER_TTY';
/** POSIX ancestor walk bounds: hops, whole walk, one `ps`. */
const MAX_HOPS = 8;
const WALK_BUDGET_MS = 1500;
const PS_STEP_TIMEOUT_MS = 1000;
/** `ps -o tty=` names of real terminals: Linux/BSD `pts/3`, macOS `ttys003`, consoles `tty1`. */
const TTY_NAME_RE = /^(?:pts\/\d{1,6}|tty[A-Za-z]{0,3}\d{1,6})$/;
const TTY_DEVICE_RE = /^\/dev\/(?:pts\/\d{1,6}|tty[A-Za-z]{0,3}\d{1,6})$/;

/**
 * POSIX: terminal device (`/dev/pts/3`, `/dev/ttys003`) of the nearest
 * ancestor of `startPid` (inclusive) that has one, or null. One
 * `ps -o ppid= -o tty= -p <pid>` per hop, no shell. Separate `-o` options
 * because POSIX lets everything after `=` be the header; procps and macOS
 * `ps` also accept `-o ppid=,tty=` (checked in CI). Bounded by `maxHops`
 * and `budgetMs`.
 */
function ancestorTtyDevice(startPid, {
  spawnSync = childProcess.spawnSync, now = Date.now, maxHops = MAX_HOPS, budgetMs = WALK_BUDGET_MS,
} = {}) {
  const deadline = now() + budgetMs;
  const seen = new Set();
  let pid = startPid;
  for (let hop = 0; hop < maxHops && Number.isInteger(pid) && pid > 1 && !seen.has(pid); hop += 1) {
    seen.add(pid);
    const left = deadline - now();
    if (left <= 0) break;
    let r;
    try {
      r = spawnSync('ps', ['-o', 'ppid=', '-o', 'tty=', '-p', String(pid)], {
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: Math.min(PS_STEP_TIMEOUT_MS, left),
      });
    } catch {
      break;
    }
    const m = r && r.status === 0 && /^\s*(\d+)\s+(\S+)\s*$/.exec(String(r.stdout || ''));
    if (!m) break;
    if (TTY_NAME_RE.test(m[2])) return `/dev/${m[2]}`;
    pid = Number.parseInt(m[1], 10);
  }
  return null;
}

/**
 * POSIX: write `seq` to `device` if it is a terminal device of the current
 * user (character device, owned by `uid`). Opened write-only with O_NOCTTY,
 * so it never becomes our controlling terminal, and O_NONBLOCK, so a stopped
 * terminal cannot hang the hook.
 */
function writeTtyDevice(device, seq, {
  uid, statSync = fs.statSync, openSync = fs.openSync, writeSync = fs.writeSync, closeSync = fs.closeSync,
  constants = fs.constants,
} = {}) {
  if (!seq || !TTY_DEVICE_RE.test(String(device)) || !Number.isInteger(uid)) return false;
  let fd;
  try {
    const st = statSync(device);
    if (!st.isCharacterDevice() || st.uid !== uid) return false;
    fd = openSync(device, constants.O_WRONLY | (constants.O_NOCTTY || 0) | (constants.O_NONBLOCK || 0));
    writeSync(fd, seq);
    return true;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) try { closeSync(fd); } catch { /* ignore */ }
  }
}

/**
 * Set the title of the controlling terminal.
 * @param {{startPid?:number}} opts  Windows only: walk up from this PID to find the console
 *   (for hooks the harness spawned without one).
 * @returns {boolean} true when the request was delivered (not proof a terminal rendered it).
 */
function writeTerminalTitle(title, {
  platform = process.platform, proc = process, startPid = null, spawnSync = childProcess.spawnSync,
  openSync = fs.openSync, writeSync = fs.writeSync, closeSync = fs.closeSync, statSync = fs.statSync,
  constants = fs.constants, env = process.env, now = Date.now,
} = {}) {
  const clean = cleanTitle(title);
  if (!clean) return false;
  if (platform === 'win32') {
    if (startPid) return setAncestorConsoleTitle(clean, startPid, { spawnSync });
    try {
      proc.title = clean;
      return true;
    } catch {
      return false;
    }
  }
  const seq = oscTitleSequence(clean);
  let fd;
  try {
    fd = openSync('/dev/tty', 'w');
    writeSync(fd, seq);
    return true;
  } catch {
    // No controlling terminal (a hook spawned `detached`): try an ancestor's terminal below.
  } finally {
    if (fd !== undefined) try { closeSync(fd); } catch { /* ignore */ }
  }
  let uid = null;
  try { uid = typeof proc.getuid === 'function' ? proc.getuid() : null; } catch { uid = null; }
  const io = { uid, statSync, openSync, writeSync, closeSync, constants };
  const hinted = env ? env[TTY_ENV] : undefined;
  if (hinted && writeTtyDevice(hinted, seq, io)) return true;
  const device = ancestorTtyDevice(proc.ppid, { spawnSync, now });
  if (!device || !writeTtyDevice(device, seq, io)) return false;
  // A worker started after this outlives our parent (it is reparented), so it cannot walk to
  // the terminal itself: it inherits the device through the environment instead.
  if (env) env[TTY_ENV] = device;
  return true;
}

module.exports = {
  oscTitleSequence, writeTerminalTitle, setAncestorConsoleTitle, resolveConsoleOwner, cleanTitle,
  ancestorTtyDevice, writeTtyDevice, ANCESTOR_SCRIPT, PS_TIMEOUT_MS, TTY_ENV, MAX_HOPS, WALK_BUDGET_MS, PS_STEP_TIMEOUT_MS,
};
