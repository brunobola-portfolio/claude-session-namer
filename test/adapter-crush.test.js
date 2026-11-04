'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const state = require('../lib/state');
const { work, shouldSpawn, parseShow, findCrush, resolveMode, KEY_PREFIX } = require('../adapters/crush/namer');

const SID = '549d545a-dedb-45db-ac2f-0c840365ed99';

function tmpEnv(extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sn-crush-'));
  return { CLAUDE_CONFIG_DIR: dir, PATH: '', SESSION_NAMER_CRUSH_TOPIC: 'claude', ...extra };
}

const showJson = (titleText, prompts) => JSON.stringify({
  meta: { id: 'b8c0', uuid: SID, title: titleText },
  messages: prompts.flatMap((p) => [
    { role: 'user', parts: [{ type: 'text', text: p }, { type: 'finish', reason: 'stop' }] },
    { role: 'assistant', parts: [{ type: 'text', text: 'ok' }] },
  ]),
});

/** Fake crush CLI: `titles` is consumed one per `show` call (last one sticks). */
function fakeCrush({ titles, prompts, renameCode = 0 }) {
  const calls = [];
  let current = null;
  let i = 0;
  const run = async (args) => {
    calls.push(args);
    if (args[0] === 'session' && args[1] === 'show') {
      const t = current !== null ? current : titles[Math.min(i, titles.length - 1)];
      i += 1;
      return { code: 0, stdout: showJson(t, prompts), stderr: '' };
    }
    if (args[0] === 'session' && args[1] === 'rename') {
      if (renameCode !== 0) return { code: renameCode, stdout: '', stderr: 'boom' };
      current = args[3];
      return { code: 0, stdout: '{"renamed":true}', stderr: '' };
    }
    return { code: 1, stdout: '', stderr: 'unexpected' };
  };
  return { run, calls };
}

const baseDeps = (env, fake, extra = {}) => ({
  env,
  run: fake.run,
  crushPath: 'crush.exe',
  git: () => null,
  sleep: async () => {},
  stateDir: state.stateDir(env),
  log: () => {},
  hasClaude: () => true,
  ...extra,
});

test('parseShow takes the newest user message and the title', () => {
  const info = parseShow(showJson('Mock title', ['first one here please', 'second real prompt here']));
  assert.equal(info.title, 'Mock title');
  assert.equal(info.prompt, 'second real prompt here');
  assert.equal(info.userCount, 2);
  assert.equal(parseShow('not json'), null);
  assert.equal(parseShow('{"x":1}'), null);
});

test('claude mode renames to "<project> - <topic>" and marks the session final', async () => {
  const env = tmpEnv();
  const fake = fakeCrush({ titles: ['Crush own title'], prompts: ['Fix the login redirect loop on Safari'] });
  const generate = async ({ prompt }) => { assert.match(prompt, /Safari/); return 'Fix Safari login redirect loop'; };
  const out = await work({ session_id: SID, cwd: path.join(os.tmpdir(), 'webapp') }, baseDeps(env, fake, { generate }));
  assert.equal(out, 'final');
  const rename = fake.calls.find((c) => c[1] === 'rename');
  assert.deepEqual(rename, ['session', 'rename', SID, 'webapp - Fix Safari login redirect loop', '--json']);
  assert.equal(state.readState(state.stateDir(env), KEY_PREFIX + SID).stage, 'final');
  assert.equal(shouldSpawn({ hook_event_name: 'TurnStart', session_id: SID }, { env }), false);
});

test('trivial prompts cost nothing and keep the session open', async () => {
  const env = tmpEnv();
  const fake = fakeCrush({ titles: ['New Session'], prompts: ['ok'] });
  let generated = false;
  const out = await work({ session_id: SID, cwd: 'C:\\x\\repo' }, baseDeps(env, fake, { generate: async () => { generated = true; return 'x y'; } }));
  assert.equal(out, 'trivial-prompt');
  assert.equal(generated, false);
  assert.ok(!fake.calls.some((c) => c[1] === 'rename'));
  assert.equal(shouldSpawn({ event: 'TurnStart', session_id: SID }, { env }), true);
});

test('waits for Crush\'s own title to land before renaming (no later overwrite)', async () => {
  const env = tmpEnv();
  const fake = fakeCrush({ titles: ['New Session', 'New Session', 'New Session', 'Crush own title'], prompts: ['Add pagination to the customer list'] });
  const out = await work({ session_id: SID, cwd: '/home/me/crm' }, baseDeps(env, fake, { generate: async () => 'Customer list pagination' }));
  assert.equal(out, 'final');
  const shows = fake.calls.filter((c) => c[1] === 'show').length;
  assert.ok(shows >= 4, `expected polling, got ${shows} show calls`);
  assert.equal(fake.calls.find((c) => c[1] === 'rename')[3], 'crm - Customer list pagination');
});

test('falls back to Crush\'s own title (native) when claude fails', async () => {
  const env = tmpEnv({ SESSION_NAMER_CRUSH_TOPIC: 'auto' });
  const fake = fakeCrush({ titles: ['Pagination for customer list'], prompts: ['Add pagination to the customer list'] });
  const out = await work({ session_id: SID, cwd: '/home/me/crm' }, baseDeps(env, fake, { generate: async () => null }));
  assert.equal(out, 'final');
  assert.equal(fake.calls.find((c) => c[1] === 'rename')[3], 'crm - Pagination for customer list');
});

