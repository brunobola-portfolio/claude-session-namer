'use strict';
/**
 * session-namer installer CLI.
 *
 *   session-namer install <agent...> | --detect   [--dry-run]
 *   session-namer uninstall <agent...> | --all    [--dry-run]
 *   session-namer status
 *   session-namer list
 */
const path = require('node:path');
const { makeContext } = require('./context');
const { HARNESSES, UNSUPPORTED, ALIASES, byId, findBin, resolveId, suggestId } = require('./harnesses');
const home = require('./home');

const MARK = { ok: '✓', same: '–', fail: '✗' };
const pad = (s, n) => String(s) + ' '.repeat(Math.max(1, n - String(s).length));
const REPO = 'brunobola-portfolio/claude-session-namer';
const docsUrl = (version) => `https://github.com/${REPO}/blob/v${version}/docs/install.md`;
/** The command that runs this same release again (npx leaves nothing on PATH). */
const npxCmd = (version) => `npx -y github:${REPO}#v${version}`;
const COMMANDS = ['install', 'uninstall', 'status', 'list', 'help'];

const PAST = {
  wrote: 'write', created: 'create', updated: 'update', added: 'add', removed: 'remove', linked: 'link',
  relinked: 'relink', registered: 'register', installed: 'install', uninstalled: 'uninstall',
};
/** "wrote x" -> "would write x", for dry runs. */
function asPlan(msg) {
  if (/^would /.test(msg)) return msg;
  const m = /^([a-z]+)\b/.exec(msg);
  if (m && PAST[m[1]]) return `would ${PAST[m[1]]}${msg.slice(m[1].length)}`;
  return `would set up ${msg}`;
}

function usage(version) {
  return `session-namer: name every AI coding session "<project> - <topic>"

Usage:
  ${npxCmd(version)} <command>
  (without #v${version}, npx runs the latest code on main)

Commands:
  install <agent...>      install into the given agents
  install --detect        every supported agent found on PATH
  uninstall <agent...>    remove exactly what install added
  uninstall --all
  status                  what is installed where, versions, problems
  list                    supported agents and support level

Options:
  --dry-run   show planned changes without writing anything
  --help      this text

Agents: ${HARNESSES.map((h) => h.id).join(', ')}
Docs: ${docsUrl(version)}
`;
}

function parseArgs(argv) {
  const flags = new Set();
  const ids = [];
  let cmd = null;
  for (const a of argv) {
    if (a.startsWith('--')) flags.add(a.slice(2));
    else if (a === '-h') flags.add('help');
    else if (!cmd) cmd = a;
    else ids.push(resolveId(a.toLowerCase()));
  }
  return { cmd, ids, flags };
}

function line(ctx, mark, id, msg) {
  ctx.out(`${MARK[mark] || mark} ${pad(id, 10)}${ctx.dryRun && mark === 'ok' ? asPlan(msg) : msg}\n`);
}

function followUps(ctx, list, prefix) {
  for (const n of list) ctx.out(`    ${prefix} ${n}\n`);
}

/** Versions every agent config references (configs are the source of truth, plus the manifest). */
function referencedVersions(ctx, manifest) {
  const refs = new Set();
  for (const h of HARNESSES) {
    if (h.usesApp === false) continue;
    try { for (const v of h.strategy.inspect(ctx).versions) refs.add(v); } catch { /* ignore */ }
  }
  for (const [id, r] of Object.entries(manifest.harnesses)) {
    if (r && r.version && byId.get(id) && byId.get(id).usesApp !== false) refs.add(r.version);
  }
  return refs;
}

function validateIds(ctx, ids) {
  const bad = ids.filter((id) => !byId.has(id));
  if (!bad.length) return true;
  for (const id of bad) {
    const u = UNSUPPORTED.find((x) => x.id === id);
    const hint = suggestId(id);
    ctx.out(`✗ ${pad(id, 10)}${u ? `${u.name} is not supported: ${u.level}` : `unknown agent${hint ? `; did you mean ${hint}?` : ''}`}\n`);
  }
  ctx.out(`\nSupported agents: ${HARNESSES.map((h) => h.id).join(', ')}\n`);
  return false;
}

const TOPIC_NOTE = 'Topics are written by the `claude` CLI with your login; Codex and Pi can use their own model, '
  + 'and OpenCode, Kilo, Crush and goose fall back to the agent\'s own title when `claude` is missing';

