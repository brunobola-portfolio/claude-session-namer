'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { stateDir, readState, writeState, pruneOld, appendLog, LOG_MAX_BYTES } = require('../lib/state');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'namer-state-'));

test('stateDir honours CLAUDE_CONFIG_DIR and defaults to ~/.claude', () => {
  const custom = tmp();
  assert.equal(stateDir({ CLAUDE_CONFIG_DIR: custom }), path.join(custom, 'session-namer'));
  const home = tmp();
  assert.equal(stateDir({ HOME: home, USERPROFILE: home }), path.join(home, '.claude', 'session-namer'));
});

test('stateDir falls back to the OS temp dir when the config dir is not writable', () => {
  const base = tmp();
  const blocker = path.join(base, 'cfg');
  fs.writeFileSync(blocker, 'a file where a directory should be');
  const dir = stateDir({ CLAUDE_CONFIG_DIR: blocker });
  assert.ok(dir.startsWith(os.tmpdir()), dir);
  assert.ok(fs.existsSync(dir));
});

test('state round-trips, is atomic, and corrupt files read as null', () => {
  const dir = tmp();
  assert.equal(readState(dir, 'abc'), null);
  writeState(dir, 'abc', { stage: 'provisional', title: 'proj', attempts: 0 });
  assert.deepEqual(readState(dir, 'abc'), { stage: 'provisional', title: 'proj', attempts: 0 });
  assert.equal(fs.readdirSync(path.join(dir, 'state')).filter((f) => f.endsWith('.tmp')).length, 0);
  fs.writeFileSync(path.join(dir, 'state', 'bad.json'), '{oops');
  assert.equal(readState(dir, 'bad'), null);
  assert.equal(readState(dir, '../../etc/passwd'), null);
});

test('pruneOld deletes only files older than maxAgeDays, bounded by maxDeletes', () => {
  const dir = tmp();
  for (let i = 0; i < 5; i++) writeState(dir, `old${i}`, { stage: 'final' });
  writeState(dir, 'fresh', { stage: 'final' });
  const oldTime = new Date(Date.now() - 40 * 86400 * 1000);
  for (let i = 0; i < 5; i++) fs.utimesSync(path.join(dir, 'state', `old${i}.json`), oldTime, oldTime);
  assert.equal(pruneOld(dir, 30, 3), 3);
  assert.equal(pruneOld(dir, 30, 200), 2);
  assert.deepEqual(fs.readdirSync(path.join(dir, 'state')), ['fresh.json']);
});

test('appendLog writes lines and rotates once past the size limit', () => {
  const dir = tmp();
  appendLog(dir, 'hello');
  const logPath = path.join(dir, 'log.txt');
  assert.match(fs.readFileSync(logPath, 'utf8'), /^\d{4}-\d{2}-\d{2}T[^ ]+ hello\n$/);
  fs.writeFileSync(logPath, 'x'.repeat(LOG_MAX_BYTES + 10));
  appendLog(dir, 'after rotation');
  assert.ok(fs.existsSync(`${logPath}.1`));
  assert.match(fs.readFileSync(logPath, 'utf8'), /after rotation\n$/);
  assert.ok(fs.statSync(logPath).size < 200);
});

test('every function swallows filesystem errors', () => {
  const bogus = path.join(tmp(), 'nope', 'deeper');
  fs.writeFileSync(path.dirname(bogus), 'file');
  assert.doesNotThrow(() => writeState(bogus, 's', { stage: 'final' }));
  assert.equal(readState(bogus, 's'), null);
  assert.equal(pruneOld(bogus), 0);
  assert.doesNotThrow(() => appendLog(bogus, 'x'));
});
