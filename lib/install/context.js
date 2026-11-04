'use strict';
/**
 * Everything the installer needs from the outside world, behind one object so
 * tests can swap HOME, env, platform and process spawning.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const childProcess = require('node:child_process');

const BACKUP_SUFFIX = '.session-namer.bak';

function quoteCmdArg(a) {
  const s = String(a);
  return /[\s"&|<>^()%!,;=]/.test(s) || s === '' ? `"${s.replace(/"/g, '""')}"` : s;
}

/** spawnSync that also runs npm .cmd shims on Windows. */
function defaultSpawn(cmd, args, opts = {}) {
  const base = { encoding: 'utf8', timeout: opts.timeout || 120000, env: opts.env, cwd: opts.cwd, windowsHide: true };
  let r;
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(cmd)) {
    const line = [cmd, ...args].map(quoteCmdArg).join(' ');
    r = childProcess.spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${line}"`], { ...base, windowsVerbatimArguments: true });
  } else {
    r = childProcess.spawnSync(cmd, args, base);
  }
  return {
    status: r.status === null ? (r.error ? -1 : 1) : r.status,
    stdout: r.stdout || '',
    stderr: r.stderr || '',
    error: r.error ? String(r.error.message || r.error) : null,
  };
}

function makeContext(opts = {}) {
  const env = opts.env || process.env;
  const platform = opts.platform || process.platform;
  const home = opts.home || os.homedir();
  const spawn = opts.spawn || defaultSpawn;
  const dryRun = !!opts.dryRun;
  const isWin = platform === 'win32';
  const sourceRoot = opts.sourceRoot || path.resolve(__dirname, '..', '..');
  const out = opts.out || ((s) => process.stdout.write(s));

  const nsHome = env.SESSION_NAMER_HOME && env.SESSION_NAMER_HOME.trim()
    ? path.resolve(env.SESSION_NAMER_HOME.trim())
    : path.join(home, '.session-namer');

  const pkg = JSON.parse(fs.readFileSync(path.join(sourceRoot, 'package.json'), 'utf8'));

  function envDir(name, fallback) {
    const v = env[name];
    return v && v.trim() ? path.resolve(v.trim()) : fallback;
  }

  const xdgConfig = envDir('XDG_CONFIG_HOME', path.join(home, '.config'));

  /** Locate an executable on PATH (PATHEXT-aware on Windows), then extra spots. */
  function which(name, extra = []) {
    if (opts.which) return opts.which(name, extra);
    const dirs = String(env.PATH || env.Path || '').split(isWin ? ';' : ':').filter(Boolean);
    const exts = isWin ? String(env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean) : [''];
    const runnable = (p) => {
      try {
        if (!fs.statSync(p).isFile()) return false;
        if (!isWin) fs.accessSync(p, fs.constants.X_OK);
        return true;
      } catch { return false; }
    };
    for (const d of dirs) {
      for (const e of exts) {
        const p = path.join(d, name + e.toLowerCase());
        if (runnable(p)) return p;
      }
    }
    for (const p of extra) if (runnable(p)) return p;
    return null;
  }

  function run(cmd, args, o = {}) {
    return spawn(cmd, args, { env, ...o });
  }

  /** Async variant (used for parallel `--version` probes). */
  function runAsync(cmd, args, o = {}) {
    if (opts.spawn && !opts.spawnAsync) return Promise.resolve(run(cmd, args, o));
    if (opts.spawnAsync) return opts.spawnAsync(cmd, args, { env, ...o });
    return new Promise((resolve) => {
      let child;
      const base = { env, windowsHide: true };
      try {
        if (isWin && /\.(cmd|bat)$/i.test(cmd)) {
          const line = [cmd, ...args].map(quoteCmdArg).join(' ');
          child = childProcess.spawn(env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${line}"`], { ...base, windowsVerbatimArguments: true });
        } else {
          child = childProcess.spawn(cmd, args, base);
        }
      } catch (err) {
        resolve({ status: -1, stdout: '', stderr: '', error: String(err.message) });
        return;
      }
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => { try { child.kill(); } catch { /* gone */ } }, o.timeout || 15000);
      child.stdout.on('data', (d) => { stdout += d; });
      child.stderr.on('data', (d) => { stderr += d; });
      child.on('error', (err) => { clearTimeout(timer); resolve({ status: -1, stdout, stderr, error: String(err.message) }); });
      child.on('close', (code) => { clearTimeout(timer); resolve({ status: code === null ? -1 : code, stdout, stderr, error: null }); });
      child.stdin.end();
    });
  }

  // Display roots, most specific first wins: $XDG_CONFIG_HOME (when set), %APPDATA% /
  // %LOCALAPPDATA% (Windows), then ~.
  const displayRoots = [];
  if (env.XDG_CONFIG_HOME && env.XDG_CONFIG_HOME.trim()) displayRoots.push([xdgConfig, isWin ? '%XDG_CONFIG_HOME%' : '$XDG_CONFIG_HOME']);
  if (isWin && env.APPDATA && env.APPDATA.trim()) displayRoots.push([path.resolve(env.APPDATA.trim()), '%APPDATA%']);
  if (isWin && env.LOCALAPPDATA && env.LOCALAPPDATA.trim()) displayRoots.push([path.resolve(env.LOCALAPPDATA.trim()), '%LOCALAPPDATA%']);
  displayRoots.push([home, '~']);

  /** Shorten a path for display: ~, %APPDATA%, $XDG_CONFIG_HOME. */
  const tilde = (p) => {
    if (!p || typeof p !== 'string') return p;
    let best = null;
    for (const [root, label] of displayRoots) {
      const rel = path.relative(root, p);
      if (rel.startsWith('..') || path.isAbsolute(rel)) continue;
      if (!best || root.length > best.root.length) best = { root, text: rel ? `${label}${path.sep}${rel}` : label };
    }
    return best ? best.text : p;
  };

  const readText = (file) => {
    try { return fs.readFileSync(file, 'utf8'); } catch { return null; }
  };

  /** Backups that uninstall left in place (for the closing note). */
  const backupsKept = new Set();

  const exists = (p) => {
    try { fs.lstatSync(p); return true; } catch { return false; }
  };

  /** Create missing directories; returns the ones it created (outermost first). */
  function mkdirs(dir) {
    const created = [];
    let d = path.resolve(dir);
    const chain = [];
    while (!exists(d)) {
      chain.unshift(d);
      const parent = path.dirname(d);
      if (parent === d) break;
      d = parent;
    }
    for (const c of chain) {
      if (!dryRun) fs.mkdirSync(c);
      created.push(c);
    }
    return created;
  }

  /**
   * Back up an existing file. An earlier backup is kept, unless `refresh` is
   * set (the file holds none of our entries, so the old backup is stale).
   * Returns { bak, made } (made: no backup existed before this call).
   */
  function backup(file, { refresh = false } = {}) {
    const bak = file + BACKUP_SUFFIX;
    if (!exists(file)) return { bak: null, made: false };
    const had = exists(bak);
    if (had && (!refresh || readText(bak) === readText(file))) return { bak, made: false };
    if (!dryRun) fs.copyFileSync(file, bak);
    return { bak, made: !had };
  }

  const backupOnce = (file) => backup(file).bak;

  /**
   * After uninstall: a backup identical to the restored file is deleted;
   * any other backup is reported as kept.
   */
  function settleBackup(file, text = readText(file)) {
    const bak = file + BACKUP_SUFFIX;
    const b = readText(bak);
    if (b === null) return null;
    if (text !== null && text === b) {
      if (!dryRun) fs.rmSync(bak, { force: true });
      return 'removed';
    }
    backupsKept.add(bak);
    return 'kept';
  }

  /**
   * Atomic write (tmp + rename). Writes through a symlink to its target,
   * keeps the existing file mode (API-key configs stay private), refuses a
   * read-only file, and never leaves the .tmp behind.
   */
  function writeText(file, text, o = {}) {
    if (dryRun) return;
    let target = file;
    try { target = fs.realpathSync(file); } catch { /* new file */ }
    let mode = o.mode;
    let st = null;
    try { st = fs.statSync(target); } catch { /* new file */ }
    if (st) {
      try { fs.accessSync(target, fs.constants.W_OK); } catch { throw new Error(`${tilde(file)} is read-only; nothing written`); }
      if (mode === undefined) mode = st.mode & 0o7777;
    }
    const tmp = `${target}.session-namer.tmp`;
    try {
      fs.writeFileSync(tmp, text, { encoding: 'utf8', mode: mode === undefined ? 0o666 : mode });
      if (mode !== undefined) fs.chmodSync(tmp, mode);
      fs.renameSync(tmp, target);
    } catch (err) {
      throw new Error(`could not write ${tilde(file)} (${err.code || err.message}); nothing written`);
    } finally {
      try { fs.rmSync(tmp, { force: true }); } catch { /* best effort */ }
    }
  }

  function removeFile(file) {
    if (!dryRun) fs.rmSync(file, { force: true });
  }

  /** Remove directories we created, innermost first, only while empty. */
  function removeEmptyDirs(dirs) {
    const removed = [];
    for (const d of [...dirs].reverse()) {
      try {
        if (fs.readdirSync(d).length === 0) {
          if (!dryRun) fs.rmdirSync(d);
          removed.push(d);
        }
      } catch { /* gone or not empty */ }
    }
    return removed;
  }

  return {
    env, platform, isWin, home, nsHome, xdgConfig, dryRun, sourceRoot, pkg, version: opts.version || pkg.version,
    appRoot: path.join(nsHome, 'app'),
    appDir: (v = opts.version || pkg.version) => path.join(nsHome, 'app', v),
    manifestFile: path.join(nsHome, 'installed.json'),
    envDir, which, run, runAsync, tilde, readText, exists, mkdirs, backup, backupOnce, settleBackup, backupsKept, writeText, removeFile, removeEmptyDirs, out,
  };
}

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

module.exports = { makeContext, defaultSpawn, quoteCmdArg, sha256, BACKUP_SUFFIX };
