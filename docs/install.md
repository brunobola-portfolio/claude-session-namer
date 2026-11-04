# Install

One command installs session-namer into one or more AI coding agents. It
needs Node.js 18+ and nothing else; the installer has no dependencies.

```
npx -y github:brunobola-portfolio/claude-session-namer#v1.3.0 install <agent...>
npx -y github:brunobola-portfolio/claude-session-namer#v1.3.0 install --detect     # every supported agent found on PATH
npx -y github:brunobola-portfolio/claude-session-namer#v1.3.0 uninstall <agent...|--all>
npx -y github:brunobola-portfolio/claude-session-namer#v1.3.0 status               # what is installed where, versions, problems
npx -y github:brunobola-portfolio/claude-session-namer#v1.3.0 list                 # supported agents + support level
```

The `#vX.Y.Z` after the repository name pins the release (npm's syntax for a
git ref); without it, `npx` runs whatever is on `main`. Every command in these
docs is pinned, and the release script moves the pins on each release.

Agent ids: `claude`, `codex`, `pi`, `opencode`, `kilo`, `copilot`, `cline`,
`amp`, `crush`, `goose`, `deepseek`, `grok`, `gemini`, `qwen`. Also accepted:
`dsh`, `kilocode`, `gh-copilot`, `github-copilot`, `claude-code`,
`gemini-cli`, `qwen-code`, `grok-build`, `opencode-ai`. A mistyped id gets a
"did you mean …?" suggestion.

Add `--dry-run` to `install` or `uninstall` to see the plan without writing
anything. There are no prompts. The exit code is non-zero only when an agent
you asked for actually failed (✗), not when there was nothing to do (–).
`install --detect` skips an agent that is on PATH but not set up yet (for
example `dsh` before its first start) with `– skipped (…)` and exit code 0.
Naming that agent explicitly still fails with the reason.

From a clone, `node bin/session-namer.js <command>` does the same thing.

Where the topic comes from: topics are written by the `claude` CLI with your
login. Pi uses Pi's own model first, Codex can opt in to `codex exec`
(`SESSION_NAMER_CODEX_GENERATOR=codex`), and OpenCode, Kilo, Crush and goose
fall back to the agent's own title when `claude` is missing. The other agents
need `claude`.

## What install does

1. **Copies session-namer to a stable home.** `npx` runs from a throwaway
   cache, so the files it needs (`lib/`, `hooks/`, `adapters/`, `commands/`,
   `bin/`, `package.json`, `LICENSE`) are first copied to
   `~/.session-namer/app/<version>/`. Set `SESSION_NAMER_HOME` to put it
   somewhere else. Every agent config points at that folder.
2. **Registers the adapter in each agent**, the same way its
   `adapters/<id>/README.md` describes, using only the agent's documented
   config files or CLI.
3. **Records what it wrote** in `~/.session-namer/installed.json` (files it
   created, keys it added, folders it made), so `uninstall` can undo exactly
   that. The record is saved after each agent, with an atomic write. A
   corrupt `installed.json` is reported and copied to
   `installed.json.corrupt-<time>`, never silently dropped; uninstall still
   finds entries by their path.

Claude Code is the exception: `install claude` runs
`claude plugin marketplace add brunobola-portfolio/claude-session-namer` and
`claude plugin install session-namer@claude-session-namer`, or reports that
the plugin is already installed. It touches nothing else and does not use the
copy in `~/.session-namer`.

### Safety rules for config files

- **Backup.** Before editing an existing file, the original is copied to
  `<file>.session-namer.bak`. A backup taken while session-namer entries are
  in the file is never overwritten; one taken when none are left is refreshed,
  so it never holds a stale version of your file. When uninstall restores the
  file to exactly the backup's bytes, the backup is deleted; otherwise it is
  kept and uninstall lists it.
- **Merge, never replace.** Entries are appended to the existing arrays. Your
  own hooks, plugins, MCP servers and settings stay where they are.
- **Comments survive.** JSON and JSONC files (`opencode.jsonc`, `kilo.jsonc`,
  `settings.json`, `hooks.json`, `crush.json`) are edited as text: only the
  inserted span changes, so comments, trailing commas, key order,
  indentation and CRLF line endings stay as they were. An empty file counts
  as `{}`. If a file does not parse, the installer writes nothing and prints
  the manual steps instead (✗).
- **Atomic, private, through links.** Writes go to a temporary file that is
  renamed over the original. A symlinked config is written through to its
  target (the link stays a link), the file keeps its permissions (an API-key
  file stays private), and a read-only file is refused (✗) instead of
  replaced.
- **Idempotent.** A second `install` with the same version changes no byte.
- **Exact undo.** `uninstall` removes only entries that point into
  `~/.session-namer/app/`. Keys and files it created are removed too, so a
  config file goes back to its original bytes, unless the agent rewrote it
  in the meantime (see below). Paths are compared decoded, so a home folder
  with spaces, accents, `#` or `%` works.
