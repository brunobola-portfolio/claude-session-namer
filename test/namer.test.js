'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { run } = require('../hooks/namer');
const { readState, writeState } = require('../lib/state');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'namer-run-'));
/** process.env without anything that would change the plugin's behaviour on a dev machine. */
const cleanEnv = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(SESSION_NAMER_|CLAUDE_SESSION_NAMER|CLAUDE_PLUGIN_OPTION_|CLAUDE_CODE_ENTRYPOINT|CLAUDE_CODE_EXECPATH)/.test(k)));

/** Deps with a temp state dir, no git, and a stubbed generator. */
function makeDeps({ topic = 'Migração de faturas para V10', env = {}, generateCalls = [] } = {}) {
  const cfgDir = tmp();
  return {
    dir: path.join(cfgDir, 'session-namer'),
    deps: {
      env: { CLAUDE_CONFIG_DIR: cfgDir, ...env },
      git: () => null,
      generate: async (opts) => { generateCalls.push(opts); return topic; },
      now: () => 1_700_000_000_000,
    },
    generateCalls,
  };
}

const startup = (over = {}) => ({ session_id: 's1', cwd: 'D:/repos/arcva-2.0', hook_event_name: 'SessionStart', source: 'startup', ...over });
const prompt = (text, over = {}) => ({ session_id: 's1', cwd: 'D:/repos/arcva-2.0', hook_event_name: 'UserPromptSubmit', prompt: text, ...over });

test('startup without title emits the provisional project title', async () => {
  const { dir, deps } = makeDeps();
  const out = await run('SessionStart', startup(), deps);
  assert.deepEqual(out, { hookSpecificOutput: { hookEventName: 'SessionStart', sessionTitle: 'arcva-2.0' } });
  assert.equal(readState(dir, 's1').stage, 'provisional');
});

test('startup with a user-set title records stage user and stays silent', async () => {
  const { dir, deps } = makeDeps();
  assert.equal(await run('SessionStart', startup({ session_title: 'my own name' }), deps), null);
  assert.equal(readState(dir, 's1').stage, 'user');
  assert.equal(await run('UserPromptSubmit', prompt('Migra as faturas para a V10 por favor'), deps), null);
});

test('resume with our own title keeps stage; resume untitled becomes provisional', async () => {
  const { dir, deps } = makeDeps();
  writeState(dir, 's1', { stage: 'final', title: 'arcva-2.0 - Algo', attempts: 1, v: 1 });
  assert.equal(await run('SessionStart', startup({ source: 'resume', session_title: 'arcva-2.0 - Algo' }), deps), null);
  assert.equal(readState(dir, 's1').stage, 'final');
  const out = await run('SessionStart', startup({ session_id: 's2', source: 'resume' }), deps);
  assert.equal(out.hookSpecificOutput.sessionTitle, 'arcva-2.0');
});

test('clear, compact, subagents and disabled plugin produce nothing', async () => {
  const { deps } = makeDeps();
  assert.equal(await run('SessionStart', startup({ source: 'clear' }), deps), null);
  assert.equal(await run('SessionStart', startup({ source: 'compact' }), deps), null);
  assert.equal(await run('SessionStart', startup({ agent_type: 'reviewer' }), deps), null);
  const off = makeDeps({ env: { CLAUDE_SESSION_NAMER: 'off' } });
  assert.equal(await run('SessionStart', startup(), off.deps), null);
  assert.equal(await run('UserPromptSubmit', prompt('Migra as faturas para a V10 por favor'), off.deps), null);
  const nested = makeDeps({ env: { SESSION_NAMER_NESTED: '1' } });
  assert.equal(await run('UserPromptSubmit', prompt('Migra as faturas para a V10 por favor'), nested.deps), null);
});

