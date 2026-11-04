# session-namer for Qwen Code

Qwen Code has no supported way for a hook or another process to rename a
session it is running. So this adapter titles the **terminal tab**:
`<project>` at start, then `<project> - <topic>` a few seconds after your first
real prompt. Qwen's saved title, shown in `/resume` and `qwen sessions list`,
is left to Qwen's own auto-title and your `/rename`. Status: beta.

| Tested with | OS | Date |
| :-- | :-- | :-- |
| `@qwen-code/qwen-code` 0.26.6, under ConPTY | Windows 11 | 2026-11-03 |

## How it works

Command hooks `SessionStart`, `UserPromptSubmit` and `Stop` run `hook.js`. A
worker sets the console title. What was ruled out, and why:

- **Hook output:** `hookSpecificOutput` supports `additionalContext`,
  `updatedPrompt`, `updatedInput`, `permissionDecision`, `decision` and
  `artifacts`. There is no title field (checked in the 0.26.6 bundle and the
  [hooks docs](https://qwenlm.github.io/qwen-code-docs/en/users/features/hooks)).
- **`/rename`:** a user command. Qwen auto-titles after the first assistant
  reply with its own fast model, and a manual title wins.
- **`QWEN_CODE_MESSAGING_SOCKET`:** inter-agent messaging. Messages are
  submitted to the agent as prompts, not as commands, so it is not a rename
  API.
- **`qwen serve` daemon:** `PATCH /session/:id/metadata` and
  `PATCH /standalone/sessions/:id/metadata` rename only sessions the daemon
  hosts. Tried live against a TUI session id: `session_not_found` and
  `standalone_session_not_found`.

On Windows, Qwen starts hooks with `windowsHide` (`CREATE_NO_WINDOW`), so a
hook has only a hidden console of its own. The first hook of a session finds
the nearest ancestor with a visible console (Qwen itself), using
`console-title.ps1` (`AttachConsole` with a `GetConsoleWindow` check). It
stores that PID. The worker then attaches to that console and calls
`SetConsoleTitleW`. Cost: about 1 s of hidden PowerShell once per session in
the `SessionStart` hook, and the same in the background for each title change.

On macOS and Linux, Qwen starts hooks `detached` (a new session with no
controlling terminal), so a hook cannot open `/dev/tty`. The hook then walks
up its parent processes with `ps -o ppid= -o tty= -p <pid>` (at most 8, within
1.5 s) to the first one with a terminal: `pts/N` on Linux, `ttysNNN` on macOS.
If that device is a character device owned by you, the hook opens it with
`O_NOCTTY` and writes OSC 0 there. The worker outlives the hook and is
reparented, so it cannot walk to the terminal itself. The hook passes the
device to it in `SESSION_NAMER_TTY`.

Headless runs (`qwen -p "..."`) are skipped unless `name_headless` is on. Qwen
does not tell hooks whether it runs interactively, so the first hook of a
session reads the Qwen command line among its parent processes and looks for
`-p` / `--prompt` (about 1 s more on Windows, once per session).

## Requirements

- Qwen Code with hooks.
- Node.js 18+ and the `claude` CLI, logged in (used for the topic).
- `ui.hideWindowTitle: true` in Qwen's settings (the installer sets it).

## Install

Recommended, one line:

```bash
npx -y github:brunobola-portfolio/claude-session-namer install qwen
```

The installer copies the runtime to `~/.session-namer/app/<version>`, adds the
three hooks and sets `ui.hideWindowTitle`.

Manual install: in `~/.qwen/settings.json` (or `$QWEN_HOME/settings.json`),
merge the following, with `<repo>` replaced by the absolute path of your
checkout (forward slashes):

```json
{
  "ui": { "hideWindowTitle": true },
  "hooks": {
    "SessionStart":     [ { "hooks": [ { "type": "command", "name": "session-namer", "command": "node \"<repo>/adapters/qwen/hook.js\"", "timeout": 10000 } ] } ],
    "UserPromptSubmit": [ { "hooks": [ { "type": "command", "name": "session-namer", "command": "node \"<repo>/adapters/qwen/hook.js\"", "timeout": 10000 } ] } ],
    "Stop":             [ { "hooks": [ { "type": "command", "name": "session-namer", "command": "node \"<repo>/adapters/qwen/hook.js\"", "timeout": 10000 } ] } ]
  }
}
```

`ui.hideWindowTitle: true` is required. Otherwise Qwen writes its own
`<session name> (folder)` title with status icons over ours.

## Verify

Start `qwen` in a git repository: the tab shows the project name. Send a real
prompt: about 5 s later it shows `<project> - <topic>` and keeps it for the
rest of the run.

## Uninstall

```bash
npx -y github:brunobola-portfolio/claude-session-namer uninstall qwen
```

Or by hand: remove the three hook entries and, if you like,
`ui.hideWindowTitle`. Optional: delete `~/.qwen/session-namer/` (state and
log).

## Configuration

The shared options apply: `CLAUDE_SESSION_NAMER=off`, `SESSION_NAMER_MODEL`,
`SESSION_NAMER_SEPARATOR`, `SESSION_NAMER_TIMEOUT_MS`,
`SESSION_NAMER_PROJECT_SOURCE`, `SESSION_NAMER_CLAUDE_PATH`,
`SESSION_NAMER_NAME_HEADLESS` (also title `qwen -p` runs), and
`.session-namer.json` at the repository root.

## Limitations

What was verified on 2026-11-03: Qwen ran under ConPTY with a sandboxed
`QWEN_HOME`, `OPENAI_API_KEY=sk-invalid-placeholder` and an unreachable
`OPENAI_BASE_URL`. The model call failed with `Connection error`, while the
hooks fired before it. The captured `UserPromptSubmit` payload was
`{session_id, transcript_path, cwd, hook_event_name, timestamp, permission_mode, prompt_id, prompt, submitted_prompt}`.

- The OSC 0 stream showed `claude-session-namer` at start, then
  `claude-session-namer - Fix Safari login redirect loop` about 5 s after the
  prompt. It stayed for the rest of the run.
- Without the ancestor attach, the hook ran fine, but its title went to its
  own hidden console and never reached the terminal.
- **macOS and Linux:** proven in CI on 2026-11-04 (GitHub Actions
  `ubuntu-latest` and `macos-latest`, Node 18, 22 and 24) under `script`, not
  with a live Qwen session. A process started `detached` got `ENXIO` from
  `/dev/tty` and still wrote `ESC ]0;proj - Topic BEL` to the pty
  (`/dev/pts/0` on Linux, `/dev/ttys000` on macOS). Its worker, reparented to
  PID 1, wrote through the inherited device. `hook.js`, started detached
  through `/bin/sh -c` with a fake topic, wrote `proj` and then
  `proj - Fix Safari login redirect loop`. Not verified: that Qwen's own hook
  runner matches this setup (the Qwen process holds the terminal, at most 8
  processes up), and how each terminal app shows the title.
- Headless detection only sees `-p` / `--prompt` on the command line. A prompt
  passed positionally or piped on stdin is treated as interactive.
- Only the tab is titled; the saved session keeps Qwen's own title.

## Log

`~/.qwen/session-namer/log.txt`.