- **Never someone else's file.** A shim, hook file or link of the same name
  that this installer did not write is left alone, and install fails for that
  agent with a clear message.
- **No secrets in the output.** Several of these files hold API tokens. The
  installer reports what it changed, never file contents.
- **`--dry-run` and `status` change nothing.** Their only side effects are
  running `<agent> --version` for each agent found on PATH and
  `claude plugin list --json`.

## Update

Run install again with the version you want; it copies the new files,
rewrites the pointers in place (the old entry is replaced, not duplicated) and
deletes old `app/<version>` folders that no agent points at any more:

```
npx -y github:brunobola-portfolio/claude-session-namer#v1.3.0 install <agents>
```

Agents you did not name keep their version; `status` shows them as
upgradeable. Codex asks you to trust its hooks again after an upgrade because
the hook command changed.

Claude Code updates through its own plugin system:
`/plugin marketplace update claude-session-namer` (then restart Claude Code).

## Per agent

| id | What install does | Manual follow-up | How to verify |
| :-- | :-- | :-- | :-- |
| `claude` | `claude plugin marketplace add` + `claude plugin install session-namer@claude-session-namer` (skipped when already installed) | Restart open Claude Code sessions | `claude plugin list` |
| `codex` | Adds `SessionStart` and `UserPromptSubmit` hook groups to `~/.codex/hooks.json` (`$CODEX_HOME`) | In `codex`, open `/hooks` and **trust** the two session-namer hooks. If `session-namer@claude-session-namer` shows up as a Codex plugin, do not trust *its* hooks. For titles in the TUI, run `codex app-server daemon start` once from a normal (not administrator) terminal | `/hooks` lists them; with the daemon running, the TUI title becomes `<project> - <topic>` after your first prompt |
| `pi` | `pi install ~/.session-namer/app/<v>/adapters/pi` (pi records it in `~/.pi/agent/settings.json`) | Start a new session or `/reload` | `pi list` |
| `opencode` | Adds a `file:///…/adapters/opencode/index.mjs` entry to `plugin` in `~/.config/opencode/opencode.jsonc` (or `opencode.json`) | Restart OpenCode | `opencode session list` after a real message |
| `kilo` | Same plugin entry in the first of `~/.config/kilo/kilo.jsonc`, `kilo.json`, `opencode.jsonc`, `opencode.json` that exists (default `kilo.jsonc`) | Restart Kilo | `kilo debug config` lists the entry under `plugin`; `kilo session list` after a real message |
| `copilot` | Writes the shim `~/.copilot/extensions/session-namer/extension.mjs` (`$COPILOT_HOME`) | Copilot extensions are experimental: `/experimental on` once, or `copilot --experimental`. Restart Copilot | Session picker / `copilot --resume` shows the name |
| `cline` | Writes `TaskStart.js` and `UserPromptSubmit.js` stubs in `~/.cline/hooks` (`$CLINE_DIR`) | None | `cline history` shows the title a few seconds after the task starts |
| `amp` | Writes the shim `~/.config/amp/plugins/session-namer.js` | `plugins: reload` (Ctrl+O) or a new session; renames use your Amp login (`amp login`) | `amp plugins list` |
| `crush` | Adds a `session-namer` entry to `hooks.TurnStart` in `~/.config/crush/crush.json` | Start a new session | The header / `crush session list` after the first prompt |
| `goose` | Links `~/.agents/plugins/session-namer` to the adapter folder (a junction on Windows) | **Windows:** goose runs hooks with `sh -c`; Git for Windows' `bin` must be on your user `PATH`, or the hook never fires. goose adds a `plugins:` entry to its own `config.yaml` (harmless) | `goose session list --format json` |
| `deepseek` | Adds a marked block to every existing `~/.dsh/profiles/<profile>/cordis.patch.yml` (`$DSH_HOME`): disables the stock title provider, inserts session-namer | Restart dsh. No profiles yet? Start `dsh` once, or use `--patch` (see the adapter README) | `dsh <profile> --dump-config` shows `id: session-namer` |
| `grok` | Writes `~/.grok/hooks/session-namer.json` | Restart Grok and answer its folder-trust prompt once per folder (until then Grok runs no hooks there) | `/hooks`; `grok sessions list` after the first prompt |
| `gemini` | Adds 3 hooks to `~/.gemini/settings.json` (`$GEMINI_CLI_HOME`) and sets `ui.hideWindowTitle: true` if it is unset | Terminal tab only (Gemini has no title API). If you set `hideWindowTitle` to `false` yourself, the installer keeps it and tells you to change it | The tab title changes a few seconds after your first prompt |
| `qwen` | Adds 3 hooks to `~/.qwen/settings.json` (`$QWEN_HOME`) and sets `ui.hideWindowTitle: true` if it is unset | Terminal tab only | As for Gemini |

