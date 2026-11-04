'use strict';
/**
 * Set the terminal tab title from a hook process.
 *
 * Hooks run with piped stdio, so stdout goes to the harness, not the
 * terminal. Instead:
 *   - POSIX: write OSC 0 (ESC ] 0 ; text BEL) to /dev/tty.
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

/**
 * Set the title of the controlling terminal.
 * @param {{startPid?:number}} opts  Windows only: walk up from this PID to find the console
 *   (for hooks the harness spawned without one).
 * @returns {boolean} true when the request was delivered (not proof a terminal rendered it).
 */
function writeTerminalTitle(title, {
  platform = process.platform, proc = process, startPid = null, spawnSync = childProcess.spawnSync,
  openSync = fs.openSync, writeSync = fs.writeSync, closeSync = fs.closeSync,
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
  let fd;
  try {
    fd = openSync('/dev/tty', 'w');
    writeSync(fd, oscTitleSequence(clean));
    return true;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) try { closeSync(fd); } catch { /* ignore */ }
  }
}

module.exports = { oscTitleSequence, writeTerminalTitle, setAncestorConsoleTitle, resolveConsoleOwner, cleanTitle, ANCESTOR_SCRIPT, PS_TIMEOUT_MS };
