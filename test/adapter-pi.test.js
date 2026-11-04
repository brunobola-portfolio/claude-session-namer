'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const sessionNamer = require('../adapters/pi/index.js');

const { pickPiModel } = sessionNamer._internals;

/** Minimal stand-in for Pi's ExtensionAPI: event bus plus session name. */
function fakePi(initialName) {
  const handlers = {};
  const pi = {
    name: initialName,
    sets: [],
    on(event, handler) { (handlers[event] = handlers[event] || []).push(handler); },
    setSessionName(name) {
      pi.name = name;
      pi.sets.push(name);
      for (const h of handlers.session_info_changed || []) h({ name }, {});
    },
    getSessionName() { return pi.name; },
    /** Simulates /name or RPC set_session_name from the user. */
    userRename(name) { pi.name = name; for (const h of handlers.session_info_changed || []) h({ name }, {}); },
    async emit(event, payload, ctx) {
      let last;
      for (const h of handlers[event] || []) last = await h(payload, ctx);
      return last;
    },
    emitSync(event, payload, ctx) {
      let last;
      for (const h of handlers[event] || []) last = h(payload, ctx);
      return last;
    },
    handlers,
  };
  return pi;
}

const git = (args) => (args[1] === '--git-common-dir' ? '/home/u/webapp/.git' : null);

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

/** Model registry whose single completion is controlled by the test. */
function fakeRegistry({ models = [{ provider: 'anthropic', id: 'claude-sonnet-4-5' }, { provider: 'anthropic', id: 'claude-haiku-4-5' }], answer = 'Fix Safari login redirect loop', fail = false, gate = null } = {}) {
  const calls = [];
  return {
    calls,
    getAvailable: () => models,
    find: (p, id) => models.find((m) => m.provider === p && m.id === id),
    hasConfiguredAuth: () => true,
    streamSimple(model, context, options) {
      calls.push({ model, context, options });
      return {
        async result() {
          if (gate) await gate;
          if (fail) return { stopReason: 'error', errorMessage: 'boom', content: [] };
          return { stopReason: 'stop', content: [{ type: 'text', text: answer }] };
        },
      };
    },
  };
}

const ctxFor = (registry, extra = {}) => ({
  cwd: '/home/u/webapp/src', mode: 'tui', hasUI: true,
  model: { provider: 'anthropic', id: 'claude-sonnet-4-5' },
  modelRegistry: registry,
  sessionManager: { getSessionId: () => 'abcdef12-3456' },
  ...extra,
});

const setup = ({ env = {}, name, generateClaude, registry = fakeRegistry(), ctx } = {}) => {
  const pi = fakePi(name);
  const claudeCalls = [];
  const gen = generateClaude || (async (opts) => { claudeCalls.push(opts); return 'Topic from Claude'; });
  sessionNamer(pi, { env, git, log: () => {}, generateClaude: gen });
  return { pi, registry, claudeCalls, ctx: ctx || ctxFor(registry) };
};

const settle = () => new Promise((r) => setImmediate(r));
async function flush() { for (let i = 0; i < 5; i += 1) await settle(); }

test('session_start names the session after the git project', async () => {
  const { pi, ctx } = setup();
  await pi.emit('session_start', { reason: 'startup' }, ctx);
  assert.equal(pi.name, 'webapp');
});

test('first eligible prompt: input returns immediately, topic arrives later via Pi model', async () => {
  const gate = deferred();
  const registry = fakeRegistry({ gate: gate.promise });
  const { pi, ctx, claudeCalls } = setup({ registry });
  await pi.emit('session_start', { reason: 'startup' }, ctx);
  const ret = pi.emitSync('input', { text: 'Fix the login redirect loop on Safari', source: 'interactive' }, ctx);
  assert.equal(ret, undefined, 'never transforms or handles the prompt');
  assert.equal(pi.name, 'webapp', 'prompt not blocked: name unchanged until the model answers');
  gate.resolve();
  await flush();
  assert.equal(pi.name, 'webapp - Fix Safari login redirect loop');
  assert.equal(claudeCalls.length, 0);
  const call = registry.calls[0];
  assert.equal(call.model.id, 'claude-haiku-4-5', 'cheap sibling of the active model');
  assert.match(call.context.systemPrompt, /short session titles/);
  assert.ok(call.options.signal, 'abortable');
});

test('later prompts do not regenerate', async () => {
  const { pi, ctx, registry } = setup();
  await pi.emit('session_start', { reason: 'startup' }, ctx);
  pi.emitSync('input', { text: 'Fix the login redirect loop on Safari', source: 'interactive' }, ctx);
  await flush();
  pi.emitSync('input', { text: 'Now refactor the billing module please', source: 'interactive' }, ctx);
  await flush();
  assert.equal(registry.calls.length, 1);
});

