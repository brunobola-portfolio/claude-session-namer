# session-namer for DeepSeek Harness (`dsh`)

Gives every DeepSeek Harness session the title `<project> - <topic>`, using
the agent's own title API. The title is a durable `session/title` event, so it
shows wherever dsh lists sessions (Web UI sidebar, `--resume` pickers, SDK
`session.event` notifications) and never reaches the model. Status: beta.

| Tested with | OS | Date |
| :-- | :-- | :-- |
| `@deepseek-ai/dsh` 0.2.1-rc.5 (Node 24) | Windows 11 | 2026-11-03 |

## How it works

The adapter is a Cordis plugin that registers the profile's single
`ctx.sessionTitle` provider
([`dsh-session-title`](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/session/session-title)).
The topic comes from your own `claude -p` (Haiku by default, see the main
README), so no DeepSeek tokens are spent on titles.

- dsh allows one title provider, so the overlay disables the shipped
  `session-title-first-prompt-llm` row and inserts this plugin.
- Cadence `all-prompts`: a trivial first prompt (`ok`) yields just the project
  name; the next real prompt yields `<project> - <topic>`. After that, later
  prompts return the same title with no model call. Trivial prompts never
  reach the model.
- Like the Claude Code plugin, at most 3 model calls per session, at least
  60 s apart. The git lookup for the project name runs once per working
  folder, not on every prompt.
- A rename in dsh (`rename()` / UI) is a `user` title: dsh pins it and stops
  calling providers. `refresh()` hands it back.
- Failures (no `claude`, timeout, bad answer) keep the current title; dsh
  never waits for the provider before answering.
- `maxTitleBytes` is raised from 80 to 160 bytes so non-ASCII topics are not
  cut.

## Requirements

- Node.js 22.19+ (dsh's own requirement).
- Claude Code logged in (`claude` on `PATH`).

## Install

Recommended, one line:

```bash
npx -y github:brunobola-portfolio/claude-session-namer install deepseek
```

The installer copies the runtime to `~/.session-namer/app/<version>` and adds
the rows below to the `cordis.patch.yml` of every profile under
`~/.dsh/profiles/`. If no profile exists yet, start dsh once (e.g. `dsh web`)
and run it again. Restart dsh afterwards.

Manual install. Per run (nothing persisted), from your checkout (`<repo>`):

```bash
dsh web --patch "<repo>/adapters/deepseek/session-namer.patch.yml"
```

Permanently for one profile (`web`, `headless`, `sdk`, `tui`, ...): append
these rows to `~/.dsh/profiles/<profile>/cordis.patch.yml`
(`$DSH_HOME/profiles/...` if you set `DSH_HOME`), replacing the leading `[]` if
the file is still empty. Use an absolute `file:///` URL, since relative names
resolve beside the patch file:

```yaml
- id: session-title-llm
  disabled: true
- id: session-title
  config:
    fallbackMaxWords: 5
    fallbackMaxBytes: 40
    maxTitleBytes: 160
- insert:
    - id: session-namer
      name: file:///<repo>/adapters/deepseek/plugin.mjs
```

## Verify

`dsh <profile> --dump-config` lists `id: session-namer`. After a real prompt,
the session list (Web UI sidebar, `--resume` picker) shows
`<project> - <topic>`, and the log has a `title "<project> - <topic>"` line.

## Uninstall

```bash
npx -y github:brunobola-portfolio/claude-session-namer uninstall deepseek
```

Or by hand: remove those rows from the profile's `cordis.patch.yml` (or stop
passing `--patch`). Optional: delete `~/.dsh/session-namer/` (log only).

## Configuration

The shared options apply: `CLAUDE_SESSION_NAMER=off`, `SESSION_NAMER_MODEL`,
`SESSION_NAMER_SEPARATOR`, `SESSION_NAMER_TIMEOUT_MS`,
`SESSION_NAMER_PROJECT_SOURCE`, `SESSION_NAMER_CLAUDE_PATH`, and
`.session-namer.json` at the repository root. The `session-title` rows above
set dsh's own fallback and length limits.

## Limitations

What was verified on 2026-11-03, and how: no DeepSeek key was available. Runs
used `DEEPSEEK_API_KEY=sk-invalid-placeholder`, so the main request got
HTTP 401 *after* dsh had logged it, which is the point where dsh schedules
title providers.

- `dsh --profile sdk --patch session-namer.patch.yml`, driven over JSON-RPC
  (`initialize`, `session/prompt`): dsh emitted
  `session/title {"title":"claude-session-namer - Safari login redirect loop fix","source":{"kind":"provider","provider":"session-namer"}}`,
  which was persisted in dsh's session projection.
- Two prompts `ok`, then `Migra as faturas para a V10 e valida os testes`:
  `claude-session-namer` first, then
  `claude-session-namer - Migração de faturas para V10`.
- Not verified: a full session with a working DeepSeek key. `dsh headless`
  exits as soon as the main request fails, before the asynchronous title
  commits. That is a property of the failed run, not of the plugin.
- Only Windows 11 was tested.

## Log

`~/.dsh/session-namer/log.txt` (`$DSH_HOME/session-namer/log.txt`), lines
prefixed `[deepseek]`.
