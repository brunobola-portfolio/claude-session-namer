'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createCopilotNamer, toCopilotName, userPromptOf, parseCommandArgs } = require('../adapters/copilot/namer');
const installer = require('../adapters/copilot/install');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'sn-copilot-'));

/** Fake Copilot session: name store with user_named, title_changed hook. */
function fakeSession({ name = null, userNamed = false, withWorkspaces = true, sessionId = 'abcdef12-0000-0000-0000-000000000000' } = {}) {
  const ws = { name, user_named: userNamed };
  const sets = [];
  const rpc = {
    name: {
      get: async () => ({ name: ws.name }),
      set: async ({ name: n }) => { sets.push(n); ws.name = n; ws.user_named = true; },
    },
  };
  if (withWorkspaces) rpc.workspaces = { getWorkspace: async () => ({ workspace: { id: 'w', ...ws } }) };
  return { sessionId, rpc, sets, ws, userRename(n) { ws.name = n; ws.user_named = true; } };
}

function make(session, extra = {}) {
  return createCopilotNamer({
    session,
    cwd: path.join(os.tmpdir(), 'myproj'),
    env: {},
    git: () => null,
    generate: async () => 'Fix Safari login redirect loop',
    stateDir: tmp(),
    ...extra,
  });
}

const msg = (content, more = {}) => ({ type: 'user.message', data: { content, ...more } });

test('start names a fresh session after the project', async () => {
  const s = fakeSession();
  const n = make(s);
  assert.equal(await n.start(), 'myproj');
  assert.deepEqual(s.sets, ['myproj']);
});

test("start replaces Copilot's own auto-name (user_named false)", async () => {
  const s = fakeSession({ name: 'Fix the login redirect loop on Safari', userNamed: false });
  const n = make(s);
  assert.equal(await n.start(), 'myproj');
});

test('start leaves a user-named session alone', async () => {
  const s = fakeSession({ name: 'My own name', userNamed: true });
  const n = make(s);
  assert.equal(await n.start(), null);
  assert.deepEqual(s.sets, []);
  await n.onUserMessage(msg('Fix the login redirect loop on Safari'));
  assert.deepEqual(s.sets, []);
});

test('first eligible user message produces "<project> - <topic>"', async () => {
  const s = fakeSession();
  const stateDir = tmp();
  const n = make(s, { stateDir });
  await n.start();
  const out = await n.onUserMessage(msg('Fix the login redirect loop on Safari'));
  assert.equal(out, 'myproj - Fix Safari login redirect loop');
  assert.equal(s.ws.name, 'myproj - Fix Safari login redirect loop');
  // Final, also after a resume (new extension process, same state): no regeneration.
  let calls = 0;
  const n2 = make(s, { stateDir, generate: async () => { calls += 1; return 'x y'; } });
  assert.equal(await n2.start(), null);
  await n2.onUserMessage(msg('Another real request for the agent'));
  assert.equal(calls, 0);
  assert.equal(s.ws.name, 'myproj - Fix Safari login redirect loop');
});

test('user.message waits for start even when it arrives first', async () => {
  const s = fakeSession();
  const n = make(s);
  n.start();
  const out = await n.onUserMessage(msg('Fix the login redirect loop on Safari'));
  assert.equal(out, 'myproj - Fix Safari login redirect loop');
});

test('trivial, injected and autopilot messages never call the model', async () => {
  const s = fakeSession();
  let calls = 0;
  const n = make(s, { generate: async () => { calls += 1; return 'Some topic here'; } });
  await n.start();
  assert.equal(await n.onUserMessage(msg('ok')), null);
  assert.equal(await n.onUserMessage(msg('Use the pdf skill on this document now', { source: 'skill-pdf' })), null);
  assert.equal(await n.onUserMessage(msg('Continue working on the task please', { isAutopilotContinuation: true })), null);
  assert.equal(calls, 0);
});

test('a rename during generation wins', async () => {
  const s = fakeSession();
  const n = make(s, { generate: async () => { s.userRename('Picked by me'); return 'Fix Safari login redirect loop'; } });
  await n.start();
  assert.equal(await n.onUserMessage(msg('Fix the login redirect loop on Safari')), null);
  assert.equal(s.ws.name, 'Picked by me');
});

test('/rename detected through title_changed locks the session', async () => {
  const s = fakeSession();
  let calls = 0;
  const n = make(s, { generate: async () => { calls += 1; return 'Fix Safari login redirect loop'; } });
  await n.start();
  s.userRename('Manual title');
  assert.equal(await n.onTitleChanged(), 'Manual title');
  await n.onUserMessage(msg('Fix the login redirect loop on Safari'));
  assert.equal(calls, 0);
  assert.equal(s.ws.name, 'Manual title');
});

test('our own title_changed echo is not mistaken for a user rename', async () => {
  const s = fakeSession();
  const n = make(s);
  await n.start();
  assert.equal(await n.onTitleChanged(), null);
  assert.equal(await n.onUserMessage(msg('Fix the login redirect loop on Safari')), 'myproj - Fix Safari login redirect loop');
});

