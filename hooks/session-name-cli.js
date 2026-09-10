#!/usr/bin/env node
'use strict';
/**
 * Diagnostics for the session-namer plugin: `node session-name-cli.js --doctor`.
 * Prints one line per check, prefixed with OK / WARN / FAIL, then the last
 * log lines and a dry-run title generation with latency.
 */
const fs = require('node:fs');
const path = require('node:path');
const childProcess = require('node:child_process');
const { loadConfig } = require('../lib/config');
const { stateDir, LOG_FILE } = require('../lib/state');
const { findClaude, generateTopic } = require('../lib/generate');
const { sanitizeTopic } = require('../lib/title');

const line = (status, text) => `${status.padEnd(4)} ${text}`;

function claudeVersion(claudePath) {
  try {
    const r = childProcess.spawnSync(claudePath.command, [...claudePath.args, '--version'], { encoding: 'utf8', timeout: 15000, windowsHide: true });
    return r.status === 0 ? r.stdout.trim().split('\n')[0] : null;
  } catch {
    return null;
  }
}

async function doctor(env = process.env) {
  const out = [];
  const major = Number(process.versions.node.split('.')[0]);
  out.push(line(major >= 18 ? 'OK' : 'FAIL', `Node.js ${process.versions.node} (${process.execPath})`));

  const claudePath = findClaude(env);
  const version = claudeVersion(claudePath);
  out.push(line(version ? 'OK' : 'FAIL', `claude CLI: ${[claudePath.command, ...claudePath.args].join(' ')}${version ? ` -> ${version}` : ' (not runnable)'}`));

  const dir = stateDir(env);
  out.push(line(dir.startsWith(require('node:os').tmpdir()) ? 'WARN' : 'OK', `state dir: ${dir}`));
  out.push(line('OK', `CLAUDE_CONFIG_DIR: ${env.CLAUDE_CONFIG_DIR || '(default ~/.claude)'}`));

  const cfg = loadConfig({ env, repoRoot: process.cwd() });
  out.push(line(cfg.enabled ? 'OK' : 'WARN', `enabled: ${cfg.enabled}`));
  out.push(line('OK', `options: model=${cfg.model} separator=${JSON.stringify(cfg.separator)} max_words=${cfg.maxWords} timeout_ms=${cfg.timeoutMs} project_source=${cfg.projectSource} name_headless=${cfg.nameHeadless}`));

  try {
    const log = fs.readFileSync(path.join(dir, LOG_FILE), 'utf8').trim().split('\n').slice(-10);
    out.push('--- last log lines ---', ...log);
  } catch {
    out.push(line('WARN', 'no log yet (the plugin has not run in a session)'));
  }

  const started = Date.now();
  const raw = await generateTopic({ prompt: 'Add pagination to the customers list and write tests', model: cfg.model, timeoutMs: cfg.timeoutMs, env });
  const topic = sanitizeTopic(raw);
  const ms = Date.now() - started;
  out.push(line(topic ? 'OK' : 'FAIL', `dry-run generation in ${ms} ms -> ${topic ? JSON.stringify(topic) : `unusable answer ${JSON.stringify(raw)}`}`));
  return out.join('\n');
}

async function main() {
  const arg = process.argv[2] || '--doctor';
  if (arg !== '--doctor') {
    process.stdout.write('Usage: node session-name-cli.js --doctor\n');
    process.exitCode = 2;
    return;
  }
  process.stdout.write(`${await doctor()}\n`);
}

if (require.main === module) main();

module.exports = { doctor };
