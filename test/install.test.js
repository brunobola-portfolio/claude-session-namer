'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const jsonc = require('../lib/install/jsonc');
const { main } = require('../lib/install');

const isWin = process.platform === 'win32';

const roots = [];
test.after(() => { for (const r of roots) fs.rmSync(r, { recursive: true, force: true }); });

function sandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sn-install-'));
  roots.push(root);
  const home = path.join(root, 'home');
  fs.mkdirSync(home);
  return { root, home };
}

/** Run the CLI against a temp HOME with mocked binaries and spawn. */
async function cli(sb, argv, { bins = {}, spawn, version, env = {} } = {}) {
  let out = '';
  const calls = [];
  const code = await main(argv, {
    home: sb.home,
    env: { ...env },
    version,
    which: (name) => bins[name] || null,
    spawn: (cmd, args, o) => {
      calls.push([path.basename(cmd), ...args]);
      return spawn ? spawn(cmd, args, o) : { status: 0, stdout: '', stderr: '' };
    },
    out: (s) => { out += s; },
  });
  return { code, out, calls };
}

const read = (p) => fs.readFileSync(p, 'utf8');
const write = (p, s) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s); };

// ------------------------------------------------------------------ jsonc

test('jsonc: insert then remove restores the exact bytes (comments, trailing commas, BOM)', () => {
  const ours = (t) => t.includes('/.session-namer/app/');
  const samples = [
    '{\n  // keep me\n  "$schema": "https://opencode.ai/config.json", /* inline */\n}\n',
    '﻿{\n\t"plugin": [\n\t\t"file:///x/other.mjs", // mine\n\t],\n\t"model": "x"\n}',
    '{}',
    '{ "plugin": [] }',
    '{\n  "plugin": ["a"]\n}\n',
  ];
  for (const s of samples) {
    const r = jsonc.ensureArrayItem(s, ['plugin'], 'file:///c/.session-namer/app/1.0.0/a.mjs', ours);
    assert.equal(r.action, 'added');
    assert.ok(jsonc.parseValue(r.text).plugin.includes('file:///c/.session-namer/app/1.0.0/a.mjs'));
    assert.ok(r.text.includes('// keep me') || !s.includes('// keep me'));
    const again = jsonc.ensureArrayItem(r.text, ['plugin'], 'file:///c/.session-namer/app/1.0.0/a.mjs', ours);
    assert.equal(again.action, 'unchanged');
    assert.equal(again.text, r.text);
    let back = jsonc.removeArrayItems(r.text, ['plugin'], ours).text;
    back = jsonc.pruneCreated(back, r.created);
    assert.equal(back, s, `round trip failed for ${JSON.stringify(s)}`);
  }
});

test('jsonc: replaces an older entry of ours in place and drops duplicates', () => {
  const ours = (t) => t.includes('/.session-namer/app/');
  const s = '{\n  "plugin": [\n    "file:///c/.session-namer/app/0.9.0/a.mjs",\n    "user.mjs",\n    "file:///c/.session-namer/app/0.8.0/a.mjs"\n  ]\n}\n';
  const r = jsonc.ensureArrayItem(s, ['plugin'], 'file:///c/.session-namer/app/1.0.0/a.mjs', ours);
  assert.equal(r.action, 'updated');
  assert.deepEqual(jsonc.parseValue(r.text).plugin, ['file:///c/.session-namer/app/1.0.0/a.mjs', 'user.mjs']);
});

test('jsonc: refuses malformed input', () => {
  assert.throws(() => jsonc.parse('{ "a": 1 '), jsonc.JsoncError);
  assert.throws(() => jsonc.ensureArrayItem('{"plugin": "x"}', ['plugin'], 'y', () => false), /not an array/);
});

// ------------------------------------------------------------ install flows

test('gemini: fresh install creates settings.json, uninstall removes it and the folder', async () => {
  const sb = sandbox();
  const r = await cli(sb, ['install', 'gemini'], { version: '1.0.0' });
  assert.equal(r.code, 0, r.out);
  const file = path.join(sb.home, '.gemini', 'settings.json');
  const cfg = JSON.parse(read(file));
  assert.equal(cfg.ui.hideWindowTitle, true);
  for (const e of ['SessionStart', 'BeforeAgent', 'AfterAgent']) {
    assert.match(cfg.hooks[e][0].hooks[0].command, /\.session-namer\/app\/1\.0\.0\/adapters\/gemini\/hook\.js/);
  }
  assert.ok(fs.existsSync(path.join(sb.home, '.session-namer', 'app', '1.0.0', 'adapters', 'gemini', 'hook.js')));
  assert.ok(fs.existsSync(path.join(sb.home, '.session-namer', 'app', '1.0.0', 'lib', 'generate.js')));
  assert.match(r.out, /✓ gemini/);
  assert.match(r.out, /terminal tab/);

  const again = await cli(sb, ['install', 'gemini'], { version: '1.0.0' });
  assert.match(again.out, /– gemini\s+already up to date/);

  const u = await cli(sb, ['uninstall', 'gemini'], { version: '1.0.0' });
  assert.equal(u.code, 0, u.out);
  assert.equal(fs.existsSync(file), false);
  assert.equal(fs.existsSync(path.join(sb.home, '.gemini')), false);
  assert.equal(fs.existsSync(path.join(sb.home, '.session-namer')), false, 'home is cleaned when nothing uses it');
});

