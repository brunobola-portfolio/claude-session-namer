#!/usr/bin/env node
'use strict';
/**
 * Install or remove the session-namer extension for GitHub Copilot CLI.
 *
 *   node adapters/copilot/install.js              user-level (~/.copilot/extensions/session-namer)
 *   node adapters/copilot/install.js --uninstall
 *
 * Writes one small entry file that imports the Copilot SDK (which Copilot
 * only resolves inside its extension folders) and starts the adapter from
 * this repository. COPILOT_HOME is honoured like Copilot itself does.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const NAME = 'session-namer';
const MARKER = '// session-namer copilot shim';

function extensionDir(env = process.env) {
  const home = env.COPILOT_HOME && env.COPILOT_HOME.trim() ? env.COPILOT_HOME.trim() : path.join(os.homedir(), '.copilot');
  return path.join(home, 'extensions', NAME);
}

function shimSource(adapterFile = path.join(__dirname, 'extension.mjs')) {
  const url = pathToFileURL(adapterFile).href;
  return [
    MARKER,
    "import { joinSession } from '@github/copilot-sdk/extension';",
    `import { start } from ${JSON.stringify(url)};`,
    'await start(joinSession);',
    '',
  ].join('\n');
}

function install(dir = extensionDir()) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'extension.mjs');
  fs.writeFileSync(file, shimSource(), 'utf8');
  return file;
}

function uninstall(dir = extensionDir()) {
  const file = path.join(dir, 'extension.mjs');
  let content = '';
  try { content = fs.readFileSync(file, 'utf8'); } catch { return false; }
  if (!content.startsWith(MARKER)) throw new Error(`${file} was not written by session-namer; not removing it`);
  fs.rmSync(dir, { recursive: true, force: true });
  return true;
}

if (require.main === module) {
  try {
    if (process.argv.includes('--uninstall')) {
      console.log(uninstall() ? `Removed ${extensionDir()}` : 'Nothing to remove.');
    } else {
      console.log(`Installed ${install()}\nStart Copilot CLI with experimental features on (/experimental on, or --experimental).`);
    }
  } catch (err) {
    console.error(String(err && err.message));
    process.exitCode = 1;
  }
}

module.exports = { extensionDir, shimSource, install, uninstall, MARKER };
