'use strict';
/**
 * Topic generation through the user's own Claude Code CLI.
 *
 *   claude -p --no-session-persistence --max-turns 1 --model <m> \
 *          --setting-sources "" --strict-mcp-config --mcp-config '{"mcpServers":{}}' \
 *          --tools "" --disable-slash-commands --output-format json \
 *          --system-prompt <fixed>            (prompt piped through stdin)
 *
 * No settings sources means no user hooks or plugins load in the child, so
 * this call cannot re-enter the plugin (SESSION_NAMER_NESTED=1 is set as a
 * second guard). `--no-session-persistence` keeps it out of the session list.
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

/**
 * Arguments for the headless call.
 *
 * Default is "lean" mode: no settings sources (so no user hooks or plugins),
 * no MCP servers, no tools, no skills, one turn. It works with both OAuth
 * logins and API keys. `--bare` is faster but skips keychain reads, so it
 * only works with an API key; opt in with SESSION_NAMER_BARE=1.
 */
function buildArgs({ model, bare = false }) {
  const mode = bare
    ? ['--bare']
    : ['--setting-sources', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--tools', '', '--disable-slash-commands'];
  return [
    '-p', ...mode, '--no-session-persistence', '--max-turns', '1',
    '--model', model,
    '--output-format', 'json',
    '--system-prompt', SYSTEM_PROMPT,
  ];
}

/** The user prompt travels through stdin: no argv quoting limits, any size. */
const promptForStdin = (prompt) => truncatePrompt(prompt, PROMPT_HEAD, PROMPT_TAIL);

/**
 * On Windows, npm installs `claude.cmd`, a shim around
 * `node_modules/@anthropic-ai/claude-code/bin/claude.exe`. cmd.exe re-parses
 * arguments and drops empty ones, so prefer the real executable when it
 * sits next to the shim; only fall back to cmd.exe when it does not.
 */
const wrapForPlatform = (file, platform, exists) => {
  if (platform !== 'win32' || !/\.(cmd|bat)$/i.test(file)) return { command: file, args: [] };
  const dir = path.win32.dirname(file);
  const exe = path.win32.join(dir, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
  if (exists(exe)) return { command: exe, args: [] };
  return { command: 'cmd.exe', args: ['/d', '/s', '/c', file] };
};

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
  if (explicit) return wrapForPlatform(explicit, platform, exists);

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
      if (exists(candidate)) return wrapForPlatform(candidate, platform, exists);
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
  claudePath = findClaude(env), platform = process.platform, log = () => {},
}) {
  if (env.SESSION_NAMER_FAKE_RESULT !== undefined) return Promise.resolve(env.SESSION_NAMER_FAKE_RESULT);
  return new Promise((resolve) => {
    let settled = false;
    const started = Date.now();
    const done = (value, reason) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (reason) log(`${reason} after ${Date.now() - started} ms`);
      resolve(value);
    };
    let child;
    let timer;
    try {
      const bare = ['1', 'true', 'on'].includes(String(env.SESSION_NAMER_BARE || '').toLowerCase());
      child = spawn(claudePath.command, [...claudePath.args, ...buildArgs({ model, bare })], {
        env: { ...env, SESSION_NAMER_NESTED: '1' },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (err) {
      return done(null, `spawn threw: ${err && err.message}`);
    }
    try {
      child.stdin.on('error', () => {});
      child.stdin.end(promptForStdin(prompt), 'utf8');
    } catch { /* child already gone */ }
    const out = [];
    const errOut = [];
    child.stdout.on('data', (d) => out.push(d));
    child.stderr.on('data', (d) => errOut.push(d));
    child.on('error', (err) => done(null, `spawn error: ${err && err.message}`));
    child.on('close', (code) => {
      const stdout = Buffer.concat(out.map((b) => Buffer.from(b))).toString('utf8');
      if (code !== 0) {
        const stderr = Buffer.concat(errOut.map((b) => Buffer.from(b))).toString('utf8').trim().slice(0, 200);
        return done(null, `exit ${code}: ${stderr || stdout.slice(0, 200) || 'no output'}`);
      }
      const parsed = parseOutput(stdout);
      return done(parsed, parsed === null ? `unusable output: ${stdout.trim().slice(0, 200)}` : `ok`);
    });
    timer = setTimeout(() => { killTree(child, platform); done(null, `timeout ${timeoutMs} ms`); }, timeoutMs);
    return undefined;
  });
}

module.exports = { generateTopic, findClaude, buildArgs, parseOutput, promptForStdin, SYSTEM_PROMPT };
