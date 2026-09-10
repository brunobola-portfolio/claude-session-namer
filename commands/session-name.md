---
description: Rename this session ("<project> - <topic>"), regenerate the topic, show Remote Control tips, or run diagnostics.
argument-hint: "[topic] | --regenerate | --remote | --doctor"
---

The session-namer plugin intercepts this command in its UserPromptSubmit hook.
By the time you read this, the hook has ALREADY acted on the arguments below:

Arguments: `$ARGUMENTS`

Follow exactly one of these branches, based on the arguments:

1. **A topic was given** (anything that is not a `--flag`): the hook has renamed
   this session to `<project> - <topic>` and marked it as user-set, so it will
   never be renamed automatically again. Reply with one short line confirming the
   new title. Do not run any tool.

2. **`--regenerate`** (or no arguments at all): the hook has reset the title to
   the project name and re-armed automatic naming. Reply with one short line
   telling the user that the next message they send will generate the topic
   automatically, in the language of that message. Do not run any tool.

3. **`--remote`**: explain, in at most six short lines, how to continue this
   session from a phone or browser:
   - type `/rc` (alias of `/remote-control`) right now to connect this session;
   - set `"remoteControlAtStartup": true` in `~/.claude/settings.json` (or
     `/config` → "Enable Remote Control for all sessions") to connect every
     new session automatically;
   - from a terminal, `claude --rc` starts a new remote session that keeps the
     plugin's title (do not pass a name to `--remote-control`, a passed name
     overrides the plugin's title);
   - the session then appears under its title at https://claude.ai/code and in
     the Claude mobile app.
   Do not run any tool.

4. **`--doctor`**: run this command with the Bash tool and show its output to
   the user verbatim inside a code block, then summarise any line marked `FAIL`
   or `WARN` in one sentence each:

   ```
   node "${CLAUDE_PLUGIN_ROOT}/hooks/session-name-cli.js" --doctor
   ```