test('opencode: JSONC with comments and secrets is merged, idempotent, restored byte-for-byte', async () => {
  const sb = sandbox();
  const file = path.join(sb.home, '.config', 'opencode', 'opencode.jsonc');
  const original = '{\n  // my config\n  "$schema": "https://opencode.ai/config.json",\n  "mcp": { "x": { "environment": { "API_KEY": "sk-secret-123" } } }, // trailing\n}\n';
  write(file, original);
  const r = await cli(sb, ['install', 'opencode'], { version: '1.0.0' });
  assert.equal(r.code, 0, r.out);
  const text = read(file);
  assert.ok(text.includes('// my config') && text.includes('// trailing'));
  assert.match(jsonc.parseValue(text).plugin[0], /^file:\/\/\/.*\.session-namer\/app\/1\.0\.0\/adapters\/opencode\/index\.mjs$/);
  assert.equal(read(`${file}.session-namer.bak`), original);
  assert.ok(!r.out.includes('sk-secret-123'), 'secrets must never be printed');

  const twice = await cli(sb, ['install', 'opencode'], { version: '1.0.0' });
  assert.equal(read(file), text, 'second install changes nothing');
  assert.match(twice.out, /– opencode/);

  const u = await cli(sb, ['uninstall', 'opencode'], { version: '1.0.0' });
  assert.equal(u.code, 0);
  assert.equal(read(file), original);
  assert.equal(fs.existsSync(`${file}.session-namer.bak`), false, 'a backup identical to the restored file is deleted');
  assert.doesNotMatch(u.out, /Backups kept/);
});

test('upgrade rewrites pointers to the new version and prunes the old runtime', async () => {
  const sb = sandbox();
  await cli(sb, ['install', 'crush', 'qwen'], { version: '1.0.0' });
  const r = await cli(sb, ['install', 'crush', 'qwen'], { version: '2.0.0' });
  assert.equal(r.code, 0, r.out);
  const crush = read(path.join(sb.home, '.config', 'crush', 'crush.json'));
  assert.match(crush, /app\/2\.0\.0\/adapters\/crush\/hook\.js/);
  assert.doesNotMatch(crush, /1\.0\.0/);
  assert.equal(JSON.parse(crush).hooks.TurnStart.length, 1);
  assert.equal(fs.existsSync(path.join(sb.home, '.session-namer', 'app', '1.0.0')), false);
  assert.match(r.out, /removed installed copies nothing uses: 1\.0\.0/);
  const st = await cli(sb, ['status'], { version: '2.0.0' });
  assert.match(st.out, /✓ crush .*installed v2\.0\.0/);
});

test('a version still used by another harness is kept', async () => {
  const sb = sandbox();
  await cli(sb, ['install', 'crush', 'grok'], { version: '1.0.0' });
  await cli(sb, ['install', 'crush'], { version: '2.0.0' });
  assert.ok(fs.existsSync(path.join(sb.home, '.session-namer', 'app', '1.0.0')));
  const st = await cli(sb, ['status'], { version: '2.0.0' });
  assert.match(st.out, /upgrades it to 2\.0\.0/);
});

