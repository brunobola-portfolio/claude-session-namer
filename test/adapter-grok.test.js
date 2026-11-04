'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');

const grok = require('../adapters/grok/hook');
const acp = require('../adapters/grok/acp');
const state = require('../lib/state');

const tmpEnv = () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sn-grok-'));
  return { GROK_HOME: home, PATH: process.env.PATH };
};
const project = () => ({ cfg: { enabled: true }, project: 'arcva' });
const SID = '01a1a38b-7740-7f71-9f63-ec8405d8c4b4';
const payload = (extra = {}) => ({ hook_event_name: 'UserPromptSubmit', hookEventName: 'user_prompt_submit', sessionId: SID, cwd: '/repos/arcva', prompt: 'Fix the login redirect loop on Safari', ...extra });

/** UserPromptSubmit stdin as Grok 1.0.70 sent it from a live TUI session (paths shortened). */
const CAPTURED_PROMPT_SUBMIT = {
  hookEventName: 'user_prompt_submit', sessionId: '01a1a4fa-f17c-76c0-b772-20311667ab06',
  cwd: 'C:\\repos\\sn-grok-e2e', workspaceRoot: 'C:\\repos\\sn-grok-e2e', timestamp: '2026-11-04T05:14:42.178804300+00:00',
  transcriptPath: 'C:/g/.grok\\sessions\\C%3A%5Crepos%5Csn-grok-e2e\\01a1a4fa-f17c-76c0-b772-20311667ab06\\updates.jsonl',
  promptId: 'da3da594-8719-4499-a1f3-456ac99cdf29', permissionMode: 'default', prompt: 'Fix the login redirect loop on Safari',
  hook_event_name: 'UserPromptSubmit', session_id: '01a1a4fa-f17c-76c0-b772-20311667ab06',
  transcript_path: 'C:/g/.grok\\sessions\\C%3A%5Crepos%5Csn-grok-e2e\\01a1a4fa-f17c-76c0-b772-20311667ab06\\updates.jsonl',
  permission_mode: 'default',
};

test('grok: normalize reads the payload Grok 1.0.70 sends (captured live)', () => {
  const n = grok.normalize(CAPTURED_PROMPT_SUBMIT, {});
  assert.equal(n.event, 'UserPromptSubmit');
  assert.equal(n.sessionId, '01a1a4fa-f17c-76c0-b772-20311667ab06');
  assert.equal(n.cwd, 'C:\\repos\\sn-grok-e2e');
  assert.equal(n.prompt, 'Fix the login redirect loop on Safari');
  assert.equal(n.subagent, false);
  // `prompt` is the only prompt field Grok sends; guessed variants are not read.
  assert.equal(grok.normalize({ hookEventName: 'user_prompt_submit', session_id: 'abc', userPrompt: 'hello there friend' }, {}).prompt, '');
  const camel = grok.normalize({ hookEventName: 'user_prompt_submit', session_id: 'abc', prompt: 'hello there friend' }, {});
  assert.equal(camel.event, 'UserPromptSubmit');
  assert.equal(camel.sessionId, 'abc');
  const fromEnv = grok.normalize({}, { GROK_SESSION_ID: 'envsid', GROK_HOOK_EVENT: 'user_prompt_submit', GROK_WORKSPACE_ROOT: '/w' });
  assert.equal(fromEnv.sessionId, 'envsid');
  assert.equal(fromEnv.cwd, '/w');
  assert.equal(fromEnv.event, 'UserPromptSubmit');
});

test('grok: eligible prompt starts one worker; state and retries are respected', () => {
  const env = tmpEnv();
  const jobs = [];
  const spawnJob = (job) => { jobs.push(job); return true; };
  const t0 = 1_000_000;
  assert.equal(grok.handleHook(payload(), { env, now: t0, spawnJob, project }).action, 'generating');
  assert.equal(jobs[0].sessionId, SID);
  assert.equal(jobs[0].cwd, '/repos/arcva');
  assert.equal(grok.handleHook(payload(), { env, now: t0 + 1000, spawnJob, project }).action, 'wait');
  assert.equal(grok.handleHook(payload(), { env, now: t0 + 61_000, spawnJob, project }).action, 'generating');
  assert.equal(grok.handleHook(payload(), { env, now: t0 + 130_000, spawnJob, project }).action, 'generating');
  assert.equal(grok.handleHook(payload(), { env, now: t0 + 200_000, spawnJob, project }).action, 'gave-up');
  assert.equal(jobs.length, 3);
});

