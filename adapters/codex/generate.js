'use strict';
/**
 * Opt-in topic generation through the user's own Codex login (`codex exec`),
 * for Codex users without Claude Code (SESSION_NAMER_CODEX_GENERATOR=codex).
 * Not the default: see DISABLED_FEATURES for why a tool-capable agent is a
 * riskier title generator than `claude -p`, which runs with no tools.
 *
 *   codex exec --ephemeral --skip-git-repo-check --ignore-user-config --ignore-rules \
 *              --disable hooks --disable shell_tool ... -c web_search="disabled" \
 *              -s read-only --color never --json \
 *              -c model_reasoning_effort="low" [-m <model>] -     (prompt on stdin)
 *
 * Recursion guards: `--disable hooks` (no hooks at all in the child),
 * `--ephemeral` (no thread is persisted, so nothing shows up in `codex resume`),
 * `--ignore-user-config` (no user MCP servers/plugins, faster start) and
 * SESSION_NAMER_NESTED=1 in the child environment.
 * Any failure resolves to null.
 */
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { SYSTEM_PROMPT, promptForStdin } = require('../../lib/generate');

const isFile = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };

/**
 * Locate Codex. Returns {command,args}. On Windows npm installs `codex.cmd`,
 * a shim around `node .../@openai/codex/bin/codex.js`; spawning the script
 * with the current Node avoids cmd.exe argument re-parsing.
 * Order: SESSION_NAMER_CODEX_PATH, CODEX_MANAGED_PACKAGE_ROOT (exported by
 * Codex to hooks), `codex(.cmd)` on PATH, then a bare "codex".
 */
