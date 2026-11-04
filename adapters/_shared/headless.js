'use strict';
/**
 * Detect a headless agent run (`gemini -p "..."`, `qwen -p "..."`) from a
 * hook. Neither agent tells its hooks whether it runs interactively (the hook
 * payload has session_id, transcript_path, cwd, hook_event_name, timestamp;
 * the environment has no mode flag), so this reads the command line of the
 * agent process among the hook's ancestors and looks for `-p` / `--prompt`.
 *
 * Not detected (treated as interactive): a positional prompt without `-p`,
 * and a prompt piped on stdin. Any failure also counts as interactive.
 */
const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const MAX_DEPTH = 8;
const PS_TIMEOUT_MS = 5000;
const HEADLESS_RE = /(?:^|\s)(?:-p|--prompt)(?:=|\s|$)/;
const INTERACTIVE_RE = /(?:^|\s)(?:-i|--prompt-interactive)(?:=|\s|$)/;
const OWN_RE = /session-namer|[\\/]adapters[\\/](?:gemini|qwen)[\\/]hook\.js/i;
const ANCESTOR_SCRIPT = path.join(__dirname, 'console-title.ps1');

/** Linux: walk /proc. */
function linuxAncestors(startPid, { readFile = (p) => fs.readFileSync(p, 'utf8') } = {}) {
  const out = [];
  let pid = startPid;
  for (let i = 0; i < MAX_DEPTH && pid > 1; i += 1) {
    try {
      out.push(readFile(`/proc/${pid}/cmdline`).split('\0').filter(Boolean).join(' '));
      const stat = readFile(`/proc/${pid}/stat`);
      pid = Number.parseInt(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1], 10);
    } catch {
      break;
    }
  }
  return out;
}

/** macOS and other POSIX: `ps -o ppid=,command= -p <pid>`. */
function psAncestors(startPid, { spawnSync = childProcess.spawnSync } = {}) {
  const out = [];
  let pid = startPid;
  for (let i = 0; i < MAX_DEPTH && pid > 1; i += 1) {
    const r = spawnSync('ps', ['-o', 'ppid=,command=', '-p', String(pid)], { encoding: 'utf8', timeout: 2000 });
    const m = r.status === 0 && /^\s*(\d+)\s+(.*)$/.exec(String(r.stdout || '').trim());
    if (!m) break;
    out.push(m[2]);
    pid = Number.parseInt(m[1], 10);
  }
  return out;
}

/** Windows: console-title.ps1 in `cmdlines` mode (input via environment only). */
function windowsAncestors(startPid, { spawnSync = childProcess.spawnSync, env = process.env } = {}) {
  try {
    const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', ANCESTOR_SCRIPT], {
      env: { ...env, SN_MODE: 'cmdlines', SN_START_PID: String(startPid) },
      stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, timeout: PS_TIMEOUT_MS, encoding: 'utf8',
    });
    return r.status === 0 ? String(r.stdout || '').split(/\r?\n/).filter(Boolean) : [];
  } catch {
    return [];
  }
}

/** Command lines of `startPid` and its ancestors, nearest first. */
function ancestorCommandLines(startPid, { platform = process.platform, ...deps } = {}) {
  if (!Number.isInteger(startPid) || startPid <= 0) return [];
  if (platform === 'win32') return windowsAncestors(startPid, deps);
  if (platform === 'linux') return linuxAncestors(startPid, deps);
  return psAncestors(startPid, deps);
}

/**
 * True when the nearest ancestor command line that mentions `agent` (and is
 * not this adapter's own hook) carries `-p`/`--prompt` without `-i`.
 */
function isHeadlessRun(agent, lines) {
  const name = new RegExp(String(agent).replace(/[^A-Za-z0-9-]/g, ''), 'i');
  const line = (lines || []).find((l) => name.test(l) && !OWN_RE.test(l));
  return !!line && HEADLESS_RE.test(line) && !INTERACTIVE_RE.test(line);
}

module.exports = { ancestorCommandLines, isHeadlessRun, linuxAncestors, psAncestors, windowsAncestors, PS_TIMEOUT_MS };
