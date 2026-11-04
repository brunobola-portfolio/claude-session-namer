'use strict';
// POSIX fallback of osc-title.js for hooks with no controlling terminal
// (Qwen Code spawns hooks `detached`). Everything is injected: no real ps, tty or fs.
const test = require('node:test');
const assert = require('node:assert/strict');

const osc = require('../adapters/_shared/osc-title');

const SEQ = '\u001b]0;proj - Topic\u0007';
const UID = 501;
const CONSTANTS = { O_WRONLY: 0x1, O_NOCTTY: 0x100, O_NONBLOCK: 0x800 };

/** spawnSync that answers `ps -o ppid= -o tty= -p <pid>` from a table {pid: 'ppid tty'}. */
function fakePs(table, calls = []) {
  return (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    const pid = args[args.indexOf('-p') + 1];
    return pid in table ? { status: 0, stdout: `  ${table[pid]}\n` } : { status: 1, stdout: '' };
  };
}

const charDev = (uid = UID) => ({ isCharacterDevice: () => true, uid });

/** Recording fs for writeTtyDevice / writeTerminalTitle. `devTty` false: /dev/tty fails with ENXIO. */
function fakeFs({ devTty = false, stat = () => charDev(), openFails = false, writeFails = false } = {}) {
  const log = [];
  return {
    log,
    statSync: (p) => { log.push(['stat', p]); return stat(p); },
    openSync: (p, flags) => {
      log.push(['open', p, flags]);
      if (p === '/dev/tty' && !devTty) throw Object.assign(new Error('ENXIO'), { code: 'ENXIO' });
      if (openFails) throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
      return 9;
    },
    writeSync: (fd, s) => { log.push(['write', fd, s]); if (writeFails) throw new Error('EIO'); },
    closeSync: (fd) => { log.push(['close', fd]); },
    constants: CONSTANTS,
  };
}

test('ancestorTtyDevice: walks up with argv-only ps and maps Linux pts/N to /dev/pts/N', () => {
  const calls = [];
  const dev = osc.ancestorTtyDevice(300, { spawnSync: fakePs({ 300: '200 ?', 200: '100 pts/4' }, calls) });
  assert.equal(dev, '/dev/pts/4');
  assert.deepEqual(calls.map((c) => [c.cmd, c.args]), [
    ['ps', ['-o', 'ppid=', '-o', 'tty=', '-p', '300']],
    ['ps', ['-o', 'ppid=', '-o', 'tty=', '-p', '200']],
  ]);
  for (const c of calls) {
    assert.ok(!c.opts.shell, 'ps must be spawned without a shell');
    assert.ok(c.opts.timeout > 0 && c.opts.timeout <= osc.PS_STEP_TIMEOUT_MS);
  }
});

test('ancestorTtyDevice: macOS ttys003 maps to /dev/ttys003 and ?? means no terminal', () => {
  assert.equal(osc.ancestorTtyDevice(50, { spawnSync: fakePs({ 50: '40 ??', 40: '1 ttys003' }) }), '/dev/ttys003');
  assert.equal(osc.ancestorTtyDevice(50, { spawnSync: fakePs({ 50: '1 ??' }) }), null);
});

test('ancestorTtyDevice: stops after MAX_HOPS, at PID 1, on loops, on ps failure and bad input', () => {
  const calls = [];
  const endless = (cmd, args) => { calls.push(args); return { status: 0, stdout: `${Number(args[5]) + 1} ?` }; };
  assert.equal(osc.ancestorTtyDevice(1000, { spawnSync: endless }), null);
  assert.equal(calls.length, osc.MAX_HOPS);

  let n = 0;
  const count = fakePs({ 7: '7 ?' });
  assert.equal(osc.ancestorTtyDevice(7, { spawnSync: (...a) => { n += 1; return count(...a); } }), null);
  assert.equal(n, 1, 'a process that is its own parent is visited once');

  assert.equal(osc.ancestorTtyDevice(30, { spawnSync: fakePs({}) }), null);
  assert.equal(osc.ancestorTtyDevice(30, { spawnSync: () => { throw new Error('ENOENT'); } }), null);
  assert.equal(osc.ancestorTtyDevice(30, { spawnSync: () => ({ status: 0, stdout: 'garbage' }) }), null);
  const never = () => { throw new Error('must not spawn'); };
  for (const pid of [1, 0, -5, null, undefined, 2.5, '12']) assert.equal(osc.ancestorTtyDevice(pid, { spawnSync: never }), null);
});

