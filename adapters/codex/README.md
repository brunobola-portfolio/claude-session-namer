# session-namer for Codex CLI

Gives Codex CLI threads the same automatic `<project> - <topic>` names the
Claude Code plugin produces, e.g. `arcva-2.0 - Migração de faturas para V10`.
Status: beta. It relies on the Codex app-server protocol (`thread/name/set`,
`thread/read`), which OpenAI labels "experimental", so a Codex update can
break it; the only effect then is that threads stay unnamed. It never blocks
a turn.

| Tested with | OS | Date |
| :-- | :-- | :-- |
| Codex CLI 0.163.0 | Windows 11 | 2026-11-03 |

## How it works

Codex hooks cannot return a title, so the adapter works like this:

1. `UserPromptSubmit` runs `hook.js`. It uses the same rules as the Claude
   plugin: it skips trivial prompts (`ok`, `/commands`, ...), skips `codex exec`
   threads, stops after 3 attempts, and stops once a thread is named. It then
   starts a **detached** worker and exits in about 0.3 s. It prints nothing,
   because plain hook stdout would be added to the model context.
2. The worker calls `thread/read` through the app server. If the thread is
   already named (by you, `/rename`, or the desktop app), it is left alone.
   Sub-agent, ephemeral and exec threads are also left alone.
3. It generates the topic with the headless `claude -p` call the Claude Code
   plugin uses (no tools, no MCP servers, one turn). See
   [Configuration](#configuration) for the opt-in `codex exec` generator.
4. It reads the thread again (in case you renamed it meanwhile), then calls
   `thread/name/set`. It first tries the shared daemon (`codex app-server proxy`),
   so attached clients get `thread/name/updated` live. If the daemon is not
   running, it falls back to a private `codex app-server`.

The project name comes from git, as in the Claude plugin, and
`.session-namer.json` works the same way.

### Why `claude -p` is the default generator

`codex exec` is a full agent: even with `-s read-only` its shell tool can
**read** any file the user can, for example `~/.codex/auth.json`. Your prompt
goes into the title request, so a prompt injection hidden in pasted text could
steer that agent into reading a file and putting its content in the title.
Codex 0.163 has no single switch that turns all tools off for `exec`. When you
opt in to `codex exec`, the adapter switches off every tool feature it can
(`--disable shell_tool`, `unified_exec`, `code_mode_host`, `view_image`,
`browser_use`, `computer_use`, `apps`, plus `-c web_search="disabled"`). In a
live test on Windows, asked to read a file, the model then answered that it
had no tool for it, and topic generation still worked. Those are per-version
feature flags, though, so `codex exec` stays opt-in. If a future Codex drops
one of these flag names, `codex exec` exits with "Unknown feature flag" and the
thread simply stays unnamed.

## Requirements

- Node.js 18+ on `PATH` and Codex CLI with hooks enabled (the default).
- The `claude` CLI, logged in, for the default generator. Without Claude Code,
  set `SESSION_NAMER_CODEX_GENERATOR=codex` (see above for the trade-off).

## Install

Recommended, one line:

```bash
npx -y github:brunobola-portfolio/claude-session-namer install codex
```

The installer copies the runtime to `~/.session-namer/app/<version>` and adds
the two hooks to `~/.codex/hooks.json`. Then do step 3 below (trust the hooks).

Manual install:

1. Clone this repository somewhere permanent (`<repo>` below).
2. Create `~/.codex/hooks.json`, or merge this into an existing one. Use an
   absolute path with forward slashes:

```json
{
  "hooks": {
    "SessionStart": [
      { "matcher": "startup|resume", "hooks": [
        { "type": "command", "command": "node \"<repo>/adapters/codex/hook.js\" SessionStart", "timeout": 10 }
      ] }
    ],
    "UserPromptSubmit": [
      { "hooks": [
        { "type": "command", "command": "node \"<repo>/adapters/codex/hook.js\" UserPromptSubmit", "timeout": 10 }
      ] }
    ]
  }
}
```

   You can put the equivalent inline TOML in `~/.codex/config.toml` instead.
   Use one form or the other, not both:

```toml
[[hooks.UserPromptSubmit]]
[[hooks.UserPromptSubmit.hooks]]
type = "command"
command = 'node "<repo>/adapters/codex/hook.js" UserPromptSubmit'
timeout = 10
```

3. Start `codex`, open `/hooks`, and **trust** the two session-namer hooks.
   Codex skips untrusted hooks, and asks you to trust them again whenever the
   hook definition changes.

The `SessionStart` hook only prunes old state files, so you can leave it out.

## Verify

Send a real prompt in a new thread. A few seconds later the thread name shows
in the `codex resume` picker as `<project> - <topic>`, and the log has a
`final "<project> - <topic>"` line.

## Uninstall

```bash
npx -y github:brunobola-portfolio/claude-session-namer uninstall codex
```

Or by hand:

1. Remove the two session-namer entries from `~/.codex/hooks.json` (or delete
   the file if nothing else is in it), or remove the matching `[[hooks.*]]`
   tables from `config.toml`.
2. Optionally remove the trust entries from `config.toml`. They are
   `[hooks.state.'<path>:session_start:0:0']` and
   `[hooks.state.'<path>:user_prompt_submit:0:0']`.
3. Optionally delete `~/.codex/session-namer/`.

Thread names that were already set stay. Rename them with `/rename` in the TUI.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `SESSION_NAMER_CODEX_GENERATOR` | `claude` | `claude` (`claude -p`, no tools), `codex` (`codex exec` with your Codex login, tools switched off as above), or `auto` (Claude first, then Codex) |
| `SESSION_NAMER_CODEX_MODEL` | Codex default | Model for the `codex exec` call (`-m`) |
| `SESSION_NAMER_CODEX_PATH` | auto | Path to `codex`, `codex.cmd` or `bin/codex.js` |
| `SESSION_NAMER_NAME_HEADLESS` | off | Also name `codex exec` threads |
| `SESSION_NAMER_MODEL`, `SESSION_NAMER_SEPARATOR`, `SESSION_NAMER_TIMEOUT_MS`, `SESSION_NAMER_PROJECT_SOURCE` | as plugin | Shared with the Claude plugin |
| `CLAUDE_SESSION_NAMER=off` | | Kill switch |

## Limitations

- **Open TUI title.** If no daemon is running, the name is written to the
  session index and is visible through `thread/read` and `thread/list` at once,
  including on the server that runs the session. Whether an open TUI redraws
  its header without the daemon has not been verified. `codex resume` reads the
  same index.
- **Language (`codex exec` generator only).** `codex exec` still loads your
  global `~/.codex/AGENTS.md`. A "reply in Portuguese" instruction there can
  make English prompts get Portuguese topics.
- **Codex as a plugin host.** Codex can install Claude Code marketplaces. If
  `session-namer@claude-session-namer` shows up in `codex plugin list`, **do
  not trust its hooks in `/hooks`**. Those hooks are written for Claude Code:
  they call `claude -p` and emit a `sessionTitle` that Codex ignores. Use this
  adapter instead.
- Only Windows 11 was tested.

## Log

`$CODEX_HOME/session-namer/log.txt` (default `~/.codex/session-namer/log.txt`),
next to the per-thread state.