test('grok: skips nested, subagent, non-prompt, trivial and already-named sessions', () => {
  const env = tmpEnv();
  const spawnJob = () => { throw new Error('must not spawn'); };
  assert.equal(grok.handleHook(payload(), { env: { ...env, SESSION_NAMER_NESTED: '1' }, spawnJob, project }).action, 'skip-nested');
  assert.equal(grok.handleHook(payload({ subagentType: 'explore' }), { env, spawnJob, project }).action, 'skip-subagent');
  assert.equal(grok.handleHook(payload({ hook_event_name: 'SessionStart', hookEventName: 'session_start' }), { env, spawnJob, project }).action, 'ignore');
  assert.equal(grok.handleHook(payload({ prompt: 'ok' }), { env, spawnJob, project }).action, 'ineligible');
  assert.equal(grok.handleHook(payload({ sessionId: '../x' }), { env, spawnJob, project }).action, 'skip-no-session');
  state.writeState(state.stateDir({ ...env, CLAUDE_CONFIG_DIR: env.GROK_HOME }), SID, { stage: 'final', attempts: 1 });
  assert.equal(grok.handleHook(payload(), { env, spawnJob, project }).action, 'skip-final');
  const off = () => ({ cfg: { enabled: false }, project: 'arcva' });
  assert.equal(grok.handleHook(payload({ sessionId: 'other-session' }), { env, spawnJob, project: off }).action, 'disabled');
});

test('grok: worker renames once and marks the session final', async () => {
  const env = tmpEnv();
  const renames = [];
  const make = async () => ({ reason: 'ok', title: 'arcva - Fix Safari login redirect loop' });
  const rename = async (args) => { renames.push(args); return { ok: true }; };
  const r = await grok.runWorker({ sessionId: SID, cwd: '/repos/arcva', prompt: 'x' }, { env, make, rename });
  assert.deepEqual(r, { ok: true, title: 'arcva - Fix Safari login redirect loop' });
  assert.equal(renames[0].sessionId, SID);
  assert.equal(renames[0].title, 'arcva - Fix Safari login redirect loop');
  const st = state.readState(state.stateDir({ ...env, CLAUDE_CONFIG_DIR: env.GROK_HOME }), SID);
  assert.equal(st.stage, 'final');
  const again = await grok.runWorker({ sessionId: SID, cwd: '/repos/arcva', prompt: 'x' }, { env, make, rename });
  assert.equal(again.ok, false);
  assert.equal(renames.length, 1);
});

test('grok: worker leaves the session alone when generation or rename fails', async () => {
  const env = tmpEnv();
  const noTopic = await grok.runWorker({ sessionId: 's2', cwd: '/r', prompt: 'x' }, { env, make: async () => ({ reason: 'generation-failed' }), rename: async () => { throw new Error('no'); } });
  assert.deepEqual(noTopic, { ok: false, reason: 'generation-failed' });
  const failed = await grok.runWorker({ sessionId: 's3', cwd: '/r', prompt: 'x' }, { env, make: async () => ({ reason: 'ok', title: 'a - b c' }), rename: async () => ({ ok: false, error: 'rename: session not found: s3' }) });
  assert.equal(failed.ok, false);
  const st = state.readState(state.stateDir({ ...env, CLAUDE_CONFIG_DIR: env.GROK_HOME }), 's3');
  assert.equal(st, null);
});

/** Fake `grok agent stdio`: answers initialize and the rename request. */
function fakeAgent(answer) {
  const sent = [];
  const spawn = (cmd, args, opts) => {
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.kill = () => {};
    child.spawnArgs = { cmd, args, opts };
    let buf = '';
    child.stdin.on('data', (d) => {
      buf += d;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const msg = JSON.parse(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
        sent.push(msg);
        // A notification carrying config must be ignored by the client.
        child.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', method: '_x.ai/mcp/servers_updated', params: { secret: 'x' } })}\n`);
        child.stdout.write(`${JSON.stringify(answer(msg))}\n`);
      }
    });
    sent.spawn = child.spawnArgs;
    return child;
  };
  return { spawn, sent };
}

