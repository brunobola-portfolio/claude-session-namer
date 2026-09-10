'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  sanitizeTopic, formatTitle, isEligiblePrompt, truncatePrompt, resolveProject, ACK_WORDS,
} = require('../lib/title');

test('sanitizeTopic strips wrappers, prefixes, emoji and trailing punctuation', () => {
  assert.equal(sanitizeTopic('"Migração de faturas para V10."'), 'Migração de faturas para V10');
  assert.equal(sanitizeTopic('Title: Fix login bug'), 'Fix login bug');
  assert.equal(sanitizeTopic('Título: Corrigir bug de login!'), 'Corrigir bug de login');
  assert.equal(sanitizeTopic('`Refactor auth module`'), 'Refactor auth module');
  assert.equal(sanitizeTopic('🚀 Deploy pipeline setup ✨'), 'Deploy pipeline setup');
  assert.equal(sanitizeTopic('Line one\nLine two'), 'Line one Line two');
  assert.equal(sanitizeTopic('  many   spaces   here  '), 'many spaces here');
  assert.equal(sanitizeTopic('\u001b[31mred\u001b[0m text here'), 'red text here');
});

test('sanitizeTopic enforces word count and length', () => {
  assert.equal(sanitizeTopic('one'), null);
  assert.equal(sanitizeTopic(''), null);
  assert.equal(sanitizeTopic(null), null);
  assert.equal(sanitizeTopic('a b c d e f g h i j k l m'), null); // 13 words
  const long = 'palavra '.repeat(12).trim(); // 12 words, 95 chars
  const out = sanitizeTopic(long);
  assert.ok(out.length <= 60);
  assert.ok(!out.endsWith(' '));
  assert.equal(out, 'palavra palavra palavra palavra palavra palavra palavra');
});

test('sanitizeTopic keeps unicode letters and internal punctuation', () => {
  assert.equal(sanitizeTopic('Análise do painel de KPIs (v2)'), 'Análise do painel de KPIs (v2)');
  assert.equal(sanitizeTopic('C++ build: fix MSVC warnings'), 'C++ build: fix MSVC warnings');
});

test('formatTitle joins and caps at 80 chars trimming topic first, then project', () => {
  assert.equal(formatTitle('arcva-2.0', 'Migração de faturas', { separator: ' - ' }), 'arcva-2.0 - Migração de faturas');
  const topic = 'uma frase bastante comprida que vai ter de ser cortada algures numa fronteira de palavra';
  const t = formatTitle('projeto', topic, { separator: ' - ' });
  assert.ok(t.length <= 80, t);
  assert.ok(t.startsWith('projeto - uma frase'));
  assert.ok(!t.endsWith(' '));
  const t2 = formatTitle('x'.repeat(90), 'topic here', { separator: ' - ' });
  assert.ok(t2.length <= 80);
  assert.ok(t2.endsWith(' - topic here'));
  assert.equal(formatTitle('proj', null, { separator: ' - ' }), 'proj');
  assert.equal(formatTitle('proj', '', { separator: ' - ' }), 'proj');
});

test('isEligiblePrompt applies the spec rules', () => {
  assert.equal(isEligiblePrompt('Migra as faturas para a V10 e valida os testes'), true);
  assert.equal(isEligiblePrompt('short'), false);
  assert.equal(isEligiblePrompt('/resume something long enough'), false);
  assert.equal(isEligiblePrompt('!git status --porcelain please'), false);
  assert.equal(isEligiblePrompt('# remember this fact for later'), false);
  assert.equal(isEligiblePrompt('@src/app.ts @src/index.ts'), false);
  assert.equal(isEligiblePrompt('[Pasted text #1 +120 lines]'), false);
  assert.equal(isEligiblePrompt('@src/app.ts refactor this file into smaller modules'), true);
  for (const w of ACK_WORDS) assert.equal(isEligiblePrompt(`${w}   `), false, w);
  assert.equal(isEligiblePrompt('Continua por favor, obrigado!'), false);
  assert.equal(isEligiblePrompt(null), false);
});

test('truncatePrompt keeps head and tail of huge prompts', () => {
  const big = 'a'.repeat(5000) + 'TAIL';
  const t = truncatePrompt(big, 1500, 300);
  assert.ok(t.length <= 1500 + 300 + 20);
  assert.ok(t.startsWith('a'.repeat(1500)));
  assert.ok(t.endsWith('TAIL'));
  assert.ok(t.includes('…'));
  assert.equal(truncatePrompt('small', 1500, 300), 'small');
});

test('resolveProject uses git common dir parent for repos and worktrees', () => {
  const git = (args) => (args[0] === 'rev-parse' ? 'D:/repos/arcva-2.0/.git' : null);
  assert.equal(resolveProject({ cwd: 'D:/repos/arcva-2.0/src', projectSource: 'git', git }), 'arcva-2.0');
  const gitRel = () => '.git';
  assert.equal(resolveProject({ cwd: 'D:/repos/arcva-2.0', projectSource: 'git', git: gitRel }), 'arcva-2.0');
  const gitWt = () => 'D:/repos/arcva-2.0/.git/worktrees/feature-x';
  assert.equal(resolveProject({ cwd: 'D:/repos/arcva-2.0-wt/feature-x', projectSource: 'git', git: gitWt }), 'arcva-2.0');
  const gitWin = () => 'C:\\Users\\bruno\\proj\\.git';
  assert.equal(resolveProject({ cwd: 'C:\\Users\\bruno\\proj\\sub', projectSource: 'git', git: gitWin }), 'proj');
});

test('resolveProject falls back to cwd basename and honours override', () => {
  const noGit = () => null;
  assert.equal(resolveProject({ cwd: 'D:/Implementacoes/Git Hub Repo Manager', projectSource: 'git', git: noGit }), 'Git Hub Repo Manager');
  assert.equal(resolveProject({ cwd: '/home/bruno', projectSource: 'git', git: noGit }), 'bruno');
  assert.equal(resolveProject({ cwd: 'C:\\', projectSource: 'git', git: noGit }), 'C');
  assert.equal(resolveProject({ cwd: '/', projectSource: 'git', git: noGit }), 'root');
  assert.equal(resolveProject({ cwd: 'D:/x/y', projectSource: 'cwd', git: () => { throw new Error('must not call'); } }), 'y');
  assert.equal(resolveProject({ cwd: 'D:/x/y', projectSource: 'git', git: noGit, override: 'ARCVA' }), 'ARCVA');
  const throwing = () => { throw new Error('git missing'); };
  assert.equal(resolveProject({ cwd: 'D:/x/ünïcode ✓', projectSource: 'git', git: throwing }), 'ünïcode ✓');
});
