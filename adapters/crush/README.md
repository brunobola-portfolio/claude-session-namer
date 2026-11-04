# session-namer for Crush

Gives every [Crush](https://github.com/charmbracelet/crush) session the title
`<project> - <topic>`, the same as the Claude Code plugin. It reuses
`lib/title.js`, `lib/config.js` and `lib/generate.js` from this repository.
Status: beta.

| Tested with | OS | Date |
| :-- | :-- | :-- |
| Crush 0.99.0 (`crush run` and the TUI) | Windows 11 | 2026-11-03 |

## How it works

Crush hooks can't return a title, but Crush has two documented commands and a
hook that fit together:

| Piece | Use |
| :-- | :-- |
| `TurnStart` hook ([docs/hooks](https://github.com/charmbracelet/crush/tree/main/docs/hooks)) | Fires on every prompt; the payload carries `session_id` and `cwd` |
| `crush session show <id> --json` | Reads the session title and the prompt you just sent |
| `crush session rename <id> <title>` | Sets the title; a running TUI picks it up straight away |

The hook starts a detached background worker and returns immediately, so your
turn is never delayed. The worker then:

1. Leaves the session alone if its title is already yours (see below).
2. Skips trivial prompts (`ok`, `continua`, slash commands); no model call.
3. Generates the topic with your own `claude -p` (lean mode, Haiku by default).
4. Waits until Crush's own one-shot title has been written, so Crush can't
   overwrite yours later.
5. Renames the session once, checks the result, and stops.

If `claude` isn't available, or the call fails, the worker prefixes Crush's own
generated title with the project name instead (`native` mode).

Crush writes its own title once, after the first prompt. So when the worker
meets a session for the first time and it already has a non-default title
after more than one prompt, that title is a rename (or predates the hook) and
is kept. Likewise, a title that changes after a trivial turn the worker has
seen is treated as yours.

## Requirements

- Crush.
- Node.js 18 or newer on `PATH`, and the `claude` CLI for `claude`-mode
  topics.

## Install

Recommended, one line:

```bash
npx -y github:brunobola-portfolio/claude-session-namer#v1.2.0 install crush
```

The installer copies the runtime to `~/.session-namer/app/<version>` and adds
the `TurnStart` hook to your global `crush.json`.

Manual install: add the hook to your global Crush config,
`~/.config/crush/crush.json` (Windows: `%USERPROFILE%\.config\crush\crush.json`;
`crush dirs` prints the folder). Use an absolute path to your checkout
(`<repo>`), with forward slashes on Windows too:

```jsonc
{
  "hooks": {
    "TurnStart": [
      {
        "name": "session-namer",
        "command": "node \"<repo>/adapters/crush/hook.js\"",
        "timeout": 10
      }
    ]
  }
}
```

If the file already has a `hooks` object, merge `TurnStart` into it. A
project-level `crush.json` works as well.

## Verify

Start a new session and send a real prompt. A few seconds later the TUI header
shows `<project> - <topic>`; `crush session show <id> --json` shows it as
`meta.title`.

## Uninstall

```bash
npx -y github:brunobola-portfolio/claude-session-namer#v1.2.0 uninstall crush
```

Or by hand: remove the `session-namer` entry from `hooks.TurnStart` in
`crush.json`. Titles that were already set stay as they are.

## Configuration

| Variable | Default | Meaning |
| :-- | :-- | :-- |
| `SESSION_NAMER_CRUSH_TOPIC` | `auto` | `claude` uses `claude -p`; `native` prefixes Crush's own title (no extra model call); `auto` uses `claude` when it's found, else `native` |
| `SESSION_NAMER_CRUSH_PATH` | (auto) | Explicit `crush` executable. By default it's found on `PATH`; behind the npm shim, the real `crush.exe` is used, and the title never goes through `cmd.exe` |

The shared options also apply: `SESSION_NAMER_MODEL`, `SESSION_NAMER_SEPARATOR`,
`SESSION_NAMER_TIMEOUT_MS`, `SESSION_NAMER_PROJECT_SOURCE`,
`CLAUDE_SESSION_NAMER=off`, and `.session-namer.json` at the repository root.

## Limitations

- If you rename a session within the first seconds of its first turn, before
  the worker has run, your name is replaced once. Later renames are never
  touched.
- `crush run` sessions are titled too.
- With a custom `--data-dir`, `crush session show` in the worker looks at the
  default data dir and finds nothing. Set `SESSION_NAMER_CRUSH_PATH` to a
  wrapper script that adds `--data-dir`.
- Only Windows 11 was tested.

## Log

`~/.claude/session-namer/log.txt`, entries prefixed `crush` (state lives next
to it).
