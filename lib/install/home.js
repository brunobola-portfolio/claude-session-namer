'use strict';
/**
 * The stable install home: ~/.session-namer (or $SESSION_NAMER_HOME).
 *
 *   app/<version>/   runtime copy every harness config points at
 *   installed.json   what install wrote, per harness, so uninstall can undo it
 */
const fs = require('node:fs');
const path = require('node:path');
const { sha256 } = require('./context');

const RUNTIME = ['lib', 'hooks', 'adapters', 'commands', 'bin', 'package.json', 'LICENSE'];
const SKIP = new Set(['node_modules', '.git', '.DS_Store', 'Thumbs.db']);
const TREE_STAMP = '.session-namer-tree';

function listFiles(root, rel = '') {
  const abs = path.join(root, rel);
  let st;
  try { st = fs.statSync(abs); } catch { return []; }
  if (st.isFile()) return [rel];
  if (!st.isDirectory()) return [];
  const out = [];
  for (const name of fs.readdirSync(abs).sort()) {
    if (SKIP.has(name)) continue;
    out.push(...listFiles(root, rel ? path.join(rel, name) : name));
  }
  return out;
}

function treeHash(root) {
  const files = RUNTIME.flatMap((entry) => listFiles(root, entry));
  const h = [];
  for (const f of files) h.push(`${f.split(path.sep).join('/')}\0${sha256(fs.readFileSync(path.join(root, f)))}`);
  return { files, hash: sha256(h.join('\n')) };
}

const samePath = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

/**
 * Copy the runtime into app/<version>. Returns 'copied' | 'current' | 'self'.
 * A changed tree with the same version (a dev checkout) is copied again.
 */
function ensureRuntime(ctx) {
  const dest = ctx.appDir();
  if (samePath(dest, ctx.sourceRoot)) return 'self';
  const { files, hash } = treeHash(ctx.sourceRoot);
  const stamp = ctx.readText(path.join(dest, TREE_STAMP));
  if (stamp && stamp.trim() === hash) return 'current';
  if (ctx.dryRun) return 'copied';
  const tmp = `${dest}.tmp-${process.pid}`;
  fs.rmSync(tmp, { recursive: true, force: true });
  for (const f of files) {
    const to = path.join(tmp, f);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(path.join(ctx.sourceRoot, f), to);
  }
  fs.writeFileSync(path.join(tmp, TREE_STAMP), `${hash}\n`);
  if (fs.existsSync(dest)) {
    // Overwrite in place: a harness may hold files open (Windows refuses to rename over them).
    for (const f of files) {
      const to = path.join(dest, f);
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.copyFileSync(path.join(tmp, f), to);
    }
    fs.copyFileSync(path.join(tmp, TREE_STAMP), path.join(dest, TREE_STAMP));
    fs.rmSync(tmp, { recursive: true, force: true });
  } else {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.renameSync(tmp, dest);
  }
  return 'copied';
}

/**
 * Read installed.json. A corrupt file is never dropped silently: it is
 * reported, and (when `preserve` is set and this is not a dry run) copied to
 * installed.json.corrupt-<time> before anything overwrites it.
 */
function loadManifest(ctx, { preserve = false } = {}) {
  const text = ctx.readText(ctx.manifestFile);
  if (!text || !text.trim()) return { schema: 1, harnesses: {} };
  try {
    const m = JSON.parse(text);
    if (!m || typeof m !== 'object' || Array.isArray(m)) throw new Error('not an object');
    if (!m.harnesses || typeof m.harnesses !== 'object') m.harnesses = {};
    return m;
  } catch {
    let kept = '';
    if (preserve && !ctx.dryRun) {
      const copy = `${ctx.manifestFile}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`;
      try { fs.copyFileSync(ctx.manifestFile, copy); kept = `; saved a copy as ${ctx.tilde(copy)}`; } catch { /* reported below */ }
    }
    ctx.out(`! ${ctx.tilde(ctx.manifestFile)} is not valid JSON, so the install record is ignored${kept}. Uninstall still finds entries by their path.\n`);
    return { schema: 1, harnesses: {} };
  }
}

/** Write installed.json atomically (tmp + rename); removes it when empty. */
function saveManifest(ctx, manifest) {
  if (ctx.dryRun) return;
  if (Object.keys(manifest.harnesses).length === 0) {
    fs.rmSync(ctx.manifestFile, { force: true });
    return;
  }
  fs.mkdirSync(path.dirname(ctx.manifestFile), { recursive: true });
  const tmp = `${ctx.manifestFile}.tmp-${process.pid}`;
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(manifest, null, 2)}\n`);
    fs.renameSync(tmp, ctx.manifestFile);
  } finally {
    try { fs.rmSync(tmp, { force: true }); } catch { /* best effort */ }
  }
}

function installedVersions(ctx) {
  try {
    return fs.readdirSync(ctx.appRoot).filter((v) => !v.includes('.tmp-') && fs.statSync(path.join(ctx.appRoot, v)).isDirectory());
  } catch {
    return [];
  }
}

/**
 * Delete app/<version> folders nothing points at any more. `referenced` is the
 * set of versions found in harness configs (plus the manifest). Returns
 * { removed, busy }.
 */
function pruneVersions(ctx, referenced) {
  const removed = [];
  const busy = [];
  for (const v of installedVersions(ctx)) {
    if (referenced.has(v)) continue;
    const dir = path.join(ctx.appRoot, v);
    if (samePath(dir, ctx.sourceRoot)) continue;
    if (ctx.dryRun) { removed.push(v); continue; }
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 2 });
      removed.push(v);
    } catch {
      busy.push(v);
    }
  }
  if (!ctx.dryRun && installedVersions(ctx).length === 0) {
    try { fs.rmdirSync(ctx.appRoot); } catch { /* not empty / absent */ }
    try { if (fs.readdirSync(ctx.nsHome).length === 0) fs.rmdirSync(ctx.nsHome); } catch { /* keep */ }
  }
  return { removed, busy };
}

module.exports = { ensureRuntime, loadManifest, saveManifest, pruneVersions, installedVersions, treeHash, RUNTIME };
