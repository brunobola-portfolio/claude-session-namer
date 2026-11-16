# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/). Entries follow the
[changelog style](docs/changelog-style.md).

## [Unreleased]

## [1.4.0] - 2026-11-16

_Install from npm with provenance, and release notes that get to the point._

### Added

- **Install from npm: `npx -y session-namer install --detect`.** Every release
  is published from CI with provenance, so `npm audit signatures` traces the
  package back to its git tag.
- **`npm fund` and GitHub's Sponsor button point to Ko-fi and Buy Me a
  Coffee.**

### Changed

- **Docs and the installer's hints use the npm command.** The git form,
  `npx -y github:brunobola-portfolio/claude-session-namer#vX.Y.Z`, keeps
  working.
- **Shorter release notes, titled with a one-line summary.** Every changelog
  entry follows the [changelog style](docs/changelog-style.md), checked by the
  tests.

### Security

- **CodeQL scans every pull request and the main branch each week.**

## [1.3.1] - 2026-11-10

### Fixed

- **`/session-name` no longer shows `&lt;project&gt;` in the command menu.**
  Claude Code escapes angle brackets in descriptions, so every description now
  reads "project - topic", and a test keeps `<`, `>` and `&` out of them.

## [1.3.0] - 2026-11-04

_Live Codex titles, a working Grok Build adapter and clearer diagnostics._

### Added

- **Codex CLI titles appear live in the TUI.** With `codex app-server daemon
  start` running, the adapter claims the thread as `<project>` at once and
  every attached TUI redraws when the topic lands.
- **Tab titles on macOS and Linux for hooks started without a terminal.** Qwen
  Code starts hooks detached; the hook now finds its parent's terminal. Proven
  in CI on real ptys.
- **Gemini CLI and Qwen Code detect headless runs better.** A prompt passed as
  an argument (`gemini "fix the bug"`) and `CI=true` now count as headless.
- **`/session-name --doctor` explains more.** It warns when Claude Code is
  older than 2.1.152 and says why a dry-run generation failed.

### Changed

- **`npx` installs fetch only the runtime.** 67 files instead of the whole
  repository, and npm no longer warns about a missing `.npmignore`.
- **Docs pin every `npx` command to the release and say what was verified
  where.** Live on Windows 11; the full test suite on Windows, macOS and Linux.

### Fixed

- **Grok Build sessions are renamed.** Grok titles new sessions itself and
  omits `title_is_manual`; the hook now reads Grok's real payload. Verified in
  the Grok TUI, so Grok moves to beta.
- **Grok no longer spends a model call on the Claude Code plugin.** Grok loads
  Claude Code plugins too; the plugin now steps aside.
- **A cancelled DeepSeek Harness title call stops.** `claude -p` and `dsh
  headless` no longer keep running for a discarded title.
- **Failed Amp renames are reported.** Colour codes in `amp threads rename`
  errors no longer hide them.
- **Topics cut by `max_words` no longer end on a dangling word.** "…expresión
  regular en" becomes "…expresión regular".
- **Installer messages are clearer.** Dry runs say "would create …", `status`
  suggests the pinned `npx` command, typos get a suggestion and a failed
  `claude plugin install` shows git's real error.

## [1.2.0] - 2026-11-04

_Thirteen more agents and a one-command installer._

### Added

- **Thirteen more agents.** Beta adapters for Codex CLI, Pi, OpenCode, Kilo
  CLI, Copilot CLI, Cline CLI, Crush, goose, DeepSeek Harness, Amp, Grok Build,
  Gemini CLI and Qwen Code. See [docs/harnesses.md](docs/harnesses.md).
- **One-command installer.** `install --detect` sets up every agent on `PATH`,
  with `uninstall`, `status` and `list`. Config files are backed up, merged and
  restored exactly on uninstall.
- **Docs for architecture, agent support, install, contributing and
  security.** The README artwork comes in light and dark variants.

### Changed

- **Claude Code shows "Naming this session" while the first-prompt hook
  runs.**
- **Minimum Claude Code version is 2.1.152.** It is the first to accept a
  title on SessionStart.
- **The generation timeout is capped at 22 s.** It always fits inside the
  hook's 28 s budget.

### Fixed

- **A `/rename` made after the automatic title is never overwritten.** The
  hook reads `session_title` and steps aside for good.
- **Prompts can no longer steer the topic model.** The prompt is wrapped in
  delimiters and treated strictly as data, so instructions inside it are
  ignored.
- **Topics in Chinese, Japanese, Thai and other unspaced scripts are
  accepted.** They were rejected as "one word" and are now judged by length.
- **`max_words` works, and model prefixes come off cleanly.** `Title: "…"`
  loses its quotes too, and `Topic-based routing` is no longer cut.
- **Project names are right for submodules and bare repositories.** Names,
  topics and the separator are stripped of control, bidi and zero-width
  characters.
- **Safer state and adapters.** A resumed session keeps its final title, the
  temp fallback is per-user and owner-only, and titles reach Amp, goose and
  Cline as plain arguments, never through a shell.

## [1.1.0] - 2026-11-03

_Titles that win the VS Code race, and no model calls for headless runs._

### Changed

- **The final title is re-asserted on the next two prompts.** It replaces the
  `Stop` hook, wins the race against the VS Code auto-title more reliably and
  saves one hook call per turn.
- **`name_headless` is honoured.** Sessions started with `claude -p` are
  skipped unless the option is on, so headless scripts no longer pay a model
  call.
- **The title is generated by the same `claude` that runs the session.** It is
  resolved from `CLAUDE_CODE_EXECPATH` before `PATH`;
  `SESSION_NAMER_CLAUDE_PATH` still wins.

## [1.0.3] - 2026-09-10

### Changed

- **The default generation timeout is 20 s (max 27 s).** Raised after a
  timeout under load on Windows.
- **The log says why a generation failed.** Timeout, exit code and stderr, or
  unusable output, so `--doctor` explains itself.

## [1.0.2] - 2026-09-10

### Fixed

- **Installing the plugin no longer fails with "Duplicate hooks file
  detected".** The manifest no longer redeclares `hooks/hooks.json` and
  `commands/`, which Claude Code finds by itself.

## [1.0.1] - 2026-09-10

### Changed

- **The default generation timeout is 15 s (max 25 s).** End-to-end runs on
  Windows took 9 to 11 s, mostly Claude Code startup.

## [1.0.0] - 2026-09-10

_First release: project - topic titles for Claude Code._

### Added

- **A `<project>` title as soon as a session starts.** Set on startup, resume
  and fork, and never over a title you chose.
- **`<project> - <topic>` after the first prompt.** A headless `claude -p`
  call sums up the prompt in 3 to 7 words, in the prompt's language.
- **The title survives the VS Code auto-title.** A `Stop` hook re-asserts it
  once.
- **`/session-name` command.** Rename and lock, `--regenerate`, `--remote`
  tips and `--doctor` diagnostics.
- **Options per user, environment and repository.** Plugin `userConfig`,
  environment overrides and `.session-namer.json`; worktree-aware project
  names, per-account state and a rotating log.
- **Works with OAuth logins, API keys and Windows.** A lean headless mode with
  no settings, MCP, tools or skills; `--bare` for API keys; native
  `claude.exe` and `taskkill` on Windows.