function findCodex(env = process.env, {
  platform = process.platform, pathSep = path.delimiter, exists = isFile, nodePath = process.execPath,
} = {}) {
  const joiner = platform === 'win32' ? path.win32 : path.posix;
  const viaScript = (script) => ({ command: nodePath, args: [script] });
  const explicit = env.SESSION_NAMER_CODEX_PATH && env.SESSION_NAMER_CODEX_PATH.trim();
  if (explicit) {
    if (/\.(c|m)?js$/i.test(explicit)) return viaScript(explicit);
    if (platform === 'win32' && /\.(cmd|bat)$/i.test(explicit)) {
      const script = joiner.join(joiner.dirname(explicit), 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
      if (exists(script)) return viaScript(script);
      return { command: 'cmd.exe', args: ['/d', '/s', '/c', explicit] };
    }
    return { command: explicit, args: [] };
  }
  const root = env.CODEX_MANAGED_PACKAGE_ROOT && env.CODEX_MANAGED_PACKAGE_ROOT.trim();
  if (root) {
    const script = joiner.join(root, 'bin', 'codex.js');
    if (exists(script)) return viaScript(script);
  }
  const dirs = String(env.PATH || env.Path || '').split(pathSep).filter(Boolean);
  for (const dir of dirs) {
    if (platform === 'win32') {
      if (exists(joiner.join(dir, 'codex.exe'))) return { command: joiner.join(dir, 'codex.exe'), args: [] };
      const shim = joiner.join(dir, 'codex.cmd');
      if (exists(shim)) {
        const script = joiner.join(dir, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
        if (exists(script)) return viaScript(script);
        return { command: 'cmd.exe', args: ['/d', '/s', '/c', shim] };
      }
    } else if (exists(joiner.join(dir, 'codex'))) {
      return { command: joiner.join(dir, 'codex'), args: [] };
    }
  }
  return { command: 'codex', args: [] };
}

function killTree(child, platform = process.platform) {
  try {
    if (platform === 'win32' && child.pid) {
      childProcess.spawn('taskkill', ['/T', '/F', '/PID', String(child.pid)], { stdio: 'ignore', windowsHide: true }).on('error', () => {});
    }
    child.kill('SIGTERM');
  } catch { /* already gone */ }
}

/**
 * Tools switched off for the title call. `-s read-only` still lets the
 * model's shell READ files (for example ~/.codex/auth.json), and a prompt
 * injection in the user's message could steer that into the title. Codex
 * 0.163 has no single "no tools" switch for exec; these feature flags remove
 * the shell, the code-mode runtime and the other tools that can read data.
 * An unknown flag makes Codex exit with an error, so a future rename fails
 * closed (no title) rather than open.
 */
const DISABLED_FEATURES = Object.freeze([
  'hooks', 'shell_tool', 'unified_exec', 'code_mode_host', 'view_image', 'browser_use', 'computer_use', 'apps',
]);

function buildExecArgs({ model = null, effort = 'low' } = {}) {
  return [
    'exec', '--ephemeral', '--skip-git-repo-check', '--ignore-user-config', '--ignore-rules',
    ...DISABLED_FEATURES.flatMap((f) => ['--disable', f]),
    '-c', 'web_search="disabled"',
    '-s', 'read-only', '--color', 'never', '--json',
    '-c', `model_reasoning_effort="${effort}"`,
    ...(model ? ['-m', model] : []),
    '-',
  ];
}

const stdinFor = (prompt) => `${SYSTEM_PROMPT}\n\nUser message:\n${promptForStdin(prompt)}\n`;

/** Last `agent_message` text from `codex exec --json` JSONL output, or null. */
function parseExecJson(stdout) {
  let text = null;
  for (const line of String(stdout || '').split(/\r?\n/)) {
    const s = line.trim();
    if (!s.startsWith('{')) continue;
    try {
      const ev = JSON.parse(s);
      if (ev && ev.type === 'item.completed' && ev.item && ev.item.type === 'agent_message' && typeof ev.item.text === 'string') {
        text = ev.item.text;
      }
    } catch { /* not an event */ }
  }
  return text;
}

/**
 * @returns {Promise<string|null>} raw model answer (not yet sanitised) or null
 */
function generateTopicCodex({
  prompt, model = null, timeoutMs = 20000, env = process.env, spawn = childProcess.spawn,
  codex = findCodex(env), platform = process.platform, log = () => {}, cwd = os.tmpdir(),
}) {
  if (env.SESSION_NAMER_FAKE_RESULT !== undefined) return Promise.resolve(env.SESSION_NAMER_FAKE_RESULT);
  return new Promise((resolve) => {
    let settled = false;
    const started = Date.now();
    let timer;
    const done = (value, reason) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (reason) log(`${reason} after ${Date.now() - started} ms`);
      resolve(value);
    };
    let child;
    try {
      child = spawn(codex.command, [...codex.args, ...buildExecArgs({ model })], {
        cwd, env: { ...env, SESSION_NAMER_NESTED: '1' }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
      });
    } catch (err) {
      done(null, `spawn threw: ${err && err.message}`);
      return;
    }
    try {
      child.stdin.on('error', () => {});
      child.stdin.end(stdinFor(prompt), 'utf8');
    } catch { /* gone */ }
    const out = [];
    const errOut = [];
    child.stdout.on('data', (d) => out.push(Buffer.from(d)));
    child.stderr.on('data', (d) => errOut.push(Buffer.from(d)));
    child.on('error', (err) => done(null, `spawn error: ${err && err.message}`));
    child.on('close', (code) => {
      const stdout = Buffer.concat(out).toString('utf8');
      const text = parseExecJson(stdout);
      if (code !== 0 && !text) {
        const stderr = Buffer.concat(errOut).toString('utf8').trim().slice(-200);
        done(null, `codex exec exit ${code}: ${stderr || 'no output'}`);
        return;
      }
      done(text, text === null ? 'codex exec: no agent_message' : 'codex exec ok');
    });
    timer = setTimeout(() => { killTree(child, platform); done(null, `codex exec timeout ${timeoutMs} ms`); }, timeoutMs);
  });
}

module.exports = { generateTopicCodex, findCodex, buildExecArgs, parseExecJson, stdinFor, killTree, DISABLED_FEATURES };