test('without workspaces RPC any existing name counts as the user\'s', async () => {
  const s = fakeSession({ name: 'Existing', withWorkspaces: false });
  assert.equal(await make(s).start(), null);
  const fresh = fakeSession({ withWorkspaces: false });
  assert.equal(await make(fresh).start(), 'myproj');
});

test('failed or unusable generations keep the project title, bounded retries', async () => {
  const s = fakeSession();
  let t = 1_000_000;
  let calls = 0;
  const n = make(s, { now: () => t, generate: async () => { calls += 1; return null; } });
  await n.start();
  await n.onUserMessage(msg('Fix the login redirect loop on Safari'));
  await n.onUserMessage(msg('Fix the login redirect loop on Safari'));
  assert.equal(calls, 1, 'retry interval respected');
  t += 61_000; await n.onUserMessage(msg('Fix the login redirect loop on Safari'));
  t += 61_000; await n.onUserMessage(msg('Fix the login redirect loop on Safari'));
  t += 61_000; await n.onUserMessage(msg('Fix the login redirect loop on Safari'));
  assert.equal(calls, 3, 'at most three attempts');
  assert.equal(s.ws.name, 'myproj');
});

test('/session-name sets a manual title or re-arms generation', async () => {
  const s = fakeSession();
  const n = make(s);
  await n.start();
  assert.match(await n.command('Meu tópico manual'), /myproj - Meu tópico manual/);
  assert.equal(s.ws.name, 'myproj - Meu tópico manual');
  assert.equal(await n.onUserMessage(msg('Fix the login redirect loop on Safari')), null, 'manual is locked');
  await n.command('--regenerate');
  assert.equal(s.ws.name, 'myproj');
  assert.equal(await n.onUserMessage(msg('Fix the login redirect loop on Safari')), 'myproj - Fix Safari login redirect loop');
  assert.match(await n.command('--doctor'), /Usage/);
});

test('disabled by SESSION_NAMER_NESTED or CLAUDE_SESSION_NAMER=off', async () => {
  for (const env of [{ SESSION_NAMER_NESTED: '1' }, { CLAUDE_SESSION_NAMER: 'off' }]) {
    const s = fakeSession();
    const n = make(s, { env });
    assert.equal(await n.start(), null);
    await n.onUserMessage(msg('Fix the login redirect loop on Safari'));
    assert.deepEqual(s.sets, []);
  }
});

test('rpc errors never throw out of handlers', async () => {
  const s = { sessionId: 'x1', rpc: { name: { get: async () => { throw new Error('boom'); }, set: async () => { throw new Error('boom'); } } } };
  const n = make(s);
  assert.equal(await n.start(), null);
  assert.equal(await n.onTitleChanged(), null);
  assert.equal(await n.onUserMessage(msg('Fix the login redirect loop on Safari')), null);
  assert.match(await n.command('A topic'), /session-namer: boom/);
});

test('helpers: name validation, prompt extraction, command parsing', () => {
  assert.equal(toCopilotName('a "quoted"\u0007 title'), "a 'quoted' title");
  assert.equal(toCopilotName('x'.repeat(150)).length, 100);
  assert.equal(userPromptOf({ content: 'hi there' }), 'hi there');
  assert.equal(userPromptOf({ content: 'hi', source: 'agent-1' }), null);
  assert.deepEqual(parseCommandArgs(''), { kind: 'regenerate' });
  assert.deepEqual(parseCommandArgs('--remote'), { kind: 'other' });
  assert.equal(parseCommandArgs('Fix the cache layer').kind, 'set');
});

test('installer writes a marked shim and only removes its own', () => {
  const home = tmp();
  const dir = installer.extensionDir({ COPILOT_HOME: home });
  assert.equal(dir, path.join(home, 'extensions', 'session-namer'));
  const src = installer.shimSource('/repo/adapters/copilot/extension.mjs');
  assert.ok(src.startsWith(installer.MARKER));
  assert.match(src, /import \{ joinSession \} from '@github\/copilot-sdk\/extension';/);
  assert.match(src, /await start\(joinSession\);/);
  const file = installer.install(dir);
  assert.ok(fs.readFileSync(file, 'utf8').includes('file:///'));
  assert.equal(installer.uninstall(dir), true);
  assert.equal(fs.existsSync(dir), false);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'extension.mjs'), 'someone else');
  assert.throws(() => installer.uninstall(dir), /not written by session-namer/);
});

test('a name whose set() failed is not "ours": the same name chosen by the user is kept', async () => {
  const s = fakeSession();
  const stateDir = tmp();
  const n = make(s, { stateDir });
  await n.start(); // provisional "myproj"
  const realSet = s.rpc.name.set;
  s.rpc.name.set = async () => { throw new Error('rpc down'); };
  assert.equal(await n.onUserMessage(msg('Fix the login redirect loop on Safari')), null);
  s.rpc.name.set = realSet;
  s.userRename('myproj - Fix Safari login redirect loop'); // the user types that exact name
  assert.equal(await n.onTitleChanged(), 'myproj - Fix Safari login redirect loop');
  const st = JSON.parse(fs.readFileSync(path.join(stateDir, 'state', `${s.sessionId}.json`), 'utf8'));
  assert.equal(st.stage, 'user');
});
