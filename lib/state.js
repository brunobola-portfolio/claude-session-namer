'use strict';
/**
 * Per-session state files, opportunistic pruning and a small rotating log.
 * Every function swallows I/O errors: the plugin must never break a session.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DIR_NAME = 'session-namer';
const STATE_SUBDIR = 'state';
const LOG_FILE = 'log.txt';
const LOG_MAX_BYTES = 512 * 1024;
const SAFE_ID = /^[A-Za-z0-9._-]{1,128}$/;

const homeDir = (env) => env.HOME || env.USERPROFILE || os.homedir();

function ensureWritableDir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.accessSync(dir, fs.constants.W_OK);
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Base directory for this plugin's files. Honours CLAUDE_CONFIG_DIR so that
 * each Claude Code account keeps its own state. Falls back to the OS temp dir.
 */
function stateDir(env = process.env) {
  const configDir = env.CLAUDE_CONFIG_DIR && env.CLAUDE_CONFIG_DIR.trim()
    ? env.CLAUDE_CONFIG_DIR.trim()
    : path.join(homeDir(env), '.claude');
  const preferred = path.join(configDir, DIR_NAME);
  if (ensureWritableDir(preferred)) return preferred;
  const fallback = path.join(os.tmpdir(), `claude-${DIR_NAME}`);
  ensureWritableDir(fallback);
  return fallback;
}

const stateFile = (dir, sessionId) => (SAFE_ID.test(String(sessionId))
  ? path.join(dir, STATE_SUBDIR, `${sessionId}.json`)
  : null);

function readState(dir, sessionId) {
  const file = stateFile(dir, sessionId);
  if (!file) return null;
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return data && typeof data === 'object' && !Array.isArray(data) ? data : null;
  } catch {
    return null;
  }
}

function writeState(dir, sessionId, state) {
  const file = stateFile(dir, sessionId);
  if (!file) return false;
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(state));
    fs.renameSync(tmp, file);
    return true;
  } catch {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    return false;
  }
}

/** Delete state files older than maxAgeDays. Returns the number deleted. */
function pruneOld(dir, maxAgeDays = 30, maxDeletes = 200) {
  const cutoff = Date.now() - maxAgeDays * 86400 * 1000;
  let deleted = 0;
  try {
    const stateDirPath = path.join(dir, STATE_SUBDIR);
    for (const name of fs.readdirSync(stateDirPath)) {
      if (deleted >= maxDeletes) break;
      if (!name.endsWith('.json')) continue;
      const file = path.join(stateDirPath, name);
      try {
        if (fs.statSync(file).mtimeMs < cutoff) {
          fs.unlinkSync(file);
          deleted += 1;
        }
      } catch { /* ignore this file */ }
    }
  } catch { /* directory missing or unreadable */ }
  return deleted;
}

function appendLog(dir, line) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, LOG_FILE);
    try {
      if (fs.statSync(file).size > LOG_MAX_BYTES) fs.renameSync(file, `${file}.1`);
    } catch { /* no log yet */ }
    fs.appendFileSync(file, `${new Date().toISOString()} ${String(line).replace(/\r?\n/g, ' ')}\n`);
  } catch { /* never throw */ }
}

module.exports = { stateDir, readState, writeState, pruneOld, appendLog, LOG_MAX_BYTES, LOG_FILE };
