'use strict';
/**
 * Run an agent's CLI without a shell, so that titles (model output and
 * folder names) are never parsed by cmd.exe.
 *
 * On Windows, npm installs `<name>.cmd` shims. Running a .cmd means running
 * cmd.exe, which expands `%VAR%` and treats `&`, `|`, `"` and friends as
 * syntax inside arguments; no quoting scheme is safe for arbitrary text. The
 * shim only forwards to a real target, so it is resolved here instead:
 *   "%dp0%\node_modules\pkg\bin\tool.exe"  %*      -> run tool.exe directly
 *   "%_prog%"  "%dp0%\node_modules\pkg\bin\tool" %* -> run it with this Node
 * If a shim cannot be resolved, callers get null and must refuse to run.
 */
const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const isFile = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };
const readText = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } };
const isShim = (p) => /\.(cmd|bat)$/i.test(String(p || ''));

/**
 * Resolve an npm `.cmd` shim to { command, args } that need no shell, or null.
 * @param {string} shimPath
 * @param {{nodePath?:string, exists?:Function, read?:Function}} [opts]
 */
function resolveCmdShim(shimPath, { nodePath = process.execPath, exists = isFile, read = readText } = {}) {
  const text = read(shimPath);
  if (typeof text !== 'string') return null;
  // The last "%dp0%\..." (or "%~dp0\...") path on the line that forwards %*.
  const re = /"%~?dp0%?\\?([^"%]+)"/gi;
  let rel = null;
  for (const line of text.split(/\r?\n/)) {
    if (!line.includes('%*')) continue;
    let m;
    re.lastIndex = 0;
    while ((m = re.exec(line)) !== null) {
      if (!/node(\.exe)?$/i.test(m[1])) rel = m[1];
    }
  }
  if (!rel) return null;
  const target = path.win32.join(path.win32.dirname(shimPath), rel);
  if (!exists(target)) return null;
  if (/\.exe$/i.test(target)) return { command: target, args: [] };
  if (isShim(target)) return null; // shim to another shim: give up rather than use cmd.exe
  return { command: nodePath, args: [target] };
}

/**
 * Turn a user-supplied or discovered executable path into a shell-free
 * command. Scripts run with Node, .cmd/.bat shims are resolved, anything
 * else is run directly. Returns null when only cmd.exe could run it.
 */
function toCommand(file, { platform = process.platform, nodePath = process.execPath, exists = isFile, read = readText } = {}) {
  const f = String(file || '').trim();
  if (!f) return null;
  if (/\.(c|m)?js$/i.test(f)) return { command: nodePath, args: [f] };
  if (platform === 'win32' && isShim(f)) return resolveCmdShim(f, { nodePath, exists, read });
  return { command: f, args: [] };
}

/**
 * Find `name` on PATH as a shell-free command: `<name>.exe`, else a resolved
 * `<name>.cmd` shim (Windows); `<name>` elsewhere. Null when not found.
 */
function findOnPath(name, env = process.env, {
  platform = process.platform, nodePath = process.execPath, exists = isFile, read = readText,
} = {}) {
  const joiner = platform === 'win32' ? path.win32 : path.posix;
  const sep = platform === 'win32' ? ';' : ':';
  const dirs = String(env.PATH || env.Path || '').split(sep).filter(Boolean);
  for (const dir of dirs) {
    if (platform === 'win32') {
      const exe = joiner.join(dir, `${name}.exe`);
      if (exists(exe)) return { command: exe, args: [] };
      const shim = joiner.join(dir, `${name}.cmd`);
      if (exists(shim)) {
        const real = resolveCmdShim(shim, { nodePath, exists, read });
        if (real) return real;
      }
    } else {
      const bin = joiner.join(dir, name);
      if (exists(bin)) return { command: bin, args: [] };
    }
  }
  return null;
}

/** Kill a child and, on Windows, its whole process tree. */
function killTree(child, platform = process.platform) {
  try {
    if (platform === 'win32' && child && child.pid) {
      childProcess.spawn('taskkill', ['/T', '/F', '/PID', String(child.pid)], { stdio: 'ignore', windowsHide: true }).on('error', () => {});
    }
    if (child) child.kill('SIGTERM');
  } catch { /* already gone */ }
}

/**
 * Run a shell-free command and collect its output (asynchronous).
 * Resolves { code, stdout, stderr, timedOut }; never rejects.
 */
function runCommand(cmd, args, {
  cwd, env = process.env, timeoutMs = 20_000, spawn = childProcess.spawn, platform = process.platform,
} = {}) {
  return new Promise((resolve) => {
    let child;
    let settled = false;
    let timer;
    const out = [];
    const err = [];
    const finish = (code, timedOut = false) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        code, timedOut,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
      });
    };
    try {
      child = spawn(cmd.command, [...cmd.args, ...args], {
        cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, shell: false,
      });
    } catch (e) {
      err.push(Buffer.from(String(e && e.message)));
      finish(1);
      return;
    }
    if (child.stdout) child.stdout.on('data', (d) => out.push(Buffer.from(d)));
    if (child.stderr) child.stderr.on('data', (d) => err.push(Buffer.from(d)));
    child.on('error', (e) => { err.push(Buffer.from(String(e && e.message))); finish(1); });
    child.on('close', (code) => finish(typeof code === 'number' ? code : 1));
    timer = setTimeout(() => { killTree(child, platform); finish(1, true); }, timeoutMs);
  });
}

module.exports = { resolveCmdShim, toCommand, findOnPath, killTree, runCommand, isShim };
