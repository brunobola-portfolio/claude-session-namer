# Contributing

Thanks for helping make session titles better. Issues, ideas and pull requests
are all welcome.

## Before you start

- **Bugs:** open an issue with the output of `/session-name --doctor` and the
  last lines of `~/.claude/session-namer/log.txt`. Those two things answer most
  questions.
- **Features:** open an issue first if the change is larger than a few lines,
  so we can agree on the shape before you write it.
- **New agent adapters:** an adapter lives in `adapters/<id>/` and is
  accepted when it has been verified live against a named version of the
  agent. Its README follows the same sections as the existing ones: a "Tested
  with" table (agent version, OS, date), How it works, Requirements, Install,
  Verify, Uninstall, Configuration, Limitations (everything not verified goes
  here) and Log. Add the agent to `lib/install/harnesses.js`, to
  [docs/harnesses.md](docs/harnesses.md) and to `scripts/build-assets.js`.

## Development

```bash
git clone https://github.com/brunobola-portfolio/claude-session-namer
cd claude-session-namer
npm test                       # node --test, no install step, no dependencies
npm run doctor                 # diagnostics against your local Claude Code
npm run assets                 # regenerate the README artwork in docs/assets/
npm run release:check          # versions, install pins and changelog agree
```

To try your working copy inside Claude Code, add it as a local marketplace:

```
/plugin marketplace add /absolute/path/to/claude-session-namer
/plugin install session-namer@claude-session-namer
```

Set `SESSION_NAMER_FAKE_RESULT="Some topic here"` to skip the model call while
testing the hook flow.

## Ground rules

- **Zero runtime dependencies.** Node's standard library only.
- **Every hook exits 0.** A failure must leave the session usable and the
  title unchanged. Log the reason; never throw to Claude Code.
- **Never overwrite a title the user chose.** Add a test for any new path that
  emits a title.
- **Tests for behaviour, not implementation.** `test/namer.test.js` drives
  `run()` with stubbed `git`, `generate` and clock; follow that pattern.
- **Cross-platform.** CI runs Ubuntu, macOS and Windows on Node 18, 22 and 24.
  Path handling goes through `path.win32` / `path.posix` explicitly where it
  matters.
- **Changelog.** Describe user-visible changes under `## [Unreleased]` in
  `CHANGELOG.md`, following the [changelog style](docs/changelog-style.md):
  a **bold lead sentence** per bullet, at most 300 characters, 6 bullets per
  section. `npm test` checks it; the release script dates that section.

## How changes reach `main`

`main` is protected. Every change, including the maintainer's, lands through
a pull request:

- the `ci-ok` check (all OS and Node versions) must pass, on a branch that is
  up to date with `main`;
- one approving review from the code owner, with all review threads resolved;
- squash merge only, so history stays linear; the branch is deleted after merge;
- force pushes and deleting `main` are blocked for everyone;
- release tags (`v*`) can only be created, moved or deleted by the maintainer.

## Releasing (maintainer)

One command bumps the version in `package.json`, `.claude-plugin/plugin.json`
and `.claude-plugin/marketplace.json`, updates every `#vX.Y.Z` install pin in
the docs and dates the `Unreleased` changelog section:

```bash
npm run release -- 1.3.0       # prints the exact git and gh commands to run next
```

Open the release PR, merge it, then tag the merge commit on `main`
(`git tag -a v1.3.0 -m v1.3.0 && git push origin v1.3.0`). The
[Release workflow](.github/workflows/release.yml) refuses a tag that does not
match the manifests or is not on `main`, runs the tests and publishes the
GitHub release with the changelog section as its notes. Claude Code users get
the update from the marketplace (`/plugin marketplace update
claude-session-namer`); everyone else re-runs the pinned `npx` command.

The same workflow then publishes the tag to npm as `session-namer`, with
provenance, through npm trusted publishing (no token in the repository). It
runs once the repository variable `NPM_PUBLISH` is `true` and the npm package
lists this repository and `release.yml` as its trusted publisher; a version
that is already on npm is skipped.

npm only lets you add a trusted publisher to a package that already exists, so
the very first version is published by hand, once:

```bash
git switch main && git pull && git checkout vX.Y.Z   # the first tag whose package.json says "session-namer"
npm login && npm publish --access public             # asks for your 2FA code
```

Then on npmjs.com, package `session-namer` → Settings → Trusted publishing,
add GitHub Actions with repository `brunobola-portfolio/claude-session-namer`
and workflow `release.yml`; set publishing access to "Require two-factor
authentication and disallow tokens"; and set the repository variable with
`gh variable set NPM_PUBLISH --body true`. Every later tag publishes itself.

## Commit messages

Conventional style keeps the changelog easy to write: `feat:`, `fix:`,
`docs:`, `test:`, `chore:`.