test('codex: merges with existing user hooks and keeps them on uninstall', async () => {
  const sb = sandbox();
  const file = path.join(sb.home, '.codex', 'hooks.json');
  const original = `${JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'echo mine' }] }] } }, null, 2)}\n`;
  write(file, original);
  const r = await cli(sb, ['install', 'codex'], { version: '1.0.0' });
  assert.equal(r.code, 0, r.out);
  const cfg = JSON.parse(read(file));
  assert.equal(cfg.hooks.UserPromptSubmit.length, 2);
  assert.equal(cfg.hooks.UserPromptSubmit[0].hooks[0].command, 'echo mine');
  assert.match(cfg.hooks.UserPromptSubmit[1].hooks[0].command, /codex\/hook\.js" UserPromptSubmit$/);
  assert.equal(cfg.hooks.SessionStart[0].matcher, 'startup|resume');
  assert.match(r.out, /\/hooks and trust/);
  await cli(sb, ['uninstall', 'codex'], { version: '1.0.0' });
  assert.equal(read(file), original);
});

test('codex: warns when the Claude Code plugin is enabled inside Codex', async () => {
  const sb = sandbox();
  write(path.join(sb.home, '.codex', 'config.toml'), '[plugins."session-namer@claude-session-namer"]\nenabled = true\n');
  const r = await cli(sb, ['install', 'codex'], { version: '1.0.0' });
  assert.match(r.out, /do not trust its hooks/);
});

test('a malformed config is refused, left untouched, and the exit code is non-zero', async () => {
  const sb = sandbox();
  const file = path.join(sb.home, '.qwen', 'settings.json');
  write(file, '{ "ui": { ');
  const r = await cli(sb, ['install', 'qwen'], { version: '1.0.0' });
  assert.equal(r.code, 1);
  assert.match(r.out, /✗ qwen\s+could not edit .* safely/);
  assert.match(r.out, /adapters\/qwen\/README\.md/);
  assert.equal(read(file), '{ "ui": { ');
  assert.equal(fs.existsSync(`${file}.session-namer.bak`), false);
});

test('qwen: an explicit ui.hideWindowTitle=false is kept and reported', async () => {
  const sb = sandbox();
  const file = path.join(sb.home, '.qwen', 'settings.json');
  write(file, '{\n  "ui": {\n    "hideWindowTitle": false\n  }\n}\n');
  const r = await cli(sb, ['install', 'qwen'], { version: '1.0.0' });
  assert.equal(JSON.parse(read(file)).ui.hideWindowTitle, false);
  assert.match(r.out, /ui\.hideWindowTitle is false/);
});

test('owned files: amp shim, grok hook file, cline stubs, copilot extension', async () => {
  const sb = sandbox();
  const r = await cli(sb, ['install', 'amp', 'grok', 'cline', 'copilot'], { version: '1.0.0' });
  assert.equal(r.code, 0, r.out);
  const amp = read(path.join(sb.home, '.config', 'amp', 'plugins', 'session-namer.js'));
  assert.match(amp, /^\/\/ session-namer amp shim/);
  assert.match(amp, /export \{ default \} from 'file:\/\/\/.*app\/1\.0\.0\/adapters\/amp\/plugin\.mjs'/);
  const grok = JSON.parse(read(path.join(sb.home, '.grok', 'hooks', 'session-namer.json')));
  assert.match(grok.hooks.UserPromptSubmit[0].hooks[0].command, /grok\/hook\.js/);
  for (const n of ['TaskStart.js', 'UserPromptSubmit.js']) {
    assert.match(read(path.join(sb.home, '.cline', 'hooks', n)), /session-namer cline adapter/);
  }
  const ext = read(path.join(sb.home, '.copilot', 'extensions', 'session-namer', 'extension.mjs'));
  assert.match(ext, /copilot-sdk\/extension/);
  assert.match(r.out, /experimental/);

  const u = await cli(sb, ['uninstall', '--all'], { version: '1.0.0' });
  assert.equal(u.code, 0, u.out);
  for (const d of [path.join('.config', 'amp'), '.grok', '.cline', '.copilot']) {
    assert.equal(fs.existsSync(path.join(sb.home, d)), false, `${d} should be gone`);
  }
});

test('a foreign file in our place is never overwritten', async () => {
  const sb = sandbox();
  const file = path.join(sb.home, '.cline', 'hooks', 'TaskStart.js');
  write(file, 'console.log("my own hook")\n');
  const r = await cli(sb, ['install', 'cline'], { version: '1.0.0' });
  assert.equal(r.code, 1);
  assert.match(r.out, /✗ cline\s+.*not written by this installer/);
  assert.equal(read(file), 'console.log("my own hook")\n');
  assert.equal(fs.existsSync(path.join(sb.home, '.cline', 'hooks', 'UserPromptSubmit.js')), false);
});

test('deepseek: empty [] patch is replaced and restored exactly; non-empty list is appended', async () => {
  const sb = sandbox();
  const empty = '# Your patch layer\n# comment\n[]\n';
  const listed = '- id: something\n  disabled: true\n';
  write(path.join(sb.home, '.dsh', 'profiles', 'web', 'cordis.patch.yml'), empty);
  write(path.join(sb.home, '.dsh', 'profiles', 'tui', 'cordis.patch.yml'), listed);
  const r = await cli(sb, ['install', 'deepseek'], { version: '1.0.0' });
  assert.equal(r.code, 0, r.out);
  const web = read(path.join(sb.home, '.dsh', 'profiles', 'web', 'cordis.patch.yml'));
  assert.match(web, /- id: session-title-llm\n  disabled: true/);
  assert.match(web, /name: file:\/\/\/.*app\/1\.0\.0\/adapters\/deepseek\/plugin\.mjs/);
  assert.doesNotMatch(web, /^\[\]$/m);
  const tui = read(path.join(sb.home, '.dsh', 'profiles', 'tui', 'cordis.patch.yml'));
  assert.ok(tui.startsWith(listed));
  const again = await cli(sb, ['install', 'deepseek'], { version: '2.0.0' });
  assert.match(read(path.join(sb.home, '.dsh', 'profiles', 'web', 'cordis.patch.yml')), /app\/2\.0\.0/);
  assert.equal(again.code, 0);
  await cli(sb, ['uninstall', 'deepseek'], { version: '2.0.0' });
  assert.equal(read(path.join(sb.home, '.dsh', 'profiles', 'web', 'cordis.patch.yml')), empty);
  assert.equal(read(path.join(sb.home, '.dsh', 'profiles', 'tui', 'cordis.patch.yml')), listed);
});

test('deepseek: without profiles it fails with the per-run alternative', async () => {
  const sb = sandbox();
  const r = await cli(sb, ['install', 'deepseek'], { version: '1.0.0' });
  assert.equal(r.code, 1);
  assert.match(r.out, /--patch/);
});

test('goose: links the adapter folder and removes only that link', async () => {
  const sb = sandbox();
  const r = await cli(sb, ['install', 'goose'], { version: '1.0.0', bins: { sh: '/bin/sh' } });
  assert.equal(r.code, 0, r.out);
  const link = path.join(sb.home, '.agents', 'plugins', 'session-namer');
  assert.ok(fs.lstatSync(link).isSymbolicLink());
  assert.ok(fs.existsSync(path.join(link, 'hook.js')));
  const u = await cli(sb, ['uninstall', 'goose'], { version: '1.0.0' });
  assert.equal(u.code, 0, u.out);
  assert.equal(fs.existsSync(link), false);
  assert.equal(fs.existsSync(path.join(sb.home, '.agents')), false);
});

test('goose on Windows without sh on PATH gets a follow-up', { skip: !isWin }, async () => {
  const sb = sandbox();
  const r = await cli(sb, ['install', 'goose'], { version: '1.0.0' });
  assert.match(r.out, /sh -c/);
});

test('claude: installs through the plugin CLI, or reports it is already there', async () => {
  const sb = sandbox();
  const bins = { claude: '/x/claude' };
  let installed = false;
  const spawn = (cmd, args) => {
    const a = args.join(' ');
    if (a === 'plugin list --json') return { status: 0, stdout: JSON.stringify(installed ? [{ id: 'session-namer@claude-session-namer', version: '1.2.0', enabled: true }] : []) };
    if (a === 'plugin marketplace list --json') return { status: 0, stdout: '[]' };
    if (a.startsWith('plugin install')) installed = true;
    return { status: 0, stdout: '' };
  };
  const r = await cli(sb, ['install', 'claude'], { bins, spawn });
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(r.calls.map((c) => c.slice(1).join(' ')), [
    'plugin list --json',
    'plugin marketplace list --json',
    'plugin marketplace add brunobola-portfolio/claude-session-namer',
    'plugin install session-namer@claude-session-namer',
  ]);
  assert.equal(fs.existsSync(path.join(sb.home, '.session-namer', 'app')), false, 'claude does not need the runtime copy');
  const again = await cli(sb, ['install', 'claude'], { bins, spawn });
  assert.match(again.out, /– claude\s+already installed \(session-namer@claude-session-namer 1\.2\.0\)/);
  assert.equal(again.calls.length, 1);
});

test('claude: missing CLI is a failure', async () => {
  const sb = sandbox();
  const r = await cli(sb, ['install', 'claude']);
  assert.equal(r.code, 1);
  assert.match(r.out, /✗ claude\s+claude CLI not found/);
});

test('pi: uses pi install / pi remove and flags a manual registration', async () => {
  const sb = sandbox();
  const settings = path.join(sb.home, '.pi', 'agent', 'settings.json');
  const checkout = path.join(sb.root, 'checkout');
  write(path.join(checkout, 'package.json'), '{"name":"claude-session-namer"}');
  write(settings, `${JSON.stringify({ packages: [checkout] }, null, 2)}\n`);
  const spawn = (cmd, args) => {
    const s = JSON.parse(read(settings));
    if (args[0] === 'install') s.packages.push(args[1]);
    if (args[0] === 'remove') s.packages = s.packages.filter((p) => p !== args[1]);
    fs.writeFileSync(settings, `${JSON.stringify(s, null, 2)}\n`);
    return { status: 0, stdout: '' };
  };
  const r = await cli(sb, ['install', 'pi'], { version: '1.0.0', bins: { pi: '/x/pi' }, spawn });
  assert.equal(r.code, 0, r.out);
  assert.equal(r.calls[0][1], 'install');
  assert.match(r.calls[0][2], /app[\\/]1\.0\.0[\\/]adapters[\\/]pi$/);
  assert.match(r.out, /pi also loads session-namer from/);
  const up = await cli(sb, ['install', 'pi'], { version: '2.0.0', bins: { pi: '/x/pi' }, spawn });
  assert.deepEqual(up.calls.map((c) => c[1]), ['remove', 'install']);
  const u = await cli(sb, ['uninstall', 'pi'], { version: '2.0.0', bins: { pi: '/x/pi' }, spawn });
  assert.equal(u.code, 0);
  assert.deepEqual(JSON.parse(read(settings)).packages, [checkout]);
});

test('--dry-run writes nothing', async () => {
  const sb = sandbox();
  const r = await cli(sb, ['install', 'gemini', 'crush', 'amp', '--dry-run'], { version: '1.0.0' });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /dry run/);
  assert.deepEqual(fs.readdirSync(sb.home), []);
});

