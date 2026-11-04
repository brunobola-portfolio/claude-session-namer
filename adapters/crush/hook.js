#!/usr/bin/env node
'use strict';
/**
 * Crush hook entry point (TurnStart). Reads the hook JSON from stdin, and when
 * the session still needs a title, starts a detached background worker and
 * exits at once, printing nothing ("no opinion"). Always exits 0.
 *
 *   node hook.js                 hook mode (stdin = Crush hook payload)
 *   node hook.js --worker <b64>  background worker (spawned by hook mode)
 */
const { spawn } = require('node:child_process');
const state = require('../../lib/state');
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

async function main() {
  if (process.argv[2] === '--worker') {
    try {
      const input = JSON.parse(Buffer.from(String(process.argv[3] || ''), 'base64').toString('utf8'));
      await work(input);
    } catch (err) {
      try { state.appendLog(state.stateDir(process.env), `crush worker fatal: ${err && err.stack}`); } catch { /* ignore */ }
    }
    return;
  }
  let input = null;
  try { input = JSON.parse(await readStdin()); } catch { input = null; }
  try {
    if (shouldSpawn(input)) {
      const payload = Buffer.from(JSON.stringify({ session_id: input.session_id, cwd: input.cwd })).toString('base64');
      const child = spawn(process.execPath, [__filename, '--worker', payload], {
        detached: true, stdio: 'ignore', windowsHide: true, cwd: input.cwd || process.cwd(),
      });
      child.on('error', () => {});
      child.unref();
    }
  } catch (err) {
    try { state.appendLog(state.stateDir(process.env), `crush hook fatal: ${err && err.stack}`); } catch { /* ignore */ }
  }
  process.exitCode = 0;
}

main();
