'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadConfig, DEFAULTS } = require('../lib/config');

const tmpRepo = (files = {}) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'namer-cfg-'));
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), content);
  return dir;
};

test('defaults when nothing is configured', () => {
  const cfg = loadConfig({ env: {}, repoRoot: null });
  assert.deepEqual(cfg, {
    enabled: true,
    model: 'haiku',
    separator: ' - ',
    maxWords: 7,
    timeoutMs: 8000,
    projectSource: 'git',
    nameHeadless: false,
    projectOverride: null,
  });
  assert.deepEqual(DEFAULTS, cfg);
});

test('plugin options are coerced from strings', () => {
  const cfg = loadConfig({
    env: {
      CLAUDE_PLUGIN_OPTION_MODEL: 'sonnet',
      CLAUDE_PLUGIN_OPTION_MAX_WORDS: '5',
      CLAUDE_PLUGIN_OPTION_TIMEOUT_MS: '3000',
      CLAUDE_PLUGIN_OPTION_NAME_HEADLESS: 'true',
      CLAUDE_PLUGIN_OPTION_ENABLED: 'false',
      CLAUDE_PLUGIN_OPTION_SEPARATOR: ' | ',
      CLAUDE_PLUGIN_OPTION_PROJECT_SOURCE: 'cwd',
    },
    repoRoot: null,
  });
  assert.equal(cfg.model, 'sonnet');
  assert.equal(cfg.maxWords, 5);
  assert.equal(cfg.timeoutMs, 3000);
  assert.equal(cfg.nameHeadless, true);
  assert.equal(cfg.enabled, false);
  assert.equal(cfg.separator, ' | ');
  assert.equal(cfg.projectSource, 'cwd');
});

test('environment overrides beat plugin options', () => {
  const cfg = loadConfig({
    env: {
      CLAUDE_PLUGIN_OPTION_MODEL: 'sonnet',
      SESSION_NAMER_MODEL: 'opus',
      CLAUDE_PLUGIN_OPTION_TIMEOUT_MS: '3000',
      SESSION_NAMER_TIMEOUT_MS: '5000',
    },
    repoRoot: null,
  });
  assert.equal(cfg.model, 'opus');
  assert.equal(cfg.timeoutMs, 5000);
});

test('CLAUDE_SESSION_NAMER=off disables even when the option says enabled', () => {
  const cfg = loadConfig({ env: { CLAUDE_SESSION_NAMER: 'off', CLAUDE_PLUGIN_OPTION_ENABLED: 'true' }, repoRoot: null });
  assert.equal(cfg.enabled, false);
});

test('repo file can set project override and disable, other keys ignored', () => {
  const repoRoot = tmpRepo({ '.session-namer.json': JSON.stringify({ project: 'ARCVA', enabled: false, model: 'ignored' }) });
  const cfg = loadConfig({ env: {}, repoRoot });
  assert.equal(cfg.projectOverride, 'ARCVA');
  assert.equal(cfg.enabled, false);
  assert.equal(cfg.model, 'haiku');
});

test('repo file with invalid JSON or unknown shapes is ignored', () => {
  const repoRoot = tmpRepo({ '.session-namer.json': '{not json' });
  assert.deepEqual(loadConfig({ env: {}, repoRoot }), DEFAULTS);
  const repoRoot2 = tmpRepo({ '.session-namer.json': JSON.stringify({ project: 42, enabled: 'yes' }) });
  assert.deepEqual(loadConfig({ env: {}, repoRoot: repoRoot2 }), DEFAULTS);
});

test('numeric options are clamped and invalid values fall back to defaults', () => {
  const low = loadConfig({ env: { SESSION_NAMER_MAX_WORDS: '1', SESSION_NAMER_TIMEOUT_MS: '10' }, repoRoot: null });
  assert.equal(low.maxWords, 3);
  assert.equal(low.timeoutMs, 1000);
  const high = loadConfig({ env: { SESSION_NAMER_MAX_WORDS: '99', SESSION_NAMER_TIMEOUT_MS: '99999' }, repoRoot: null });
  assert.equal(high.maxWords, 12);
  assert.equal(high.timeoutMs, 20000);
  const bad = loadConfig({ env: { SESSION_NAMER_MAX_WORDS: 'abc', SESSION_NAMER_TIMEOUT_MS: '', CLAUDE_PLUGIN_OPTION_PROJECT_SOURCE: 'nope' }, repoRoot: null });
  assert.equal(bad.maxWords, 7);
  assert.equal(bad.timeoutMs, 8000);
  assert.equal(bad.projectSource, 'git');
});

test('separator is kept verbatim but an empty one falls back to default', () => {
  assert.equal(loadConfig({ env: { CLAUDE_PLUGIN_OPTION_SEPARATOR: '' }, repoRoot: null }).separator, ' - ');
  assert.equal(loadConfig({ env: { CLAUDE_PLUGIN_OPTION_SEPARATOR: ' · ' }, repoRoot: null }).separator, ' · ');
});
