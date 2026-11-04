# session-namer for OpenCode

Gives every [OpenCode](https://opencode.ai) session a `<project> - <topic>`
title, the same format as the Claude Code plugin in this repository. It also
works unchanged in [Kilo CLI](https://kilo.ai), which is a fork of OpenCode.
Status: beta.

| Tested with | OS | Date |
| :-- | :-- | :-- |
| OpenCode (`opencode-ai`) 1.19.5 | Windows 11 | 2026-11-03 |
| Kilo CLI (`@kilocode/cli`) 7.8.18 | Windows 11 | 2026-11-03 |

## How it works

| Moment | `claude` topic source (default when the Claude Code CLI is installed) | `native` topic source (default otherwise) |
| :-- | :-- | :-- |
| Session created | Title becomes the **project name** (git repository folder, worktree-aware). OpenCode's own title generator then stands down, because it only runs while the title is still `New session - <date>`. | Title is left alone. |
| First real message | The message is summarised in the background by the same headless `claude -p` call the Claude Code plugin uses (Haiku by default, about USD 0.004). Title becomes `<project> - <topic>`, about 2 to 4 s later. | OpenCode's own small model names the session as usual. The adapter prefixes that title once: `<project> - <OpenCode's title>`. No extra model call. |

Safety rules:

- A title you set yourself (TUI rename, `PATCH /session/:id`, or any title that
  is not OpenCode's default and was not written by the adapter) is never
  overwritten. The adapter also re-reads the title right before it writes.
- In `native` mode, only a title that looks like OpenCode's own is prefixed:
  it must arrive within 2 minutes of the first message and be at most 100
  characters on one line (OpenCode's own limit). Anything else is your rename
  and locks the session.
- The adapter makes at most three title writes per session and never writes in
  reaction to its own updates, so `session.updated` cannot loop.
- Subagent (child) sessions are ignored, as OpenCode itself ignores them.
- Prompts such as `ok`, `/command` or a bare `@file` never trigger a model
  call. Failed generations retry on a later message, at most three attempts,
  one per minute.
- Hooks never throw into OpenCode. `SESSION_NAMER_NESTED=1` disables the
  adapter, which guards against recursion.

## Requirements

- OpenCode 1.19.5 or newer (`npm install -g opencode-ai`), or Kilo CLI 7.8.18
  or newer (`npm install -g @kilocode/cli`).
- For the `claude` topic source: the Claude Code CLI (`claude`) installed and
  logged in. Without it, the adapter falls back to `native`.
- For a manual install: a clone of this repository. The plugin loads `lib/`
  from the clone directly, so keep the clone where it is.

## Install

Recommended, one line (`kilo` for Kilo CLI):

```bash
npx -y github:brunobola-portfolio/claude-session-namer#v1.3.0 install opencode
npx -y github:brunobola-portfolio/claude-session-namer#v1.3.0 install kilo
```

The installer copies the runtime to `~/.session-namer/app/<version>` and adds
the plugin to your global OpenCode (or Kilo) config.

Manual install: the plugin is a single file inside this repository,
`adapters/opencode/index.mjs`. Register it by absolute path in the `plugin`
array of your config, written as a `file://` URL with forward slashes (`<repo>`
is your checkout).

**OpenCode, all projects.** Edit `~/.config/opencode/opencode.jsonc` (OpenCode
creates it on first run; `opencode.json` works too). On Windows that is
`%USERPROFILE%\.config\opencode\opencode.jsonc`.

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["file:///<repo>/adapters/opencode/index.mjs"]
}
```

**OpenCode, one project.** Put the same `plugin` entry in `opencode.json` at
the project root.

**Kilo CLI.** Use the same entry in `kilo.json` at the project root (tested).
For all projects, add it to `~/.config/kilo/kilo.jsonc` (same key, same
loader; checked with `kilo debug config` on 7.8.18).

```json
{
  "$schema": "https://app.kilo.ai/config.json",
  "plugin": ["file:///<repo>/adapters/opencode/index.mjs"]
}
```

If the config already has a `plugin` array, add the path to it.

## Verify

Restart OpenCode (or Kilo), open a session in a git repository and send a real
message. The session list (`opencode session list`, the TUI picker or
`GET /session`) shows `<repo> - <topic>`.

## Uninstall

```bash
npx -y github:brunobola-portfolio/claude-session-namer#v1.3.0 uninstall opencode
npx -y github:brunobola-portfolio/claude-session-namer#v1.3.0 uninstall kilo
```

Or by hand: remove the `file:///.../adapters/opencode/index.mjs` entry from the
`plugin` array in every config file you added it to, then restart OpenCode or
Kilo. Existing titles stay as they are.

## Configuration

These are environment variables, read when OpenCode starts.

| Variable | Default | Meaning |
| :-- | :-- | :-- |
| `SESSION_NAMER_OPENCODE_TOPIC` | `auto` | `claude`, `native`, or `auto` (`claude` when the `claude` CLI is found, otherwise `native`) |
| `SESSION_NAMER_OPENCODE_LOG` | unset | Path of a plain-text debug log the adapter appends to |
| `CLAUDE_SESSION_NAMER=off` | | Disables the adapter |

The adapter also honours the shared options from the main README:
`SESSION_NAMER_MODEL`, `SESSION_NAMER_TIMEOUT_MS`, `SESSION_NAMER_SEPARATOR`,
`SESSION_NAMER_PROJECT_SOURCE`, `SESSION_NAMER_CLAUDE_PATH`,
`SESSION_NAMER_BARE`, and the per-repository `.session-namer.json` (`project`,
`enabled`).

## Limitations

- **`native` mode, early rename:** a rename you type within 2 minutes of the
  first message, before OpenCode's own title has landed, cannot be told apart
  from OpenCode's title and is prefixed once. Rename again and it is kept.
- **`opencode run` (one-shot mode)** exits as soon as the answer is printed.
  With the `claude` topic source, the topic only lands if `claude -p` finishes
  first, which usually takes about 3 s. A very fast reply can leave the session
  with the project-only title. The TUI and `opencode serve` are not affected.
- In `native` mode, OpenCode's title follows OpenCode's own prompt, so it is
  often in English and may be up to 100 characters. The full title is capped at
  80 characters.
- Session titles are only stored by OpenCode, so they do not appear in Claude
  Code's session list, and the reverse is also true.
- The plugin relies on OpenCode's default-title format
  (`New session - <ISO date>`). If a future release changes that format, the
  adapter stops recognising default titles: a project title may then not be
  set, but nothing gets overwritten.
- Kilo CLI reads the plugin from its global config (`~/.config/kilo/kilo.jsonc`;
  checked with `kilo debug config` on 7.8.18). Kilo rewrites that file on its
  first start (adding `$schema` and `permission`), so after uninstall it matches
  your original except for what Kilo itself added.
- Only Windows 11 was tested.

Files: `index.mjs` is the plugin entry (the OpenCode loader rejects modules
with extra exports, so it only default-exports `{ id, server }`); `namer.js`
holds the logic, reusing `../../lib/`. Its tests are in
`test/adapter-opencode.test.js`.

## Log

OpenCode's own log, service `session-namer` (visible with `--print-logs`),
plus the optional plain-text file set by `SESSION_NAMER_OPENCODE_LOG`.
