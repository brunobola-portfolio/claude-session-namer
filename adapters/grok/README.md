# session-namer for Grok Build

Renames each Grok Build (xAI `grok` CLI) session to `<project> - <topic>` after
your first real prompt. The title is stored by Grok itself, so it appears in
`/resume`, the Agent Dashboard and `grok sessions list`, and
`grok --resume "<title>"` finds it. Status: beta.

| Tested with | OS | Date |
| :-- | :-- | :-- |
| Grok Build 1.0.70 (official installer) | Windows 11 | 2026-11-04 |

## How it works

A `UserPromptSubmit` hook starts a detached worker. The worker generates the
topic with your own `claude -p` (`lib/generate.js`), then talks to Grok's ACP
interface through `grok agent --no-leader stdio`:

1. `session/list` (filtered by the working folder) reads the session's current
   title, and the worker reads Grok's `summary.json` for that session
   (`title_is_manual`).
2. If the title is manual and not the one this adapter wrote, the session is
   yours: nothing is renamed, and the session is never touched again. Grok
   writes `title_is_manual` only when it is true, so a `summary.json` without
   it holds Grok's own auto-title, which is replaced. If `summary.json` cannot
   be read at all, any title that is not ours is treated as yours.
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
npx -y github:brunobola-portfolio/claude-session-namer#v1.3.1 install grok
```

The installer copies the runtime to `~/.session-namer/app/<version>` and writes
`~/.grok/hooks/session-namer.json`.

Manual install: create `~/.grok/hooks/session-namer.json`, with `<repo>`
replaced by the absolute path of your checkout (forward slashes):

```json
{
  "hooks": {
    "UserPromptSubmit": [
      { "hooks": [ { "type": "command", "command": "node \"<repo>/adapters/grok/hook.js\"", "timeout": 10 } ] }
    ]
  }
}
```

Restart Grok. Grok runs your own hooks, including those in `~/.grok/hooks/`,
only in folders you trust: the first time you open a folder, answer "Do you
trust the contents of this directory?" with Yes. Headless runs (`grok -p`)
count the folder as trusted for your own hooks.

## Verify

`/hooks` (Hooks tab) lists the hook. After your first real prompt,
`grok sessions list` shows the session as `<project> - <topic>`, and the log
has a `renamed "<project> - <topic>"` line.

## Uninstall

```bash
npx -y github:brunobola-portfolio/claude-session-namer#v1.3.1 uninstall grok
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
(`[compat.claude] hooks = false` turns that off), and it discovers Claude Code
plugins in `~/.claude/plugins`. With the Claude Code session-namer plugin
installed, `grok inspect` lists that plugin's hooks too, so Grok runs them
beside this adapter. They cannot title a Grok session (Grok discards a
`UserPromptSubmit` hook's output), but they may spend an extra `claude -p`
call (not measured). In 1.0.70, `disabled = ["session-namer"]` under `[plugins]` in
`~/.grok/config.toml` did not remove them from `grok inspect`.

## Limitations

What was verified on 2026-11-04 with Grok Build 1.0.70: no grok.com sign-in or
xAI key was available, so the interactive TUI ran against a local mock model
endpoint (a `[model.*]` entry in `config.toml` with its own `base_url` and a
placeholder `api_key`; Grok then shows "Logged in with API key"). The installer
wrote the hook into a sandboxed home, and the TUI ran under ConPTY in a fresh
git repository.

- The hook fires inside the TUI. The status line read
  `Running 2 user_prompt_submit hooks…` before the model call. The captured
  stdin had `hookEventName`, `hook_event_name`, `sessionId`, `session_id`,
  `cwd`, `workspaceRoot`, `timestamp`, `transcriptPath`, `transcript_path`,
  `promptId`, `permissionMode`, `permission_mode` and `prompt`. `prompt` is
  the only prompt field, and the adapter reads only that.
- Grok titles a new session from the first prompt immediately
  (`Fix the login redirect loop on Safari`). Its `summary.json` then has
  `generated_title` and no `title_is_manual` key. The adapter replaces that
  title. About 3 s after the prompt the log read
  `renamed "sn-grok-e2e - Fix Safari login redirect loop"`, and
  `grok sessions list` showed it.
- The rename comes from a separate `grok agent` process while the TUI is
  open. Two more turns in the same open TUI kept it: Grok's own title refresh
  ran and its model answered another title, yet `summary.json` still read
  `title_is_manual: true` with our title. A later `grok -p ... -r <id>` run
  also kept it.
- The open TUI does not reload the title. Its terminal tab keeps showing
  Grok's first title (`<prompt> - grok`) until the session is reopened.
  `/resume`, the dashboard list and `grok sessions list` read the stored
  title.
- Validation of `_x.ai/session/rename`: blank title gives
  `title must not be blank`, unknown id gives `session not found`, and the
  un-prefixed `x.ai/session/rename` gives `Method not found`.
- **Not verified:** a session signed in to grok.com or using an xAI key (only
  the model endpoint differed from that setup), and macOS and Linux.

## Log

`~/.grok/session-namer/log.txt`. The adapter never logs agent notifications,
because they can include MCP server environment values.