test('native mode never calls claude', async () => {
  const env = tmpEnv({ SESSION_NAMER_CRUSH_TOPIC: 'native' });
  const fake = fakeCrush({ titles: ['Webhook retry docs'], prompts: ['Document the retry policy for webhooks'] });
  const out = await work({ session_id: SID, cwd: '/r/api' }, baseDeps(env, fake, { generate: async () => { throw new Error('must not run'); } }));
  assert.equal(out, 'final');
  assert.equal(fake.calls.find((c) => c[1] === 'rename')[3], 'api - Webhook retry docs');
});

test('a failed rename is reported, not retried in a loop', async () => {
  const env = tmpEnv();
  const fake = fakeCrush({ titles: ['Own'], prompts: ['Refactor the invoice export to stream rows'], renameCode: 1 });
  const out = await work({ session_id: SID, cwd: '/r/billing' }, baseDeps(env, fake, { generate: async () => 'Invoice export streaming' }));
  assert.equal(out, 'rename-failed');
  assert.equal(fake.calls.filter((c) => c[1] === 'rename').length, 1);
});

test('missing crush executable and disabled config are no-ops', async () => {
  const env = tmpEnv();
  const fake = fakeCrush({ titles: ['Own'], prompts: ['Refactor the invoice export'] });
  assert.equal(await work({ session_id: SID, cwd: '/r/x' }, baseDeps(env, fake, { crushPath: null })), 'no-crush');
  const off = tmpEnv({ CLAUDE_SESSION_NAMER: 'off' });
  assert.equal(await work({ session_id: SID, cwd: '/r/x' }, baseDeps(off, fake)), 'disabled');
  assert.equal(fake.calls.length, 0);
});

test('shouldSpawn gates on event, session and nesting', () => {
  const env = tmpEnv();
  assert.equal(shouldSpawn(null, { env }), false);
  assert.equal(shouldSpawn({ event: 'TurnEnd', session_id: SID }, { env }), false);
  assert.equal(shouldSpawn({ event: 'TurnStart' }, { env }), false);
  assert.equal(shouldSpawn({ event: 'TurnStart', session_id: SID }, { env: { ...env, SESSION_NAMER_NESTED: '1' } }), false);
  assert.equal(shouldSpawn({ hook_event_name: 'turn_start', session_id: SID }, { env }), true);
});

test('findCrush prefers the real exe behind the npm shim and never returns a .cmd', () => {
  const files = new Set(['C:\\npm\\crush.cmd', 'C:\\npm\\node_modules\\@charmland\\crush\\bin\\crush.exe']);
  const exists = (p) => files.has(p);
  assert.equal(findCrush({ PATH: 'C:\\npm' }, { platform: 'win32', exists }), 'C:\\npm\\node_modules\\@charmland\\crush\\bin\\crush.exe');
  assert.equal(findCrush({ PATH: 'C:\\other' }, { platform: 'win32', exists }), null);
  assert.equal(findCrush({ PATH: '/usr/bin', SESSION_NAMER_CRUSH_PATH: '/opt/crush' }, { platform: 'linux', exists }), '/opt/crush');
  assert.equal(findCrush({ PATH: '/usr/bin:/bin' }, { platform: 'linux', exists: (p) => p === '/bin/crush' }), '/bin/crush');
});

test('resolveMode honours SESSION_NAMER_CRUSH_TOPIC', () => {
  assert.equal(resolveMode({ SESSION_NAMER_CRUSH_TOPIC: 'native' }, () => true), 'native');
  assert.equal(resolveMode({ SESSION_NAMER_CRUSH_TOPIC: 'claude' }, () => false), 'claude');
  assert.equal(resolveMode({}, () => true), 'claude');
  assert.equal(resolveMode({}, () => false), 'native');
});

test('first sight of a session renamed by the user (non-default title, several prompts) is left alone', async () => {
  const env = tmpEnv();
  const fake = fakeCrush({ titles: ['Release prep'], prompts: ['ok', 'Fix the login redirect loop on Safari'] });
  let generated = false;
  const out = await work({ session_id: SID, cwd: '/x/repo' }, baseDeps(env, fake, { generate: async () => { generated = true; return 'x y z'; } }));
  assert.equal(out, 'user-titled');
  assert.equal(generated, false);
  assert.ok(!fake.calls.some((c) => c[1] === 'rename'));
  assert.equal(shouldSpawn({ event: 'TurnStart', session_id: SID }, { env }), false);
});

test('a title that changed after a trivial turn we saw is treated as a user rename', async () => {
  const env = tmpEnv();
  const first = fakeCrush({ titles: ['Greeting'], prompts: ['ok'] });
  assert.equal(await work({ session_id: SID, cwd: '/x/repo' }, baseDeps(env, first)), 'trivial-prompt');
  const second = fakeCrush({ titles: ['My own name'], prompts: ['ok', 'Fix the login redirect loop on Safari'] });
  assert.equal(await work({ session_id: SID, cwd: '/x/repo' }, baseDeps(env, second)), 'user-titled');
  assert.ok(!second.calls.some((c) => c[1] === 'rename'));
});

test('Crush\'s own title after a trivial first turn is still renamed', async () => {
  const env = tmpEnv();
  const first = fakeCrush({ titles: ['New Session'], prompts: ['ok'] });
  await work({ session_id: SID, cwd: '/x/repo' }, baseDeps(env, first));
  const second = fakeCrush({ titles: ['Greeting the user'], prompts: ['ok', 'Fix the login redirect loop on Safari'] });
  const out = await work({ session_id: SID, cwd: '/x/repo' }, baseDeps(env, second, { generate: async () => 'Fix Safari login redirect loop' }));
  assert.equal(out, 'final');
});
