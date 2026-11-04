'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const state = require('../lib/state');
const { work, shouldSpawn, parseList, findGoose, KEY_PREFIX } = require('../adapters/goose/namer');
const { spawnSync } = require('node:child_process');
const { spawnWorker, winArg, PS_COMMAND } = require('../adapters/goose/hook');

const SID = '20261103_1';

function tmpEnv(extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sn-goose-'));
  return { CLAUDE_CONFIG_DIR: dir, PATH: '', SESSION_NAMER_GOOSE_TOPIC: 'claude', ...extra };
}

/**
 * Fake goose CLI. `timeline` is a list of { name, userSet } snapshots returned
 * by successive `session list` calls until the first rename; afterwards the
 * renamed value is returned, unless `overwriteAfterRename` injects goose's
 * late auto-name once.
 */
function fakeGoose({ timeline, overwriteAfterRename = null, renameCode = 0 }) {
  const calls = [];
  let i = 0;
  let renamed = null;
  let overwritePending = overwriteAfterRename;
  const list = (s) => JSON.stringify([{ id: 'other_1', name: 'x', user_set_name: false }, { id: SID, name: s.name, user_set_name: s.userSet, extension_data: {} }]);
  const run = async (args) => {
    calls.push(args);
    if (args[1] === 'list') {
      if (renamed) {
        if (overwritePending) { const o = overwritePending; overwritePending = null; renamed = { name: o, userSet: false }; }
        return { code: 0, stdout: list(renamed), stderr: '' };
      }
      const s = timeline[Math.min(i, timeline.length - 1)];
      i += 1;
      return { code: 0, stdout: list(s), stderr: '' };
    }
    if (args[1] === 'rename') {
      if (renameCode) return { code: renameCode, stdout: '', stderr: 'Error: Session not found' };
      renamed = { name: args[args.indexOf('-n') + 1], userSet: true };
      return { code: 0, stdout: 'renamed', stderr: '' };
    }
    return { code: 1, stdout: '', stderr: '?' };
  };
  return { run, calls };
}

const input = (message, dir = '/home/me/webapp') => ({ event: 'UserPromptSubmit', session_id: SID, message, working_dir: dir });

const deps = (env, fake, extra = {}) => ({
  env, run: fake.run, goosePath: 'goose.exe', git: () => null, sleep: async () => {},
  stateDir: state.stateDir(env), log: () => {}, hasClaude: () => true, ...extra,
});

test('parseList finds the session and its user_set_name flag', () => {
  const out = parseList(JSON.stringify([{ id: 'a', name: 'A', user_set_name: true }, { id: SID, name: 'Mock', user_set_name: false }]), SID);
  assert.deepEqual(out, { name: 'Mock', userSet: false });
  assert.equal(parseList('[]', SID), null);
  assert.equal(parseList('nope', SID), null);
});

test('claude topic is applied with goose session rename and the session becomes final', async () => {
  const env = tmpEnv();
  const fake = fakeGoose({ timeline: [{ name: 'Safari login fix', userSet: false }] });
  const out = await work(input('Fix the login redirect loop on Safari'), deps(env, fake, { generate: async () => 'Fix Safari login redirect loop' }));
  assert.equal(out, 'final');
  const rename = fake.calls.find((c) => c[1] === 'rename');
  assert.deepEqual(rename, ['session', 'rename', '--session-id', SID, '-n', 'webapp - Fix Safari login redirect loop']);
  assert.equal(state.readState(state.stateDir(env), KEY_PREFIX + SID).stage, 'final');
  assert.equal(shouldSpawn(input('Another real prompt for the session'), { env }), false);
});

test('re-asserts when goose\'s in-flight auto-name lands after ours', async () => {
  const env = tmpEnv();
  const fake = fakeGoose({ timeline: [{ name: '', userSet: false }], overwriteAfterRename: 'Goose late name' });
  const out = await work(input('Add rate limiting to the public search API'), deps(env, fake, { generate: async () => 'Rate limiting for search API' }));
  assert.equal(out, 'final');
  assert.equal(fake.calls.filter((c) => c[1] === 'rename').length, 2);
});

test('a name the user set is never touched', async () => {
  const env = tmpEnv();
  const fake = fakeGoose({ timeline: [{ name: 'My own name', userSet: true }] });
  let generated = false;
  const out = await work(input('Add rate limiting to the public search API'), deps(env, fake, { generate: async () => { generated = true; return 'x y z'; } }));
  assert.equal(out, 'user-named');
  assert.equal(generated, false);
  assert.ok(!fake.calls.some((c) => c[1] === 'rename'));
  assert.equal(state.readState(state.stateDir(env), KEY_PREFIX + SID).stage, 'user');
});

test('native mode uses goose\'s own name, waiting for it when still empty', async () => {
  const env = tmpEnv({ SESSION_NAMER_GOOSE_TOPIC: 'native' });
  const fake = fakeGoose({ timeline: [{ name: '', userSet: false }, { name: '', userSet: false }, { name: '', userSet: false }, { name: 'Search API rate limits', userSet: false }] });
  const out = await work(input('Add rate limiting to the public search API'), deps(env, fake, { generate: async () => { throw new Error('must not run'); } }));
  assert.equal(out, 'final');
  assert.equal(fake.calls.find((c) => c[1] === 'rename')[5], 'webapp - Search API rate limits');
});

