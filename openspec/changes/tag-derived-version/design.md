# Design

## Context

See `proposal.md`. The release workflow (archived change `2026-11-23-add-release-workflow`) already creates the tag from the dispatch input; only the version source changes.

## Decisions

- **Placeholder `0.0.0-development` on `main`.** This is semantic-release's documented convention. It sorts below every real version, cannot be confused with a release, and is valid semver for `npm ci`. Alternative: keep the bump PR (release-please style). Rejected: two steps and a mismatch failure mode for a single-maintainer package.
- **`npm version --no-git-tag-version` in the stage job, not committed back.** The tag already marks the released commit; committing a bump back to `main` would need a token that can bypass the main ruleset. The CI gates run first, on the tag exactly as committed (the tests pin the placeholder); the version is written afterwards. Nothing in `dist/` embeds the version (`VERSION` is read from `package.json` at load time), and `prepublishOnly` rebuilds anyway.
- **`VERSION` read from `package.json`.** A literal in `src/index.ts` would have to be rewritten by the workflow as well (a second edit, by `sed`). Reading `new URL("../package.json", import.meta.url)` resolves to the package root from both `src/` (vitest) and `dist/` (published), and `package.json` always ships.
- **Prerelease detection from the tag.** Equivalent to reading the rewritten `package.json`, but it does not depend on step order.
- **CHANGELOG stays hand-written.** Entries accumulate under `Unreleased` in feature PRs; the GitHub release uses generated notes. Dating the section remains a later, optional docs commit.

## Risks

- A tag that is valid semver for the preflight but not for npm. The preflight accepts `vX.Y.Z[-pre]` without build metadata, which `npm version` accepts too.