test('ancestorTtyDevice: the whole walk has a time budget', () => {
  let t = 0;
  const calls = [];
  const slowPs = (cmd, args, opts) => { calls.push(opts.timeout); t += 600; return { status: 0, stdout: `${Number(args[5]) + 1} ?` }; };
  assert.equal(osc.ancestorTtyDevice(100, { spawnSync: slowPs, now: () => t, budgetMs: 1500 }), null);
  assert.deepEqual(calls, [1000, 900, 300], 'each ps gets at most what is left of the budget');
  assert.ok(osc.WALK_BUDGET_MS <= 2000, 'well inside the hooks\' 10 s timeout');
});

test('ancestorTtyDevice: names that are not terminals never become paths', () => {
  for (const name of ['../../etc/passwd', 'pts/1/../../x', 'console', '/dev/sda', 'pts/']) {
    assert.equal(osc.ancestorTtyDevice(20, { spawnSync: fakePs({ 20: `1 ${name}` }) }), null, name);
  }
});

test('writeTtyDevice: only a character device owned by the current user, opened O_WRONLY|O_NOCTTY', () => {
  const ok = fakeFs();
  assert.equal(osc.writeTtyDevice('/dev/pts/4', SEQ, { uid: UID, ...ok }), true);
  assert.deepEqual(ok.log, [
    ['stat', '/dev/pts/4'],
    ['open', '/dev/pts/4', CONSTANTS.O_WRONLY | CONSTANTS.O_NOCTTY | CONSTANTS.O_NONBLOCK],
    ['write', 9, SEQ],
    ['close', 9],
  ]);

  const notChar = fakeFs({ stat: () => ({ isCharacterDevice: () => false, uid: UID }) });
  assert.equal(osc.writeTtyDevice('/dev/pts/4', SEQ, { uid: UID, ...notChar }), false);
  const foreign = fakeFs({ stat: () => charDev(0) });
  assert.equal(osc.writeTtyDevice('/dev/pts/4', SEQ, { uid: UID, ...foreign }), false);
  for (const f of [notChar, foreign]) assert.ok(!f.log.some(([op]) => op === 'open'), 'never opened');

  const strange = fakeFs();
  for (const dev of ['/etc/passwd', '/dev/pts/4/../../sda', 'pts/4', '/dev/console']) {
    assert.equal(osc.writeTtyDevice(dev, SEQ, { uid: UID, ...strange }), false, dev);
  }
  assert.deepEqual(strange.log, [], 'not even stat-ed');
  assert.equal(osc.writeTtyDevice('/dev/pts/4', SEQ, { uid: null, ...strange }), false);

  const missing = fakeFs({ stat: () => { throw new Error('ENOENT'); } });
  assert.equal(osc.writeTtyDevice('/dev/pts/4', SEQ, { uid: UID, ...missing }), false);
  const writeFails = fakeFs({ writeFails: true });
  assert.equal(osc.writeTtyDevice('/dev/pts/4', SEQ, { uid: UID, ...writeFails }), false);
  assert.deepEqual(writeFails.log.at(-1), ['close', 9], 'closed after a failed write');
});

test('writeTerminalTitle (POSIX): /dev/tty first; no ancestor walk when it works', () => {
  const f = fakeFs({ devTty: true });
  const env = {};
  const ok = osc.writeTerminalTitle('proj - Topic', {
    platform: 'linux', env, proc: { ppid: 300, getuid: () => UID }, ...f,
    spawnSync: () => { throw new Error('must not walk'); },
  });
  assert.equal(ok, true);
  assert.deepEqual(f.log, [['open', '/dev/tty', 'w'], ['write', 9, SEQ], ['close', 9]]);
  assert.deepEqual(env, {});
});