test('grok acp: initialize then _x.ai/session/rename, success flag honoured', async () => {
  const { spawn, sent } = fakeAgent((m) => (m.method === 'initialize'
    ? { jsonrpc: '2.0', id: m.id, result: { protocolVersion: 1 } }
    : { jsonrpc: '2.0', id: m.id, result: { success: true } }));
  const r = await acp.renameSession({ sessionId: SID, title: 'arcva - Topic', grokPath: 'grok', spawn, cwd: '/r' });
  assert.deepEqual(r, { ok: true, error: undefined });
  assert.deepEqual(sent.map((m) => m.method), ['initialize', acp.RENAME_METHOD]);
  assert.deepEqual(sent[1].params, { sessionId: SID, title: 'arcva - Topic' });
  assert.deepEqual(sent.spawn.args, ['agent', '--no-leader', 'stdio']);
});

test('grok acp: JSON-RPC errors and timeouts become ok:false', async () => {
  const { spawn } = fakeAgent((m) => (m.method === 'initialize'
    ? { jsonrpc: '2.0', id: m.id, result: {} }
    : { jsonrpc: '2.0', id: m.id, error: { code: -32600, message: 'Invalid request', data: 'session not found: nope' } }));
  const r = await acp.renameSession({ sessionId: 'nope', title: 'x y', grokPath: 'grok', spawn });
  assert.equal(r.ok, false);
  assert.match(r.error, /session not found/);
  const silent = (cmd, args) => { const c = new EventEmitter(); c.stdin = new PassThrough(); c.stdout = new PassThrough(); c.kill = () => {}; return c; };
  const t = await acp.renameSession({ sessionId: 'a', title: 'x y', grokPath: 'grok', spawn: silent, timeoutMs: 50 });
  assert.deepEqual(t, { ok: false, error: 'timeout 50 ms' });
});

test('grok acp: findGrok prefers the override, then ~/.grok/bin', () => {
  assert.equal(acp.findGrok({ SESSION_NAMER_GROK_PATH: '/opt/grok' }), '/opt/grok');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sn-grokbin-'));
  const exe = path.join(home, '.grok', 'bin', 'grok');
  assert.equal(acp.findGrok({ HOME: home, USERPROFILE: '' }, { platform: 'linux', exists: (p) => p === exe }), exe);
  assert.equal(acp.findGrok({ HOME: home, USERPROFILE: '' }, { platform: 'linux', exists: () => false }), 'grok');
});

test('grok acp: with check, session/list is read first and a refusal skips the rename', async () => {
  const listed = { sessionId: SID, cwd: '/r', title: 'Release prep' };
  const answer = (m) => {
    if (m.method === 'initialize') return { jsonrpc: '2.0', id: m.id, result: {} };
    if (m.method === acp.LIST_METHOD) return { jsonrpc: '2.0', id: m.id, result: { sessions: [{ sessionId: 'other', title: 'x' }, listed] } };
    return { jsonrpc: '2.0', id: m.id, result: { success: true } };
  };
  const a = fakeAgent(answer);
  let seen = null;
  const r = await acp.renameSession({ sessionId: SID, title: 'arcva - Topic', grokPath: 'grok', spawn: a.spawn, cwd: '/r', check: (s) => { seen = s; return 'user'; } });
  assert.deepEqual(r, { ok: false, skipped: 'user', title: 'Release prep' });
  assert.deepEqual(seen, listed);
  assert.deepEqual(a.sent.map((m) => m.method), ['initialize', acp.LIST_METHOD]);
  assert.deepEqual(a.sent[1].params, { cwd: '/r' });
  const b = fakeAgent(answer);
  const ok = await acp.renameSession({ sessionId: SID, title: 'arcva - Topic', grokPath: 'grok', spawn: b.spawn, cwd: '/r', check: () => null });
  assert.equal(ok.ok, true);
  assert.deepEqual(b.sent.map((m) => m.method), ['initialize', acp.LIST_METHOD, acp.RENAME_METHOD]);
});

