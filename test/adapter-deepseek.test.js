'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const load = () => import(pathToFileURL(path.join(__dirname, '..', 'adapters', 'deepseek', 'plugin.mjs')).href);

const project = () => ({ cfg: { enabled: true }, project: 'arcva' });
const session = { id: 's1', header: { cwd: '/repos/arcva' } };
const signal = new AbortController().signal;

test('deepseek: provider shape and registration', async () => {
  const mod = await load();
  assert.equal(mod.name, 'session-namer');
  assert.deepEqual(mod.inject, ['sessionTitle']);
  let registered = null;
  mod.apply({ sessionTitle: { register: (p) => { registered = p; return () => {}; } } });
  assert.equal(registered.id, mod.PROVIDER_ID);
  assert.equal(registered.automatic, 'all-prompts');
  assert.equal(typeof registered.generate, 'function');
});

test('deepseek: eligible prompt yields "<project> - <topic>" from the session cwd', async () => {
  const { createProvider } = await load();
  const calls = [];
  const make = async ({ prompt, cwd }) => { calls.push({ prompt, cwd }); return { reason: 'ok', title: 'arcva - Migração de faturas para V10' }; };
  const p = createProvider({ make, project });
  const r = await p.generate({ session, messages: [{ seq: 8, text: 'Migra as faturas para a V10 e valida os testes' }], signal });
  assert.deepEqual(r, { title: 'arcva - Migração de faturas para V10', messageSeqs: [8] });
  assert.equal(calls[0].cwd, '/repos/arcva');
});

test('deepseek: trivial prompts keep the project-only title, newest real prompt wins later', async () => {
  const { createProvider } = await load();
  const seen = [];
  const make = async ({ prompt }) => {
    seen.push(prompt);
    return prompt === 'ok' ? { reason: 'ineligible', title: 'arcva' } : { reason: 'ok', title: `arcva - ${prompt}` };
  };
  const p = createProvider({ make, project });
  const first = await p.generate({ session, messages: [{ seq: 8, text: 'ok' }], signal });
  assert.deepEqual(first, { title: 'arcva', messageSeqs: [8] });
  const second = await p.generate({
    session, signal,
    currentTitle: { title: 'arcva', messageSeqs: [8], source: { kind: 'provider', provider: 'session-namer' } },
    messages: [{ seq: 8, text: 'ok' }, { seq: 22, text: 'Fix Safari login loop' }],
  });
  assert.deepEqual(second, { title: 'arcva - Fix Safari login loop', messageSeqs: [22] });
  assert.deepEqual(seen, ['Fix Safari login loop'], 'trivial prompts never reach the generator');
});

test('deepseek: an accepted own title is reused without a model call', async () => {
  const { createProvider } = await load();
  const make = async () => { throw new Error('must not generate'); };
  const p = createProvider({ make, project });
  const current = { title: 'arcva - Topic here', messageSeqs: [8], source: { kind: 'provider', provider: 'session-namer' } };
  const r = await p.generate({ session, signal, currentTitle: current, messages: [{ seq: 8, text: 'a' }, { seq: 30, text: 'b' }] });
  assert.deepEqual(r, { title: 'arcva - Topic here', messageSeqs: [8] });
});

test('deepseek: fallback or other-provider titles are not treated as ours', async () => {
  const { isOwnFinal } = await load();
  assert.equal(isOwnFinal({ title: 'x', source: { kind: 'fallback' } }, 'arcva'), false);
  assert.equal(isOwnFinal({ title: 'x', source: { kind: 'provider', provider: 'other' } }, 'arcva'), false);
  assert.equal(isOwnFinal({ title: 'arcva', source: { kind: 'provider', provider: 'session-namer' } }, 'arcva'), false);
  assert.equal(isOwnFinal(undefined, 'arcva'), false);
});

test('deepseek: generation failure falls back to the project; disabled and empty input reject', async () => {
  const { createProvider } = await load();
  const failing = createProvider({ make: async () => ({ reason: 'generation-failed', title: 'arcva' }), project });
  assert.deepEqual(await failing.generate({ session, signal, messages: [{ seq: 3, text: 'Fix the login redirect loop' }] }), { title: 'arcva', messageSeqs: [3] });
  const disabled = createProvider({ make: async () => ({ reason: 'disabled' }), project });
  await assert.rejects(disabled.generate({ session, signal, messages: [{ seq: 3, text: 'Fix the login redirect loop' }] }), /disabled/);
  await assert.rejects(failing.generate({ session, signal, messages: [] }), /no eligible/);
});

test('deepseek: aborted requests stop before generating', async () => {
  const { createProvider } = await load();
  const ac = new AbortController();
  ac.abort();
  const p = createProvider({ make: async () => { throw new Error('must not run'); }, project });
  await assert.rejects(p.generate({ session, signal: ac.signal, messages: [{ seq: 1, text: 'Fix the login redirect loop' }] }), /aborted/);
});

test('deepseek: missing session cwd uses the fallback directory', async () => {
  const { createProvider } = await load();
  let cwdSeen = null;
  const p = createProvider({ make: async ({ cwd }) => { cwdSeen = cwd; return { reason: 'ok', title: 'x - y z' }; }, project, fallbackCwd: '/fallback' });
  await p.generate({ session: { id: 's', header: {} }, signal, messages: [{ seq: 1, text: 'Fix the login redirect loop' }] });
  assert.equal(cwdSeen, '/fallback');
});

test('deepseek: at most MAX_ATTEMPTS model calls per session, RETRY_INTERVAL_MS apart', async () => {
  const { createProvider, MAX_ATTEMPTS, RETRY_INTERVAL_MS } = await load();
  let calls = 0;
  let t = 1_000_000;
  const make = async () => { calls += 1; return { reason: 'generation-failed', title: 'arcva' }; };
  const p = createProvider({ make, project, now: () => t });
  const req = { session, signal, messages: [{ seq: 1, text: 'Fix the login redirect loop on Safari' }] };
  await p.generate(req);
  await p.generate(req); // too soon: no call
  assert.equal(calls, 1);
  for (let i = 0; i < 5; i += 1) { t += RETRY_INTERVAL_MS + 1; await p.generate(req); }
  assert.equal(calls, MAX_ATTEMPTS);
  assert.deepEqual(await p.generate(req), { title: 'arcva', messageSeqs: [1] });
});

test('deepseek: git runs once per cwd, not once per message', async () => {
  const { createProvider } = await load();
  const made = [];
  const gitFor = (cwd) => { made.push(cwd); return () => null; };
  const p = createProvider({ make: async () => ({ reason: 'ineligible', title: 'arcva' }), project, gitFor });
  for (let i = 0; i < 4; i += 1) await p.generate({ session, signal, messages: [{ seq: i, text: 'ok' }] });
  assert.deepEqual(made, ['/repos/arcva']);
});