test('writeTerminalTitle (POSIX, detached): falls back to the ancestor terminal and hands it on', () => {
  const f = fakeFs();
  const env = {};
  const ok = osc.writeTerminalTitle('proj - Topic', {
    platform: 'darwin', env, proc: { ppid: 300, getuid: () => UID }, ...f,
    spawnSync: fakePs({ 300: '200 ??', 200: '1 ttys003' }),
  });
  assert.equal(ok, true);
  assert.deepEqual(f.log, [
    ['open', '/dev/tty', 'w'],
    ['stat', '/dev/ttys003'],
    ['open', '/dev/ttys003', CONSTANTS.O_WRONLY | CONSTANTS.O_NOCTTY | CONSTANTS.O_NONBLOCK],
    ['write', 9, SEQ],
    ['close', 9],
  ]);
  assert.equal(env[osc.TTY_ENV], '/dev/ttys003', 'the worker inherits the device');
});

test('writeTerminalTitle (POSIX, worker): uses the inherited device, re-walks when it is stale', () => {
  const f = fakeFs();
  const env = { [osc.TTY_ENV]: '/dev/pts/4' };
  const noWalk = () => { throw new Error('must not walk'); };
  assert.equal(osc.writeTerminalTitle('proj - Topic', { platform: 'linux', env, proc: { ppid: 1, getuid: () => UID }, ...f, spawnSync: noWalk }), true);
  assert.deepEqual(f.log.slice(1).map((e) => e.slice(0, 2)), [['stat', '/dev/pts/4'], ['open', '/dev/pts/4'], ['write', 9], ['close', 9]]);

  const stale = fakeFs({ stat: (p) => (p === '/dev/pts/4' ? charDev(0) : charDev()) });
  const env2 = { [osc.TTY_ENV]: '/dev/pts/4' };
  assert.equal(osc.writeTerminalTitle('proj - Topic', { platform: 'linux', env: env2, proc: { ppid: 70, getuid: () => UID }, ...stale, spawnSync: fakePs({ 70: '1 pts/6' }) }), true);
  assert.equal(env2[osc.TTY_ENV], '/dev/pts/6');

  const bogus = fakeFs();
  const env3 = { [osc.TTY_ENV]: '/etc/passwd' };
  assert.equal(osc.writeTerminalTitle('proj - Topic', { platform: 'linux', env: env3, proc: { ppid: 1, getuid: () => UID }, ...bogus, spawnSync: noWalk }), false);
  assert.ok(!bogus.log.some(([, p]) => p === '/etc/passwd'), 'a bad hint is never touched');
});

test('writeTerminalTitle (POSIX): no terminal anywhere, or not ours, means false and no hint', () => {
  const env = {};
  const none = fakeFs();
  assert.equal(osc.writeTerminalTitle('t', { platform: 'linux', env, proc: { ppid: 300, getuid: () => UID }, ...none, spawnSync: fakePs({ 300: '1 ?' }) }), false);
  const foreign = fakeFs({ stat: () => charDev(0) });
  assert.equal(osc.writeTerminalTitle('t', { platform: 'linux', env, proc: { ppid: 300, getuid: () => UID }, ...foreign, spawnSync: fakePs({ 300: '1 pts/0' }) }), false);
  assert.ok(!foreign.log.some(([op, p]) => op === 'open' && p === '/dev/pts/0'));
  const noUid = fakeFs();
  assert.equal(osc.writeTerminalTitle('t', { platform: 'linux', env, proc: { ppid: 300 }, ...noUid, spawnSync: fakePs({ 300: '1 pts/0' }) }), false);
  assert.deepEqual(env, {});
  assert.equal(osc.writeTerminalTitle('\u001b\u0007', { platform: 'linux', env, spawnSync: () => { throw new Error('no'); } }), false, 'nothing printable: nothing to do');
});