test('first eligible prompt produces the final title and records it', async () => {
  const { dir, deps, generateCalls } = makeDeps();
  await run('SessionStart', startup(), deps);
  const out = await run('UserPromptSubmit', prompt('Migra as faturas para a V10 e valida os testes'), deps);
  assert.deepEqual(out, { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', sessionTitle: 'arcva-2.0 - Migração de faturas para V10' } });
  const st = readState(dir, 's1');
  assert.equal(st.stage, 'final');
  assert.equal(st.title, 'arcva-2.0 - Migração de faturas para V10');
  assert.equal(generateCalls.length, 1);
  assert.equal(generateCalls[0].model, 'haiku');
  // Next two prompts re-assert the final title (VS Code race), then silence.
  const r1 = await run('UserPromptSubmit', prompt('Agora corrige os testes que falharam'), deps);
  assert.equal(r1.hookSpecificOutput.sessionTitle, 'arcva-2.0 - Migração de faturas para V10');
  const r2 = await run('UserPromptSubmit', prompt('E agora faz o deploy disto tudo'), deps);
  assert.equal(r2.hookSpecificOutput.sessionTitle, 'arcva-2.0 - Migração de faturas para V10');
  assert.equal(await run('UserPromptSubmit', prompt('Mais uma tarefa qualquer aqui'), deps), null);
  assert.equal(generateCalls.length, 1); // never another model call
});

test('a /rename after the automatic title is never overwritten by re-assertion', async () => {
  const { dir, deps, generateCalls } = makeDeps();
  await run('SessionStart', startup(), deps);
  await run('UserPromptSubmit', prompt('Migra as faturas para a V10 e valida os testes'), deps);
  // User runs /rename: Claude Code now reports that custom title on every prompt.
  const renamed = { session_title: 'O meu nome' };
  assert.equal(await run('UserPromptSubmit', prompt('Continua com a parte dos testes', renamed), deps), null);
  assert.equal(readState(dir, 's1').stage, 'user');
  assert.equal(await run('UserPromptSubmit', prompt('Mais uma tarefa qualquer aqui', renamed), deps), null);
  assert.equal(generateCalls.length, 1);
});

test('a custom title set before the first prompt is respected without a model call', async () => {
  const { deps, generateCalls } = makeDeps();
  const out = await run('UserPromptSubmit', prompt('Migra as faturas para a V10 e valida os testes', { session_title: 'feature-x' }), deps);
  assert.equal(out, null);
  assert.equal(generateCalls.length, 0);
});

test('our own title echoed back as session_title does not count as a user rename', async () => {
  const { dir, deps } = makeDeps();
  await run('SessionStart', startup(), deps);
  const first = await run('UserPromptSubmit', prompt('Migra as faturas para a V10 e valida os testes', { session_title: 'arcva-2.0' }), deps);
  assert.equal(first.hookSpecificOutput.sessionTitle, 'arcva-2.0 - Migração de faturas para V10');
  const echo = { session_title: 'arcva-2.0 - Migração de faturas para V10' };
  const again = await run('UserPromptSubmit', prompt('Agora corrige os testes que falharam', echo), deps);
  assert.equal(again.hookSpecificOutput.sessionTitle, 'arcva-2.0 - Migração de faturas para V10');
  assert.equal(readState(dir, 's1').stage, 'final');
});

test('/session-name still works when a custom title is present', async () => {
  const { deps } = makeDeps();
  const out = await run('UserPromptSubmit', prompt('/session-name Novo nome', { session_title: 'Antigo' }), deps);
  assert.equal(out.hookSpecificOutput.sessionTitle, 'arcva-2.0 - Novo nome');
});

test('legacy state with reasserted:true never re-asserts again', async () => {
  const { dir, deps } = makeDeps();
  const base = { v: 1, stage: 'final', title: 'arcva-2.0 - Algo antigo', attempts: 1, project: 'arcva-2.0' };
  writeState(dir, 's1', { ...base, reasserted: true });
  assert.equal(await run('UserPromptSubmit', prompt('Outro pedido qualquer aqui'), deps), null);
  assert.equal(readState(dir, 's1').stage, 'final');
});

test('headless (claude -p) sessions are skipped unless name_headless is on', async () => {
  const off = makeDeps({ env: { CLAUDE_CODE_ENTRYPOINT: 'sdk-cli' } });
  assert.equal(await run('SessionStart', startup(), off.deps), null);
  assert.equal(await run('UserPromptSubmit', prompt('Migra as faturas para a V10 por favor'), off.deps), null);
  assert.equal(off.generateCalls.length, 0);
  const on = makeDeps({ env: { CLAUDE_CODE_ENTRYPOINT: 'sdk-cli', SESSION_NAMER_NAME_HEADLESS: '1' } });
  const out = await run('SessionStart', startup(), on.deps);
  assert.equal(out.hookSpecificOutput.sessionTitle, 'arcva-2.0');
});

test('ineligible prompts keep the provisional stage without calling the model', async () => {
  const { dir, deps, generateCalls } = makeDeps();
  await run('SessionStart', startup(), deps);
  assert.equal(await run('UserPromptSubmit', prompt('/resume'), deps), null);
  assert.equal(await run('UserPromptSubmit', prompt('ok'), deps), null);
  assert.equal(generateCalls.length, 0);
  assert.equal(readState(dir, 's1').stage, 'provisional');
});

test('generation failure stays provisional, counts attempts, rate-limits and caps at 3', async () => {
  const calls = [];
  const cfgDir = tmp();
  const dir = path.join(cfgDir, 'session-namer');
  let clock = 1_700_000_000_000;
  const deps = { env: { CLAUDE_CONFIG_DIR: cfgDir }, git: () => null, generate: async () => { calls.push(1); return null; }, now: () => clock };
  await run('SessionStart', startup(), deps);
  const p = prompt('Migra as faturas para a V10 e valida os testes');
  assert.equal(await run('UserPromptSubmit', p, deps), null);
  assert.equal(readState(dir, 's1').attempts, 1);
  assert.equal(await run('UserPromptSubmit', p, deps), null); // within 60 s: no call
  assert.equal(calls.length, 1);
  clock += 61_000; await run('UserPromptSubmit', p, deps);
  clock += 61_000; await run('UserPromptSubmit', p, deps);
  clock += 61_000; await run('UserPromptSubmit', p, deps);
  assert.equal(calls.length, 3);
  assert.equal(readState(dir, 's1').attempts, 3);
});

test('unusable model answers are treated as failures', async () => {
  const { deps } = makeDeps({ topic: 'one' });
  await run('SessionStart', startup(), deps);
  assert.equal(await run('UserPromptSubmit', prompt('Migra as faturas para a V10 e valida os testes'), deps), null);
});

test('plugin enabled mid-session: no state, first prompt goes straight to final', async () => {
  const { deps } = makeDeps();
  const out = await run('UserPromptSubmit', prompt('Migra as faturas para a V10 e valida os testes'), deps);
  assert.equal(out.hookSpecificOutput.sessionTitle, 'arcva-2.0 - Migração de faturas para V10');
});

test('/session-name <topic> renames immediately and locks the title', async () => {
  const { dir, deps, generateCalls } = makeDeps();
  await run('SessionStart', startup(), deps);
  await run('UserPromptSubmit', prompt('Migra as faturas para a V10 e valida os testes'), deps);
  const out = await run('UserPromptSubmit', prompt('/session-name Nome manual bonito'), deps);
  assert.equal(out.hookSpecificOutput.sessionTitle, 'arcva-2.0 - Nome manual bonito');
  assert.equal(readState(dir, 's1').stage, 'user');
  assert.equal(await run('UserPromptSubmit', prompt('Outra tarefa completamente diferente agora'), deps), null);
  assert.equal(generateCalls.length, 1);
  const ns = await run('UserPromptSubmit', prompt('/session-namer:session-name "Com prefixo de plugin"'), deps);
  assert.equal(ns.hookSpecificOutput.sessionTitle, 'arcva-2.0 - Com prefixo de plugin');
});

test('/session-name with no args or --regenerate re-arms automatic naming', async () => {
  const { dir, deps, generateCalls } = makeDeps();
  await run('SessionStart', startup(), deps);
  await run('UserPromptSubmit', prompt('Migra as faturas para a V10 e valida os testes'), deps);
  const out = await run('UserPromptSubmit', prompt('/session-name --regenerate'), deps);
  assert.equal(out.hookSpecificOutput.sessionTitle, 'arcva-2.0');
  assert.equal(readState(dir, 's1').stage, 'provisional');
  assert.equal(readState(dir, 's1').attempts, 0);
  const again = await run('UserPromptSubmit', prompt('Agora adiciona paginação à lista de clientes'), deps);
  assert.equal(again.hookSpecificOutput.sessionTitle, 'arcva-2.0 - Migração de faturas para V10');
  assert.equal(generateCalls.length, 2);
  assert.equal((await run('UserPromptSubmit', prompt('/session-name'), deps)).hookSpecificOutput.sessionTitle, 'arcva-2.0');
});

test('/session-name --remote and --doctor are left to the command markdown', async () => {
  const { deps, generateCalls } = makeDeps();
  await run('SessionStart', startup(), deps);
  assert.equal(await run('UserPromptSubmit', prompt('/session-name --remote'), deps), null);
  assert.equal(await run('UserPromptSubmit', prompt('/session-name --doctor'), deps), null);
  assert.equal(generateCalls.length, 0);
});

test('doctor prints checks and a dry-run using the fake result', async () => {
  const { doctor } = require('../hooks/session-name-cli');
  const cfgDir = tmp();
  const report = await doctor({ ...cleanEnv(), CLAUDE_CONFIG_DIR: cfgDir, SESSION_NAMER_FAKE_RESULT: 'Paginação na lista de clientes', SESSION_NAMER_CLAUDE_PATH: path.join(cfgDir, 'no-such-claude') });
  assert.match(report, /^OK {3}Node\.js/m);
  assert.match(report, /claude CLI:/);
  assert.match(report, /state dir: /);
  assert.match(report, /dry-run generation in \d+ ms -> "Paginação na lista de clientes"/);
});

test('config: separator, project override via repo file and cwd source', async () => {
  const repo = tmp();
  fs.writeFileSync(path.join(repo, '.session-namer.json'), JSON.stringify({ project: 'ARCVA' }));
  const { deps } = makeDeps({ env: { CLAUDE_PLUGIN_OPTION_SEPARATOR: ' | ' } });
  const repoPosix = repo.replace(/\\/g, '/');
  deps.git = (args) => (args.includes('--show-toplevel') ? repoPosix : `${repoPosix}/.git`);
  const out = await run('SessionStart', startup({ cwd: repo }), deps);
  assert.equal(out.hookSpecificOutput.sessionTitle, 'ARCVA');
  const out2 = await run('UserPromptSubmit', prompt('Migra as faturas para a V10 e valida os testes', { cwd: repo }), deps);
  assert.equal(out2.hookSpecificOutput.sessionTitle, 'ARCVA | Migração de faturas para V10');
});

test('CLI wrapper: malformed stdin exits 0 with empty stdout; valid input prints JSON', () => {
  const script = path.join(__dirname, '..', 'hooks', 'namer.js');
  const dir = tmp();
  const bad = spawnSync(process.execPath, [script, 'SessionStart'], { input: '{nope', env: { ...cleanEnv(), CLAUDE_CONFIG_DIR: dir } });
  assert.equal(bad.status, 0);
  assert.equal(bad.stdout.toString(), '');
  const good = spawnSync(process.execPath, [script, 'SessionStart'], {
    input: JSON.stringify(startup({ cwd: dir })),
    env: { ...cleanEnv(), CLAUDE_CONFIG_DIR: dir, SESSION_NAMER_PROJECT_SOURCE: 'cwd' },
  });
  assert.equal(good.status, 0);
  assert.equal(JSON.parse(good.stdout.toString()).hookSpecificOutput.sessionTitle, path.basename(dir));
  const unknown = spawnSync(process.execPath, [script, 'Bogus'], { input: '{}', env: { ...cleanEnv(), CLAUDE_CONFIG_DIR: dir } });
  assert.equal(unknown.status, 0);
  assert.equal(unknown.stdout.toString(), '');
});

test('CLI wrapper with fake result produces a final title end to end', () => {
  const script = path.join(__dirname, '..', 'hooks', 'namer.js');
  const dir = tmp();
  const env = { ...cleanEnv(), CLAUDE_CONFIG_DIR: dir, SESSION_NAMER_PROJECT_SOURCE: 'cwd', SESSION_NAMER_FAKE_RESULT: 'Título simulado aqui' };
  const r = spawnSync(process.execPath, [script, 'UserPromptSubmit'], { input: JSON.stringify(prompt('Migra as faturas para a V10 e valida os testes', { cwd: dir })), env });
  assert.equal(r.status, 0);
  assert.equal(JSON.parse(r.stdout.toString()).hookSpecificOutput.sessionTitle, `${path.basename(dir)} - Título simulado aqui`);
  assert.match(fs.readFileSync(path.join(dir, 'session-namer', 'log.txt'), 'utf8'), /final/);
});

// --- Run by OpenAI Codex (which can install Claude Code plugins): must be a no-op.
// Inputs below mirror real hook payloads captured from Codex CLI 0.163.0 and Claude Code.
const { isCodexInput } = require('../hooks/namer');
const CODEX_TRANSCRIPT = String.raw`C:\Users\u\.codex\sessions\2026\11\03\rollout-2026-11-03T22-17-41-01a1a37d-4c40-7521-8bd0-f642cdc999aa.jsonl`;
const CLAUDE_TRANSCRIPT = String.raw`C:\Users\u\.claude\projects\D--repos-arcva-2-0\edc2b95b-5ad8-4471-a202-238dfd21f249.jsonl`;

test('Codex-run hook: SessionStart and UserPromptSubmit return null and never generate', async () => {
  const generateCalls = [];
  const { deps, dir } = makeDeps({ generateCalls });
  const codexStart = startup({ session_id: '01a1a37d-4c40-7521-8bd0-f642cdc999aa', transcript_path: CODEX_TRANSCRIPT, model: 'gpt-5.6-luna', permission_mode: 'bypassPermissions' });
  assert.equal(await run('SessionStart', codexStart, deps), null);
  const codexPrompt = prompt('Migra as faturas para a V10 e valida os testes', {
    session_id: '01a1a37d-4c40-7521-8bd0-f642cdc999aa', turn_id: '01a1a37d-571f-7152-8f7a-3ed615b3c3e8', transcript_path: CODEX_TRANSCRIPT, model: 'gpt-5.6-luna',
  });
  assert.equal(await run('UserPromptSubmit', codexPrompt, deps), null);
  // turn_id + model alone (e.g. ephemeral thread without a transcript) is enough.
  assert.equal(await run('UserPromptSubmit', { ...codexPrompt, transcript_path: null }, deps), null);
  assert.equal(generateCalls.length, 0);
  assert.equal(readState(dir, '01a1a37d-4c40-7521-8bd0-f642cdc999aa'), null);
});

test('Claude Code input is not mistaken for Codex and still gets titled', async () => {
  const claudeStart = { session_id: 'edc2b95b', cwd: 'D:/repos/arcva-2.0', hook_event_name: 'SessionStart', source: 'startup', transcript_path: CLAUDE_TRANSCRIPT };
  const claudePrompt = { session_id: 'edc2b95b', cwd: 'D:/repos/arcva-2.0', hook_event_name: 'UserPromptSubmit', permission_mode: 'default', prompt: 'Migra as faturas para a V10 e valida os testes', prompt_id: 'p1', transcript_path: CLAUDE_TRANSCRIPT };
  assert.equal(isCodexInput(claudeStart), false);
  assert.equal(isCodexInput(claudePrompt), false);
  assert.equal(isCodexInput({ ...claudeStart, model: 'claude-haiku' }), false, 'model alone is not a Codex marker');
  const generateCalls = [];
  const { deps } = makeDeps({ generateCalls });
  assert.equal((await run('SessionStart', claudeStart, deps)).hookSpecificOutput.sessionTitle, 'arcva-2.0');
  const out = await run('UserPromptSubmit', claudePrompt, deps);
  assert.equal(out.hookSpecificOutput.sessionTitle, 'arcva-2.0 - Migração de faturas para V10');
  assert.equal(generateCalls.length, 1);
});

test('resume of a final session without session_title re-emits the final title', async () => {
  const { dir, deps, generateCalls } = makeDeps();
  writeState(dir, 's1', { v: 1, stage: 'final', title: 'arcva-2.0 - Algo bom', attempts: 1, project: 'arcva-2.0' });
  const out = await run('SessionStart', startup({ source: 'resume' }), deps);
  assert.equal(out.hookSpecificOutput.sessionTitle, 'arcva-2.0 - Algo bom');
  assert.equal(readState(dir, 's1').stage, 'final');
  assert.equal(generateCalls.length, 0);
});

test('resume with our provisional title but pruned state keeps auto-naming armed', async () => {
  const { dir, deps, generateCalls } = makeDeps();
  assert.equal(await run('SessionStart', startup({ source: 'resume', session_title: 'arcva-2.0' }), deps), null);
  assert.equal(readState(dir, 's1').stage, 'provisional');
  const out = await run('UserPromptSubmit', prompt('Migra as faturas para a V10 e valida os testes', { session_title: 'arcva-2.0' }), deps);
  assert.equal(out.hookSpecificOutput.sessionTitle, 'arcva-2.0 - Migração de faturas para V10');
  assert.equal(generateCalls.length, 1);
});

test('/session-name treats any dash argument as a flag and trims long manual topics at a word', async () => {
  const { deps } = makeDeps();
  assert.equal(await run('UserPromptSubmit', prompt('/session-name -r'), deps), null);
  const long = await run('UserPromptSubmit', prompt(`/session-name ${'palavra '.repeat(20)}`), deps);
  assert.ok(!long.hookSpecificOutput.sessionTitle.endsWith('pala'));
  assert.ok(long.hookSpecificOutput.sessionTitle.length <= 80);
});

test('--regenerate clears the legacy reasserted flag so re-assertion works again', async () => {
  const { dir, deps } = makeDeps();
  writeState(dir, 's1', { v: 1, stage: 'final', title: 'arcva-2.0 - Velho', attempts: 1, project: 'arcva-2.0', reasserted: true });
  await run('UserPromptSubmit', prompt('/session-name --regenerate'), deps);
  assert.equal(readState(dir, 's1').reasserted, undefined);
  await run('UserPromptSubmit', prompt('Migra as faturas para a V10 e valida os testes'), deps);
  const again = await run('UserPromptSubmit', prompt('Agora corrige os testes que falharam'), deps);
  assert.equal(again.hookSpecificOutput.sessionTitle, 'arcva-2.0 - Migração de faturas para V10');
});