test('ineligible prompts never trigger a model call', async () => {
  const { pi, ctx, registry, claudeCalls } = setup();
  await pi.emit('session_start', { reason: 'startup' }, ctx);
  for (const text of ['ok', 'continua', '/name Something', '/skill:review the code', '@file.ts']) {
    pi.emitSync('input', { text, source: 'interactive' }, ctx);
  }
  pi.emitSync('input', { text: 'A long enough prompt from an extension', source: 'extension' }, ctx);
  await flush();
  assert.equal(registry.calls.length + claudeCalls.length, 0);
  assert.equal(pi.name, 'webapp');
});

test('falls back to claude -p when Pi has no usable model', async () => {
  const registry = fakeRegistry({ fail: true });
  const { pi, ctx, claudeCalls } = setup({ registry, env: { SESSION_NAMER_MODEL: 'haiku' } });
  await pi.emit('session_start', { reason: 'startup' }, ctx);
  pi.emitSync('input', { text: 'Migra as faturas para a V10 e valida', source: 'interactive' }, ctx);
  await flush();
  assert.equal(claudeCalls.length, 1);
  assert.equal(claudeCalls[0].model, 'haiku');
  assert.equal(pi.name, 'webapp - Topic from Claude');
});

test('SESSION_NAMER_PI_BACKEND=pi never calls claude; =claude never calls Pi', async () => {
  const a = setup({ registry: fakeRegistry({ fail: true }), env: { SESSION_NAMER_PI_BACKEND: 'pi' } });
  await a.pi.emit('session_start', { reason: 'startup' }, a.ctx);
  a.pi.emitSync('input', { text: 'Fix the login redirect loop on Safari', source: 'interactive' }, a.ctx);
  await flush();
  assert.equal(a.claudeCalls.length, 0);
  assert.equal(a.pi.name, 'webapp');

  const b = setup({ env: { SESSION_NAMER_PI_BACKEND: 'claude' } });
  await b.pi.emit('session_start', { reason: 'startup' }, b.ctx);
  b.pi.emitSync('input', { text: 'Fix the login redirect loop on Safari', source: 'interactive' }, b.ctx);
  await flush();
  assert.equal(b.registry.calls.length, 0);
  assert.equal(b.pi.name, 'webapp - Topic from Claude');
});

test('a user rename while the topic is being generated is never overwritten', async () => {
  const gate = deferred();
  const { pi, ctx } = setup({ registry: fakeRegistry({ gate: gate.promise }) });
  await pi.emit('session_start', { reason: 'startup' }, ctx);
  pi.emitSync('input', { text: 'Fix the login redirect loop on Safari', source: 'interactive' }, ctx);
  pi.userRename('My own name');
  gate.resolve();
  await flush();
  assert.equal(pi.name, 'My own name');
});

test('a session already named (--name, resume) is left alone', async () => {
  const { pi, ctx, registry } = setup({ name: 'Chosen by me' });
  await pi.emit('session_start', { reason: 'startup' }, ctx);
  pi.emitSync('input', { text: 'Fix the login redirect loop on Safari', source: 'interactive' }, ctx);
  await flush();
  assert.equal(pi.name, 'Chosen by me');
  assert.equal(pi.sets.length, 0);
  assert.equal(registry.calls.length, 0);
});

test('a resumed session that only has the project name still gets its topic', async () => {
  const { pi, ctx } = setup({ name: 'webapp' });
  await pi.emit('session_start', { reason: 'resume' }, ctx);
  pi.emitSync('input', { text: 'Fix the login redirect loop on Safari', source: 'interactive' }, ctx);
  await flush();
  assert.equal(pi.name, 'webapp - Fix Safari login redirect loop');
});

test('recursion guard: SESSION_NAMER_NESTED=1 registers nothing', () => {
  const pi = fakePi();
  sessionNamer(pi, { env: { SESSION_NAMER_NESTED: '1' }, git, log: () => {} });
  assert.deepEqual(Object.keys(pi.handlers), []);
});

test('kill switch and print mode (unless SESSION_NAMER_NAME_HEADLESS=1)', async () => {
  const off = setup({ env: { CLAUDE_SESSION_NAMER: 'off' } });
  await off.pi.emit('session_start', { reason: 'startup' }, off.ctx);
  assert.equal(off.pi.name, undefined);

  const registry = fakeRegistry();
  const print = setup({ registry, ctx: ctxFor(registry, { mode: 'print', hasUI: false }) });
  await print.pi.emit('session_start', { reason: 'startup' }, print.ctx);
  assert.equal(print.pi.name, undefined);

  const registry2 = fakeRegistry();
  const printOn = setup({ registry: registry2, env: { SESSION_NAMER_NAME_HEADLESS: '1' }, ctx: ctxFor(registry2, { mode: 'print', hasUI: false }) });
  await printOn.pi.emit('session_start', { reason: 'startup' }, printOn.ctx);
  assert.equal(printOn.pi.name, 'webapp');
});

