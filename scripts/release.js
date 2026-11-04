#!/usr/bin/env node
'use strict';
/**
 * Release helper. Zero dependencies.
 *
 *   node scripts/release.js 1.3.0     bump every version and install pin, date the changelog
 *   node scripts/release.js --check   verify they all agree (run by the tests and the release workflow)
 *   node scripts/release.js --notes   print the changelog section of the current version
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
  return { date: m[1], body: (next === -1 ? rest : rest.slice(0, next)).trim() };
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
    process.stdout.write(`${section.body}\n`);
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

module.exports = { check, bump, changelogSection, pinnedDocs, cmpSemver, PIN_RE };