`list` shows the support level of each agent: **stable** (Claude Code),
**beta** (Codex, Pi, OpenCode, Kilo, Copilot, Cline, Crush, goose, DeepSeek,
Grok), **partly verified** (Amp) and **tab title only** (Gemini, Qwen).
Factory Droid and Cursor CLI are not supported: neither has a session-title
API.

**Kilo's global config, checked live.** With Kilo CLI 7.8.18 in a sandbox
home (`HOME`, `USERPROFILE` and the `XDG_*` folders pointed at a temp
folder), `kilo debug config` picked up a probe value from
`~/.config/kilo/kilo.jsonc`, both with `XDG_CONFIG_HOME` set and without it,
and also from `kilo.json`, `opencode.jsonc` and `opencode.json` in the same
folder. A `file:///…` entry in `plugin` was merged with Kilo's built-in
plugins. One caveat: on its first start Kilo rewrites `kilo.jsonc` itself (it
adds `"$schema"` and a `permission` block), so after uninstall that file
matches your original except for what Kilo added.

## Uninstall

```
npx -y github:brunobola-portfolio/claude-session-namer#v1.3.0 uninstall codex opencode
npx -y github:brunobola-portfolio/claude-session-namer#v1.3.0 uninstall --all
```

`--all` covers every agent whose config points at `~/.session-namer`, plus
Claude Code only if this installer installed it (a plugin you installed with
`/plugin install` stays). When nothing points at the copy any more,
`~/.session-namer` is deleted. Titles that were already set stay as they are.

What uninstall deliberately leaves behind, because the agent wrote it, not
the installer:

- Codex: the trust entries it adds to `config.toml` when you trust the hooks.
- goose: the `plugins:` entry for the link in its `config.yaml`.
- Kilo: the `"$schema"` and `permission` keys it adds to `kilo.jsonc`.
- Qwen Code: its `"$version"` key in `settings.json`, so a settings file the
  installer created is kept (with only that key) instead of deleted.
- Backups that differ from the restored file (uninstall lists them).
- Adapter logs and state, e.g. `~/.claude/session-namer/`,
  `~/.codex/session-namer/`, `~/.gemini/session-namer/`.

## Troubleshooting

- **`status` first.** It lists every agent with its version, where
  session-namer is registered, the session-namer version it points at, and
  problems such as a missing copy, an entry this installer did not write (a
  manual install, which would title sessions twice), or a required setting.
  Each row ends with the next step (`→`): how to check it works, or the
  install command for an agent that is on PATH but not set up. Paths are
  shortened with `~`, `%APPDATA%` and `$XDG_CONFIG_HOME`.
- **"could not edit … safely".** The config did not parse (or a key has an
  unexpected type). Nothing was written. Fix the file, or add the entry by
  hand from the adapter README.
- **"is read-only".** Make the file writable, then re-run install.
- **"exists and was not written by this installer".** A file or link of your
  own sits where the shim goes. Remove or rename it, then re-run install.
- **Double titles / two log lines per session.** An older manual install is
  still registered (`status` flags it). Remove it as its README describes,
  e.g. `pi remove <path>`.
- **Codex hooks don't run.** They are untrusted until you approve them in
  `/hooks`, again after every upgrade.
- **Copilot does nothing.** Turn on experimental mode (`/experimental on`).
- **goose does nothing on Windows.** `sh` is not on the `PATH` goose sees.
  Running `install goose` from PowerShell says so.
- **Copy in use.** On Windows a running agent can lock files in an old
  `app/<version>`. The installer reports it and deletes it on a later run.
- **The topic never arrives.** Run `claude -p "hi"` to check that the Claude
  Code CLI works and is logged in, then check the adapter's log (listed in its
  README).

## Manual install

Each adapter's README documents the exact manual steps, if you prefer to edit
configs yourself or work from a clone:

- [Codex](../adapters/codex/README.md)
- [Pi](../adapters/pi/README.md)
- [OpenCode and Kilo](../adapters/opencode/README.md)
- [GitHub Copilot CLI](../adapters/copilot/README.md)
- [Cline](../adapters/cline/README.md)
- [Amp](../adapters/amp/README.md)
- [Crush](../adapters/crush/README.md)
- [goose](../adapters/goose/README.md)
- [DeepSeek Harness](../adapters/deepseek/README.md)
- [Grok Build](../adapters/grok/README.md)
- [Gemini CLI](../adapters/gemini/README.md)
- [Qwen Code](../adapters/qwen/README.md)

Point those snippets at your clone instead of `~/.session-namer/app/<version>`.
Don't mix the two for the same agent, or sessions get titled twice.
