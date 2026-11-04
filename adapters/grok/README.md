# session-namer for Grok Build

Renames each Grok Build (xAI `grok` CLI) session to `<project> - <topic>` after
your first real prompt. The title is stored by Grok itself, so it appears in
`/resume`, the Agent Dashboard and `grok sessions list`, and
`grok --resume "<title>"` finds it. Status: beta.

| Tested with | OS | Date |
| :-- | :-- | :-- |
| Grok Build 1.0.70 (official installer) | Windows 11 | 2026-11-03 |

## How it works

A `UserPromptSubmit` hook starts a detached worker. The worker generates the
topic with your own `claude -p` (`lib/generate.js`), then talks to Grok's ACP
interface through `grok agent --no-leader stdio`:

1. `session/list` (filtered by the working folder) reads the session's current
   title, and the worker reads Grok's `summary.json` for that session
   (`title_is_manual`).
2. If the title is manual and not the one this adapter wrote, the session is
   yours: nothing is renamed, and the session is never touched again. If the
   manual flag cannot be read, any title that is not ours is treated as yours.
3. Otherwise it calls Grok's ACP extension `_x.ai/session/rename`.

Why not a hook output field? Grok hooks cannot return a title. An allowing
`UserPromptSubmit` hook's stdout is discarded
([hooks guide](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-pager/docs/user-guide/10-hooks.md)).
Grok's ACP interface does expose session management under the `x.ai/`
extension namespace
([agent mode guide](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-pager/docs/user-guide/15-agent-mode.md),
"non-exhaustive, discover from the agent"). `_x.ai/session/rename` is the call
behind `/rename` and the dashboard's Ctrl+R.

- The hook prints nothing and returns immediately, so your prompt is not
  delayed.
- Grok records the title as manual (`title_is_manual`), so its own
  auto-titling leaves the session alone. `/rename --auto` gives it back.
- One rename per session. Up to 3 attempts, 60 s apart, if generation fails.
  Trivial prompts (`ok`, slash commands) never trigger a model call.
- Subagent sessions and nested `claude -p` runs are skipped.

## Requirements

- Grok Build, installed with the official installer (`~/.grok/bin/grok`) or on
  `PATH`.
- Node.js 18+ and the `claude` CLI, logged in (used for the topic).

## Install

Recommended, one line:

```bash
npx -y github:brunobola-portfolio/claude-session-namer install grok
```

The installer copies the runtime to `~/.session-namer/app/<version>` and writes
`~/.grok/hooks/session-namer.json`.

Manual install: create `~/.grok/hooks/session-namer.json` (global hooks are
always trusted), with `<repo>` replaced by the absolute path of your checkout
(forward slashes):

```json
{
  "hooks": {
    "UserPromptSubmit": [
      { "hooks": [ { "type": "command", "command": "node \"<repo>/adapters/grok/hook.js\"", "timeout": 10 } ] }
    ]
  }
}
```

Restart Grok.

## Verify

`/hooks` (Hooks tab) lists the hook. After your first real prompt,
`grok sessions list` shows the session as `<project> - <topic>`, and the log
has a `renamed "<project> - <topic>"` line.

## Uninstall

```bash
npx -y github:brunobola-portfolio/claude-session-namer uninstall grok
```

Or by hand: delete `~/.grok/hooks/session-namer.json`. Optional: delete
`~/.grok/session-namer/` (state and log).

## Configuration

| Variable | Default | Meaning |
| :-- | :-- | :-- |
| `SESSION_NAMER_GROK_PATH` | (auto) | Grok executable, when it is not at `~/.grok/bin/grok(.exe)` or on `PATH` |

The shared options also apply: `CLAUDE_SESSION_NAMER=off`,
`SESSION_NAMER_MODEL`, `SESSION_NAMER_SEPARATOR`, `SESSION_NAMER_TIMEOUT_MS`,
`SESSION_NAMER_PROJECT_SOURCE`, `SESSION_NAMER_CLAUDE_PATH`, and
`.session-namer.json` at the repository root.

Grok also loads Claude Code hooks from `~/.claude/settings.json` by default
(`[compat.claude] hooks = false` turns that off). The Claude Code session-namer
plugin installs through the plugin system, not `settings.json`.

## Limitations

What was verified on 2026-11-03: no grok.com sign-in or API key was available
(`session/new` answers "Authentication required"), so no interactive turn
could run.

- `_x.ai/session/rename` on a session that Grok had persisted answered
  `{"success":true}` without a login. `session/list` and `grok sessions list`
  then showed the new title, and Grok's `summary.json` read
  `title_is_manual: true`.
- Validation: blank title gives `title must not be blank`, unknown id gives
  `session not found`, and the un-prefixed `x.ai/session/rename` gives
  `Method not found`.
- Full adapter path: a `UserPromptSubmit` payload on stdin led to the worker,
  `claude -p`, and the rename. `grok sessions list` showed
  `claude-session-namer - Pagination for customer list endpoint`.
- The pre-rename read (`session/list` plus `summary.json`) was checked live
  against that session: it returned the title and `title_is_manual: true`.
- **Not verified:** the hook firing inside a signed-in TUI, the exact
  `UserPromptSubmit` payload field for the prompt (the adapter accepts
  `prompt`, `userPrompt` and `user_prompt`), and whether a live TUI session
  that later rewrites its own `summary.json` keeps the external rename. Check
  with `grok sessions list` after your first prompt.
- Only Windows 11 was tested.

## Log

`~/.grok/session-namer/log.txt`. The adapter never logs agent notifications,
because they can include MCP server environment values.