test('--detect installs every harness found on PATH', async () => {
  const sb = sandbox();
  const r = await cli(sb, ['install', '--detect'], { version: '1.0.0', bins: { crush: '/x/crush', amp: '/x/amp' } });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /✓ amp/);
  assert.match(r.out, /✓ crush/);
  assert.doesNotMatch(r.out, /gemini/);
});

test('unknown and unsupported harness ids are rejected', async () => {
  const sb = sandbox();
  const r = await cli(sb, ['install', 'droid']);
  assert.equal(r.code, 2);
  assert.match(r.out, /Factory Droid is not supported/);
  const r2 = await cli(sb, ['install', 'nope']);
  assert.equal(r2.code, 2);
});

test('list and status run without a home', async () => {
  const sb = sandbox();
  const l = await cli(sb, ['list'], { bins: { codex: '/x/codex' } });
  assert.equal(l.code, 0);
  assert.match(l.out, /✓ codex/);
  assert.match(l.out, /terminal tab title only/);
  const s = await cli(sb, ['status'], { bins: { codex: '/x/codex' }, spawn: () => ({ status: 0, stdout: 'codex-cli 0.163.0\n' }) });
  assert.equal(s.code, 0);
  assert.match(s.out, /– codex\s+codex 0\.163\.0\s+not installed/);
});