function runInstall(ctx, ids, { detected = false } = {}) {
  const manifest = home.loadManifest(ctx, { preserve: true });
  let failed = 0;
  let succeeded = 0;
  // Found by --detect but not set up yet (e.g. dsh without a profile): skip, not fail.
  const skipped = new Map();
  if (detected) {
    for (const id of ids) {
      const reason = byId.get(id).notReady && byId.get(id).notReady(ctx);
      if (reason) skipped.set(id, reason);
    }
  }
  const todo = ids.filter((id) => !skipped.has(id));
  ctx.out(`session-namer ${ctx.version} installer${ctx.dryRun ? ' (dry run: nothing is written)' : ''}\n`);
  if (todo.some((id) => byId.get(id).usesApp !== false)) {
    try {
      const r = home.ensureRuntime(ctx);
      const where = ctx.tilde(ctx.appDir());
      ctx.out(`  files ${r === 'current' ? 'up to date in' : r === 'self' ? 'run from' : ctx.dryRun ? 'would be copied to' : 'copied to'} ${where}\n\n`);
    } catch (err) {
      ctx.out(`✗ could not copy session-namer to ${ctx.tilde(ctx.appDir())}: ${err.message}\n`);
      return 1;
    }
  } else {
    ctx.out('\n');
  }
  for (const id of ids) {
    const h = byId.get(id);
    if (skipped.has(id)) { line(ctx, 'same', id, `skipped (${skipped.get(id)})`); continue; }
    const record = JSON.parse(JSON.stringify(manifest.harnesses[id] || { files: {}, dirs: [] }));
    let res;
    try {
      res = h.strategy.install(ctx, record);
    } catch (err) {
      res = { mark: 'fail', msg: err.message, notes: [], warnings: [] };
    }
    const bin = findBin(ctx, h);
    const extra = [];
    if (!bin && res.mark !== 'fail') extra.push(`${h.bins[0]} was not found on PATH; the config ${ctx.dryRun ? 'would be' : 'is'} in place for when it is`);
    line(ctx, res.mark, id, res.msg);
    if (res.mark === 'fail') {
      failed++;
    } else {
      succeeded++;
      record.version = h.usesApp === false ? undefined : ctx.version;
      record.installedAt = record.installedAt && res.mark === 'same' ? record.installedAt : new Date().toISOString();
      // A Claude plugin that was already there (installed by hand) is not ours to remove with --all.
      const adopt = !(h.usesApp === false && res.mark === 'same' && !manifest.harnesses[id]);
      if (adopt && !ctx.dryRun) manifest.harnesses[id] = record;
      const notes = [...(res.notes || []), ...(h.notes ? h.notes(ctx, res) : []), ...(h.checks && h.checksAreNotes ? h.checks(ctx) : []), ...extra];
      const warns = [...(res.warnings || []), ...(h.checks && !h.checksAreNotes ? h.checks(ctx) : [])];
      followUps(ctx, notes, '→');
      followUps(ctx, warns, '!');
    }
    // Saved after every agent, so an interrupted run still knows what it wrote.
    home.saveManifest(ctx, manifest);
  }
  const keep = referencedVersions(ctx, manifest);
  if (ctx.dryRun && todo.some((id) => byId.get(id).usesApp !== false) && succeeded) keep.add(ctx.version);
  const pr = home.pruneVersions(ctx, keep);
  if (pr.removed.length) ctx.out(`\n  ${ctx.dryRun ? 'would remove' : 'removed'} installed copies nothing uses: ${pr.removed.join(', ')}\n`);
  if (pr.busy.length) ctx.out(`\n  could not remove ${pr.busy.join(', ')} (in use); it is removed on the next install\n`);
  if (!ctx.which('claude') && todo.some((id) => !['pi', 'codex', 'claude'].includes(id))) {
    ctx.out(`\n  note: \`claude\` is not on PATH. ${TOPIC_NOTE}\n`);
  }
  ctx.out(failed ? `\n${failed} agent(s) failed; see above.\n` : ctx.dryRun ? '\nDry run complete; nothing was written.\n' : '\nDone.\n');
  return failed ? 1 : 0;
}

