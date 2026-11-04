#!/usr/bin/env node
'use strict';
/**
 * Gemini CLI adapter (terminal-tab fallback).
 *
 *   node hook.js            Gemini command hook: SessionStart, BeforeAgent, AfterAgent (JSON on stdin)
 *   node hook.js --worker   internal: console-attached topic generation
 *
 * Gemini hooks can only return additionalContext / decisions; there is no
 * title field and no rename command, so this sets the terminal tab title.
 * Requires `"ui": {"hideWindowTitle": true}` in Gemini settings, otherwise
 * Gemini rewrites the tab title ("◇  Ready (folder)") on every state change.
 */
const os = require('node:os');
const path = require('node:path');
// Shared tab-title hook plus positional-prompt and CI headless checks.
const { main } = require('./headless-argv');

function geminiHome(env = process.env) {
  const base = (env.GEMINI_CLI_HOME && env.GEMINI_CLI_HOME.trim()) || env.HOME || env.USERPROFILE || os.homedir();
  return path.join(base, '.gemini');
}

const spec = (env = process.env) => ({
  name: 'gemini',
  homeDir: geminiHome(env),
  startEvents: ['SessionStart'],
  promptEvents: ['BeforeAgent'],
  reassertEvents: ['AfterAgent'],
  script: __filename,
});

// ci: Gemini itself runs headless when CI=true or GITHUB_ACTIONS=true.
if (require.main === module) main(spec(), { ci: true });

module.exports = { spec, geminiHome };
