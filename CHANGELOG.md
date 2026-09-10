# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [1.0.1] - 2026-09-10

### Changed

- Default generation timeout raised from 12 s to 15 s (max 25 s) after measuring
  9 to 11 s end-to-end on Windows, where Claude Code startup dominates.

## [1.0.0] - 2026-09-10

### Added

- SessionStart hook: provisional `<project>` title on startup, resume and fork,
  never overwriting a user-set title.
- UserPromptSubmit hook: on the first eligible prompt, a headless `claude -p`
  call summarises the prompt into a 3 to 7 word topic in the prompt's language
  and the title becomes `<project> - <topic>`.
- Stop hook: re-asserts the final title once to survive the VS Code
  auto-title rewrite.
- `/session-name` command: manual rename and lock, `--regenerate`, `--remote`
  tips, `--doctor` diagnostics.
- Options via plugin `userConfig`, environment overrides and a per-repository
  `.session-namer.json`.
- Worktree-aware project resolution, per-account state under
  `$CLAUDE_CONFIG_DIR/session-namer/`, rotating log, pruning of old state.
- Lean headless mode (no settings, MCP, tools or skills) that works with OAuth
  logins and API keys; `--bare` opt-in for API-key users.
- Windows support: exec-form hooks, native `claude.exe` resolution behind the
  npm shim, `taskkill` on timeout.
- 52 unit and contract tests with `node:test`, CI on Linux, macOS and Windows
  with Node 18, 20 and 22.