test('session_shutdown waits for a pending topic so pi -p still gets named', async () => {
  const gate = deferred();
  const { pi, ctx } = setup({ registry: fakeRegistry({ gate: gate.promise }) });
  await pi.emit('session_start', { reason: 'startup' }, ctx);
  pi.emitSync('input', { text: 'Fix the login redirect loop on Safari', source: 'interactive' }, ctx);
  setTimeout(() => gate.resolve(), 20);
  await pi.emit('session_shutdown', { reason: 'quit' }, ctx);
  assert.equal(pi.name, 'webapp - Fix Safari login redirect loop');
});

test('pickPiModel: explicit SESSION_NAMER_PI_MODEL, cheap sibling, active model, none', () => {
  const reg = fakeRegistry({ models: [
    { provider: 'openai', id: 'gpt-5.2' }, { provider: 'openai', id: 'gpt-realtime-mini' },
    { provider: 'openai', id: 'gpt-5-mini' }, { provider: 'google', id: 'gemini-flash' },
  ] });
  const ctx = { modelRegistry: reg, model: { provider: 'openai', id: 'gpt-5.2' } };
  assert.equal(pickPiModel(ctx, {}).id, 'gpt-5-mini');
  assert.equal(pickPiModel(ctx, { SESSION_NAMER_PI_MODEL: 'google/gemini-flash' }).id, 'gemini-flash');
  assert.equal(pickPiModel(ctx, { SESSION_NAMER_PI_MODEL: 'nope/missing' }), null);
  const lone = { modelRegistry: fakeRegistry({ models: [{ provider: 'x', id: 'big' }] }), model: { provider: 'x', id: 'big' } };
  assert.equal(pickPiModel(lone, {}).id, 'big');
  assert.equal(pickPiModel({ modelRegistry: reg, model: undefined }, {}), null);
  const noAuth = { ...reg, hasConfiguredAuth: () => false };
  assert.equal(pickPiModel({ modelRegistry: noAuth, model: { provider: 'openai', id: 'gpt-5.2' } }, {}), null);
});

test('pickPiModel: "gemini" is not a "mini" model; flash wins over generic words', () => {
  const reg = fakeRegistry({ models: [
    { provider: 'google', id: 'gemini-2.5-pro' }, { provider: 'google', id: 'gemini-2.5-flash' }, { provider: 'google', id: 'gemini-nano-x' },
  ] });
  assert.equal(pickPiModel({ modelRegistry: reg, model: { provider: 'google', id: 'gemini-2.5-pro' } }, {}).id, 'gemini-2.5-flash');
  const onlyPro = fakeRegistry({ models: [{ provider: 'google', id: 'gemini-2.5-pro' }, { provider: 'google', id: 'gemini-exp' }] });
  // No cheap sibling: the active model, not "gemini-exp" picked by a bare /mini/ match.
  assert.equal(pickPiModel({ modelRegistry: onlyPro, model: { provider: 'google', id: 'gemini-2.5-pro' } }, {}).id, 'gemini-2.5-pro');
  const { CHEAP_MODEL_PATTERNS } = sessionNamer._internals;
  const cheap = (id) => CHEAP_MODEL_PATTERNS.some((re) => re.test(id));
  assert.equal(cheap('gemini-2.5-pro'), false);
  assert.equal(cheap('ministral-8b'), false);
  assert.equal(cheap('gpt-4o-mini'), true);
  assert.equal(cheap('o4-mini'), true);
});

test('session_shutdown on quit waits at most QUIT_WAIT_MS (<= 5 s) for a stuck generation', async () => {
  const { QUIT_WAIT_MS } = sessionNamer._internals;
  assert.ok(QUIT_WAIT_MS <= 5000);
  const gate = deferred();
  const { pi, ctx } = setup({ registry: fakeRegistry({ gate: gate.promise }) });
  await pi.emit('session_start', { reason: 'startup' }, ctx);
  pi.emitSync('input', { text: 'Fix the login redirect loop on Safari', source: 'interactive' }, ctx);
  const t0 = Date.now();
  await pi.emit('session_shutdown', { reason: 'quit' }, ctx);
  const waited = Date.now() - t0;
  gate.resolve();
  assert.ok(waited <= QUIT_WAIT_MS + 1000, `waited ${waited} ms`);
});
