# Security policy

## Supported versions

Only the latest release receives fixes. Update the Claude Code plugin with
`/plugin marketplace update claude-session-namer`, and everything else by
re-running `npx -y github:brunobola-portfolio/claude-session-namer install <agent...>`.

## What session-namer does on your machine

**Model calls.** To write a topic, session-namer makes one call to a fast
model per session, through a login you already have. It retries at most three
times if a call fails, and `/session-name --regenerate` allows a fresh call.
The prompt is truncated to about 1,800 characters, wrapped in delimiters, and
the model is told to treat it as data. Which login is used:

- Claude Code and most adapters: your `claude` CLI, run headless with no
  settings sources, no MCP servers, no tools and no slash commands, so it
  cannot run anything or load other hooks.
- Pi and OpenCode/Kilo can use the agent's own configured model instead.
- Codex CLI uses `claude -p` by default. `codex exec` with your OpenAI login
  is opt-in, runs read-only with its shell and other tools disabled; see
  [adapters/codex/README.md](adapters/codex/README.md).

**Titles.** Model output and project names are stripped of control
characters, ANSI and OSC escape sequences, bidi and zero-width characters, and
are length-limited. Titles are passed to other programs as argument vectors,
never through a shell.

**Files it writes.**

- The Claude Code plugin writes only under `$CLAUDE_CONFIG_DIR/session-namer/`
  (default `~/.claude/session-namer/`): one small state file per session and a
  log. If that folder is not writable it uses a per-user, owner-only folder in
  the OS temp directory.
- Each adapter keeps its state and log in a `session-namer` folder under that
  agent's own config directory; each adapter README names it.
- The installer copies the runtime to `~/.session-namer/app/<version>/` and
  adds entries to the config files listed in
  [docs/install.md](docs/install.md). It backs up each file once as
  `<file>.session-namer.bak`, keeps the original file mode, never prints file
  contents, and `uninstall` removes exactly what it added.

**What it reads.** `.session-namer.json` at a repository root is parsed as
JSON and only two keys are read (`project`, `enabled`). It never executes
code. Agent config files are read only to merge the installer's entries.

**No telemetry.** session-namer sends nothing anywhere except the model call
above, made by the agent CLI you already use.

## Reporting a vulnerability

Please use GitHub's private vulnerability reporting:
**Security → Report a vulnerability** on
https://github.com/brunobola-portfolio/claude-session-namer.

Do not open a public issue for security problems. You will get an answer
within seven days.