test('SESSION_NAMER_HOME is honoured', async () => {
  const sb = sandbox();
  const custom = path.join(sb.root, 'custom-home');
  const r = await cli(sb, ['install', 'crush'], { version: '1.0.0', env: { SESSION_NAMER_HOME: custom } });
  assert.equal(r.code, 0, r.out);
  assert.ok(fs.existsSync(path.join(custom, 'app', '1.0.0', 'adapters', 'crush', 'hook.js')));
  assert.match(read(path.join(sb.home, '.config', 'crush', 'crush.json')), /custom-home\/app\/1\.0\.0/);
});

test('pi: entries pi stores relative to its settings folder are recognised', async () => {
  const sb = sandbox();
  const settings = path.join(sb.home, '.pi', 'agent', 'settings.json');
  write(settings, '{\n  "packages": []\n}\n');
  const spawn = (cmd, args) => {
    if (args[0] !== 'install' && args[0] !== 'remove') return { status: 0, stdout: 'pi 1.5.0\n' };
    const s = JSON.parse(read(settings));
    const rel = path.relative(path.dirname(settings), args[1]);
    if (args[0] === 'install') s.packages.push(rel);
    if (args[0] === 'remove') s.packages = s.packages.filter((p) => path.resolve(path.dirname(settings), p) !== path.resolve(args[1]));
    fs.writeFileSync(settings, `${JSON.stringify(s, null, 2)}\n`);
    return { status: 0, stdout: '' };
  };
  const opts = { version: '1.0.0', bins: { pi: '/x/pi' }, spawn };
  await cli(sb, ['install', 'pi'], opts);
  assert.ok(JSON.parse(read(settings)).packages[0].startsWith(`..${path.sep}`));
  const again = await cli(sb, ['install', 'pi'], opts);
  assert.match(again.out, /– pi\s+already installed/);
  const st = await cli(sb, ['status'], opts);
  assert.match(st.out, /✓ pi .*installed v1\.0\.0/);
  await cli(sb, ['uninstall', 'pi'], opts);
  assert.deepEqual(JSON.parse(read(settings)).packages, []);
});

test('uninstall --all leaves a Claude plugin this installer did not install', async () => {
  const sb = sandbox();
  const spawn = (cmd, args) => (args.join(' ') === 'plugin list --json'
    ? { status: 0, stdout: JSON.stringify([{ id: 'session-namer@claude-session-namer', version: '1.0.3', enabled: true }]) }
    : { status: 0, stdout: '' });
  const opts = { version: '1.0.0', bins: { claude: '/x/claude' }, spawn };
  await cli(sb, ['install', 'claude', 'crush'], opts);
  const u = await cli(sb, ['uninstall', '--all'], opts);
  assert.doesNotMatch(u.out, /claude/);
  assert.ok(!u.calls.some((c) => c.includes('uninstall')));
  assert.match(u.out, /✓ crush/);
});

// ------------------------------------------------------- review fixes

const S = require('../lib/install/strategies');
const { makeContext } = require('../lib/install/context');

/** Every file under a folder with its bytes (for byte-identical comparisons). */
function snapshot(dir) {
  const out = {};
  const walk = (d) => {
    for (const n of fs.readdirSync(d)) {
      const p = path.join(d, n);
      const st = fs.lstatSync(p);
      if (st.isDirectory()) walk(p);
      else out[path.relative(dir, p)] = fs.readFileSync(p).toString('base64');
    }
  };
  walk(dir);
  return out;
}

test('unicode / # / % in HOME: install twice changes nothing, uninstall restores every byte', async () => {
  const sb = sandbox();
  sb.home = path.join(sb.root, 'hömé #1 %41 ünï');
  fs.mkdirSync(sb.home);
  write(path.join(sb.home, '.config', 'opencode', 'opencode.jsonc'), '{\n  // mine\n  "plugin": ["user.mjs"]\n}\n');
  write(path.join(sb.home, '.codex', 'hooks.json'), '{\n  "hooks": {}\n}\n');
  write(path.join(sb.home, '.dsh', 'profiles', 'web', 'cordis.patch.yml'), '[]\n');
  write(path.join(sb.home, '.copilot', 'settings.json'), '{ "experimental": true }\n');
  const before = snapshot(sb.home);
  const ids = ['opencode', 'kilo', 'codex', 'copilot', 'cline', 'amp', 'crush', 'deepseek', 'gemini', 'grok'];
  const r = await cli(sb, ['install', ...ids], { version: '1.0.0' });
  assert.equal(r.code, 0, r.out);
  const once = snapshot(sb.home);
  const again = await cli(sb, ['install', ...ids], { version: '1.0.0' });
  assert.equal(again.code, 0, again.out);
  for (const id of ids) assert.match(again.out, new RegExp(`– ${id}\\s`), `${id} should be unchanged:\n${again.out}`);
  assert.deepEqual(snapshot(sb.home), once, 'second install changes no byte');
  assert.equal(JSON.parse(read(path.join(sb.home, '.config', 'opencode', 'opencode.jsonc')).replace(/\/\/.*$/m, '')).plugin.length, 2);
  const st = await cli(sb, ['status'], { version: '1.0.0' });
  assert.match(st.out, /No problems found/, st.out);
  const u = await cli(sb, ['uninstall', ...ids], { version: '1.0.0' });
  assert.equal(u.code, 0, u.out);
  assert.doesNotMatch(u.out, /nothing to remove/);
  assert.deepEqual(snapshot(sb.home), before, 'uninstall restores the home byte for byte (backups included)');
});

