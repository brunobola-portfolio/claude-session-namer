# Working on session-namer

Guidance for AI coding agents and people alike. [CONTRIBUTING.md](CONTRIBUTING.md)
has the full detail; these are the rules that keep every release clean.

## Every change

- Zero runtime dependencies, every hook exits 0, never overwrite a title the
  user chose. `npm test` must pass on Windows, macOS and Linux.
- `main` is protected: work on a branch and open a pull request. The `ci-ok`
  check and CodeQL must be green.
- User-visible changes go under `## [Unreleased]` in `CHANGELOG.md`, written to
  the [changelog style](docs/changelog-style.md): a **bold lead sentence** per
  bullet, at most 300 characters, sections in Keep a Changelog order. `npm
  test` enforces it. CI, test and refactor-only changes get no entry.
- Install commands in docs are pinned (`npx -y session-namer@X.Y.Z`); the
  release script moves the pins, so never edit them by hand.

## Releasing

1. Make sure `## [Unreleased]` reads well as release notes, and give minor and
   major releases a one-line `_summary_`: it becomes the release title.
2. `npm run release -- X.Y.Z` bumps every manifest and pin, dates the
   changelog and prints the commands for a release PR whose title and body
   come from the changelog.
3. Merge the PR, then tag the merge commit: `git tag -a vX.Y.Z -m vX.Y.Z &&
   git push origin vX.Y.Z`.
4. The Release workflow verifies the tag and tests, publishes to npm through
   trusted publishing (OIDC, no token) with provenance, checks the provenance
   is served, then publishes the GitHub release: title from the summary, notes
   from the changelog, plus install, verify and full-changelog lines.

Never store an npm token in the repository, and never move a tag that already
has a GitHub release or an npm version.
