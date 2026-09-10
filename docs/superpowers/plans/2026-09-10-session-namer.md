# claude-session-namer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Claude Code plugin that titles every session `<project> - <topic>` automatically via SessionStart / UserPromptSubmit / Stop hooks, cross-platform, zero dependencies.

**Architecture:** One Node entry point `hooks/namer.js <event>` reads the hook JSON from stdin and dispatches to pure modules in `lib/` (config, state, title, generate). Titles are emitted only through `hookSpecificOutput.sessionTitle`. Topic generation shells out to `claude -p --bare` with a hard timeout; every failure path exits 0 with empty stdout.

**Tech Stack:** Node.js ≥ 18, `node:test`, no npm dependencies. Claude Code plugin manifest + marketplace.

**Spec:** `docs/superpowers/specs/2026-09-10-session-namer-design.md`

## Global Constraints

- Node ≥ 18, zero runtime dependencies, CommonJS.
- Hooks in exec form: `"command": "node", "args": ["${CLAUDE_PLUGIN_ROOT}/hooks/namer.js", "<event>"]`.
- Every hook exits 0. Never write to stderr on the normal path. Empty stdout means "no change".
- Title cap 80 chars; topic cap 60 chars; topic 3..7 words (min 2 accepted from model, max `max_words`).
- State under `$CLAUDE_CONFIG_DIR/session-namer/` (default `~/.claude/session-namer/`).
- Internal generation timeout default 8000 ms; platform hook timeout set to 20 s in hooks.json.
- Minimum Claude Code version documented: 2.1.94.
- License MIT. Docs in English (README.md), Portuguese summary (README.pt.md).

---

### Task 1: Scaffold, manifest, hooks.json, test runner

**Files:** `package.json`, `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`, `hooks/hooks.json`, `LICENSE`, `.gitignore`, `.editorconfig`, `test/manifest.test.js`

**Produces:** plugin id `session-namer`; userConfig keys `model, separator, max_words, timeout_ms, project_source, name_headless, enabled`.

- [ ] Test: manifest files parse, hooks.json has SessionStart/UserPromptSubmit/Stop each in exec form pointing at `hooks/namer.js`, userConfig keys match spec.
- [ ] Implement files. `npm test` = `node --test test/`.
- [ ] Commit `chore: scaffold plugin manifest and hooks`.

### Task 2: lib/config.js

**Produces:** `loadConfig({ env, cwd, repoRoot }) -> { enabled, model, separator, maxWords, timeoutMs, projectSource, nameHeadless, projectOverride }`. Precedence: env `SESSION_NAMER_*` / `CLAUDE_SESSION_NAMER=off` > `CLAUDE_PLUGIN_OPTION_*` > `.session-namer.json` at repoRoot (only `project`, `enabled`) > defaults.

- [ ] Tests: defaults; plugin option coercion (`"7"`→7, `"false"`→false); env override wins; `CLAUDE_SESSION_NAMER=off` disables; repo file `enabled:false` disables; repo file invalid JSON ignored; `max_words` clamped to 3..12; `timeout_ms` clamped 1000..20000.
- [ ] Implement. Commit `feat(config): option resolution with precedence`.

### Task 3: lib/title.js (pure)

**Produces:**
- `sanitizeTopic(raw) -> string|null` (strip quotes/backticks, "Title:" prefixes, emoji, control chars, newlines→space, collapse spaces, trim trailing `.:;,!`, cap 60 at word boundary, require 2..12 words, null otherwise)
- `formatTitle(project, topic, { separator }) -> string` (cap 80; trim topic at word boundary first, then project)
- `isEligiblePrompt(prompt) -> boolean` per spec 4.4 (length ≥ 12, not starting with `/ ! #`, not only `@path`/`[Pasted text`, not in ack list)
- `truncatePrompt(prompt, head=1500, tail=300) -> string`
- `resolveProject({ cwd, projectSource, override, git }) -> string` where `git` is an injectable `(args) => string|null`; git source: `rev-parse --git-common-dir` → basename of its parent (handles worktrees); fallback cwd basename; drive/home root → basename anyway.

- [ ] Tests for each function including unicode, emoji, huge input, Windows paths (`C:\\x\\y`), git-common-dir returning `.git` (relative) and absolute worktree paths (`D:/repo/.git/worktrees/a` → `repo`).
- [ ] Implement. Commit `feat(title): sanitising, formatting, eligibility, project resolution`.

### Task 4: lib/state.js

**Produces:** `stateDir(env) -> string`; `readState(dir, sessionId) -> {stage, title, attempts, lastAttemptTs, reasserted, v}|null`; `writeState(dir, sessionId, state)` atomic (tmp+rename); `pruneOld(dir, maxAgeDays=30, maxDeletes=200)`; `appendLog(dir, line)` with 512 KB rotation to `log.txt.1`. All swallow errors; `stateDir` falls back to `os.tmpdir()/claude-session-namer` when the config dir is not writable.

