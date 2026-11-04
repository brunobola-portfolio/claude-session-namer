'use strict';
/**
 * Reusable install strategies. Each returns { install, uninstall, inspect }
 * working on one harness record from installed.json:
 *   record = { version, files: { <path>: { created, createdPaths, scalars } }, dirs: [] }
 *
 * Results: { mark: 'ok' | 'same' | 'fail', msg, notes: [], warnings: [] }
 */
const fs = require('node:fs');
const path = require('node:path');
const jsonc = require('./jsonc');
const { BACKUP_SUFFIX } = require('./context');

// ---------------------------------------------------------------- helpers

/** Decode runs of %XX escapes; a run that is not valid UTF-8 stays as it is. */
const decodeEscapes = (u) => u.replace(/(?:%[0-9a-f]{2})+/gi, (run) => {
  try { return decodeURIComponent(run); } catch { return run; }
});

/**
 * Comparable form of a text that holds paths: file:// URLs are decoded
 * (pathToFileURL escapes spaces, non-ASCII, #, % ...), and on Windows
 * separators are unified and case folded. POSIX paths stay case-sensitive.
 */
const norm = (s, isWin = process.platform === 'win32') => {
  let t = String(s).replace(/file:\/\/[^\s"`]+/gi, decodeEscapes);
  if (isWin) t = t.replace(/\\\\/g, '/').replace(/\\/g, '/').toLowerCase();
  return t;
};

const appMark = (ctx) => `${norm(ctx.appRoot, ctx.isWin).replace(/\/+$/, '')}/`;

const isOursText = (ctx) => (text) => norm(text, ctx.isWin).includes(appMark(ctx));

/** Versions referenced by a text (app/<version>/...). */
function versionsIn(ctx, text) {
  const mark = appMark(ctx);
  const s = norm(text, ctx.isWin);
  const out = new Set();
  let i = s.indexOf(mark);
  while (i >= 0) {
    const rest = s.slice(i + mark.length);
    const m = /^([^/"'\s]+)\//.exec(rest);
    if (m) out.add(m[1]);
    i = s.indexOf(mark, i + 1);
  }
  return out;
}

/** Text looks like a session-namer entry that this installer did not write. */
const isForeign = (ctx, adapter) => (text) => {
  const s = norm(text, ctx.isWin);
  return !s.includes(appMark(ctx)) && (s.includes(`adapters/${adapter}/`) || s.includes('session-namer'));
};

const fwd = (p) => p.split(path.sep).join('/');
const fileUrl = (p) => require('node:url').pathToFileURL(p).href;

const ok = (msg, extra = {}) => ({ mark: 'ok', msg, notes: [], warnings: [], ...extra });
const same = (msg, extra = {}) => ({ mark: 'same', msg, notes: [], warnings: [], ...extra });
const fail = (msg, extra = {}) => ({ mark: 'fail', msg, notes: [], warnings: [], ...extra });

function recordFile(record, file) {
  record.files = record.files || {};
  record.files[file] = record.files[file] || { created: false, createdPaths: [], scalars: {} };
  return record.files[file];
}

function addDirs(record, dirs) {
  record.dirs = record.dirs || [];
  for (const d of dirs) if (!record.dirs.includes(d)) record.dirs.push(d);
}

function pushUnique(list, p) {
  const k = JSON.stringify(p);
  if (!list.some((x) => JSON.stringify(x) === k)) list.push(p);
}

/** Empty or whitespace-only (a BOM included) config: treated as {}. */
const isBlank = (text) => text.replace(/^\uFEFF/, '').trim() === '';

/** Two JSON/JSONC texts hold the same value (a blank text counts as {}). */
function sameJson(a, b) {
  try {
    const va = isBlank(a) ? {} : jsonc.parseValue(a);
    const vb = isBlank(b) ? {} : jsonc.parseValue(b);
    return JSON.stringify(va) === JSON.stringify(vb);
  } catch {
    return false;
  }
}

function manualHint(readme) {
  return `edit it by hand instead: see ${readme}`;
}

// ------------------------------------------------- JSON / JSONC config entries

/**
 * spec = {
 *   adapter: 'gemini',                 // adapters/<adapter>/
 *   file: (ctx) => path,               // config file to edit
 *   ops: (ctx, appDir) => [ { path: [...], item } | { path: [...], value, why } ],
 *   readme,                            // manual fallback
 *   what,                              // "3 hooks" etc. for messages
 * }
 */
function jsonEntries(spec) {
  function plan(ctx, text, appDir) {
    const ours = isOursText(ctx);
    const created = [];
    const scalars = {};
    const kept = [];
    let out = text;
    let changed = 0;
    for (const op of spec.ops(ctx, appDir)) {
      if ('item' in op) {
        const r = jsonc.ensureArrayItem(out, op.path, op.item, ours);
        out = r.text;
        for (const p of r.created) pushUnique(created, p);
        if (r.action !== 'unchanged') changed++;
      } else {
        const r = jsonc.ensureScalar(out, op.path, op.value);
        out = r.text;
        for (const p of r.created) pushUnique(created, p);
        if (r.action === 'added') { scalars[JSON.stringify(op.path)] = op.value; changed++; }
        if (r.action === 'kept') kept.push(`${op.path.join('.')} is ${JSON.stringify(r.current)}; ${op.why}`);
      }
    }
    return { text: out, created, scalars, kept, changed };
  }

  function foreignEntries(ctx, text) {
    const found = [];
    let root;
    try { root = jsonc.parse(text); } catch { return found; }
    const foreign = isForeign(ctx, spec.adapter);
    for (const op of spec.ops(ctx, ctx.appDir())) {
      if (!('item' in op)) continue;
      const node = jsonc.at(root, op.path);
      if (!node || node.type !== 'array') continue;
      for (const it of node.items) if (foreign(text.slice(it.start, it.end))) found.push(op.path.join('.'));
    }
    return [...new Set(found)];
  }

  return {
    install(ctx, record) {
      const file = spec.file(ctx);
      const original = ctx.readText(file);
      const creating = original === null;
      const blank = !creating && isBlank(original);
      let result;
      try {
        result = plan(ctx, creating || blank ? '{}' : original, ctx.appDir());
      } catch (err) {
        return fail(`could not edit ${ctx.tilde(file)} safely (${err.message}); nothing written, ${manualHint(spec.readme)}`);
      }
      let text = result.text;
      if (creating || blank) text = `${JSON.stringify(jsonc.parseValue(text), null, 2)}\n`;
      const warnings = foreignEntries(ctx, text).map((p) => `${ctx.tilde(file)} also has a session-namer entry under ${p} that this installer did not write (a manual install?); remove it to avoid double titles`);
      const notes = result.kept;
      if (!creating && text === original) return same(`already up to date in ${ctx.tilde(file)}`, { notes, warnings });
      const dirs = ctx.mkdirs(path.dirname(file));
      // A backup taken before an earlier install is stale once none of our entries remain.
      const bak = creating ? { made: false } : ctx.backup(file, { refresh: !isOursText(ctx)(original) });
      try {
        ctx.writeText(file, text);
      } catch (err) {
        if (bak.made) ctx.removeFile(bak.bak);
        ctx.removeEmptyDirs(dirs);
        return fail(`${err.message}; ${manualHint(spec.readme)}`);
      }
      const rf = recordFile(record, file);
      if (creating) rf.created = true;
      if (blank && rf.blank === undefined) rf.blank = original;
      for (const p of result.created) pushUnique(rf.createdPaths, p);
      Object.assign(rf.scalars, result.scalars);
      addDirs(record, dirs);
      const f = ctx.tilde(file);
      const msg = creating ? `created ${f} with ${spec.what}`
        : versionsIn(ctx, original).size ? `updated ${spec.what} in ${f}` : `added ${spec.what} to ${f}`;
      return ok(msg, { notes, warnings });
    },

    uninstall(ctx, record) {
      const file = spec.file(ctx);
      const original = ctx.readText(file);
      if (original === null) return same('nothing to remove');
      if (isBlank(original)) { ctx.settleBackup(file, original); return same(`nothing to remove in ${ctx.tilde(file)}`); }
      const known = record.files && record.files[file];
      const rf = known || { created: false, createdPaths: [], scalars: {} };
      const ops = spec.ops(ctx, ctx.appDir());
      let text = original;
      let removedOnly;
      try {
        const ours = isOursText(ctx);
        for (const op of [...ops].reverse()) {
          if ('item' in op) text = jsonc.removeArrayItems(text, op.path, ours).text;
        }
        removedOnly = text;
        text = jsonc.pruneCreated(text, rf.createdPaths || [], rf.scalars || {});
      } catch (err) {
        return fail(`could not edit ${ctx.tilde(file)} safely (${err.message}); nothing written, ${manualHint(spec.readme)}`);
      }
      if (text === original) { ctx.settleBackup(file, original); return same(`nothing to remove in ${ctx.tilde(file)}`); }
      // No install record (installed.json lost or corrupt): when taking our entries
      // (and the keys they need) out gives the backup's content, restore its bytes.
      const bakText = ctx.readText(file + BACKUP_SUFFIX);
      if (!known && bakText !== null && text !== bakText) {
        const paths = [];
        const scalars = {};
        for (const op of ops) {
          for (let k = 1; k <= op.path.length; k++) pushUnique(paths, op.path.slice(0, k));
          if (!('item' in op)) scalars[JSON.stringify(op.path)] = op.value;
        }
        let pruned = removedOnly;
        try { pruned = jsonc.pruneCreated(removedOnly, paths, scalars); } catch { /* compare as is */ }
        if (sameJson(pruned, bakText) || sameJson(removedOnly, bakText)) text = bakText;
      }
      let empty = false;
      try { const v = jsonc.parseValue(text); empty = v && typeof v === 'object' && Object.keys(v).length === 0; } catch { /* keep */ }
      if (rf.created && empty) {
        ctx.removeFile(file);
        ctx.removeEmptyDirs(record.dirs || []);
        return ok(`removed ${ctx.tilde(file)} (it was created by install)`);
      }
      if (typeof rf.blank === 'string' && empty) text = rf.blank;
      ctx.writeText(file, text);
      ctx.settleBackup(file, text);
      return ok(`removed ${spec.what} from ${ctx.tilde(file)}`);
    },

    inspect(ctx) {
      const file = spec.file(ctx);
      const text = ctx.readText(file);
      const res = { installed: false, versions: new Set(), where: [file], problems: [] };
      if (text === null || isBlank(text)) return res;
      let root;
      try { root = jsonc.parse(text); } catch (err) {
        res.problems.push(`${ctx.tilde(file)} does not parse (${err.message})`);
        return res;
      }
      const ours = isOursText(ctx);
      let found = 0;
      let expected = 0;
      const scalarProblems = [];
      for (const op of spec.ops(ctx, ctx.appDir())) {
        const node = jsonc.at(root, op.path);
        if ('item' in op) {
          expected++;
          if (node && node.type === 'array' && node.items.some((it) => ours(text.slice(it.start, it.end)))) found++;
        } else {
          const v = node ? jsonc.toValue(node) : undefined;
          if (v !== op.value) scalarProblems.push(`${op.path.join('.')} is ${v === undefined ? 'not set' : JSON.stringify(v)}; ${op.why}`);
        }
      }
      res.installed = found > 0;
      if (found) res.problems.push(...scalarProblems);
      if (found && found < expected) res.problems.push(`only ${found} of ${expected} entries present in ${ctx.tilde(file)}; re-run install`);
      for (const v of versionsIn(ctx, text)) res.versions.add(v);
      for (const p of foreignEntries(ctx, text)) res.problems.push(`another session-namer entry (not from this installer) under ${p} in ${ctx.tilde(file)}`);
      if (!res.installed) res.problems = res.problems.filter((p) => p.startsWith('another'));
      return res;
    },
  };
}

// ----------------------------------------------------------- owned files

/**
 * Files that belong entirely to session-namer (a shim, a hook stub, a hook
 * file). spec = { files: (ctx, appDir) => [{ file, content }], ownDirs?: (ctx) => [dir], readme }
 */
function ownedFiles(spec) {
  const ours = (ctx, text) => text !== null && isOursText(ctx)(text);
  return {
    install(ctx, record) {
      const items = spec.files(ctx, ctx.appDir());
      for (const { file } of items) {
        const cur = ctx.readText(file);
        if (cur !== null && !ours(ctx, cur)) {
          return fail(`${ctx.tilde(file)} exists and was not written by this installer; nothing changed (remove it, or ${manualHint(spec.readme)})`);
        }
      }
      let changed = 0;
      let upgraded = false;
      for (const { file, content, mode } of items) {
        const cur = ctx.readText(file);
        if (cur === content) continue;
        if (cur !== null) upgraded = true;
        addDirs(record, ctx.mkdirs(path.dirname(file)));
        ctx.writeText(file, content, { mode });
        recordFile(record, file).created = true;
        changed++;
      }
      const where = items.length === 1 ? ctx.tilde(items[0].file) : ctx.tilde(path.dirname(items[0].file));
      if (!changed) return same(`already up to date (${where})`);
      return ok(`${upgraded ? 'updated' : 'wrote'} ${where}`);
    },

    uninstall(ctx, record) {
      const items = spec.files(ctx, ctx.appDir());
      let removed = 0;
      const skipped = [];
      for (const { file } of items) {
        const cur = ctx.readText(file);
        if (cur === null) continue;
        if (!ours(ctx, cur)) { skipped.push(file); continue; }
        ctx.removeFile(file);
        removed++;
      }
      const dirs = [...(record.dirs || [])];
      for (const d of spec.ownDirs ? spec.ownDirs(ctx) : []) if (!dirs.includes(d)) dirs.push(d);
      ctx.removeEmptyDirs(dirs);
      const warnings = skipped.map((f) => `left ${ctx.tilde(f)} alone (not written by this installer)`);
      if (!removed) return same('nothing to remove', { warnings });
      return ok(`removed ${items.length === 1 ? ctx.tilde(items[0].file) : `${removed} file(s) from ${ctx.tilde(path.dirname(items[0].file))}`}`, { warnings });
    },

    inspect(ctx) {
      const items = spec.files(ctx, ctx.appDir());
      const res = { installed: false, versions: new Set(), where: items.map((i) => i.file), problems: [] };
      let n = 0;
      for (const { file } of items) {
        const cur = ctx.readText(file);
        if (cur === null) continue;
        if (ours(ctx, cur)) {
          n++;
          for (const v of versionsIn(ctx, cur)) res.versions.add(v);
        } else if (/session-namer/i.test(cur)) {
          res.problems.push(`${ctx.tilde(file)} is a session-namer file this installer did not write (manual install?)`);
        }
      }
      res.installed = n > 0;
      if (n && n < items.length) res.problems.push(`only ${n} of ${items.length} files present; re-run install`);
      return res;
    },
  };
}

// ------------------------------------------------------ directory link

function readLinkTarget(p) {
  try {
    const st = fs.lstatSync(p);
    if (!st.isSymbolicLink()) return { exists: true, link: false };
    let t = fs.readlinkSync(p);
    t = t.replace(/^\\\\\?\\/, '');
    return { exists: true, link: true, target: path.resolve(path.dirname(p), t) };
  } catch {
    return { exists: false };
  }
}

function removeLink(p) {
  try { fs.unlinkSync(p); } catch { fs.rmdirSync(p); }
}

/** spec = { link: (ctx) => path, target: (ctx, appDir) => path, readme } */
function dirLink(spec) {
  return {
    install(ctx, record) {
      const link = spec.link(ctx);
      const target = spec.target(ctx, ctx.appDir());
      const cur = readLinkTarget(link);
      if (cur.exists && !(cur.link && isOursText(ctx)(cur.target))) {
        return fail(`${ctx.tilde(link)} exists and was not made by this installer; nothing changed (remove it, or ${manualHint(spec.readme)})`);
      }
      if (cur.exists && norm(cur.target, ctx.isWin) === norm(target, ctx.isWin)) return same(`already linked (${ctx.tilde(link)})`);
      addDirs(record, ctx.mkdirs(path.dirname(link)));
      if (!ctx.dryRun) {
        if (cur.exists) removeLink(link);
        fs.symlinkSync(target, link, ctx.isWin ? 'junction' : 'dir');
      }
      return ok(`${cur.exists ? 'relinked' : 'linked'} ${ctx.tilde(link)} -> ${ctx.tilde(target)}`);
    },
    uninstall(ctx, record) {
      const link = spec.link(ctx);
      const cur = readLinkTarget(link);
      if (!cur.exists) return same('nothing to remove');
      if (!(cur.link && isOursText(ctx)(cur.target))) return same('nothing to remove', { warnings: [`left ${ctx.tilde(link)} alone (not made by this installer)`] });
      if (!ctx.dryRun) removeLink(link);
      ctx.removeEmptyDirs(record.dirs || []);
      return ok(`removed link ${ctx.tilde(link)}`);
    },
    inspect(ctx) {
      const link = spec.link(ctx);
      const cur = readLinkTarget(link);
      const res = { installed: false, versions: new Set(), where: [link], problems: [] };
      if (!cur.exists) return res;
      if (cur.link && isOursText(ctx)(cur.target)) {
        res.installed = true;
        for (const v of versionsIn(ctx, `${cur.target}/`)) res.versions.add(v);
        if (!fs.existsSync(cur.target)) res.problems.push(`link target ${ctx.tilde(cur.target)} is missing; re-run install`);
      } else {
        res.problems.push(`${ctx.tilde(link)} exists but was not made by this installer`);
      }
      return res;
    },
  };
}

// --------------------------------------------------- YAML marked block

const BLOCK_START = '# >>> session-namer (managed by the session-namer installer; do not edit inside)';
const BLOCK_END = '# <<< session-namer';
const MODE_RE = /^# mode: (replace-empty|append|append-nl)\r?$/m;
const eolBefore = (text, i) => (text.slice(i - 2, i) === '\r\n' ? 2 : text[i - 1] === '\n' ? 1 : 0);
const eolAt = (text, i) => (text.startsWith('\r\n', i) ? 2 : text[i] === '\n' ? 1 : 0);

/**
 * A marked block appended to (or replacing an empty `[]` of) a YAML
 * top-level sequence. spec = { files: (ctx) => [path], rows: (ctx, appDir) => string, readme, what }
 */
function yamlBlock(spec) {
  const findBlock = (text) => {
    const s = text.indexOf(BLOCK_START);
    if (s < 0) return null;
    const e = text.indexOf(BLOCK_END, s);
    if (e < 0) return { broken: true };
    return { start: s, end: e + BLOCK_END.length, body: text.slice(s, e + BLOCK_END.length) };
  };

  function strip(text) {
    const b = findBlock(text);
    if (!b) return text;
    if (b.broken) throw new Error('found a session-namer start marker without its end marker');
    const mode = (MODE_RE.exec(b.body) || [])[1];
    if (mode === 'replace-empty') return text.slice(0, b.start) + '[]' + text.slice(b.end);
    if (mode === 'append-nl') return text.slice(0, b.start - eolBefore(text, b.start)) + text.slice(b.end);
    // append: block + line end was added at the end
    return text.slice(0, b.start) + text.slice(b.end + eolAt(text, b.end));
  }

  function build(text, rows) {
    const eol = jsonc.detectEol(text);
    const block = (mode) => `${BLOCK_START}\n# mode: ${mode}\n${rows.trimEnd()}\n${BLOCK_END}`.replace(/\n/g, eol);
    const lines = text.split('\n');
    const content = lines.filter((l) => l.trim() && !l.trim().startsWith('#'));
    if (content.length === 1 && content[0].trim() === '[]') {
      const idx = text.indexOf(content[0]) + content[0].indexOf('[]');
      return text.slice(0, idx) + block('replace-empty') + text.slice(idx + 2);
    }
    if (content.length === 0 || content.every((l) => /^(- |\s)/.test(l)) && /^- /.test(content[0])) {
      if (text === '' || text.endsWith('\n')) return `${text}${block('append')}${eol}`;
      return `${text}${eol}${block('append-nl')}`;
    }
    return null;
  }

  return {
    install(ctx, record) {
      const files = spec.files(ctx);
      if (!files.length) return fail(spec.noFiles);
      const rows = spec.rows(ctx, ctx.appDir());
      let changed = 0;
      for (const file of files) {
        const original = ctx.readText(file);
        if (original === null) continue;
        let base;
        try { base = strip(original); } catch (err) { return fail(`${ctx.tilde(file)}: ${err.message}; ${manualHint(spec.readme)}`); }
        const next = build(base, rows);
        if (next === null) return fail(`${ctx.tilde(file)} is not a plain YAML list this installer can extend safely; nothing written, ${manualHint(spec.readme)}`);
        if (next === original) continue;
        const bak = ctx.backup(file, { refresh: findBlock(original) === null });
        try {
          ctx.writeText(file, next);
        } catch (err) {
          if (bak.made) ctx.removeFile(bak.bak);
          return fail(`${err.message}; ${manualHint(spec.readme)}`);
        }
        recordFile(record, file);
        changed++;
      }
      const where = files.map((f) => path.basename(path.dirname(f))).join(', ');
      if (!changed) return same(`already up to date (profiles: ${where})`);
      return ok(`${spec.what} in profiles: ${where}`);
    },
    uninstall(ctx) {
      let changed = 0;
      for (const file of spec.files(ctx)) {
        const original = ctx.readText(file);
        if (original === null) continue;
        let next;
        try { next = strip(original); } catch (err) { return fail(`${ctx.tilde(file)}: ${err.message}; ${manualHint(spec.readme)}`); }
        if (next === original) continue;
        ctx.writeText(file, next);
        ctx.settleBackup(file, next);
        changed++;
      }
      return changed ? ok(`removed the block from ${changed} profile(s)`) : same('nothing to remove');
    },
    inspect(ctx) {
      const files = spec.files(ctx);
      const res = { installed: false, versions: new Set(), where: files, problems: [] };
      for (const file of files) {
        const text = ctx.readText(file) || '';
        const b = findBlock(text);
        if (b && !b.broken) {
          res.installed = true;
          for (const v of versionsIn(ctx, b.body)) res.versions.add(v);
        } else if (/session-namer/.test(text)) {
          res.problems.push(`${ctx.tilde(file)} mentions session-namer outside the managed block (manual install?)`);
        }
      }
      return res;
    },
  };
}

module.exports = {
  jsonEntries, ownedFiles, dirLink, yamlBlock,
  isOursText, isForeign, versionsIn, norm, fwd, fileUrl, ok, same, fail, recordFile, addDirs, isBlank,
  BLOCK_START, BLOCK_END,
};