test('grok: refusal honours title_is_manual and our own earlier title', () => {
  assert.equal(grok.refusal({ listed: { title: '' }, summary: null }), null);
  assert.equal(grok.refusal({ listed: null, summary: null }), null);
  assert.equal(grok.refusal({ listed: { title: 'Release prep' }, summary: { title_is_manual: true } }), 'user');
  assert.equal(grok.refusal({ listed: { title: 'Grok auto title' }, summary: { title_is_manual: false } }), null);
  assert.equal(grok.refusal({ listed: { title: 'arcva - Old' }, summary: { title_is_manual: true }, own: 'arcva - Old' }), null);
  // Grok omits title_is_manual unless it is true: an auto-titled session (live 1.0.70 summary.json).
  assert.equal(grok.refusal({ listed: { title: 'Fix the login redirect loop on Safari' }, summary: { generated_title: 'Fix the login redirect loop on Safari', session_summary: 'Fix the login redirect loop on Safari' } }), null);
  // Manual flag unknown (summary.json unreadable): a title that is not ours is assumed to be the user's.
  assert.equal(grok.refusal({ listed: { title: 'Something' }, summary: null }), 'user');
});

test('grok: worker renames a session that only has Grok\'s own auto-title', async () => {
  const env = tmpEnv();
  const sdir = path.join(env.GROK_HOME, 'sessions', encodeURIComponent('/repos/arcva'), SID);
  fs.mkdirSync(sdir, { recursive: true });
  // What Grok 1.0.70 wrote right after the first turn: no title_is_manual key at all.
  fs.writeFileSync(path.join(sdir, 'summary.json'), JSON.stringify({ info: { id: SID, cwd: '/repos/arcva' }, session_summary: 'Fix the login redirect loop on Safari', generated_title: 'Fix the login redirect loop on Safari', num_messages: 5 }));
  let renamed = null;
  const make = async () => ({ reason: 'ok', title: 'arcva - Safari login redirect loop' });
  const rename = async ({ check, title: t }) => {
    const why = check({ sessionId: SID, cwd: '/repos/arcva', title: 'Fix the login redirect loop on Safari' });
    if (why) return { ok: false, skipped: why, title: 'Fix the login redirect loop on Safari' };
    renamed = t;
    return { ok: true };
  };
  const r = await grok.runWorker({ sessionId: SID, cwd: '/repos/arcva', prompt: 'x' }, { env, make, rename });
  assert.deepEqual(r, { ok: true, title: 'arcva - Safari login redirect loop' });
  assert.equal(renamed, 'arcva - Safari login redirect loop');
});

test('grok: worker never renames a session the user already named', async () => {
  const env = tmpEnv();
  const sdir = path.join(env.GROK_HOME, 'sessions', encodeURIComponent('/repos/arcva'), SID);
  fs.mkdirSync(sdir, { recursive: true });
  fs.writeFileSync(path.join(sdir, 'summary.json'), JSON.stringify({ generated_title: 'Release prep', title_is_manual: true }));
  let renamed = false;
  const make = async () => ({ reason: 'ok', title: 'arcva - Fix Safari login redirect loop' });
  const rename = async ({ check }) => {
    const why = check({ sessionId: SID, cwd: '/repos/arcva', title: 'Release prep' });
    if (why) return { ok: false, skipped: why, title: 'Release prep' };
    renamed = true;
    return { ok: true };
  };
  const r = await grok.runWorker({ sessionId: SID, cwd: '/repos/arcva', prompt: 'x' }, { env, make, rename });
  assert.deepEqual(r, { ok: false, reason: 'user' });
  assert.equal(renamed, false);
  const st = state.readState(state.stateDir({ ...env, CLAUDE_CONFIG_DIR: env.GROK_HOME }), SID);
  assert.equal(st.stage, 'user');
  assert.equal(grok.handleHook(payload(), { env, project, spawnJob: () => true }).action, 'skip-user');
});
