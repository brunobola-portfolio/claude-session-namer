'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.join(__dirname, '..');
const script = path.join(root, 'scripts', 'release.js');
const { check, cmpSemver, lintChangelog, absoluteLinks } = require('../scripts/release');

test('release notes point relative links at the tag and leave the rest alone', () => {
  const base = 'https://github.com/brunobola-portfolio/claude-session-namer/blob/v1.4.0';
  assert.equal(absoluteLinks('[style](docs/changelog-style.md) [a](./adapters/pi/README.md)', 'v1.4.0'),
    `[style](${base}/docs/changelog-style.md) [a](${base}/adapters/pi/README.md)`);
  assert.equal(absoluteLinks('[root](/LICENSE) [t](docs/a.md "Title") ![art](docs/assets/x.svg)', 'v1.4.0'),
    `[root](${base}/LICENSE) [t](${base}/docs/a.md "Title") ![art](https://github.com/brunobola-portfolio/claude-session-namer/raw/v1.4.0/docs/assets/x.svg)`);
  const keep = '[npm](https://www.npmjs.com/package/session-namer) [top](#install) [mail](mailto:x@y.z) `arr[0](x)`';
  assert.equal(absoluteLinks(keep, 'v1.4.0'), keep);
});

test('README artwork uses absolute URLs, so it also renders on npmjs.com', () => {
  // npm rewrites a relative <img src> but not <source srcset>, so dark-mode and
  // phone variants broke on the package page.
  const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
  const refs = [...readme.matchAll(/\b(?:src|srcset)="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(refs.length > 0);
  assert.deepEqual(refs.filter((u) => !/^https:\/\//.test(u)), []);
});

const lint = (body, heading = '## [Unreleased]') => lintChangelog(`# Changelog\n\n${heading}\n\n${body}\n\n## [1.0.0] - 2026-01-01\n\n### Added\n\n- **First release.**\n`);

test('changelog lint accepts the documented shape', () => {
  assert.deepEqual(lint('_Faster titles._\n\n### Added\n\n- **Zed gets titles.** Set up by\n  `install --detect`.\n\n### Fixed\n\n- **Slow `git` no longer delays the title.**'), []);
  assert.deepEqual(lint(''), [], 'an empty Unreleased section is fine');
  assert.deepEqual(lint('### Fixed\n\n- **A thing.**', '## [1.3.1] - 2026-11-10'), []);
});

test('changelog lint checks every release, not only Unreleased', () => {
  const p = lint('', '## [Unreleased]\n\n## [1.1.0] - 2026-02-01\n\n### Fixed\n\n- An old entry without a lead.');
  assert.equal(p.length, 1, p.join('\n'));
  assert.match(p[0], /\[1\.1\.0\] Fixed, bullet 1: start with a \*\*bold lead/);
  assert.match(lint('', '## [1.1.0]').join('\n'), /\[1\.1\.0\] has no date/);
});

test('changelog lint rejects long, unbolded, nested, unordered or oversized entries', () => {
  const one = (body) => { const p = lint(body); assert.equal(p.length, 1, p.join('\n')); return p[0]; };
  assert.match(one('### Fixed\n\n- A thing without a lead.'), /bold lead/);
  assert.match(one(`### Fixed\n\n- **Lead.** ${'x'.repeat(300)}`), /characters \(max 300\)/);
  assert.match(one(`### Fixed\n\n- **${'y'.repeat(91)}**`), /bold lead is 91/);
  assert.match(one('### Fixed\n\n- **Lead.**\n  - nested'), /no nested lists/);
  assert.match(one('### Fixed\n\n- **A.**\n\n### Added\n\n- **B.**'), /out of order/);
  assert.match(one('### Improvements\n\n- **A.**'), /not one of/);
  assert.match(one('### Added\n\n### Fixed\n\n- **A.**'), /empty section/);
  assert.match(one('### Fixed\n\n- **A.**\n\nA loose paragraph.'), /"- " bullet/);
  assert.match(one('Some intro text.\n\n### Fixed\n\n- **A.**'), /italic summary/);
  assert.match(one(`_${'s'.repeat(121)}_\n\n### Fixed\n\n- **A.**`), /summary is 121/);
  assert.match(one(`### Fixed\n\n${'- **A.**\n'.repeat(7)}`), /7 bullets \(max 6\)/);
  const many = ['Added', 'Changed', 'Fixed'].map((s) => `### ${s}\n\n${'- **A.**\n'.repeat(5)}`).join('\n');
  assert.match(one(many), /15 bullets \(max 12\)/);
});

test('every manifest version, install pin and changelog entry agree', () => {
  assert.deepEqual(check(), []);
});

test('cmpSemver orders versions numerically', () => {
  assert.ok(cmpSemver('1.10.0', '1.9.9') > 0);
  assert.ok(cmpSemver('1.2.0', '1.2.0') === 0);
  assert.ok(cmpSemver('1.2.0', '2.0.0') < 0);
});

function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sn-release-'));
  const put = (rel, text) => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  };
  put('package.json', JSON.stringify({ name: 'x', version: '1.2.0' }, null, 2));
  put('.claude-plugin/plugin.json', JSON.stringify({ name: 'session-namer', version: '1.2.0' }, null, 2));
  put('.claude-plugin/marketplace.json', JSON.stringify({ metadata: { version: '1.2.0' }, plugins: [{ name: 'session-namer', version: '1.2.0' }] }, null, 2));
  put('README.md', 'npx -y session-namer@1.2.0 install --detect\n/plugin install session-namer@claude-session-namer\n');
  put('README.pt.md', 'npx -y github:brunobola-portfolio/claude-session-namer#v1.2.0 install\n');
  put('docs/install.md', 'pin: claude-session-namer#v1.2.0\n');
  put('adapters/x/README.md', 'nothing pinned here\n');
  put('CHANGELOG.md', '# Changelog\n\n## [Unreleased]\n\n_Small fixes._\n\n### Fixed\n\n- **A thing.**\n\n## [1.2.0] - 2026-11-04\n\n### Added\n\n- **Old.**\n');
  return dir;
}

const run = (dir, ...args) => spawnSync(process.execPath, [script, ...args], {
  env: { ...process.env, SESSION_NAMER_RELEASE_ROOT: dir }, encoding: 'utf8',
});

test('release bumps manifests, pins and dates the Unreleased section', () => {
  const dir = sandbox();
  try {
    const r = run(dir, '1.2.1');
    assert.equal(r.status, 0, r.stderr + r.stdout);
    for (const rel of ['package.json', '.claude-plugin/plugin.json']) assert.equal(JSON.parse(fs.readFileSync(path.join(dir, rel), 'utf8')).version, '1.2.1');
    const market = JSON.parse(fs.readFileSync(path.join(dir, '.claude-plugin/marketplace.json'), 'utf8'));
    assert.equal(market.metadata.version, '1.2.1');
    assert.equal(market.plugins[0].version, '1.2.1');
    assert.equal(fs.readFileSync(path.join(dir, 'README.md'), 'utf8'), 'npx -y session-namer@1.2.1 install --detect\n/plugin install session-namer@claude-session-namer\n');
    assert.match(fs.readFileSync(path.join(dir, 'README.pt.md'), 'utf8'), /claude-session-namer#v1\.2\.1 install/);
    assert.match(fs.readFileSync(path.join(dir, 'docs/install.md'), 'utf8'), /#v1\.2\.1/);
    const log = fs.readFileSync(path.join(dir, 'CHANGELOG.md'), 'utf8');
    assert.match(log, /## \[Unreleased\]\n\n## \[1\.2\.1\] - \d{4}-\d{2}-\d{2}\n\n_Small fixes\._\n\n### Fixed\n\n- \*\*A thing\.\*\*/);
    assert.equal(run(dir, '--check').status, 0);
    assert.equal(run(dir, '--notes').stdout.trim(), '### Fixed\n\n- **A thing.**');
    assert.equal(run(dir, '--title').stdout.trim(), 'v1.2.1 · Small fixes.');

    const npmFooter = run(dir, '--footer', '--npm').stdout;
    assert.match(npmFooter, /`npx -y session-namer@1\.2\.1 install --detect`/);
    assert.match(npmFooter, /\*\*Verify\.\*\* \[session-namer@1\.2\.1 on npm\]\(https:\/\/www\.npmjs\.com\/package\/session-namer\/v\/1\.2\.1\)/);
    assert.match(npmFooter, /\*\*Full changelog:\*\* \[v1\.2\.0\.\.\.v1\.2\.1\]\(https:\/\/github\.com\/brunobola-portfolio\/claude-session-namer\/compare\/v1\.2\.0\.\.\.v1\.2\.1\)/);
    const gitFooter = run(dir, '--footer').stdout;
    assert.match(gitFooter, /github:brunobola-portfolio\/claude-session-namer#v1\.2\.1 install --detect/);
    assert.doesNotMatch(gitFooter, /Verify/, 'no provenance claim when npm did not publish');

    const body = run(dir, '--pr-body').stdout;
    assert.match(body, /^### Fixed\n\n- \*\*A thing\.\*\*/);
    assert.match(body, /git tag -a v1\.2\.1 -m v1\.2\.1 && git push origin v1\.2\.1/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('release refuses a version that is not newer, and check reports drift', () => {
  const dir = sandbox();
  try {
    const same = run(dir, '1.2.0');
    assert.equal(same.status, 1);
    assert.match(same.stderr, /must be greater/);
    fs.writeFileSync(path.join(dir, 'README.md'), 'claude-session-namer#v1.1.0\n');
    const drift = run(dir, '--check');
    assert.equal(drift.status, 1);
    assert.match(drift.stderr, /README\.md pins v1\.1\.0, expected v1\.2\.0/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
