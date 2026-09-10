# claude-session-namer

**Every Claude Code session gets a title you can actually read: `<project> - <topic>`. Automatically, from the first prompt, in every surface.**

[![CI](https://github.com/brunobola-portfolio/claude-session-namer/actions/workflows/ci.yml/badge.svg)](https://github.com/brunobola-portfolio/claude-session-namer/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Claude Code plugin](https://img.shields.io/badge/Claude%20Code-plugin-8A2BE2)](https://code.claude.com/docs/en/plugins)

```
Before                                   After
──────────────────────────────────────   ─────────────────────────────────────────────────────
bruno-w11-graceful-unicorn               arcva-2.0 - Migração de faturas para V10
Implement the changes we discussed       github-repo-manager - Fix Safari login redirect loop
ok                                       bolalabs-platform - Paginación en listado de clientes
```

Open claude.ai/code or the Claude mobile app with ten Remote Control sessions running and you know instantly which is which. Run `claude --resume` and the picker reads like a task list. Nothing to type, nothing to remember.

## How it works

Three tiny hooks, one Node script, zero dependencies:

| Moment | What happens | Cost |
| :-- | :-- | :-- |
| Session starts | Title becomes the **project name** (git repository folder, worktree-aware) | 0 ms, no network |
| First real prompt | A fast model turns your prompt into a **3 to 7 word topic in the language you wrote**; title becomes `<project> - <topic>` | ~5 s, ≈ USD 0.004 with Haiku |
| First turn ends | Title is re-asserted once, so the VS Code sidebar keeps it | 0 ms |

Titles are set only through Claude Code's documented `sessionTitle` hook output, the same mechanism as `/rename`. A title you set yourself (with `--name`, `/rename`, or from claude.ai) is never overwritten.

## Install in 60 seconds

Inside Claude Code:

```
/plugin marketplace add brunobola-portfolio/claude-session-namer
/plugin install session-namer@claude-session-namer
```

Or from a terminal:

```bash
claude plugin marketplace add brunobola-portfolio/claude-session-namer
claude plugin install session-namer@claude-session-namer
```

Start a new session and send a real message. That's it.

**Requirements:** Claude Code 2.1.94 or newer, Node.js 18 or newer on your `PATH`, and the `claude` CLI (which the plugin calls headlessly to generate the topic). Works on Windows, macOS and Linux, in the CLI, the VS Code extension and Remote Control, with OAuth logins and API keys alike.

## Examples

| You type (first message) | Session title |
| :-- | :-- |
| `Migra as faturas para a V10 e valida os testes` | `arcva-2.0 - Migração de faturas para V10` |
| `Fix the login redirect loop on Safari` | `webapp - Fix Safari login redirect loop` |
| `Añade paginación al listado de clientes` | `crm - Paginación en listado de clientes` |
| `ok` / `continua` / `/resume` | *(no model call: stays `arcva-2.0` until a real message arrives)* |

The topic follows the language of your prompt. Hidden or tiny prompts (`ok`, `sim`, slash commands, bare file references) never trigger a model call.

## The `/session-name` command

| Command | Effect |
| :-- | :-- |
| `/session-name Nome que eu quero` | Renames to `<project> - Nome que eu quero` immediately and locks it (no more automatic renames) |
| `/session-name` or `/session-name --regenerate` | Resets to the project name and lets the next message generate a fresh topic |
| `/session-name --remote` | Shows how to continue this session from your phone or browser |
| `/session-name --doctor` | Runs diagnostics: Node, `claude` path and version, options, last log lines, and a timed dry-run generation |

## Remote Control

The plugin does not reinvent Remote Control; Claude Code already has it. Two tips make them work together:

- **Connect a running session:** type `/rc` (alias of `/remote-control`). The session appears under its plugin title at [claude.ai/code](https://claude.ai/code) and in the mobile app.
- **Connect every session automatically:** set `"remoteControlAtStartup": true` in `~/.claude/settings.json`, or use `/config` → "Enable Remote Control for all sessions".
- **From a terminal, use `claude --rc` without a name.** A name passed to `--remote-control` outranks any title, including this plugin's.

## Configuration

Claude Code asks for these options when you enable the plugin (`/plugin configure session-namer@claude-session-namer` to change them later). All are optional.

| Option | Default | Meaning |
| :-- | :-- | :-- |
| `model` | `haiku` | Model alias or id used to summarise the first prompt |
| `separator` | ` - ` | Text between project and topic |
| `max_words` | `7` | Upper bound for topic words (3 to 12) |
| `timeout_ms` | `12000` | How long to wait for the topic before keeping the project-only title |
| `project_source` | `git` | `git` uses the repository folder name (shared by all worktrees); `cwd` uses the current folder |
| `name_headless` | `false` | Also name `claude -p` sessions |
| `enabled` | `true` | Master switch |

**Environment overrides** (handy for scripts and CI): `CLAUDE_SESSION_NAMER=off`, `SESSION_NAMER_MODEL`, `SESSION_NAMER_TIMEOUT_MS`, `SESSION_NAMER_MAX_WORDS`, `SESSION_NAMER_SEPARATOR`, `SESSION_NAMER_PROJECT_SOURCE`, `SESSION_NAMER_CLAUDE_PATH` (explicit path to the `claude` executable), `SESSION_NAMER_BARE=1` (use `claude --bare`, faster, **API-key logins only**).

**Per-repository override:** a `.session-namer.json` at the repository root can set a friendlier project name or switch the plugin off for that repo. Nothing else is read from it, and it never executes code.

```json
{ "project": "ARCVA", "enabled": true }
```

**Two accounts?** State and logs live under `$CLAUDE_CONFIG_DIR/session-namer/` (default `~/.claude/session-namer/`), so accounts using different `CLAUDE_CONFIG_DIR` values never share anything.

## Privacy and safety

- The only network call is the one headless `claude -p` request that summarises your first prompt, made through **your own** Claude Code login. The prompt goes to the same provider it was going to anyway. Huge pastes are truncated to about 1 800 characters before that call.
- No telemetry, no third-party services, no dependencies. The transcript file is never touched.
- Every hook exits 0 on every failure path. If the model call times out or errors, the session simply keeps the project-only title and the plugin retries on the next real message (at most three attempts per session, one per minute).
- The headless call runs with no settings, no MCP servers, no tools and no skills, so it cannot recurse into hooks or execute anything.

## VS Code notes

The VS Code extension runs plugin hooks, so titles work there too. Two upstream limitations to know about:

- The sidebar session list may keep showing the extension's own automatic title until you reopen the session; `claude --resume` and claude.ai/code show the plugin title immediately. The Stop hook re-asserts the title once to minimise this.
- `/session-name` works in the VS Code prompt box like any other slash command.

## Troubleshooting

Run `/session-name --doctor` inside a session, or from the plugin folder:

```bash
node hooks/session-name-cli.js --doctor
```

| Symptom | Likely cause | Fix |
| :-- | :-- | :-- |
| Sessions get the project name but never a topic | `claude` not found by the hook, or the headless call fails | Doctor shows the resolved path and a dry run; set `SESSION_NAMER_CLAUDE_PATH` if needed |
| Dry run says `Not logged in` | `SESSION_NAMER_BARE=1` with an OAuth login | Unset it; bare mode needs an API key |
| Nothing happens at all | Node.js missing from `PATH`, or `enabled=false` | Install Node 18+; check `/plugin configure` |
| Topic in the wrong language | Model slip | `/session-name <your topic>` or `/session-name --regenerate` |

Log file: `~/.claude/session-namer/log.txt` (rotated at 512 KB).

## Uninstall

```
/plugin uninstall session-namer@claude-session-namer
/plugin marketplace remove claude-session-namer
```

Optionally delete `~/.claude/session-namer/`. Existing session titles stay as they are.

## Development

```bash
npm test          # node --test, no dependencies
npm run doctor    # diagnostics against your local Claude Code
```

Design notes and the full edge-case table live in [`docs/superpowers/specs`](docs/superpowers/specs/2026-09-10-session-namer-design.md). Contributions and issues are welcome.

## License

[MIT](LICENSE) © 2026 Bruno Bola