- [ ] Tests with temp dirs: honours `CLAUDE_CONFIG_DIR`; round-trip; corrupt JSON → null; prune deletes only old files; log rotates; unwritable dir → tmp fallback (simulate with a file in place of the dir).
- [ ] Implement. Commit `feat(state): per-session state, pruning, rotating log`.

### Task 5: lib/generate.js

**Produces:** `generateTopic({ prompt, model, timeoutMs, env, spawn, claudePath }) -> Promise<string|null>`; `findClaude(env) -> {command, args}` resolution order: `SESSION_NAMER_CLAUDE_PATH`, `claude` on PATH (with `.exe`/`.cmd` handling on win32 via `cmd.exe /c` for `.cmd`), `%APPDATA%\npm\claude.cmd`, `~/.local/bin/claude`, `~/.claude/local/claude`. Fake mode: if `env.SESSION_NAMER_FAKE_RESULT` is set, resolve with it (for tests/eval). Kills child on timeout (win32: `taskkill /T /F /PID`). Parses `--output-format json` → `.result`; falls back to raw stdout. Sets `SESSION_NAMER_NESTED=1` on the child env.

- [ ] Tests with an injected fake `spawn` (EventEmitter child): success JSON; non-JSON stdout; timeout → null and kill called; spawn error → null; fake result path; `findClaude` on win32 returns cmd.exe form for `.cmd`.
- [ ] Implement. Commit `feat(generate): headless claude call with timeout and fallbacks`.

### Task 6: hooks/namer.js orchestrator

**Produces:** `run(event, input, deps) -> Promise<object|null>` exported for tests; CLI wrapper reads stdin JSON, prints JSON if non-null, always exits 0 (catches everything, logs).

Rules per spec 4.2/4.3/4.4/4.6 and edge table. Output shapes:
- SessionStart: `{hookSpecificOutput:{hookEventName:"SessionStart", sessionTitle}}`
- UserPromptSubmit: `{hookSpecificOutput:{hookEventName:"UserPromptSubmit", sessionTitle}}`
- Stop: same with `hookEventName:"Stop"`.

- [ ] Tests (fake deps: config, state in temp dir, generate stub): startup no title → provisional `<project>`; startup with session_title ≠ ours → stage user, no output; resume with our title → no output; `agent_type` present → null; clear/compact → null; first eligible prompt → final title, state final; ineligible prompt → null, stays provisional; generate null → null, attempts++; attempts ≥3 → null without calling generate; rate-limit 60 s; plugin enabled mid-session (no state) → final directly; Stop once → re-emit, then null; disabled → null; nested env → null; malformed stdin → exits 0 empty.
- [ ] Implement. Commit `feat(hooks): namer orchestrator`.

### Task 7: /session-name command

**Files:** `commands/session-name.md` (frontmatter `description`, `argument-hint`), `hooks/session-name-cli.js` invoked by the command via `!` shell embedding for `--doctor` / `--remote` output. The command instructs Claude to: with a topic argument → run `/rename "<project> - <topic>"` guidance is impossible from Claude; instead the command's markdown tells Claude to call `node ${CLAUDE_PLUGIN_ROOT}/hooks/session-name-cli.js set "<topic>"` which writes state and prints the title, and to tell the user the title was set (the actual rename is applied by the next UserPromptSubmit hook, which reads a `pending_title` in state). `--doctor` prints diagnostics; `--remote` prints Remote Control instructions.

- [ ] Tests: `set` writes pending; orchestrator applies `pending_title` on next UserPromptSubmit even if stage final; `--doctor` output contains node version and resolved claude path; `--remote` mentions `/rc` and `remoteControlAtStartup`.
- [ ] Implement. Commit `feat(command): /session-name set, --doctor, --remote`.

### Task 8: Docs, CI, release

**Files:** `README.md`, `README.pt.md`, `CHANGELOG.md`, `.github/workflows/ci.yml` (ubuntu/macos/windows × node 18/20/22 running `npm test`), `evals/` with 3 `claude plugin eval` scenarios if the CLI supports it locally.

- [ ] README sections: hero + before/after example, 60-second install (`/plugin marketplace add brunobola-portfolio/claude-session-namer`, `/plugin install session-namer@claude-session-namer`), how it works (3 hooks diagram), examples (pt/en prompts → titles), configuration table, `/session-name` usage, Remote Control section, VS Code caveat, privacy, troubleshooting (`--doctor`), uninstall, requirements, license.
- [ ] Commit `docs: README, changelog, CI`.

### Task 9: Real-world verification

- [ ] Install locally from the repo as a marketplace (`claude plugin marketplace add D:\Implementacoes\claude-session-namer` or `/plugin marketplace add`), enable, run `claude --init-only` in a temp git repo → SessionStart output; run a real interactive session with a pt prompt and confirm title in `claude --resume` list; check log. Fix anything found.
- [ ] Create GitHub repo under `brunobola-portfolio`, push, tag `v1.0.0`.