function runUninstall(ctx, ids, manifest = home.loadManifest(ctx, { preserve: true })) {
  let failed = 0;
  ctx.out(`session-namer ${ctx.version} uninstall${ctx.dryRun ? ' (dry run: nothing is written)' : ''}\n\n`);
  for (const id of ids) {
    const h = byId.get(id);
    const record = manifest.harnesses[id] || { files: {}, dirs: [] };
    let res;
    try {
      res = h.strategy.uninstall(ctx, record);
    } catch (err) {
      res = { mark: 'fail', msg: err.message, notes: [], warnings: [] };
    }
    line(ctx, res.mark, id, res.msg);
    if (res.mark === 'ok' && h.uninstallNotes) followUps(ctx, h.uninstallNotes(ctx), '→');
    followUps(ctx, res.warnings || [], '!');
    if (res.mark === 'fail') failed++;
    else delete manifest.harnesses[id];
    home.saveManifest(ctx, manifest);
  }
  const pr = home.pruneVersions(ctx, referencedVersions(ctx, manifest));
  if (pr.removed.length) ctx.out(`\n  ${ctx.dryRun ? 'would remove' : 'removed'} installed copies nothing uses any more: ${pr.removed.join(', ')}\n`);
  if (pr.busy.length) ctx.out(`\n  could not remove ${pr.busy.join(', ')} (in use by a running agent); delete ${ctx.tilde(ctx.appRoot)} later\n`);
  if (ctx.backupsKept.size) {
    ctx.out(`\n  Backups kept (your file before the first install; delete them when you no longer need them):\n${[...ctx.backupsKept].map((b) => `    ${ctx.tilde(b)}\n`).join('')}`);
  }
  ctx.out(failed ? `\n${failed} agent(s) failed; see above.\n` : ctx.dryRun ? '\nDry run complete; nothing was written.\n' : '\nDone.\n');
  return failed ? 1 : 0;
}

async function probeVersions(ctx, harnesses) {
  return Promise.all(harnesses.map(async (h) => {
    const bin = findBin(ctx, h);
    if (!bin) return { bin: null, version: null };
    const r = await ctx.runAsync(bin, ['--version'], { timeout: 15000 });
    const text = `${r.stdout || ''}\n${r.stderr || ''}`.split('\n').map((s) => s.trim()).find((s) => /\d+\.\d+/.test(s)) || '';
    const m = /\d+\.\d+(?:[\w.+-]*\w)?/.exec(text);
    return { bin, version: m ? m[0] : null };
  }));
}

const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

async function runStatus(ctx) {
  const manifest = home.loadManifest(ctx);
  const probes = await probeVersions(ctx, HARNESSES);
  const versions = home.installedVersions(ctx);
  ctx.out(`session-namer ${ctx.version} status\n  home: ${ctx.tilde(ctx.nsHome)}  installed copies: ${versions.length ? versions.join(', ') : 'none'}\n\n`);
  const rows = HARNESSES.map((h, i) => {
    const p = probes[i];
    let res;
    try { res = h.strategy.inspect(ctx); } catch (err) { res = { installed: false, versions: new Set(), where: [], problems: [err.message] }; }
    const probs = [...res.problems];
    if (res.installed && h.checks) probs.push(...h.checks(ctx));
    for (const v of res.versions) if (!versions.includes(v)) probs.push(`points at session-namer ${v}, which is missing from ${ctx.tilde(ctx.appRoot)}: run install ${h.id}`);
    if (res.installed && h.usesApp !== false && res.versions.size && !res.versions.has(ctx.version)) probs.push(`runs ${[...res.versions].join(', ')}; \`install ${h.id}\` upgrades it to ${ctx.version}`);
    if (!res.installed && manifest.harnesses[h.id]) probs.push(`installed.json lists it, but its config entry is gone (removed by hand?): run install ${h.id} or uninstall ${h.id}`);
    const found = p.bin ? `${h.bins[0]} ${p.version ? clip(p.version, 20) : '(version unknown)'}` : 'not found';
    const where = res.where.filter(Boolean);
    const inst = res.installed
      ? `installed${res.detail ? ` (${res.detail})` : res.versions.size ? ` v${[...res.versions].join(', v')}` : ''}${where.length ? ` · ${path.isAbsolute(where[0]) ? ctx.tilde(where[0]) : where[0]}${where.length > 1 ? ` (+${where.length - 1})` : ''}` : ''}`
      : 'not installed';
    const next = [];
    if (res.installed && !probs.length && h.verify) next.push(`check: ${h.verify}`);
    if (!res.installed && p.bin) {
      const reason = h.notReady && h.notReady(ctx);
      next.push(reason || `install with: ${npxCmd(ctx.version)} install ${h.id}`);
    }
    return { h, res, probs, found, inst, next };
  });
  const idW = Math.max(...rows.map((r) => r.h.id.length)) + 2;
  const foundW = Math.max(...rows.map((r) => r.found.length)) + 2;
  let problems = 0;
  for (const r of rows) {
    const mark = r.probs.length && r.res.installed ? 'fail' : r.res.installed ? 'ok' : 'same';
    ctx.out(`${MARK[mark]} ${pad(r.h.id, idW)}${pad(r.found, foundW)}${r.inst}\n`);
    followUps(ctx, r.probs, '!');
    followUps(ctx, r.next, '→');
    problems += r.probs.length;
  }
  ctx.out(`\n${problems ? `${problems} problem(s) found.` : 'No problems found.'}\n`);
  return 0;
}

