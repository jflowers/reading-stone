# Proposal

## Why

A release currently takes four maintainer actions: dispatch the workflow, approve the `npm` GitHub environment, approve the staged version on npm with 2FA, and create the GitHub release by hand. Two of them add little:

- The environment approval gates only staging. Since the npm trust relationship is stage-only and the package requires 2FA, nothing reaches npm users without the maintainer's npm approval anyway.
- The GitHub release needs no judgment: it uses generated notes on a tag the workflow already created and the `release-tag-protection` ruleset makes permanent. The dispatch already identifies the maintainer (write access is required to run it).

npm offers no supported callback from its approval to GitHub, so the GitHub release cannot wait on the npm approval without a polling job.

## What Changes

- `release.yml` gains a final `github-release` job (needs the stage job; the only job with `contents: write`) that creates the GitHub release for the tag with generated notes, marked prerelease for prerelease tags. It skips when the release already exists, so re-runs are safe.
- The stage job first checks whether `reading-stone@X.Y.Z` is already on npm and, if so, skips the gates and staging (borrowed from opencode-auto-question's publish workflow), so a re-run after approval still reaches the GitHub release.
- README "Releasing": two maintainer steps (dispatch; approve on npm), plus what to do if a staged version is rejected (delete the GitHub release; the tag stays).
- Repository settings (zero-dot-force/.github): the `npm` environment drops its required reviewer, keeping the environment (the npm trust relationship names it) and its `main`-only deployment policy.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `release`: "Tag-versioned dispatched npm release" creates the GitHub release after staging, skips staging for an already-published version, and no longer waits on an environment approval.

## Impact

- `.github/workflows/release.yml`, `README.md`.
- zero-dot-force/.github `safe-settings/repos/reading-stone.yml` (environment reviewers).
- Trade-off: the GitHub release exists before the npm version is public. If the staged version is rejected, the maintainer deletes the GitHub release by hand.
- npm trust relationship: unchanged (same file, environment, and `npm stage publish`).
- Gaze protocol contract and package contents: unchanged.

## Constitution Alignment

- **I. Protocol Fidelity — N/A**: no protocol change.
- **II. Detection Accuracy — N/A**: no detection code changes.
- **III. TypeScript-Native Analysis — N/A**: no analysis code changes.
- **IV. Testability — PASS**: workflow-only; checked by `actionlint` and the next release run. The CI parity gates are unchanged.
- **V. Analysis Safety — PASS**: no new dependencies; the new job runs no repository code.
