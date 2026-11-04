'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');
const { createSessionNamer, isDefaultTitle, promptText, resolveMode } = require('../adapters/opencode/namer.js');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-adapter-'));
const PROJECT = path.basename(DIR);
const DEFAULT = 'New session - 2026-11-03T22:22:31.702Z';
const flush = () => new Promise((r) => setImmediate(r));

/** In-memory stand-in for the OpenCode SDK client (v1 shape). */
function mockClient(initial = {}) {
  const store = new Map(Object.entries(initial));
  const updates = [];
  return {
    store,
    updates,
    app: { log: async () => ({}) },
    session: {
      get: async ({ path: p }) => ({ data: store.get(p.id) || null }),
      update: async ({ path: p, body }) => {
        updates.push({ id: p.id, title: body.title });
        const cur = store.get(p.id) || { id: p.id };
        const next = { ...cur, title: body.title };
        store.set(p.id, next);
        return { data: next };
      },
    },
  };
}

function setup({ mode = 'claude', generate, sessions = {}, env = {}, now = Date.now } = {}) {
  const client = mockClient(sessions);
  const calls = [];
  const gen = generate || (async () => 'Paginação no listagem de clientes');
  const hooks = createSessionNamer({
    client, directory: DIR, worktree: DIR, git: () => null,
    env: { SESSION_NAMER_OPENCODE_TOPIC: mode, ...env },
    generate: async (o) => { calls.push(o.prompt); return gen(o); },
    hasClaude: () => true, log: () => {}, now,
  });
  const created = async (info) => {
    client.store.set(info.id, info);
    await hooks.event({ event: { type: 'session.created', properties: { sessionID: info.id, info } } });
  };
  const updated = (id) => hooks.event({ event: { type: 'session.updated', properties: { sessionID: id, info: client.store.get(id) } } });
  const message = (id, text, extra = {}) => hooks['chat.message']({ sessionID: id }, { message: {}, parts: [{ type: 'text', text, ...extra }] });
  const pending = async (id) => { await flush(); const s = hooks._sessions.get(id); if (s && s.pending) await s.pending; };
  return { client, hooks, calls, created, updated, message, pending };
}

test('default-title detection mirrors OpenCode', () => {
  assert.equal(isDefaultTitle(DEFAULT), true);
  assert.equal(isDefaultTitle('Child session - 2026-11-03T22:22:31.702Z'), true);
  assert.equal(isDefaultTitle('New session'), false);
  assert.equal(isDefaultTitle('my title'), false);
});

test('promptText drops synthetic and non-text parts', () => {
  assert.equal(promptText([{ type: 'text', text: 'hello world prompt' }, { type: 'text', text: 'x', synthetic: true }, { type: 'file' }]), 'hello world prompt');
  assert.equal(promptText(null), '');
});

test('resolveMode: explicit values win, auto follows Claude availability', () => {
  assert.equal(resolveMode({ SESSION_NAMER_OPENCODE_TOPIC: 'native' }, () => true), 'native');
  assert.equal(resolveMode({ SESSION_NAMER_OPENCODE_TOPIC: 'claude' }, () => false), 'claude');
  assert.equal(resolveMode({}, () => true), 'claude');
  assert.equal(resolveMode({}, () => false), 'native');
});

test('disabled by recursion guard and kill switch', () => {
  const client = mockClient();
  assert.deepEqual(createSessionNamer({ client, directory: DIR, env: { SESSION_NAMER_NESTED: '1' }, git: () => null }), {});
  assert.deepEqual(createSessionNamer({ client, directory: DIR, env: { CLAUDE_SESSION_NAMER: 'off' }, git: () => null }), {});
});

test('claude mode: project on create, "<project> - <topic>" after first eligible message', async () => {
  const t = setup();
  await t.created({ id: 's1', title: DEFAULT });
  assert.equal(t.client.store.get('s1').title, PROJECT);
  await t.updated('s1'); // echo of our own write: ignored
  await t.message('s1', 'Adiciona paginação ao endpoint de clientes');
  await t.pending('s1');
  assert.equal(t.client.store.get('s1').title, `${PROJECT} - Paginação no listagem de clientes`);
  await t.updated('s1');
  await t.message('s1', 'Agora escreve os testes de integração');
  await t.pending('s1');
  assert.equal(t.calls.length, 1, 'one model call per session');
  assert.equal(t.client.updates.length, 2, 'two writes, no update loop');
});