function runList(ctx) {
  const idW = Math.max(...HARNESSES.map((h) => h.id.length), ...UNSUPPORTED.map((u) => u.id.length)) + 2;
  const nameW = Math.max(...HARNESSES.map((h) => h.name.length), ...UNSUPPORTED.map((u) => u.name.length)) + 2;
  const tierW = Math.max('Level'.length, ...HARNESSES.map((h) => h.tier.length)) + 2;
  ctx.out('Supported agents (✓ = found on this machine):\n\n');
  ctx.out(`  ${pad('Agent', idW)}${pad('Name', nameW)}${pad('Level', tierW)}What it names\n`);
  for (const h of HARNESSES) {
    const bin = findBin(ctx, h);
    ctx.out(`${bin ? '✓' : '–'} ${pad(h.id, idW)}${pad(h.name, nameW)}${pad(h.tier, tierW)}${h.level}\n`);
  }
  ctx.out('\nNot supported:\n\n');
  for (const u of UNSUPPORTED) ctx.out(`  ${pad(u.id, idW)}${pad(u.name, nameW)}${u.level}\n`);
  const aliases = Object.entries(ALIASES).filter(([, to]) => byId.has(to)).map(([a, to]) => `${a} = ${to}`);
  ctx.out(`\nAlso accepted: ${aliases.join(', ')}\n`);
  return 0;
}

async function main(argv, opts = {}) {
  const { cmd, ids, flags } = parseArgs(argv);
  const ctx = makeContext({ ...opts, dryRun: flags.has('dry-run') });
  const USAGE = usage(ctx.pkg.version);
  if (flags.has('version')) { ctx.out(`${ctx.version}\n`); return 0; }
  if (!cmd || flags.has('help') || cmd === 'help') { ctx.out(USAGE); return 0; }
  const known = new Set(['dry-run', 'detect', 'all', 'help', 'version']);
  const unknownFlags = [...flags].filter((f) => !known.has(f));
  if (unknownFlags.length) { ctx.out(`Unknown option(s): ${unknownFlags.map((f) => `--${f}`).join(' ')}\n\n${USAGE}`); return 2; }

  if (cmd === 'install') {
    let list = ids;
    const detected = flags.has('detect');
    if (detected) {
      list = HARNESSES.filter((h) => findBin(ctx, h)).map((h) => h.id);
      if (!list.length) { ctx.out('No supported agent found on PATH.\n'); return 1; }
    }
    if (!list.length) { ctx.out(`Name at least one agent, or use --detect.\n\n${USAGE}`); return 2; }
    if (!validateIds(ctx, list)) return 2;
    return runInstall(ctx, [...new Set(list)], { detected });
  }
  if (cmd === 'uninstall' || cmd === 'remove') {
    let list = ids;
    let manifest;
    if (flags.has('all')) {
      manifest = home.loadManifest(ctx, { preserve: true });
      list = HARNESSES.filter((h) => {
        if (manifest.harnesses[h.id]) return true;
        if (h.usesApp === false) return false; // claude: only when this installer installed it
        try { return h.strategy.inspect(ctx).installed; } catch { return false; }
      }).map((h) => h.id);
      if (!list.length) { ctx.out('Nothing is installed.\n'); return 0; }
    }
    if (!list.length) { ctx.out(`Name at least one agent, or use --all.\n\n${USAGE}`); return 2; }
    if (!validateIds(ctx, list)) return 2;
    return runUninstall(ctx, [...new Set(list)], manifest);
  }
  if (cmd === 'status') return runStatus(ctx);
  if (cmd === 'list') return runList(ctx);
  const guess = COMMANDS.find((c) => c.slice(0, 3) === cmd.slice(0, 3).toLowerCase());
  ctx.out(`Unknown command "${cmd}".${guess ? ` Did you mean ${guess}?` : ''}\n\n${USAGE}`);
  return 2;
}

module.exports = { main, parseArgs, usage };
