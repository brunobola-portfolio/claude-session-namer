'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const readJson = (p) => JSON.parse(fs.readFileSync(path.join(root, p), 'utf8'));

const USER_CONFIG_KEYS = [
  'model', 'separator', 'max_words', 'timeout_ms', 'project_source', 'name_headless', 'enabled',
];

test('plugin.json is valid and declares the documented userConfig keys', () => {
  const plugin = readJson('.claude-plugin/plugin.json');
  assert.equal(plugin.name, 'session-namer');
  assert.match(plugin.version, /^\d+\.\d+\.\d+$/);
  // hooks/hooks.json and commands/ are auto-discovered; declaring them again
  // makes Claude Code fail with "Duplicate hooks file detected".
  assert.equal(plugin.hooks, undefined);
  assert.equal(plugin.commands, undefined);
  assert.deepEqual(Object.keys(plugin.userConfig).sort(), [...USER_CONFIG_KEYS].sort());
  for (const [key, opt] of Object.entries(plugin.userConfig)) {
    assert.ok(opt.type && opt.title && opt.description, `userConfig.${key} needs type/title/description`);
    assert.ok('default' in opt, `userConfig.${key} needs a default`);
  }
});

test('marketplace.json points at this plugin with the same version', () => {
  const plugin = readJson('.claude-plugin/plugin.json');
  const market = readJson('.claude-plugin/marketplace.json');
  assert.equal(market.name, 'claude-session-namer');
  assert.equal(market.plugins.length, 1);
  assert.equal(market.plugins[0].name, plugin.name);
  assert.equal(market.plugins[0].version, plugin.version);
  assert.equal(readJson('package.json').version, plugin.version);
});

test('hooks.json registers the three events in exec form pointing at hooks/namer.js', () => {
  const hooks = readJson('hooks/hooks.json').hooks;
  for (const event of ['SessionStart', 'UserPromptSubmit', 'Stop']) {
    assert.ok(hooks[event], `${event} missing`);
    const handler = hooks[event][0].hooks[0];
    assert.equal(handler.type, 'command');
    assert.equal(handler.command, 'node');
    assert.deepEqual(handler.args, ['${CLAUDE_PLUGIN_ROOT}/hooks/namer.js', event]);
    assert.ok(handler.timeout <= 28, `${event} timeout must stay under the platform default (30 s)`);
  }
  assert.equal(hooks.SessionStart[0].matcher, 'startup|resume|fork');
});
