# session-namer for Cline CLI

Gives every Cline CLI session a `<project> - <topic>` title, the same as the
Claude Code plugin, through Cline's documented `cline history update` command.
Status: beta.

| Tested with | OS | Date |
| :-- | :-- | :-- |
| Cline CLI 3.0.74 | Windows 11 | 2026-11-03 |

## How it works

| Step | What happens |
| :-- | :-- |
| Task starts | Cline runs the `TaskStart` hook file (fire-and-forget; the task is never held up). The stub hands the payload to a detached worker and exits. |
| Worker | Finds the session in `cline history --json` by `sessionContext.rootSessionId` (the hook's `taskId` is a different `conv_…` id), summarises the first prompt with the headless `claude -p` call from `lib/generate.js`, and sets the title with `cline history update --session-id <id> --title "<title>"`. |
| Later turns | Nothing. One title per session, at most 3 generation attempts, 60 s apart. |

`UserPromptSubmit` is installed too. When Cline fires it, its prompt is used
instead of the stored first prompt. That helps when the session opened with a
trivial message such as `hi`. Cline fires both hooks for the first prompt, so
each worker first takes an exclusive per-session claim; the second one sees
the claim and exits, and only one model call is made.

A title that matches neither Cline's default (the prompt's first line) nor the
one this adapter wrote counts as yours, and the adapter never changes it.

The `cline` calls never go through a shell. On Windows, the npm `cline.cmd`
shim is resolved to the Node script behind it, so `cmd.exe` never sees the
title (it would expand `%VARIABLES%` inside it). A call that takes too long is
killed together with its child processes.

## Requirements

- Cline CLI 3.x.
- Node.js 18+ and the `claude` CLI, logged in. It generates the topic, as it
  does for the Claude Code plugin.

## Install

Recommended, one line:

```bash
npx -y github:brunobola-portfolio/claude-session-namer#v1.2.0 install cline
```

The installer copies the runtime to `~/.session-namer/app/<version>` and writes
the two hook stubs into Cline's global hooks directory.

Manual install, from the repository root (`<repo>`):

```bash
# All workspaces (Cline's global hooks directory, ~/.cline/hooks or $CLINE_DIR/hooks)
node adapters/cline/install.js

# Or one workspace only (<dir>/.clinerules/hooks)
node adapters/cline/install.js --workspace /path/to/repo
```

This writes two one-line stubs, `TaskStart.js` and `UserPromptSubmit.js`, that
`require` `adapters/cline/hook.js` by absolute path. Keep the repository where
it is, or re-run the installer after you move it. An existing hook file of your
own with the same name is never overwritten. Cline runs `.js` hook files as
`node <file>` on every platform.

## Verify

Start a task with a real prompt. A few seconds later `cline history --json`
shows the session with `metadata.title` set to `<project> - <topic>`, and the
log has a `final "<project> - <topic>"` line.

## Uninstall

```bash
npx -y github:brunobola-portfolio/claude-session-namer#v1.2.0 uninstall cline
```

Or by hand, from the repository root:

```bash
node adapters/cline/install.js --uninstall
node adapters/cline/install.js --uninstall --workspace /path/to/repo
```

Only stubs that carry the `session-namer cline adapter` marker are removed.
Titles already set stay in place.

## Configuration

The same environment overrides as the plugin apply: `CLAUDE_SESSION_NAMER=off`,
`SESSION_NAMER_MODEL`, `SESSION_NAMER_TIMEOUT_MS`, `SESSION_NAMER_SEPARATOR`,
`SESSION_NAMER_PROJECT_SOURCE`, `SESSION_NAMER_CLAUDE_PATH`, and
`.session-namer.json` at the repository root.

| Variable | Default | Meaning |
| :-- | :-- | :-- |
| `SESSION_NAMER_CLINE_PATH` | (auto) | The Cline CLI to call: its Node script, an executable, or the npm `cline.cmd` shim (resolved to its script). Without it, the adapter uses `CLINE_WRAPPER_PATH`, which Cline exports to hooks, and then `cline` on `PATH` |

## Limitations

- The title is written a few seconds after the task starts, once generation
  finishes. Until then Cline shows its default title, which is the prompt.
- One-shot runs (`cline "prompt"`) are titled too. The worker is detached, so
  it finishes after the CLI exits.
- If you run Cline with a non-default `--config` or `--data-dir`, set the same
  `CLINE_DIR` or `CLINE_DATA_DIR` in the environment. The `cline history` calls
  then see the same store.
- Subagent and teammate runs (`parent_agent_id` set) are ignored.
- Only Windows 11 was tested.

## Log

`~/.claude/session-namer/log.txt`, lines prefixed `cline`.
