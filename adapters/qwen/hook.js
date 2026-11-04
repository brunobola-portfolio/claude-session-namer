#!/usr/bin/env node
'use strict';
/**
 * Qwen Code adapter (terminal-tab fallback).
 *
 *   node hook.js            Qwen Code command hook: SessionStart, UserPromptSubmit, Stop (JSON on stdin)
 *   node hook.js --worker   internal: console-attached topic generation
 *
 * Qwen hooks return additionalContext / decisions only; there is no title
 * field, and `/rename` is a user command. So this sets the terminal tab
 * title. Requires `"ui": {"hideWindowTitle": true}` in Qwen settings,
 * otherwise Qwen rewrites the tab title with its own session name and status.
 */
const os = require('node:os');
const path = require('node:path');
// Shared tab-title hook plus the positional-prompt headless check
// (lives beside the Gemini adapter; Qwen has no CI rule, so ci stays off).
const { main } = require('../gemini/headless-argv');

/** $QWEN_HOME is the .qwen directory itself (default ~/.qwen). */
function qwenHome(env = process.env) {
  if (env.QWEN_HOME && env.QWEN_HOME.trim()) return env.QWEN_HOME.trim();
  return path.join(env.HOME || env.USERPROFILE || os.homedir(), '.qwen');
}

const spec = (env = process.env) => ({
  name: 'qwen',
  homeDir: qwenHome(env),
  startEvents: ['SessionStart'],
  promptEvents: ['UserPromptSubmit'],
  reassertEvents: ['Stop'],
  consoleless: true, // Windows: Qwen spawns hooks with windowsHide (no console of their own)
  script: __filename,
});

if (require.main === module) main(spec(), { ci: false });

module.exports = { spec, qwenHome };
