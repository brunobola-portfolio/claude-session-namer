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
node scripts/build-assets.js   # regenerate the README artwork in docs/assets/
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
- **Versioning.** Bump the version in `package.json`,
  `.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json` together
  (a test enforces it) and add a `CHANGELOG.md` entry.

## How changes reach `main`

`main` is protected. Every change, including the maintainer's, lands through
a pull request:

- the `ci-ok` check (all OS and Node versions) must pass, on a branch that is
  up to date with `main`;
- one approving review from the code owner, with all review threads resolved;
- squash merge only, so history stays linear; the branch is deleted after merge;
- force pushes and deleting `main` are blocked for everyone.

## Commit messages

Conventional style keeps the changelog easy to write: `feat:`, `fix:`,
`docs:`, `test:`, `chore:`.
