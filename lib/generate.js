'use strict';
/**
 * Topic generation through the user's own Claude Code CLI.
 *
 *   claude -p --bare --no-session-persistence --model <m> --output-format json \
 *          --system-prompt <fixed> "<prompt>"
 *
 * `--bare` skips hooks, plugins and LSP so this call can never re-enter the
 * plugin. `--no-session-persistence` keeps it out of the session list.
 * Any failure resolves to null; the caller keeps the project-only title.
 */
const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { truncatePrompt } = require('./title');

const SYSTEM_PROMPT = [
  'You write short session titles for a coding assistant.',
  'Reply with ONLY the title: 3 to 7 words that describe the task in the user message.',
  'Write it in the same language as the user message. Sentence case. No quotes, no emoji,',
  'no trailing period, no prefix such as "Title:". Never answer the request itself.',
  'Examples:',
  'User: Migra as faturas para a V10 e valida os testes -> Migração de faturas para V10',
  'User: Fix the login redirect loop on Safari -> Fix Safari login redirect loop',
  'User: Añade paginación al listado de clientes -> Paginación en listado de clientes',
].join('\n');

const PROMPT_HEAD = 1500;
const PROMPT_TAIL = 300;

function buildArgs({ prompt, model }) {
  return [
    '-p', '--bare', '--no-session-persistence',
    '--model', model,
    '--output-format', 'json',
    '--system-prompt', SYSTEM_PROMPT,
    truncatePrompt(prompt, PROMPT_HEAD, PROMPT_TAIL),
  ];
}

const wrapForPlatform = (file, platform) => (platform === 'win32' && /\.(cmd|bat)$/i.test(file)
  ? { command: 'cmd.exe', args: ['/d', '/s', '/c', file] }
  : { command: file, args: [] });

/**
 * Locate the `claude` executable. Order: SESSION_NAMER_CLAUDE_PATH, PATH,
 * well-known install locations, then a bare "claude" and hope for the best.
 */
function findClaude(env = process.env, {
  platform = process.platform,
  pathSep = path.delimiter,
  exists = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } },
} = {}) {
  const explicit = env.SESSION_NAMER_CLAUDE_PATH && env.SESSION_NAMER_CLAUDE_PATH.trim();
  if (explicit) return wrapForPlatform(explicit, platform);

  const names = platform === 'win32' ? ['claude.exe', 'claude.cmd', 'claude'] : ['claude'];
  const home = env.HOME || env.USERPROFILE || '';
  const dirs = String(env.PATH || env.Path || '').split(pathSep).filter(Boolean);
  const wellKnown = platform === 'win32'
    ? [env.APPDATA ? path.win32.join(env.APPDATA, 'npm') : null, home ? path.win32.join(home, '.local', 'bin') : null]
    : [home ? path.posix.join(home, '.local', 'bin') : null, home ? path.posix.join(home, '.claude', 'local') : null, '/usr/local/bin', '/opt/homebrew/bin'];
  const joiner = platform === 'win32' ? path.win32 : path.posix;
  for (const dir of [...dirs, ...wellKnown.filter(Boolean)]) {
    for (const name of names) {
      const candidate = joiner.join(dir, name);
      if (exists(candidate)) return wrapForPlatform(candidate, platform);
    }
  }
  return { command: 'claude', args: [] };
}

function killTree(child, platform) {
  try {
    if (platform === 'win32' && child.pid) {
      childProcess.spawn('taskkill', ['/T', '/F', '/PID', String(child.pid)], { stdio: 'ignore', windowsHide: true }).on('error', () => {});
    }
    child.kill('SIGTERM');
    setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, 1000).unref();
  } catch { /* already gone */ }
}

function parseOutput(stdout) {
  const text = String(stdout || '').trim();
  if (!text) return null;
  try {
    const data = JSON.parse(text);
    if (data && typeof data === 'object') {
      if (data.is_error) return null;
      if (typeof data.result === 'string') return data.result;
      return null;
    }
  } catch { /* not JSON: raw text answer */ }
  return text;
}

/**
 * @param {{prompt:string, model:string, timeoutMs:number, env?:object, spawn?:Function,
 *          claudePath?:{command:string,args:string[]}, platform?:string}} opts
 * @returns {Promise<string|null>} raw model answer (not yet sanitised) or null
 */
function generateTopic({
  prompt, model, timeoutMs, env = process.env, spawn = childProcess.spawn,
  claudePath = findClaude(env), platform = process.platform,
}) {
  if (env.SESSION_NAMER_FAKE_RESULT !== undefined) return Promise.resolve(env.SESSION_NAMER_FAKE_RESULT);
  return new Promise((resolve) => {
    let settled = false;
    const done = (value) => { if (!settled) { settled = true; clearTimeout(timer); resolve(value); } };
    let child;
    let timer;
    try {
      child = spawn(claudePath.command, [...claudePath.args, ...buildArgs({ prompt, model })], {
        env: { ...env, SESSION_NAMER_NESTED: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch {
      return done(null);
    }
    const out = [];
    child.stdout.on('data', (d) => out.push(d));
    child.stderr.on('data', () => {});
    child.on('error', () => done(null));
    child.on('close', (code) => done(code === 0 ? parseOutput(Buffer.concat(out.map((b) => Buffer.from(b)))) : null));
    timer = setTimeout(() => { killTree(child, platform); done(null); }, timeoutMs);
    return undefined;
  });
}

module.exports = { generateTopic, findClaude, buildArgs, parseOutput, SYSTEM_PROMPT };
