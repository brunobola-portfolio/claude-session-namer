#!/usr/bin/env node
'use strict';
/**
 * Release helper. Zero dependencies.
 *
 *   node scripts/release.js 1.3.0     bump every version and install pin, date the changelog
 *   node scripts/release.js --check   verify they all agree (run by the tests and the release workflow)
 *   node scripts/release.js --notes   print the changelog section of the current version (without its summary)
 *   node scripts/release.js --title   print the release title: "vX.Y.Z · <summary line>"
 *
 * --check also lints the changelog against docs/changelog-style.md.
 *
 * The version lives in package.json, .claude-plugin/plugin.json and
 * .claude-plugin/marketplace.json; the docs pin it as `claude-session-namer#vX.Y.Z`.
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = process.env.SESSION_NAMER_RELEASE_ROOT || path.join(__dirname, '..');
const SEMVER = /^\d+\.\d+\.\d+$/;
const PIN_RE = /claude-session-namer#v(\d+\.\d+\.\d+)/g;
const MANIFESTS = ['package.json', '.claude-plugin/plugin.json', '.claude-plugin/marketplace.json'];

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const write = (rel, text) => fs.writeFileSync(path.join(ROOT, rel), text);

/** Markdown files that may carry an install pin. */
function pinnedDocs() {
  const out = ['README.md', 'README.pt.md', 'SECURITY.md', 'CONTRIBUTING.md'].filter((f) => fs.existsSync(path.join(ROOT, f)));
  for (const dir of ['docs', 'adapters']) {
    const walk = (rel) => {
      for (const ent of fs.readdirSync(path.join(ROOT, rel), { withFileTypes: true })) {
        const child = path.posix.join(rel, ent.name);
        if (ent.isDirectory()) walk(child);
        else if (ent.name.endsWith('.md')) out.push(child);
      }
    };
    walk(dir);
  }
  return out;
}

/** Every "version" string in a manifest, as [jsonPath, value]. */
function manifestVersions(rel) {
  const found = [];
  const visit = (node, where) => {
    if (Array.isArray(node)) node.forEach((v, i) => visit(v, `${where}[${i}]`));
    else if (node && typeof node === 'object') {
      for (const [k, v] of Object.entries(node)) {
        if (k === 'version' && typeof v === 'string') found.push([`${where}.${k}`, v]);
        else visit(v, `${where}.${k}`);
      }
    }
  };
  visit(JSON.parse(read(rel)), rel);
  return found;
}