test('chat.message does not wait for the model', async () => {
  let release;
  const t = setup({ generate: () => new Promise((r) => { release = r; }) });
  await t.created({ id: 's2', title: DEFAULT });
  await t.message('s2', 'Fix the Safari login redirect loop');
  assert.equal(t.client.store.get('s2').title, PROJECT, 'hook returned before the topic');
  release('Fix Safari login redirect loop');
  await t.pending('s2');
  assert.equal(t.client.store.get('s2').title, `${PROJECT} - Fix Safari login redirect loop`);
});

test('ineligible prompts never call the model', async () => {
  const t = setup();
  await t.created({ id: 's3', title: DEFAULT });
  for (const p of ['ok', '/help', 'continua por favor', '@src/a.js']) await t.message('s3', p);
  await t.pending('s3');
  assert.equal(t.calls.length, 0);
  assert.equal(t.client.store.get('s3').title, PROJECT);
});

test('a manual rename locks the session', async () => {
  const t = setup();
  await t.created({ id: 's4', title: DEFAULT });
  t.client.store.set('s4', { id: 's4', title: 'My manual title' });
  await t.updated('s4');
  await t.message('s4', 'Adiciona paginação ao endpoint de clientes');
  await t.pending('s4');
  assert.equal(t.calls.length, 0);
  assert.equal(t.client.store.get('s4').title, 'My manual title');
});

test('a rename while the topic is generating is not overwritten', async () => {
  let release;
  const t = setup({ generate: () => new Promise((r) => { release = r; }) });
  await t.created({ id: 's5', title: DEFAULT });
  await t.message('s5', 'Adiciona paginação ao endpoint de clientes');
  t.client.store.set('s5', { id: 's5', title: 'Renamed meanwhile' }); // no event delivered yet
  release('Paginação de clientes agora');
  await t.pending('s5');
  assert.equal(t.client.store.get('s5').title, 'Renamed meanwhile');
});

test('sessions that already had a real title are left alone', async () => {
  const t = setup({ sessions: { old: { id: 'old', title: 'Imported earlier' } } });
  await t.message('old', 'Adiciona paginação ao endpoint de clientes');
  await t.pending('old');
  assert.equal(t.client.updates.length, 0);
  assert.equal(t.calls.length, 0);
});

test('resumed default-titled session gets the project before the turn runs', async () => {
  const t = setup({ sessions: { r1: { id: 'r1', title: DEFAULT } } });
  await t.message('r1', 'Adiciona paginação ao endpoint de clientes');
  assert.equal(t.client.updates[0].title, PROJECT, 'awaited inside chat.message');
  await t.pending('r1');
  assert.equal(t.client.store.get('r1').title, `${PROJECT} - Paginação no listagem de clientes`);
});

test('child (subagent) sessions are ignored', async () => {
  const t = setup();
  await t.created({ id: 'c1', parentID: 's1', title: 'Child session - 2026-11-03T22:22:31.702Z' });
  await t.message('c1', 'Investigate the failing integration tests');
  await t.pending('c1');
  assert.equal(t.client.updates.length, 0);
});

test('failed generations retry at most after the interval and stop at three', async () => {
  const t = setup({ generate: async () => null });
  await t.created({ id: 's6', title: DEFAULT });
  await t.message('s6', 'Adiciona paginação ao endpoint de clientes');
  await t.pending('s6');
  await t.message('s6', 'Adiciona paginação ao endpoint de clientes'); // within 60 s: skipped
  await t.pending('s6');
  assert.equal(t.calls.length, 1);
  const s = t.hooks._sessions.get('s6');
  s.lastAttempt = 1; // pretend the interval elapsed
  await t.message('s6', 'Adiciona paginação ao endpoint de clientes');
  await t.pending('s6');
  s.lastAttempt = 1;
  await t.message('s6', 'Adiciona paginação ao endpoint de clientes');
  await t.pending('s6');
  s.lastAttempt = 1;
  await t.message('s6', 'Adiciona paginação ao endpoint de clientes');
  await t.pending('s6');
  assert.equal(t.calls.length, 3);
  assert.equal(t.client.store.get('s6').title, PROJECT);
});