test('norm: decodes file:// URLs; folds case and separators on Windows only', () => {
  assert.equal(S.norm('file:///C:/Us%C3%A9r/a%20b%23c%25d/x', true), 'file:///c:/usér/a b#c%d/x');
  assert.equal(S.norm('C:\\Users\\Bé', true), 'c:/users/bé');
  assert.equal(S.norm('/Home/A\\b', false), '/Home/A\\b');
  assert.equal(S.norm('file:///Home/%E9%zz', false), 'file:///Home/%E9%zz', 'invalid escapes stay as they are');
  const posix = { isWin: false, appRoot: '/Home/U/.session-namer/app' };
  assert.equal(S.isOursText(posix)('/home/u/.session-namer/app/1.0.0/x'), false, 'POSIX paths are case-sensitive');
  assert.equal(S.isOursText(posix)('/Home/U/.session-namer/app/1.0.0/x'), true);
  const win = { isWin: true, appRoot: 'C:\\Users\\U\\.session-namer\\app' };
  assert.equal(S.isOursText(win)('"file:///c:/users/u/.session-namer/app/1.0.0/x"'), true);
});

test('which on POSIX needs the execute bit', { skip: isWin }, () => {
  const sb = sandbox();
  const bin = path.join(sb.root, 'bin');
  write(path.join(bin, 'tool'), '#!/bin/sh\n');
  fs.chmodSync(path.join(bin, 'tool'), 0o644);
  const ctx = makeContext({ home: sb.home, platform: 'linux', env: { PATH: bin } });
  assert.equal(ctx.which('tool'), null);
  fs.chmodSync(path.join(bin, 'tool'), 0o755);
  assert.equal(ctx.which('tool'), path.join(bin, 'tool'));
});

test('cline hook stubs are written executable', { skip: isWin }, async () => {
  const sb = sandbox();
  await cli(sb, ['install', 'cline'], { version: '1.0.0' });
  assert.equal(fs.statSync(path.join(sb.home, '.cline', 'hooks', 'TaskStart.js')).mode & 0o777, 0o755);
});

test('installed.json: a corrupt file is kept aside and reported, never dropped silently', async () => {
  const sb = sandbox();
  await cli(sb, ['install', 'crush'], { version: '1.0.0' });
  const manifest = path.join(sb.home, '.session-namer', 'installed.json');
  fs.writeFileSync(manifest, '{ broken');
  const r = await cli(sb, ['install', 'gemini'], { version: '1.0.0' });
  assert.match(r.out, /installed\.json is not valid JSON/);
  const copies = fs.readdirSync(path.dirname(manifest)).filter((n) => n.startsWith('installed.json.corrupt-'));
  assert.equal(copies.length, 1);
  assert.equal(read(path.join(path.dirname(manifest), copies[0])), '{ broken');
  assert.ok(JSON.parse(read(manifest)).harnesses.gemini, 'rewritten after the agent, atomically');
  assert.deepEqual(fs.readdirSync(path.dirname(manifest)).filter((n) => n.includes('.tmp')), []);
});

test('no install record: uninstall restores the backup bytes when only our entries differ', async () => {
  const sb = sandbox();
  const file = path.join(sb.home, '.gemini', 'settings.json');
  const original = '{\r\n    "theme": "dark"\r\n}';
  write(file, original);
  await cli(sb, ['install', 'gemini'], { version: '1.0.0' });
  fs.rmSync(path.join(sb.home, '.session-namer', 'installed.json'));
  const u = await cli(sb, ['uninstall', 'gemini'], { version: '1.0.0' });
  assert.equal(u.code, 0, u.out);
  assert.equal(read(file), original);
  assert.equal(fs.existsSync(`${file}.session-namer.bak`), false);
});

test('CRLF files get CRLF lines and round-trip exactly (JSONC and YAML)', async () => {
  const sb = sandbox();
  const json = path.join(sb.home, '.config', 'crush', 'crush.json');
  const jsonText = '{\r\n  "hooks": {\r\n    "TurnStart": [\r\n      { "command": "echo mine" }\r\n    ]\r\n  }\r\n}\r\n';
  const yml = path.join(sb.home, '.dsh', 'profiles', 'web', 'cordis.patch.yml');
  const ymlText = '- id: something\r\n  disabled: true';
  write(json, jsonText);
  write(yml, ymlText);
  const r = await cli(sb, ['install', 'crush', 'deepseek'], { version: '1.0.0' });
  assert.equal(r.code, 0, r.out);
  for (const f of [json, yml]) assert.doesNotMatch(read(f), /[^\r]\n/, `${f} has a bare LF`);
  assert.equal(JSON.parse(read(json)).hooks.TurnStart.length, 2);
  const again = await cli(sb, ['install', 'crush', 'deepseek'], { version: '1.0.0' });
  assert.match(again.out, /– crush/);
  assert.match(again.out, /– deepseek/);
  await cli(sb, ['uninstall', 'crush', 'deepseek'], { version: '1.0.0' });
  assert.equal(read(json), jsonText);
  assert.equal(read(yml), ymlText);
});

