# session-namer for goose

Gives every [goose](https://github.com/aaif-goose/goose) session (formerly
block/goose) the name `<project> - <topic>`, the same as the Claude Code
plugin. It reuses `lib/title.js`, `lib/config.js` and `lib/generate.js` from
this repository. Status: beta.

| Tested with | OS | Date |
| :-- | :-- | :-- |
| goose 1.57.0 (interactive `goose session` and `goose run`) | Windows 11 | 2026-11-03 |

## How it works

goose hooks are observe-only: no hook output can set a name. goose does have a
documented rename command and an Open Plugins hook that fit together:

| Piece | Use |
| :-- | :-- |
| `UserPromptSubmit` hook ([hooks guide](https://goose-docs.ai/docs/guides/context-engineering/hooks)) | The payload carries `session_id`, `message` (the prompt) and `working_dir` |
| `goose session list --format json` | Reads `name` and `user_set_name` |
| `goose session rename --session-id <id> -n <name>` | Sets the name and `user_set_name = true` |

goose names sessions itself for the first three prompts while `user_set_name`
is false. That write is unconditional and resets the flag. A CLI rename sets
the flag, which stops goose's auto-naming for good.

The hook starts a background worker and returns. The worker then:

1. Skips trivial prompts, and leaves alone any session the user has already
   named.
2. Generates the topic with your own `claude -p`.
3. Renames the session.
4. Watches for 15 seconds. If goose's in-flight auto-name lands after the
   rename, the worker renames again (at most 3 writes).

If `claude` isn't available, the worker prefixes goose's own name with the
project name instead (`native` mode).

**Windows worker launch.** goose reads hook output until EOF and waits for
`UserPromptSubmit` hooks inline. A child process started by Node on Windows
inherits the hook's pipe handles, so a plain detached worker would hold the
turn open. In one test, a 12 s worker kept goose waiting 12.3 s. The hook
therefore launches the worker with `Start-Process`, which goes through
ShellExecute and inherits no handles; measured turn time was about 1 s,
including roughly 0.5 s of PowerShell startup. This happens only on prompts of
sessions that don't have their final name yet. The PowerShell command is a
fixed string: the folder, the Node path and the worker arguments reach it
through environment variables, so no folder name is ever parsed as PowerShell
code.

## Requirements

- goose.
- Node.js 18 or newer on `PATH`, and the `claude` CLI for `claude`-mode
  topics.
- **Windows only:** goose runs hook commands with `sh -c`. If `sh` isn't on
  `PATH`, hooks silently never run; this was checked: from a plain PowerShell,
  the hooks did not fire. Git for Windows provides `sh`. Add its `bin` folder
  to your user `PATH` once, then open a new terminal:

```powershell
[Environment]::SetEnvironmentVariable('Path', "C:\Program Files\Git\bin;" + [Environment]::GetEnvironmentVariable('Path','User'), 'User')
```

## Install

Recommended, one line:

```bash
npx -y github:brunobola-portfolio/claude-session-namer install goose
```

The installer copies the runtime to `~/.session-namer/app/<version>` and links
its `adapters/goose` folder as the user plugin `~/.agents/plugins/session-namer`.

Manual install: link the `adapters/goose` folder of your checkout (`<repo>`)
as a user plugin. Don't copy it: the hook uses `../../lib`.

```powershell
# Windows (directory junction, no admin rights needed)
New-Item -ItemType Directory -Force "$env:USERPROFILE\.agents\plugins" | Out-Null
New-Item -ItemType Junction -Path "$env:USERPROFILE\.agents\plugins\session-namer" -Target "<repo>\adapters\goose"
```

```bash
# macOS / Linux
mkdir -p ~/.agents/plugins && ln -s <repo>/adapters/goose ~/.agents/plugins/session-namer
```

For one project only, link it as `<project>/.agents/plugins/session-namer`
instead.

## Verify

Start a new `goose session` and send a real prompt. A few seconds later
`goose session list --format json` shows the session's `name` as
`<project> - <topic>`.

## Uninstall

```bash
npx -y github:brunobola-portfolio/claude-session-namer uninstall goose
```

Or by hand, removing only the link:

```powershell
cmd /c rmdir "%USERPROFILE%\.agents\plugins\session-namer"
```

```bash
rm ~/.agents/plugins/session-namer
```

goose may keep a `plugins:` entry for the old path in its `config.yaml`. That
entry is harmless and can be deleted.

## Configuration

| Variable | Default | Meaning |
| :-- | :-- | :-- |
| `SESSION_NAMER_GOOSE_TOPIC` | `auto` | `claude`, `native` (goose's own name with the project prefix, no extra model call), or `auto` |
| `SESSION_NAMER_GOOSE_PATH` | (auto) | Explicit goose executable. By default it's looked up on `PATH`, then in `%USERPROFILE%\goose\goose.exe` (Windows installer) or `~/.local/bin/goose` |

The shared options also apply: `SESSION_NAMER_MODEL`, `SESSION_NAMER_SEPARATOR`,
`SESSION_NAMER_TIMEOUT_MS`, `SESSION_NAMER_PROJECT_SOURCE`,
`CLAUDE_SESSION_NAMER=off`, and `.session-namer.json`.

## Limitations

- **Headless runs:** with `goose run`, the run may end before the worker does,
  so one-shot runs aren't always named.
- **Renaming sets `user_set_name`:** after this adapter names a session, goose
  no longer auto-renames it. That's intended, and the same thing happens when
  you rename it yourself.
- Only Windows 11 was tested.

## Log

`~/.claude/session-namer/log.txt`, entries prefixed `goose`.