test('trivial prompts are filtered both in the hook gate and in the worker', async () => {
  const env = tmpEnv();
  assert.equal(shouldSpawn(input('ok'), { env }), false);
  assert.equal(shouldSpawn({ ...input('Fix the login redirect loop on Safari'), event: 'Stop' }, { env }), false);
  assert.equal(shouldSpawn(input('Fix the login redirect loop on Safari'), { env }), true);
  const fake = fakeGoose({ timeline: [{ name: '', userSet: false }] });
  assert.equal(await work(input('continua'), deps(env, fake)), 'trivial-prompt');
  assert.equal(fake.calls.length, 0);
});

test('rename failure and missing goose are reported cleanly', async () => {
  const env = tmpEnv();
  const fake = fakeGoose({ timeline: [{ name: 'n', userSet: false }], renameCode: 1 });
  assert.equal(await work(input('Fix the login redirect loop on Safari'), deps(env, fake, { generate: async () => 'Fix Safari login loop' })), 'rename-failed');
  assert.equal(await work(input('Fix the login redirect loop on Safari'), deps(tmpEnv(), fake, { goosePath: null })), 'no-goose');
});

test('findGoose checks PATH, then the official install folders', () => {
  const winExists = (p) => p === 'C:\\Users\\me\\goose\\goose.exe';
  assert.equal(findGoose({ PATH: 'C:\\bin', USERPROFILE: 'C:\\Users\\me' }, { platform: 'win32', exists: winExists }), 'C:\\Users\\me\\goose\\goose.exe');
  assert.equal(findGoose({ PATH: '/usr/bin', HOME: '/home/me' }, { platform: 'linux', exists: (p) => p === '/home/me/.local/bin/goose' }), '/home/me/.local/bin/goose');
  assert.equal(findGoose({ SESSION_NAMER_GOOSE_PATH: 'D:\\g\\goose.exe' }, { platform: 'win32', exists: () => false }), 'D:\\g\\goose.exe');
  assert.equal(findGoose({ PATH: '' }, { platform: 'linux', exists: () => false }), null);
});

test('on Windows the worker is started through Start-Process, with every value in the environment', () => {
  let seen = null;
  const spawnSyncFn = (cmd, args, opts) => { seen = { cmd, args, opts }; return { status: 0 }; };
  const evilCwd = 'C:\\it\u2019s; New-Item PWNED \u2018here';
  spawnWorker('eyJhIjoxfQ==', evilCwd, { platform: 'win32', spawnSyncFn });
  assert.equal(seen.cmd, 'powershell.exe');
  const command = seen.args[seen.args.length - 1];
  // The command is a constant: no data is ever part of the PowerShell source.
  assert.equal(command, PS_COMMAND);
  assert.match(command, /^Start-Process -WindowStyle Hidden /);
  assert.ok(!command.includes('it'), command);
  assert.equal(seen.opts.env.SN_GOOSE_CWD, evilCwd);
  assert.equal(seen.opts.env.SN_GOOSE_NODE, process.execPath);
  assert.ok(seen.opts.env.SN_GOOSE_ARGS.endsWith(' --worker eyJhIjoxfQ=='), seen.opts.env.SN_GOOSE_ARGS);
  assert.equal(winArg('C:\\a b\\x.js'), '"C:\\a b\\x.js"');
  assert.equal(winArg('a"b'), '"a\\"b"');
  assert.equal(winArg('C:\\dir with space\\'), '"C:\\dir with space\\\\"');
});

test('live (Windows): a folder name with Unicode quotes does not inject PowerShell', { skip: process.platform !== 'win32' }, async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'sn-goose-ps-'));
  const evil = path.join(base, 'x\u2019; New-Item -ItemType File PWNED; \u2018y');
  fs.mkdirSync(evil);
  const script = path.join(base, 'probe.js');
  const out = path.join(base, 'out.json');
  fs.writeFileSync(script, `require('fs').writeFileSync(${JSON.stringify(out)}, JSON.stringify({ cwd: process.cwd(), argv: process.argv.slice(2) }));\n`);
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', PS_COMMAND], {
    stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true, timeout: 20000, encoding: 'utf8',
    env: { ...process.env, SN_GOOSE_CWD: evil, SN_GOOSE_NODE: process.execPath, SN_GOOSE_ARGS: [script, '--worker', 'e30='].map(winArg).join(' ') },
  });
  assert.equal(r.status, 0, r.stderr);
  for (let i = 0; i < 100 && !fs.existsSync(out); i += 1) await new Promise((res) => { setTimeout(res, 100); });
  const got = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.equal(got.cwd, evil);
  assert.deepEqual(got.argv, ['--worker', 'e30=']);
  assert.equal(fs.existsSync(path.join(evil, 'PWNED')), false);
  assert.equal(fs.existsSync(path.join(base, 'PWNED')), false);
});

test('elsewhere the worker is a plain detached child', () => {
  let opts = null;
  const spawnFn = (cmd, args, o) => { opts = o; return { on() {}, unref() {} }; };
  spawnWorker('e30=', '/tmp', { platform: 'linux', spawnFn });
  assert.equal(opts.detached, true);
  assert.equal(opts.stdio, 'ignore');
});