test('native mode: leaves the default title, prefixes OpenCode\'s own title once', async () => {
  const t = setup({ mode: 'native' });
  await t.created({ id: 'n1', title: DEFAULT });
  assert.equal(t.client.updates.length, 0, 'default title kept so OpenCode generates one');
  await t.message('n1', 'Fix the Safari login redirect loop');
  t.client.store.set('n1', { id: 'n1', title: 'Fixing Safari login redirect loop' }); // OpenCode's generator
  await t.updated('n1');
  assert.equal(t.client.store.get('n1').title, `${PROJECT} - Fixing Safari login redirect loop`);
  await t.updated('n1'); // echo
  assert.equal(t.client.updates.length, 1);
  t.client.store.set('n1', { id: 'n1', title: 'User picked this' });
  await t.updated('n1');
  assert.equal(t.client.updates.length, 1, 'later rename respected');
  assert.equal(t.calls.length, 0, 'no extra model call in native mode');
});

test('native mode: a rename before the first message is respected', async () => {
  const t = setup({ mode: 'native' });
  await t.created({ id: 'n2', title: DEFAULT });
  t.client.store.set('n2', { id: 'n2', title: 'Named up front' });
  await t.updated('n2');
  await t.message('n2', 'Fix the Safari login redirect loop');
  await t.updated('n2');
  assert.equal(t.client.updates.length, 0);
});

test('hook errors never propagate to OpenCode', async () => {
  const client = mockClient();
  client.session.update = async () => { throw new Error('boom'); };
  client.session.get = async () => { throw new Error('boom'); };
  const hooks = createSessionNamer({ client, directory: DIR, git: () => null, env: { SESSION_NAMER_OPENCODE_TOPIC: 'claude' }, hasClaude: () => true, log: () => {} });
  await hooks.event({ event: { type: 'session.created', properties: { info: { id: 'e1', title: DEFAULT } } } });
  await hooks['chat.message']({ sessionID: 'e1' }, { parts: [{ type: 'text', text: 'Adiciona paginação ao endpoint' }] });
});

test('index.mjs exports only a v1 plugin object', async () => {
  const mod = await import(pathToFileURL(path.join(__dirname, '..', 'adapters', 'opencode', 'index.mjs')).href);
  assert.deepEqual(Object.keys(mod), ['default']);
  assert.equal(mod.default.id, 'session-namer');
  assert.equal(typeof mod.default.server, 'function');
  const saved = {};
  for (const k of ['SESSION_NAMER_NESTED', 'CLAUDE_SESSION_NAMER', 'SESSION_NAMER_ENABLED']) { saved[k] = process.env[k]; delete process.env[k]; }
  let hooks;
  try {
    hooks = await mod.default.server({ client: mockClient(), directory: DIR, worktree: DIR });
  } finally {
    for (const [k, v] of Object.entries(saved)) if (v !== undefined) process.env[k] = v;
  }
  assert.equal(typeof hooks.event, 'function');
  assert.equal(typeof hooks['chat.message'], 'function');
  assert.deepEqual(Object.keys(hooks).sort(), ['chat.message', 'event']);
});

test('native mode: a late user rename (before OpenCode titled it) is not prefixed', async () => {
  const { NATIVE_WINDOW_MS } = require('../adapters/opencode/namer');
  let clock = 1_000_000;
  const t = setup({ mode: 'native', now: () => clock });
  await t.created({ id: 'n3', title: DEFAULT });
  await t.message('n3', 'Fix the Safari login redirect loop');
  clock += NATIVE_WINDOW_MS + 1; // OpenCode's own title never landed (e.g. its small model failed)
  t.client.store.set('n3', { id: 'n3', title: 'Release prep' });
  await t.updated('n3');
  assert.equal(t.client.updates.length, 0);
  assert.equal(t.client.store.get('n3').title, 'Release prep');
  assert.equal(t.hooks._sessions.get('n3').locked, true);
});

test('native mode: a title longer than OpenCode ever writes is the user rename', async () => {
  const t = setup({ mode: 'native' });
  await t.created({ id: 'n4', title: DEFAULT });
  await t.message('n4', 'Fix the Safari login redirect loop');
  t.client.store.set('n4', { id: 'n4', title: 'x'.repeat(120) });
  await t.updated('n4');
  assert.equal(t.client.updates.length, 0);
});