function changelogSection(version) {
  const text = read('CHANGELOG.md').replace(/\r\n/g, '\n');
  const head = new RegExp(`^## \\[${version.replace(/\./g, '\\.')}\\] - (\\d{4}-\\d{2}-\\d{2})$`, 'm');
  const m = head.exec(text);
  if (!m) return null;
  const rest = text.slice(m.index + m[0].length);
  const next = rest.search(/^## \[/m);
  const body = (next === -1 ? rest : rest.slice(0, next)).trim();
  const sm = SUMMARY_RE.exec(body.split('\n')[0] || '');
  return {
    date: m[1],
    body,
    summary: sm ? sm[1].trim() : '',
    notes: sm ? body.split('\n').slice(1).join('\n').trim() : body,
  };
}

/* Changelog style (docs/changelog-style.md), enforced on every entry. */
const SECTIONS = ['Added', 'Changed', 'Deprecated', 'Removed', 'Fixed', 'Security'];
const SUMMARY_RE = /^_([^_].*[^_]|[^_])_$/;
const LIMITS = { summary: 120, lead: 90, bullet: 300, perSection: 6, perRelease: 12 };

/** @returns {string[]} style problems in CHANGELOG text; empty when it follows the guide. */
function lintChangelog(text) {
  const problems = [];
  const blocks = text.replace(/\r\n/g, '\n').split(/^(?=## )/m).filter((b) => b.startsWith('## '));
  for (const block of blocks) {
    const [heading, ...lines] = block.split('\n');
    const hm = /^## \[(Unreleased|\d+\.\d+\.\d+)\](?: - \d{4}-\d{2}-\d{2})?$/.exec(heading.trim());
    if (!hm) { problems.push(`"${heading.trim()}" is not "## [X.Y.Z] - YYYY-MM-DD" or "## [Unreleased]"`); continue; }
    const name = hm[1];
    if (name !== 'Unreleased' && !/ - \d{4}-\d{2}-\d{2}$/.test(heading.trim())) problems.push(`[${name}] has no date`);

    const where = (s, i) => `[${name}]${s ? ` ${s}` : ''}${i ? `, bullet ${i}` : ''}`;
    const sections = [];
    let section = null;
    let bullet = null;
    let sawSummary = false;
    const closeBullet = () => {
      if (!bullet) return;
      const textOf = bullet.join(' ');
      const n = section.bullets.push(textOf);
      const lead = /^\*\*(.+?)\*\*/.exec(textOf);
      if (!lead) problems.push(`${where(section.name, n)}: start with a **bold lead sentence.**`);
      else if (lead[1].length > LIMITS.lead) problems.push(`${where(section.name, n)}: bold lead is ${lead[1].length} characters (max ${LIMITS.lead})`);
      if (textOf.length > LIMITS.bullet) problems.push(`${where(section.name, n)}: ${textOf.length} characters (max ${LIMITS.bullet}); keep the what and the why, drop the how`);
      bullet = null;
    };

    for (const raw of lines) {
      const line = raw.replace(/\s+$/, '');
      if (!line) { if (bullet) closeBullet(); continue; }
      const sh = /^### (.+)$/.exec(line);
      if (sh) {
        closeBullet();
        const label = sh[1].trim();
        if (!SECTIONS.includes(label)) problems.push(`${where()}: "### ${label}" is not one of ${SECTIONS.join(', ')}`);
        else if (sections.some((s) => s.name === label)) problems.push(`${where()}: "### ${label}" appears twice`);
        else if (sections.length && SECTIONS.indexOf(label) < SECTIONS.indexOf(sections[sections.length - 1].name)) {
          problems.push(`${where()}: "### ${label}" is out of order (${SECTIONS.join(', ')})`);
        }
        section = { name: label, bullets: [] };
        sections.push(section);
        continue;
      }
      if (/^#/.test(line)) { problems.push(`${where(section && section.name)}: no headings other than "### Section" ("${line}")`); continue; }
      if (!section) {
        const sm = SUMMARY_RE.exec(line);
        if (sm && !sawSummary) {
          sawSummary = true;
          if (sm[1].length > LIMITS.summary) problems.push(`${where()}: summary is ${sm[1].length} characters (max ${LIMITS.summary})`);
        } else {
          problems.push(`${where()}: only one _italic summary line_ may come before the first "### Section"`);
        }
        continue;
      }
      if (/^- /.test(line)) { closeBullet(); bullet = [line.slice(2).trim()]; continue; }
      if (/^\s+[-*+] |^\s+\d+\. /.test(line)) { problems.push(`${where(section.name, section.bullets.length + 1)}: no nested lists; split it or say it in one sentence`); continue; }
      if (bullet && /^\s+\S/.test(line)) { bullet.push(line.trim()); continue; }
      problems.push(`${where(section.name)}: every entry is a "- " bullet ("${line.slice(0, 40)}")`);
    }
    closeBullet();

    let total = 0;
    for (const s of sections) {
      total += s.bullets.length;
      if (!s.bullets.length) problems.push(`${where(s.name)}: empty section; remove the heading`);
      if (s.bullets.length > LIMITS.perSection) problems.push(`${where(s.name)}: ${s.bullets.length} bullets (max ${LIMITS.perSection}); merge the small ones`);
    }
    if (total > LIMITS.perRelease) problems.push(`${where()}: ${total} bullets (max ${LIMITS.perRelease}); keep what users will notice`);
    if (name !== 'Unreleased' && !total) problems.push(`${where()}: a release needs at least one entry`);
  }
  return problems;
}

/** @returns {string[]} problems; empty when everything agrees. */
function check() {
  const version = JSON.parse(read('package.json')).version;
  const problems = [];
  if (!SEMVER.test(version)) problems.push(`package.json version "${version}" is not X.Y.Z`);
  for (const rel of MANIFESTS) {
    for (const [where, v] of manifestVersions(rel)) if (v !== version) problems.push(`${where} is ${v}, expected ${version}`);
  }
  for (const rel of pinnedDocs()) {
    for (const m of read(rel).matchAll(PIN_RE)) if (m[1] !== version) problems.push(`${rel} pins v${m[1]}, expected v${version}`);
  }
  const section = changelogSection(version);
  if (!section) problems.push(`CHANGELOG.md has no "## [${version}] - YYYY-MM-DD" entry`);
  else if (!section.body) problems.push(`CHANGELOG.md entry for ${version} is empty`);
  for (const p of lintChangelog(read('CHANGELOG.md'))) problems.push(`CHANGELOG.md ${p} (see docs/changelog-style.md)`);
  return problems;
}

function cmpSemver(a, b) {
  const pa = a.split('.').map(Number); const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
  return 0;
}

function bump(next, today = new Date().toISOString().slice(0, 10)) {
  const current = JSON.parse(read('package.json')).version;
  if (!SEMVER.test(next)) throw new Error(`"${next}" is not a version like 1.3.0`);
  if (cmpSemver(next, current) <= 0) throw new Error(`${next} must be greater than the current ${current}`);

  const changed = [];
  for (const rel of MANIFESTS) {
    const before = read(rel);
    const after = before.replace(/("version"\s*:\s*")\d+\.\d+\.\d+(")/g, `$1${next}$2`);
    if (after !== before) { write(rel, after); changed.push(rel); }
  }
  for (const rel of pinnedDocs()) {
    const before = read(rel);
    const after = before.replace(PIN_RE, `claude-session-namer#v${next}`);
    if (after !== before) { write(rel, after); changed.push(rel); }
  }

  let log = read('CHANGELOG.md');
  const eol = log.includes('\r\n') ? '\r\n' : '\n';
  if (/^## \[Unreleased\][ \t]*$/m.test(log)) {
    log = log.replace(/^## \[Unreleased\][ \t]*$/m, `## [Unreleased]${eol}${eol}## [${next}] - ${today}`);
    write('CHANGELOG.md', log);
    changed.push('CHANGELOG.md');
  } else if (!changelogSection(next)) {
    throw new Error(`CHANGELOG.md needs a "## [Unreleased]" section (or "## [${next}] - ${today}") describing this release`);
  }
  return { current, next, changed };
}

function main(argv) {
  const [arg] = argv;
  if (arg === '--check') {
    const problems = check();
    if (problems.length) {
      process.stderr.write(`Release check failed:\n${problems.map((p) => `  - ${p}`).join('\n')}\n`);
      return 1;
    }
    process.stdout.write(`OK: everything is at ${JSON.parse(read('package.json')).version}\n`);
    return 0;
  }
  if (arg === '--notes') {
    const version = JSON.parse(read('package.json')).version;
    const section = changelogSection(version);
    if (!section) { process.stderr.write(`No changelog entry for ${version}\n`); return 1; }
    process.stdout.write(`${section.notes}\n`);
    return 0;
  }
  if (arg === '--title') {
    const version = JSON.parse(read('package.json')).version;
    const section = changelogSection(version);
    process.stdout.write(`v${version}${section && section.summary ? ` · ${section.summary}` : ''}\n`);
    return 0;
  }
  if (!arg || arg === '-h' || arg === '--help') {
    process.stdout.write('Usage: node scripts/release.js <X.Y.Z> | --check | --notes\n');
    return arg ? 0 : 1;
  }
  try {
    const { current, next, changed } = bump(arg);
    const problems = check();
    process.stdout.write(`Bumped ${current} -> ${next}:\n${changed.map((c) => `  ${c}`).join('\n')}\n`);
    if (problems.length) process.stdout.write(`\nStill to fix:\n${problems.map((p) => `  - ${p}`).join('\n')}\n`);
    process.stdout.write(`
Next steps:
  git switch -c release/v${next} && git commit -am "Release ${next}"
  git push -u origin release/v${next} && gh pr create --fill
  # after the PR is merged into main:
  git switch main && git pull && git tag -a v${next} -m v${next} && git push origin v${next}
  # the Release workflow checks the tag, runs the tests and publishes the GitHub release.
`);
    return problems.length ? 1 : 0;
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    return 1;
  }
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { check, bump, changelogSection, lintChangelog, pinnedDocs, cmpSemver, PIN_RE, LIMITS };
