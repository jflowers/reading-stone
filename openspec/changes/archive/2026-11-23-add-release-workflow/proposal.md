# Proposal

## Why

v0.2.0 was published by hand: a maintainer ran `npm publish` from a local checkout. Its tag could only be pushed by temporarily bypassing the `version tags` ruleset, which blocks `v*` tag creation for everyone.

npm trusted publishing is now configured for `reading-stone`: GitHub Actions, `zero-dot-force/reading-stone`, workflow `release.yml`, environment `npm`. It is stage-only, so the trust relationship allows `npm stage publish` but not `npm publish` or `npm dist-tag`. Package publishing access requires 2FA and disallows tokens.

No `release.yml` exists yet. Every release therefore still depends on a maintainer's local machine and on a ruleset bypass to tag.

## What Changes

- Add `.github/workflows/release.yml`, a one-click release that follows the unbound-force/unbound-force pattern. A maintainer runs it from `main` with a `tag` input such as `v0.3.0`.
  1. **Verify.** The run must be on `main`, and the tag must equal `v` + the `package.json` version at `HEAD`.
  2. **Preflight.** This step uses the shared `complytime/org-infra` reusable workflow, the same one unbound-force uses. It checks that the tag is valid semver, that it is unique (re-runs are detected), and that it is newer than the latest tag. It checks that `ci.yml`'s `test (22)` and `test (24)` passed on `HEAD`, and that there are unreleased commits. Then it creates the annotated tag through the GitHub API.
  3. **Stage.** This job runs in the `npm` GitHub environment, which requires reviewers. It checks out the tag, reruns the CI gates, and runs `npm stage publish --provenance` over OIDC, with no token anywhere.

  The staged version goes public only when a maintainer approves it on npmjs.com with 2FA.
- README: a "Releasing" section documenting run → approve environment → approve on npm → GitHub release.
- Repository settings that a maintainer applies, listed in design.md:
  - the `version tags` ruleset becomes gaze's `release-tag-protection`: `v*` tags may be created, so the workflow's `GITHUB_TOKEN` can tag, but never deleted or moved; org admins can bypass;
  - the `npm` environment's deployment policy moves from the `v*` tag to the `main` branch, because a dispatched run's ref is the branch.

Out of scope: automating the GitHub release notes, CHANGELOG dating, and version bumps. Those stay with the maintainer before the run.

## Capabilities

### New Capabilities

- `release`: how a version is tagged and reaches the npm registry.

### Modified Capabilities

None.

## Impact

- New `.github/workflows/release.yml`; `README.md`.
- Repository settings, declared in `zero-dot-force/.github` safe-settings: the tag ruleset (`version tags` → `release-tag-protection`) and the `npm` environment deployment policy.
- No source, test, or package changes. The Gaze protocol contract is unaffected.