test('an empty or whitespace-only config is treated as {} and restored as it was', async () => {
  const sb = sandbox();
  const file = path.join(sb.home, '.qwen', 'settings.json');
  write(file, '  \n');
  const st0 = await cli(sb, ['status']);
  assert.doesNotMatch(st0.out, /does not parse/);
  const r = await cli(sb, ['install', 'qwen'], { version: '1.0.0' });
  assert.equal(r.code, 0, r.out);
  assert.equal(JSON.parse(read(file)).ui.hideWindowTitle, true);
  await cli(sb, ['uninstall', 'qwen'], { version: '1.0.0' });
  assert.equal(read(file), '  \n');
});

test('a stale backup is refreshed when none of our entries remain', async () => {
  const sb = sandbox();
  const file = path.join(sb.home, '.config', 'crush', 'crush.json');
  write(file, '{ "a": 1 }\n');
  write(`${file}.session-namer.bak`, '{ "very": "old" }\n');
  await cli(sb, ['install', 'crush'], { version: '1.0.0' });
  assert.equal(read(`${file}.session-namer.bak`), '{ "a": 1 }\n');
  const u = await cli(sb, ['uninstall', 'crush'], { version: '1.0.0' });
  assert.equal(read(file), '{ "a": 1 }\n');
  assert.equal(fs.existsSync(`${file}.session-namer.bak`), false);
  assert.doesNotMatch(u.out, /Backups kept/);
});

test('uninstall mentions backups only when one is kept', async () => {
  const sb = sandbox();
  const file = path.join(sb.home, '.config', 'crush', 'crush.json');
  write(file, '{ "a": 1 }\n');
  await cli(sb, ['install', 'crush'], { version: '1.0.0' });
  fs.writeFileSync(file, read(file).replace('"a": 1', '"a": 2'));
  const u = await cli(sb, ['uninstall', 'crush'], { version: '1.0.0' });
  assert.match(u.out, /Backups kept/);
  assert.match(u.out, /crush\.json\.session-namer\.bak/);
});

test('a read-only config fails cleanly: no .tmp, no stray backup, no unused copy', async () => {
  const sb = sandbox();
  const file = path.join(sb.home, '.config', 'crush', 'crush.json');
  write(file, '{ "a": 1 }\n');
  fs.chmodSync(file, 0o444);
  try {
    const r = await cli(sb, ['install', 'crush'], { version: '1.0.0' });
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /✗ crush\s+.*read-only/);
    assert.equal(read(file), '{ "a": 1 }\n');
    assert.deepEqual(fs.readdirSync(path.dirname(file)), ['crush.json']);
    assert.equal(fs.existsSync(path.join(sb.home, '.session-namer', 'app', '1.0.0')), false);
  } finally {
    fs.chmodSync(file, 0o644);
  }
});

test('a symlinked config is edited through the link and keeps its mode', async (t) => {
  const sb = sandbox();
  const real = path.join(sb.root, 'dotfiles', 'crush.json');
  write(real, '{ "providers": { "x": { "api_key": "sk-1" } } }\n');
  if (!isWin) fs.chmodSync(real, 0o600);
  const link = path.join(sb.home, '.config', 'crush', 'crush.json');
  fs.mkdirSync(path.dirname(link), { recursive: true });
  try { fs.symlinkSync(real, link, 'file'); } catch (err) { t.skip(`no symlink permission (${err.code})`); return; }
  const r = await cli(sb, ['install', 'crush'], { version: '1.0.0' });
  assert.equal(r.code, 0, r.out);
  assert.ok(fs.lstatSync(link).isSymbolicLink(), 'the link is still a link');
  assert.match(read(real), /crush\/hook\.js/);
  if (!isWin) assert.equal(fs.statSync(real).mode & 0o777, 0o600);
  await cli(sb, ['uninstall', 'crush'], { version: '1.0.0' });
  assert.ok(fs.lstatSync(link).isSymbolicLink());
  assert.equal(read(real), '{ "providers": { "x": { "api_key": "sk-1" } } }\n');
});

test('install --detect skips an agent that is found but not set up, with exit 0', async () => {
  const sb = sandbox();
  const r = await cli(sb, ['install', '--detect'], { version: '1.0.0', bins: { dsh: '/x/dsh', crush: '/x/crush' } });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /– deepseek\s+skipped \(start dsh once, then run install deepseek\)/);
  assert.match(r.out, /✓ crush/);
  const named = await cli(sb, ['install', 'dsh'], { version: '1.0.0', bins: { dsh: '/x/dsh' } });
  assert.equal(named.code, 1);
  assert.match(named.out, /✗ deepseek/);
});

test('aliases and "did you mean" for agent ids', async () => {
  const sb = sandbox();
  const r = await cli(sb, ['install', 'gemini-cli', 'qwen-code', '--dry-run'], { version: '1.0.0' });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /✓ gemini/);
  assert.match(r.out, /✓ qwen/);
  const bad = await cli(sb, ['install', 'opencod']);
  assert.equal(bad.code, 2);
  assert.match(bad.out, /unknown agent; did you mean opencode\?/);
  assert.match(bad.out, /Supported agents:/);
  for (const [alias, id] of [['dsh', 'deepseek'], ['kilocode', 'kilo'], ['gh-copilot', 'copilot'], ['github-copilot', 'copilot'], ['claude-code', 'claude'], ['grok-build', 'grok'], ['opencode-ai', 'opencode']]) {
    assert.deepEqual(require('../lib/install').parseArgs(['install', alias]).ids, [id]);
  }
});

