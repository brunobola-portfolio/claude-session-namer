'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

// Claude Code HTML-escapes plugin and command descriptions in its menus, so
// "<project>" shows up as "&lt;project&gt;". Keep every description that an
// agent UI displays free of <, > and &.
const UNSAFE = /[<>&]/;

test('slash command description has no characters a menu would escape', () => {
  const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(read('commands/session-name.md'))[1];
  for (const line of front.split(/\r?\n/).filter((l) => /^(description|argument-hint):/.test(l))) {
    assert.doesNotMatch(line, UNSAFE, line);
  }
});

test('manifest descriptions have no characters a menu would escape', () => {
  const files = ['package.json', '.claude-plugin/plugin.json', '.claude-plugin/marketplace.json', 'hooks/hooks.json',
    'adapters/pi/package.json', 'adapters/goose/plugin.json'];
  for (const rel of files) {
    const visit = (node, where) => {
      if (Array.isArray(node)) node.forEach((v, i) => visit(v, `${where}[${i}]`));
      else if (node && typeof node === 'object') {
        for (const [k, v] of Object.entries(node)) {
          if (k === 'description' && typeof v === 'string') assert.doesNotMatch(v, UNSAFE, `${where}.${k}: ${v}`);
          else visit(v, `${where}.${k}`);
        }
      }
    };
    visit(JSON.parse(read(rel)), rel);
  }
});

test('Copilot slash command description has no characters a menu would escape', () => {
  const m = /description:\s*'([^']*)'/.exec(read('adapters/copilot/extension.mjs'));
  assert.ok(m);
  assert.doesNotMatch(m[1], UNSAFE);
});
