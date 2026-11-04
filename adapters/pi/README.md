# session-namer for Pi

Gives every [Pi](https://github.com/earendil-works/pi) coding-agent session the
same `<project> - <topic>` name that the Claude Code plugin produces. The name
is Pi's own session display name (the one `/name` sets), so it shows in the
`/resume` and `pi --resume` picker, in `get_state` over RPC, and in the
terminal title (`π - <name> - <folder>`). Status: beta.

| Tested with | OS | Date |
| :-- | :-- | :-- |
| `@earendil-works/pi-coding-agent` 1.5.0 (TUI, RPC and print mode) | Windows 11 | 2026-11-03 |

The package used to be called `@mariozechner/pi-coding-agent`, which is now
deprecated.

## How it works

| Pi event | What the extension does |
| :-- | :-- |
| `session_start` | Sets the name to the project (git repository folder, worktree-aware, same rules as the plugin). Leaves the session alone if it already has a different name (`--name`, `/name`, or a resumed session that already has a topic). |
| `input` (first prompt that passes the plugin's eligibility rules) | Starts topic generation **in the background** and returns at once, so your prompt is never delayed. When the topic arrives the name becomes `<project> - <topic>`. |
| `session_info_changed` | A name the extension did not set (`/name`, RPC `set_session_name`) locks it out for the rest of the session. The name is checked again just before the topic is applied. |
| `session_shutdown` | Waits for a pending topic so short `pi -p` runs are still named: at most 5 s when Pi quits, 3 s on `/new`, `/resume` or `/fork`. |

Topic generation, in order:

1. **Pi's own model access** (`ctx.modelRegistry.streamSimple`), nothing extra
   to set up: a cheap model from the active provider when one has credentials,
   otherwise the active model. Cheap means, in this order: an id containing
   `haiku`, `flash-lite` or `flash`, then one with `nano`, `mini` or `small` as
   a separate part of the id (so `gpt-4o-mini` counts, `gemini-2.5-pro` does
   not). Override with `SESSION_NAMER_PI_MODEL=provider/model-id`.
2. **Fallback:** the plugin's headless `claude -p` call (`lib/generate.js`),
   when the Claude Code CLI is installed and logged in.

At most three attempts per session. Shared logic (eligibility, sanitising,
title formatting, project resolution, config) is required from this
repository's `lib/` folder, so the adapter has to be loaded **in place**. Pi
does not copy it anywhere.

## Requirements

- Pi.
- Node.js 18 or newer.
- Optional: the `claude` CLI, only used as the fallback.

## Install

Recommended, one line:

```bash
npx -y github:brunobola-portfolio/claude-session-namer install pi
```

The installer copies the runtime to `~/.session-namer/app/<version>` and runs
`pi install` on its `adapters/pi` folder.

Manual install, from a clone of this repository:

```bash
git clone https://github.com/brunobola-portfolio/claude-session-namer.git
pi install ./claude-session-namer/adapters/pi
```

`pi install <local path>` records the path in `~/.pi/agent/settings.json` under
`packages`. Pi loads it from that path and does not copy it. Start a new Pi
session (or run `/reload`).

For one run without installing: `pi -e ./claude-session-namer/adapters/pi`.

## Verify

`pi list` shows `.../adapters/pi`. Start a session: the terminal title shows
the project name. Send a real message: a few seconds later the name becomes
`<project> - <topic>` in the title and in the `/resume` picker.

## Uninstall

```bash
npx -y github:brunobola-portfolio/claude-session-namer uninstall pi
```

Or by hand: `pi remove ./claude-session-namer/adapters/pi` (the same path you
installed). Optionally delete `~/.pi/agent/session-namer/` (the log). Existing
session names stay as they are.

## Configuration

These are the plugin's environment variables, read the same way:
`CLAUDE_SESSION_NAMER=off`, `SESSION_NAMER_SEPARATOR`,
`SESSION_NAMER_TIMEOUT_MS` (per backend), `SESSION_NAMER_PROJECT_SOURCE`
(`git` or `cwd`), `SESSION_NAMER_MODEL` (model for the `claude -p` fallback,
default `haiku`), `SESSION_NAMER_CLAUDE_PATH`, `SESSION_NAMER_BARE`, and
`.session-namer.json` at the repository root (`project`, `enabled`).

Pi-only variables:

| Variable | Default | Meaning |
| :-- | :-- | :-- |
| `SESSION_NAMER_PI_BACKEND` | `auto` | `auto` (Pi model, then `claude -p`), `pi` (Pi model only), `claude` (`claude -p` only) |
| `SESSION_NAMER_PI_MODEL` | *(automatic)* | `provider/model-id` for the topic call, for example `anthropic/claude-haiku-4-5` |
| `SESSION_NAMER_NAME_HEADLESS` | `false` | Also name `pi -p` and `--mode json` runs (TUI and RPC sessions are always named) |

`SESSION_NAMER_NESTED=1` turns the extension off. The `claude -p` fallback sets
it for its child process.

## Limitations

- With no Pi credentials at all, Pi refuses to answer ("No API key found") and
  does not save the session file. The extension still names the in-memory
  session through `claude -p`, but the name is lost with the session.
- The cheap-model choice is a name heuristic. Set `SESSION_NAMER_PI_MODEL` if
  it picks something you do not want.
- A `pi -p` run whose topic takes longer than 5 s after the answer is printed
  ends without the topic.
- Installing from git (`pi install git:github.com/...`) is not supported yet.
  The repository root has no `pi` manifest, so Pi would find nothing to load.
- Only Windows 11 was tested.

## Log

`~/.pi/agent/session-namer/log.txt` (honours `PI_CODING_AGENT_DIR`).