test('list shows the Level column and the unsupported agents', async () => {
  const sb = sandbox();
  const l = await cli(sb, ['list']);
  const row = (id) => l.out.split('\n').find((s) => new RegExp(`^. ${id}\\s`).test(s)) || '';
  assert.match(l.out, /Level/);
  assert.match(row('claude'), /\sstable\s/);
  for (const id of ['codex', 'pi', 'opencode', 'kilo', 'copilot', 'cline', 'crush', 'goose', 'deepseek']) assert.match(row(id), /\sbeta\s/, id);
  for (const id of ['amp', 'grok']) assert.match(row(id), /\spartly verified\s/, id);
  for (const id of ['gemini', 'qwen']) assert.match(row(id), /\stab title only\s/, id);
  assert.match(l.out, /Not supported:[\s\S]*Factory Droid\s+no session-title API[\s\S]*Cursor CLI\s+no session-title API/);
  assert.doesNotMatch(l.out.replace('DeepSeek Harness', ''), /harness/i, 'product names aside, the CLI says "agent"');
});

test('status: counts every printed problem, aligns columns, clips long versions, gives next steps', async () => {
  const sb = sandbox();
  write(path.join(sb.home, '.grok', 'hooks', 'session-namer.json'), '{"x":"my own session-namer copy"}');
  await cli(sb, ['install', 'cline'], { version: '1.0.0' });
  const spawn = (cmd) => ({ status: 0, stdout: cmd.includes('amp') ? '0.0.1700000000-g1234567890abcdef (released 2026-10-01)\n' : '1.2.3\n' });
  const st = await cli(sb, ['status'], { version: '1.0.0', bins: { amp: '/x/amp', crush: '/x/crush' }, spawn });
  assert.match(st.out, /! .*grok.*did not write/);
  assert.match(st.out, /1 problem\(s\) found\./);
  assert.match(st.out, /amp 0\.0\.1700000000-g123…/);
  const cols = st.out.split('\n').filter((s) => /^[✓–✗] /.test(s)).map((s) => s.search(/not installed|installed/));
  assert.equal(new Set(cols).size, 1, `columns line up:\n${st.out}`);
  assert.match(st.out, /✓ cline[\s\S]*?→ check: `cline history`/);
  assert.match(st.out, /– crush[^\n]*\n\s+→ install with: npx -y github:brunobola-portfolio\/claude-session-namer#v1\.0\.0 install crush/);
  assert.doesNotMatch(st.out, /runtime|harness/i);
});

test('--dry-run and status only run `--version` and `claude plugin list --json`', async () => {
  const sb = sandbox();
  const spawn = (cmd, args) => (args.join(' ') === 'plugin list --json' ? { status: 0, stdout: '[]' } : { status: 0, stdout: '1.0.0\n' });
  const bins = { claude: '/x/claude', pi: '/x/pi', crush: '/x/crush' };
  const r = await cli(sb, ['install', 'claude', 'pi', 'crush', '--dry-run'], { version: '1.0.0', bins, spawn });
  const st = await cli(sb, ['status'], { version: '1.0.0', bins, spawn });
  for (const c of [...r.calls, ...st.calls]) assert.ok(['--version', 'plugin list --json'].includes(c.slice(1).join(' ')), c.join(' '));
  assert.deepEqual(fs.readdirSync(sb.home), []);
});

test('help: no arguments prints it with exit 0, npx form, #tag pin and the docs URL', async () => {
  const sb = sandbox();
  const r = await cli(sb, []);
  assert.equal(r.code, 0);
  assert.match(r.out, /npx -y github:brunobola-portfolio\/claude-session-namer#v\d+\.\d+\.\d+ <command>/);
  assert.match(r.out, /without #v\d+\.\d+\.\d+, npx runs the latest code on main/);
  assert.match(r.out, /https:\/\/github\.com\/brunobola-portfolio\/claude-session-namer\/blob\/v\d+\.\d+\.\d+\/docs\/install\.md/);
  assert.match(r.out, /install <agent\.\.\.>/);
  assert.doesNotMatch(r.out, /harness/i);
});

test('dry runs speak in the future tense and a mistyped command gets a suggestion', async () => {
  const sb = sandbox();
  const bins = { crush: '/x/crush' };
  const spawn = () => ({ status: 0, stdout: '1.0.0\n' });
  const r = await cli(sb, ['install', 'crush', '--dry-run'], { version: '1.0.0', bins, spawn });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /✓ crush\s+would (create|add|update|write) /);
  assert.doesNotMatch(r.out, /would be: /);
  assert.match(r.out, /Dry run complete; nothing was written\./);
  const typo = await cli(sb, ['instal', 'crush']);
  assert.equal(typo.code, 2);
  assert.match(typo.out, /Unknown command "instal"\. Did you mean install\?/);
});

test('the CLI exits quietly when stdout is closed early (| head)', async () => {
  const sb = sandbox();
  const { spawn } = require('node:child_process');
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'bin', 'session-namer.js'), 'list'], {
    env: { ...process.env, HOME: sb.home, USERPROFILE: sb.home, SESSION_NAMER_HOME: path.join(sb.root, 'ns') },
  });
  child.stdout.destroy();
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d; });
  const code = await new Promise((resolve) => child.on('close', resolve));
  assert.equal(stderr, '');
  assert.equal(code, 0);
});
