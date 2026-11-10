# session-namer for Amp

Gives every new Amp thread a `<project> - <topic>` title, generated from your
first real prompt by the same headless `claude -p` call the Claude Code plugin
uses (`lib/generate.js`). Status: beta, partly verified (see [Limitations](#limitations)).

| Tested with | OS | Date |
| :-- | :-- | :-- |
| Amp CLI 0.0.1793736138 | Windows 11 | 2026-11-03 |

## How it works

| Amp event | What happens |
| :-- | :-- |
| `agent.start` (first eligible prompt of an untitled thread) | Topic generated in the background, then `amp threads rename <thread> "<project> - <topic>"`. The turn is not delayed. |
| `agent.end` | If Amp's own auto-title replaced ours within 2 minutes, re-assert once. |
| Any other title change | Treated as your rename: the thread is left alone from then on. |

Amp's plugin API exposes the thread title read-only (`ctx.thread.title.get()`),
so the title is written with Amp's documented CLI command `amp threads rename`
([Threads docs](https://ampcode.com/docs/threads): "Rename replaces the title
the agent chose"). Threads that already have a title when the plugin first sees
them are never touched. Trivial prompts (`ok`, slash commands) never cost a
model call.

The rename never goes through a shell. On Windows, npm installs `amp.cmd`, and
running a `.cmd` means running `cmd.exe`, which would parse the title (a folder
name or a model answer) as commands. The plugin resolves the shim to the real
`amp.exe` behind it and runs that directly. If no such executable can be found,
it does not rename and logs why.

## Requirements

- Amp CLI (`npm i -g @ampcode/cli`), logged in (`amp login`). Renaming is a
  server call made with your Amp login.
- Node.js 18+ and the `claude` CLI, logged in (used for the topic).
- Plugins run locally (the CLI or a local runner). The plugin calls the running
  `amp` executable; set `SESSION_NAMER_AMP_PATH` to override.

## Install

Recommended, one line:

```bash
npx -y github:brunobola-portfolio/claude-session-namer#v1.3.1 install amp
```

The installer copies the runtime to `~/.session-namer/app/<version>` and writes
a one-line shim, `session-namer.js`, into Amp's plugin folder.

Manual install: Amp loads system plugins from `%USERPROFILE%\.config\amp\plugins\`
on Windows (`$XDG_CONFIG_HOME/amp/plugins/` or `~/.config/amp/plugins/`
elsewhere). Write a one-line shim there that points at `adapters/amp/plugin.mjs`.
Run these from the repository root (`<repo>`):

PowerShell:

```powershell
$dir = "$env:USERPROFILE\.config\amp\plugins"; New-Item -ItemType Directory -Force $dir | Out-Null
$url = ([Uri](Resolve-Path .\adapters\amp\plugin.mjs).Path).AbsoluteUri
Set-Content -Encoding utf8 "$dir\session-namer.js" "export { default } from '$url'"
```

bash (macOS/Linux):

```bash
mkdir -p ~/.config/amp/plugins
echo "export { default } from 'file://$PWD/adapters/amp/plugin.mjs'" > ~/.config/amp/plugins/session-namer.js
```

For one project only, put the same shim in `<project>/.amp/plugins/session-namer.js`.
Then run `plugins: reload` from the command palette (Ctrl+O) or start a new
`amp` session.

## Verify

`amp plugins list` shows the plugin with its `agent.start` and `agent.end`
events. Send a real prompt in a new thread: a few seconds later the thread
title becomes `<project> - <topic>`, and the log shows a
`renamed "<project> - <topic>"` line.

## Uninstall

```bash
npx -y github:brunobola-portfolio/claude-session-namer#v1.3.1 uninstall amp
```

Or by hand: delete `session-namer.js` from the plugin folder
(`Remove-Item "$env:USERPROFILE\.config\amp\plugins\session-namer.js"`, or
`rm ~/.config/amp/plugins/session-namer.js`), then `plugins: reload`. Titles
already set stay as they are.

## Configuration

The same environment overrides as the Claude Code plugin apply
(`CLAUDE_SESSION_NAMER=off`, `SESSION_NAMER_MODEL`, `SESSION_NAMER_SEPARATOR`,
`SESSION_NAMER_TIMEOUT_MS`, `SESSION_NAMER_PROJECT_SOURCE`,
`SESSION_NAMER_CLAUDE_PATH`), plus `.session-namer.json` at the repository
root.

| Variable | Default | Meaning |
| :-- | :-- | :-- |
| `SESSION_NAMER_AMP_PATH` | (auto) | Amp executable to call: `amp.exe`, a Node script, or an npm `amp.cmd` shim (resolved to its target, never run through `cmd.exe`) |

## Limitations

- Not seen end to end. Amp threads live on Amp's server, so without a login
  none can be created or renamed (`amp threads list` and `amp threads new`
  answer `Invalid or missing API key`). What was verified on 2026-11-04
  without a login:
  - Amp loads the plugin in its own runtime (`amp plugins exec`), where the
    running executable is `amp.exe`, so the rename never goes through a shell.
  - Given an `agent.start` event, the installed plugin returns at once, then
    runs `amp threads rename <thread> "<project> - <topic>"` with the real
    `amp.exe`. Amp answered
    `Error: Failed to rename thread: API request for getThreadTail failed: 401`
    (exit 1). The plugin logged it as a failed rename, to be retried on a later
    prompt (at most 3 attempts).
  - Amp's rename command, read in the 0.0.1793736138 binary, loads the thread
    from the server, refuses an empty thread or a title over 256 characters,
    needs your Amp login, and sets the title through the thread's server-side
    actor. Success prints `✓ Thread <url> renamed to "<title>"` and exits 0.
    Every failure exits 1.
  - Not verified: the title change itself, and whether a rename made while the
    first turn is still running always succeeds. `amp plugins exec` cannot
    send `agent.start`, because Amp delivers it through a separate call. Only
    a signed-in session can trigger the plugin from inside Amp.
- State is kept in memory for the plugin process (at most 200 threads). A
  thread reopened in a new Amp process that already has a title is left alone.
- If your first prompt is trivial and Amp auto-titles the thread, the next real
  prompt still names it; a rename you make before that locks the thread.
- A rename you make within 2 minutes of the plugin's own rename, during the
  first turn, can be overwritten once.

## Log

`~/.claude/session-namer/log.txt` (lines start with `amp`), also mirrored to
the plugin logger.
