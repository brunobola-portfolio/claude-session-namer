# Changelog style

`CHANGELOG.md` is read by people deciding whether to update, and its section
for a version becomes that version's GitHub release notes word for word. Write
it for them: short, concrete and about what they will notice.

The format is [Keep a Changelog 1.1](https://keepachangelog.com/en/1.1.0/)
with [Semantic Versioning](https://semver.org/). `npm run release:check` (run
by `npm test`, so by CI on every pull request) enforces the rules marked
**[checked]** on every entry, from `## [Unreleased]` down to 1.0.0.

## Shape of a release

```markdown
## [1.4.0] - 2026-12-01

_Titles in Zed and Warp, and a faster first title everywhere._

### Added

- **Zed and Warp get session titles.** Both are set up by `install --detect`
  and verified live on Windows 11 and macOS.

### Fixed

- **The first title no longer waits for a slow `git`.** Repositories on
  network drives took up to 8 s; the project name is now read in under 50 ms.
```

- **Heading [checked]:** `## [X.Y.Z] - YYYY-MM-DD`. The release script adds
  the version and date; you only write under `## [Unreleased]`.
- **Summary line [checked]:** optional, one line in `_italics_` right under the
  heading, at most 120 characters. It becomes the GitHub release title
  (`v1.4.0 · Titles in Zed and Warp, …`). Write one for every minor or major
  release.
- **Sections [checked]:** only `Added`, `Changed`, `Deprecated`, `Removed`,
  `Fixed`, `Security`, in that order, each at most once, never empty.
- **Size [checked]:** at most 6 bullets per section and 12 per release. If
  there are more, merge the small ones ("Installer messages are clearer for dry
  runs, typos and failed installs.") or leave out what nobody will notice.

## Shape of a bullet

- **Bold lead [checked]:** every bullet starts with one bold sentence, at most
  90 characters, that says what changed for the user. Someone who reads only
  the bold text should know what the release does.
- **One or two plain sentences after it:** the why, the impact, or what to do.
  Not the how; the pull request has that.
- **At most 300 characters [checked]** including the lead (about four lines in
  the file). Flat list only: no nested bullets, no paragraphs between bullets
  **[checked]**.

## Wording

- Name the thing the user sees: the agent, command, option or message. Code,
  commands and option names go in backticks.
- Present tense, active voice, no "we": "Titles survive a `/rename`", not "We
  fixed an issue where titles could be overwritten".
- `Fixed` says what was wrong as the user saw it: "**Grok sessions were never
  renamed.**", then one sentence on what now happens.
- Numbers beat adjectives: "67 files instead of the whole repository", not
  "much smaller".
- Breaking changes start the bold lead with "Breaking:" and say what to do:
  `- **Breaking: \`--bare\` is gone.** API-key users need nothing; it is automatic.`
- Leave out refactors, test-only changes, CI tweaks and dependency bumps unless
  a user would notice them.

## Before and after

No lead, and it explains the how (the workflow, the variable) instead of what
the user gets:

```markdown
- The npm package is named `session-namer` (the name `claude-session-namer`
  belongs to someone else on npm) and is no longer private. The Release
  workflow can publish each tag to npm with provenance through trusted
  publishing, switched on by the `NPM_PUBLISH` repository variable.
```

Better (what the user gets, then why):

```markdown
- **Published on npm as `session-namer`, with provenance.** The name
  `claude-session-namer` is taken on npm, so the package uses the plugin's name.
```
