'use strict';
/**
 * The harness table: where each harness keeps its config and what install
 * writes there. Every entry mirrors the manual steps in adapters/<id>/README.md.
 */
const fs = require('node:fs');
const path = require('node:path');
const jsonc = require('./jsonc');
const S = require('./strategies');

const readme = (id) => `adapters/${id}/README.md`;
const nodeCmd = (file, ...args) => [`node "${S.fwd(file)}"`, ...args].join(' ');

function firstExisting(dir, names) {
  for (const n of names) {
    const p = path.join(dir, n);
    if (fs.existsSync(p)) return p;
  }
  return path.join(dir, names[0]);
}

// ------------------------------------------------------------------ claude

const CLAUDE_PLUGIN = 'session-namer@claude-session-namer';
const CLAUDE_MARKET = 'claude-session-namer';
const CLAUDE_REPO = 'brunobola-portfolio/claude-session-namer';

/** The most telling line of a failed command: the last `fatal:`/`error:` line, else the first line. */
function errLine(r) {
  const lines = String(r.stderr || r.stdout || r.error || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const telling = lines.filter((l) => /^(fatal|error)\b/i.test(l));
  return (telling.length ? telling[telling.length - 1] : lines[0]) || 'no output';
}

function claudeList(ctx, bin) {
  const r = ctx.run(bin, ['plugin', 'list', '--json'], { timeout: 60000 });
  if (r.status !== 0) return { error: (r.stderr || r.error || 'claude plugin list failed').trim().split('\n')[0] };
  try {
    const list = JSON.parse(r.stdout);
    return { plugin: (Array.isArray(list) ? list : []).find((p) => p && p.id === CLAUDE_PLUGIN) || null };
  } catch {
    return { error: 'could not read `claude plugin list --json`' };
  }
}

const claudeStrategy = {
  install(ctx, record) {
    const bin = ctx.which('claude');
    if (!bin) return S.fail('claude CLI not found on PATH (install Claude Code first)');
    const cur = claudeList(ctx, bin);
    if (cur.error) return S.fail(cur.error);
    if (cur.plugin) {
      const notes = cur.plugin.enabled === false ? [`it is disabled: claude plugin enable ${CLAUDE_PLUGIN}`] : [];
      return S.same(`already installed (${CLAUDE_PLUGIN} ${cur.plugin.version || ''}`.trim() + ')', { notes });
    }
    if (ctx.dryRun) return S.ok(`would run: claude plugin marketplace add ${CLAUDE_REPO} && claude plugin install ${CLAUDE_PLUGIN}`);
    const ml = ctx.run(bin, ['plugin', 'marketplace', 'list', '--json'], { timeout: 60000 });
    let hasMarket = false;
    try { hasMarket = JSON.parse(ml.stdout).some((m) => m && m.name === CLAUDE_MARKET); } catch { /* treat as absent */ }
    if (!hasMarket) {
      const add = ctx.run(bin, ['plugin', 'marketplace', 'add', CLAUDE_REPO], { timeout: 180000 });
      if (add.status !== 0) return S.fail(`claude plugin marketplace add failed: ${errLine(add)} (or run /plugin marketplace add ${CLAUDE_REPO} inside Claude Code)`);
      record.data = { ...(record.data || {}), addedMarketplace: true };
    }
    const inst = ctx.run(bin, ['plugin', 'install', CLAUDE_PLUGIN], { timeout: 180000 });
    if (inst.status !== 0) return S.fail(`claude plugin install failed: ${errLine(inst)} (or run /plugin install ${CLAUDE_PLUGIN} inside Claude Code)`);
    return S.ok(`installed ${CLAUDE_PLUGIN} via the Claude Code plugin system`, { notes: ['restart open Claude Code sessions to load it'] });
  },
  uninstall(ctx, record) {
    const bin = ctx.which('claude');
    if (!bin) return S.fail('claude CLI not found on PATH');
    const cur = claudeList(ctx, bin);
    if (cur.error) return S.fail(cur.error);
    if (!cur.plugin) return S.same('not installed');
    if (ctx.dryRun) return S.ok(`would run: claude plugin uninstall ${CLAUDE_PLUGIN}`);
    const r = ctx.run(bin, ['plugin', 'uninstall', CLAUDE_PLUGIN], { timeout: 120000 });
    if (r.status !== 0) return S.fail(`claude plugin uninstall failed: ${(r.stderr || r.stdout || '').trim().split('\n')[0]}`);
    if (record.data && record.data.addedMarketplace) ctx.run(bin, ['plugin', 'marketplace', 'remove', CLAUDE_MARKET], { timeout: 60000 });
    return S.ok(`uninstalled ${CLAUDE_PLUGIN}`);
  },
  inspect(ctx) {
    const res = { installed: false, versions: new Set(), where: ['Claude Code plugin system'], problems: [] };
    const bin = ctx.which('claude');
    if (!bin) return res;
    const cur = claudeList(ctx, bin);
    if (cur.error) { res.problems.push(cur.error); return res; }
    if (cur.plugin) {
      res.installed = true;
      res.detail = `${CLAUDE_PLUGIN} ${cur.plugin.version || ''}`.trim();
      if (cur.plugin.enabled === false) res.problems.push(`plugin is disabled (claude plugin enable ${CLAUDE_PLUGIN})`);
    }
    return res;
  },
};

// ---------------------------------------------------------------------- pi

function piSettingsFile(ctx) {
  return path.join(ctx.envDir('PI_CODING_AGENT_DIR', path.join(ctx.home, '.pi', 'agent')), 'settings.json');
}

/** Local package paths from pi's settings, resolved (pi stores them relative to its settings folder). */
function piPackages(ctx) {
  const file = piSettingsFile(ctx);
  const text = ctx.readText(file);
  if (!text) return [];
  try {
    const v = jsonc.parseValue(text);
    return (Array.isArray(v.packages) ? v.packages : [])
      .map((p) => (typeof p === 'string' ? p : (p && (p.source || p.path)) || ''))
      .filter((p) => p && !/^(npm|git|https?):/i.test(p))
      .map((p) => path.resolve(path.dirname(file), p));
  } catch {
    return [];
  }
}

function piForeign(ctx, entry) {
  if (S.isOursText(ctx)(entry)) return false;
  for (const f of ['package.json', path.join('adapters', 'pi', 'package.json')]) {
    try {
      const name = JSON.parse(fs.readFileSync(path.resolve(entry, f), 'utf8')).name;
      if (f === 'package.json' && (name === 'session-namer' || name === 'claude-session-namer' || name === 'pi-session-namer')) return true;
    } catch { /* not a local package */ }
  }
  return /session-namer/i.test(entry);
}

const piStrategy = {
  install(ctx, record) {
    const target = path.join(ctx.appDir(), 'adapters', 'pi');
    const pkgs = piPackages(ctx);
    const ours = pkgs.filter(S.isOursText(ctx));
    const warnings = pkgs.filter((p) => piForeign(ctx, p)).map((p) => `pi also loads session-namer from ${ctx.tilde(p)} (not from this installer); remove it to avoid double titles: pi remove "${p}"`);
    if (ours.length === 1 && S.norm(ours[0], ctx.isWin) === S.norm(target, ctx.isWin)) return S.same(`already installed (${ctx.tilde(target)})`, { warnings });
    const bin = ctx.which('pi');
    if (!bin) return S.fail('pi CLI not found on PATH');
    if (ctx.dryRun) return S.ok(`would run: ${ours.map((o) => `pi remove "${o}" && `).join('')}pi install "${target}"`, { warnings });
    ctx.backup(piSettingsFile(ctx), { refresh: !ours.length });
    for (const old of ours) {
      const r = ctx.run(bin, ['remove', old], { timeout: 120000 });
      if (r.status !== 0) return S.fail(`pi remove ${ctx.tilde(old)} failed: ${(r.stderr || r.stdout || r.error || '').trim().split('\n')[0]}`);
    }
    const r = ctx.run(bin, ['install', target], { timeout: 180000 });
    if (r.status !== 0) return S.fail(`pi install failed: ${(r.stderr || r.stdout || r.error || '').trim().split('\n')[0]}`);
    S.recordFile(record, piSettingsFile(ctx));
    return S.ok(`${ours.length ? 'updated' : 'registered'} ${ctx.tilde(target)} with pi install`, { warnings, notes: ['start a new pi session (or /reload) to load it'] });
  },
  uninstall(ctx) {
    const ours = piPackages(ctx).filter(S.isOursText(ctx));
    if (!ours.length) return S.same('nothing to remove');
    const bin = ctx.which('pi');
    if (!bin) return S.fail(`pi CLI not found on PATH; remove ${ours.map(ctx.tilde).join(', ')} from ${ctx.tilde(piSettingsFile(ctx))} by hand`);
    if (ctx.dryRun) return S.ok(`would run: ${ours.map((o) => `pi remove "${o}"`).join(' && ')}`);
    for (const old of ours) {
      const r = ctx.run(bin, ['remove', old], { timeout: 120000 });
      if (r.status !== 0) return S.fail(`pi remove ${ctx.tilde(old)} failed: ${(r.stderr || r.stdout || '').trim().split('\n')[0]}`);
    }
    ctx.settleBackup(piSettingsFile(ctx));
    return S.ok(`removed ${ours.length > 1 ? `${ours.length} packages` : ctx.tilde(ours[0])} with pi remove`);
  },
  inspect(ctx) {
    const pkgs = piPackages(ctx);
    const ours = pkgs.filter(S.isOursText(ctx));
    const res = { installed: ours.length > 0, versions: new Set(), where: [piSettingsFile(ctx)], problems: [] };
    for (const o of ours) for (const v of S.versionsIn(ctx, `${o}/`)) res.versions.add(v);
    for (const p of pkgs) if (piForeign(ctx, p)) res.problems.push(`pi also loads session-namer from ${ctx.tilde(p)} (not from this installer); remove it: pi remove "${p}"`);
    return res;
  },
};

// -------------------------------------------------------------- table

const hookGroup = (command, extra = {}, timeout = 10) => ({ ...extra, hooks: [{ type: 'command', command, timeout }] });
const namedHook = (command, timeout) => ({ hooks: [{ type: 'command', name: 'session-namer', command, timeout }] });

const codexHome = (ctx) => ctx.envDir('CODEX_HOME', path.join(ctx.home, '.codex'));
const copilotHome = (ctx) => ctx.envDir('COPILOT_HOME', path.join(ctx.home, '.copilot'));
const geminiDir = (ctx) => path.join(ctx.envDir('GEMINI_CLI_HOME', ctx.home), '.gemini');
const qwenDir = (ctx) => ctx.envDir('QWEN_HOME', path.join(ctx.home, '.qwen'));
const dshHome = (ctx) => ctx.envDir('DSH_HOME', path.join(ctx.home, '.dsh'));

const HIDE_TITLE_WHY = 'set it to true or the agent overwrites the tab title';

function dshProfiles(ctx) {
  const dir = path.join(dshHome(ctx), 'profiles');
  let names = [];
  try { names = fs.readdirSync(dir).sort(); } catch { /* none */ }
  return names.map((n) => path.join(dir, n, 'cordis.patch.yml')).filter((f) => fs.existsSync(f));
}

const HARNESSES = [
  {
    id: 'claude', name: 'Claude Code', bins: ['claude'],
    tier: "stable", verify: "`claude plugin list`", level: 'session title (native plugin)',
    strategy: claudeStrategy, usesApp: false,
  },
  {
    id: 'codex', name: 'OpenAI Codex CLI', bins: ['codex'],
    tier: "beta", verify: "`/hooks` lists both hooks; with the daemon running, the TUI title changes after the first prompt", level: 'thread name (needs the Codex daemon for the TUI)',
    strategy: S.jsonEntries({
      adapter: 'codex', readme: readme('codex'), what: '2 hooks',
      file: (ctx) => path.join(codexHome(ctx), 'hooks.json'),
      ops: (ctx, app) => {
        const hook = path.join(app, 'adapters', 'codex', 'hook.js');
        return [
          { path: ['hooks', 'SessionStart'], item: hookGroup(nodeCmd(hook, 'SessionStart'), { matcher: 'startup|resume' }) },
          { path: ['hooks', 'UserPromptSubmit'], item: hookGroup(nodeCmd(hook, 'UserPromptSubmit')) },
        ];
      },
    }),
    uninstallNotes: (ctx) => (/hooks\.json:(session_start|user_prompt_submit):/.test(ctx.readText(path.join(codexHome(ctx), 'config.toml')) || '')
      ? ['config.toml still holds Codex\'s trust entries for hooks.json ([hooks.state.\'...hooks.json:...\']); they are harmless and can be deleted']
      : []),
    notes: (ctx, res) => (res.mark === 'ok' ? [
      'open codex, run /hooks and trust the 2 session-namer hooks (Codex asks again whenever they change, e.g. after an upgrade)',
      'for titles in the Codex TUI, run `codex app-server daemon start` once from a normal (not administrator) terminal; without the daemon Codex titles new threads itself and session-namer leaves those titles alone',
    ] : []),
    checks: (ctx) => {
      const out = [];
      const toml = ctx.readText(path.join(codexHome(ctx), 'config.toml')) || '';
      if (/\[plugins\."session-namer@claude-session-namer"\]\s*\n\s*enabled\s*=\s*true/.test(toml)) {
        out.push('Codex also has the Claude Code plugin session-namer@claude-session-namer enabled: do not trust its hooks in /hooks (they target Claude Code)');
      }
      if (/adapters[\\/]+codex[\\/]+hook\.js/.test(toml)) out.push('config.toml also defines session-namer hooks; keep only one form (hooks.json is what this installer manages)');
      return out;
    },
  },
  {
    id: 'pi', name: 'Pi coding agent', bins: ['pi'],
    tier: "beta", verify: "`pi list`", level: 'session name',
    strategy: piStrategy,
  },
  {
    id: 'opencode', name: 'OpenCode', bins: ['opencode'],
    tier: "beta", verify: "`opencode session list` after a real message", level: 'session title (experimental)',
    strategy: S.jsonEntries({
      adapter: 'opencode', readme: readme('opencode'), what: 'the plugin',
      file: (ctx) => firstExisting(path.join(ctx.envDir('OPENCODE_CONFIG_DIR', path.join(ctx.xdgConfig, 'opencode'))), ['opencode.jsonc', 'opencode.json', 'config.json']),
      ops: (ctx, app) => [{ path: ['plugin'], item: S.fileUrl(path.join(app, 'adapters', 'opencode', 'index.mjs')) }],
    }),
    notes: (ctx, res) => (res.mark === 'ok' ? ['restart OpenCode to load the plugin'] : []),
  },
  {
    id: 'kilo', name: 'Kilo CLI', bins: ['kilo', 'kilocode'],
    tier: "beta", verify: "`kilo session list` after a real message", level: 'session title (experimental, OpenCode adapter)',
    strategy: S.jsonEntries({
      adapter: 'opencode', readme: readme('opencode'), what: 'the plugin',
      file: (ctx) => firstExisting(path.join(ctx.xdgConfig, 'kilo'), ['kilo.jsonc', 'kilo.json', 'opencode.jsonc', 'opencode.json']),
      ops: (ctx, app) => [{ path: ['plugin'], item: S.fileUrl(path.join(app, 'adapters', 'opencode', 'index.mjs')) }],
    }),
    notes: (ctx, res) => (res.mark === 'ok' ? ['restart Kilo to load the plugin'] : []),
  },
  {
    id: 'copilot', name: 'GitHub Copilot CLI', bins: ['copilot'],
    tier: "beta", verify: "`copilot --resume` shows the name", level: 'session name (experimental extensions)',
    strategy: S.ownedFiles({
      readme: readme('copilot'),
      files: (ctx, app) => {
        const { shimSource } = require(path.join(ctx.sourceRoot, 'adapters', 'copilot', 'install.js'));
        return [{ file: path.join(copilotHome(ctx), 'extensions', 'session-namer', 'extension.mjs'), content: shimSource(path.join(app, 'adapters', 'copilot', 'extension.mjs')) }];
      },
      ownDirs: (ctx) => [path.join(copilotHome(ctx), 'extensions', 'session-namer')],
    }),
    notes: (ctx, res) => (res.mark === 'ok' ? ['restart Copilot CLI (or /extensions manage, then reload)'] : []),
    checks: (ctx) => {
      const text = ctx.readText(path.join(copilotHome(ctx), 'settings.json'));
      let on = false;
      try { on = !!(text && jsonc.parseValue(text).experimental === true); } catch { /* treat as off */ }
      return on ? [] : ['extensions need Copilot experimental mode: run /experimental on once, or start copilot --experimental'];
    },
    checksAreNotes: true,
  },
  {
    id: 'cline', name: 'Cline CLI', bins: ['cline'],
    tier: "beta", verify: "`cline history` shows the title a few seconds after the task starts", level: 'session title',
    strategy: S.ownedFiles({
      readme: readme('cline'),
      files: (ctx, app) => {
        const { stubSource, HOOK_FILES } = require(path.join(ctx.sourceRoot, 'adapters', 'cline', 'install.js'));
        const dir = path.join(ctx.envDir('CLINE_DIR', path.join(ctx.home, '.cline')), 'hooks');
        return HOOK_FILES.map((n) => ({ file: path.join(dir, n), content: stubSource(path.join(app, 'adapters', 'cline', 'hook.js')), mode: 0o755 }));
      },
    }),
  },
  {
    id: 'amp', name: 'Amp', bins: ['amp'],
    tier: "partly verified", verify: "`amp plugins list`", level: 'thread title',
    strategy: S.ownedFiles({
      readme: readme('amp'),
      files: (ctx, app) => [{
        file: path.join(ctx.xdgConfig, 'amp', 'plugins', 'session-namer.js'),
        content: `// session-namer amp shim (written by the session-namer installer; safe to delete)\nexport { default } from '${S.fileUrl(path.join(app, 'adapters', 'amp', 'plugin.mjs'))}'\n`,
      }],
    }),
    notes: (ctx, res) => (res.mark === 'ok' ? ['run `plugins: reload` in Amp (Ctrl+O) or start a new amp session; renames use your Amp login (amp login)'] : []),
  },
  {
    id: 'crush', name: 'Crush', bins: ['crush'],
    tier: "beta", verify: "`crush session list` after the first prompt", level: 'session title',
    strategy: S.jsonEntries({
      adapter: 'crush', readme: readme('crush'), what: 'the TurnStart hook',
      file: (ctx) => {
        const g = ctx.env.CRUSH_GLOBAL_CONFIG && ctx.env.CRUSH_GLOBAL_CONFIG.trim();
        return g ? path.join(path.resolve(g), 'crush.json') : firstExisting(path.join(ctx.xdgConfig, 'crush'), ['crush.json']);
      },
      ops: (ctx, app) => [{ path: ['hooks', 'TurnStart'], item: { name: 'session-namer', command: nodeCmd(path.join(app, 'adapters', 'crush', 'hook.js')), timeout: 10 } }],
    }),
    notes: (ctx, res) => (res.mark === 'ok' ? ['start a new crush session'] : []),
  },
  {
    id: 'goose', name: 'goose', bins: ['goose'],
    tier: "beta", verify: "`goose session list --format json`",
    extraBins: (ctx) => (ctx.isWin ? [path.join(ctx.home, 'goose', 'goose.exe')] : [path.join(ctx.home, '.local', 'bin', 'goose')]),
    level: 'session name',
    strategy: S.dirLink({
      readme: readme('goose'),
      link: (ctx) => path.join(ctx.home, '.agents', 'plugins', 'session-namer'),
      target: (ctx, app) => path.join(app, 'adapters', 'goose'),
    }),
    notes: (ctx, res) => (res.mark === 'ok' ? ['start a new goose session; goose may add a plugins: entry to its config.yaml by itself (harmless)'] : []),
    uninstallNotes: () => ['goose may still list the link under plugins: in its config.yaml; that entry is harmless and can be deleted'],
    checks: (ctx) => (ctx.isWin && !ctx.which('sh') ? ['goose runs hooks with `sh -c`: put Git for Windows\' bin folder on your user PATH (see adapters/goose/README.md), or the hook never fires'] : []),
    checksAreNotes: true,
  },
  {
    id: 'deepseek', name: 'DeepSeek Harness (dsh)', bins: ['dsh'],
    tier: "beta", verify: "`dsh <profile> --dump-config` shows id: session-namer", level: 'session title',
    strategy: S.yamlBlock({
      readme: readme('deepseek'), what: 'title provider block',
      files: dshProfiles,
      rows: (ctx, app) => [
        '- id: session-title-llm',
        '  disabled: true',
        '- id: session-title',
        '  config:',
        '    fallbackMaxWords: 5',
        '    fallbackMaxBytes: 40',
        '    maxTitleBytes: 160',
        '- insert:',
        '    - id: session-namer',
        `      name: ${S.fileUrl(path.join(app, 'adapters', 'deepseek', 'plugin.mjs'))}`,
      ].join('\n'),
      noFiles: 'no dsh profile found under ~/.dsh/profiles: start dsh once (e.g. `dsh web`) and re-run install, or run dsh with --patch <app>/adapters/deepseek/session-namer.patch.yml',
    }),
    notReady: (ctx) => (dshProfiles(ctx).length ? null : 'start dsh once, then run install deepseek'),
    notes: (ctx, res) => (res.mark === 'ok' ? ['restart dsh; check with `dsh <profile> --dump-config` (look for id: session-namer)'] : []),
  },
  {
    id: 'grok', name: 'Grok Build (xAI)', bins: ['grok'],
    tier: "beta", verify: "`grok sessions list` after the first prompt",
    extraBins: (ctx) => [path.join(ctx.home, '.grok', 'bin', ctx.isWin ? 'grok.exe' : 'grok')],
    level: 'session title (`grok sessions list`, /resume)',
    strategy: S.ownedFiles({
      readme: readme('grok'),
      files: (ctx, app) => [{
        file: path.join(ctx.home, '.grok', 'hooks', 'session-namer.json'),
        content: `${JSON.stringify({ hooks: { UserPromptSubmit: [hookGroup(nodeCmd(path.join(app, 'adapters', 'grok', 'hook.js')))] } }, null, 2)}\n`,
      }],
    }),
    notes: (ctx, res) => (res.mark === 'ok' ? ['restart grok and check /hooks; answer the Grok folder-trust prompt once per folder, or its hooks (ours included) do not run'] : []),
  },
  {
    id: 'gemini', name: 'Gemini CLI', bins: ['gemini'],
    tier: "tab title only", verify: "the tab title changes after your first prompt", level: 'terminal tab title only',
    strategy: S.jsonEntries({
      adapter: 'gemini', readme: readme('gemini'), what: '3 hooks',
      file: (ctx) => path.join(geminiDir(ctx), 'settings.json'),
      ops: (ctx, app) => {
        const cmd = nodeCmd(path.join(app, 'adapters', 'gemini', 'hook.js'));
        return [
          ...['SessionStart', 'BeforeAgent', 'AfterAgent'].map((e) => ({ path: ['hooks', e], item: namedHook(cmd, 10000) })),
          { path: ['ui', 'hideWindowTitle'], value: true, why: HIDE_TITLE_WHY },
        ];
      },
    }),
    notes: (ctx, res) => (res.mark === 'ok' ? ['titles the terminal tab only (Gemini\'s own session list is unchanged); ui.hideWindowTitle is set to true, which this needs'] : []),
  },
  {
    id: 'qwen', name: 'Qwen Code', bins: ['qwen'],
    tier: "tab title only", verify: "the tab title changes after your first prompt", level: 'terminal tab title only',
    strategy: S.jsonEntries({
      adapter: 'qwen', readme: readme('qwen'), what: '3 hooks',
      file: (ctx) => path.join(qwenDir(ctx), 'settings.json'),
      ops: (ctx, app) => {
        const cmd = nodeCmd(path.join(app, 'adapters', 'qwen', 'hook.js'));
        return [
          ...['SessionStart', 'UserPromptSubmit', 'Stop'].map((e) => ({ path: ['hooks', e], item: namedHook(cmd, 10000) })),
          { path: ['ui', 'hideWindowTitle'], value: true, why: HIDE_TITLE_WHY },
        ];
      },
    }),
    notes: (ctx, res) => (res.mark === 'ok' ? ['titles the terminal tab only (Qwen\'s /resume titles are unchanged); ui.hideWindowTitle is set to true, which this needs'] : []),
  },
];

const UNSUPPORTED = [
  { id: 'droid', name: 'Factory Droid', bins: ['droid'], level: 'no session-title API' },
  { id: 'cursor', name: 'Cursor CLI', bins: ['cursor-agent'], level: 'no session-title API' },
];

/** Other names people type for an agent. */
const ALIASES = {
  dsh: 'deepseek',
  kilocode: 'kilo',
  'gh-copilot': 'copilot',
  'github-copilot': 'copilot',
  'claude-code': 'claude',
  'gemini-cli': 'gemini',
  'qwen-code': 'qwen',
  'grok-build': 'grok',
  'opencode-ai': 'opencode',
  'cursor-agent': 'cursor',
  'factory-droid': 'droid',
};

const byId = new Map(HARNESSES.map((h) => [h.id, h]));

const resolveId = (id) => ALIASES[id] || id;

function editDistance(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return d[a.length][b.length];
}

/** Closest supported id for a typo ("opencod" -> "opencode"), or null. */
function suggestId(id) {
  let best = null;
  for (const name of [...byId.keys(), ...Object.keys(ALIASES)]) {
    const target = resolveId(name);
    if (!byId.has(target)) continue;
    const dist = name.startsWith(id) || id.startsWith(name) ? 1 : editDistance(id, name);
    if (dist <= Math.max(2, Math.floor(name.length / 3)) && (!best || dist < best.dist)) best = { id: target, dist };
  }
  return best ? best.id : null;
}

function findBin(ctx, h) {
  for (const b of h.bins) {
    const p = ctx.which(b, []);
    if (p) return p;
  }
  return ctx.which(h.bins[0], h.extraBins ? h.extraBins(ctx) : []);
}

module.exports = { HARNESSES, UNSUPPORTED, ALIASES, byId, findBin, resolveId, suggestId, CLAUDE_PLUGIN };
