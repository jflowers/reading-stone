# Proposal

## Why

v0.2.0 was published by hand: a maintainer ran `npm publish` from a local checkout. npm trusted publishing is now configured for `reading-stone`: GitHub Actions, `zero-dot-force/reading-stone`, workflow `release.yml`, environment `npm`. It is stage-only, so the trust relationship allows `npm stage publish` but not `npm publish` or `npm dist-tag`. Package publishing access requires 2FA and disallows tokens. No `release.yml` exists yet, so the trust relationship has nothing to authenticate, and every release still depends on a maintainer's local machine and credentials.

## What Changes

- Add `.github/workflows/release.yml`. On a pushed `v*` tag it:
  - runs in the `npm` GitHub environment, which requires reviewers and has a `v*` tag deployment policy;
  - checks that the tag equals `v` + the `package.json` version;
  - runs the same gates as `ci.yml`;
  - stages the package with `npm stage publish --provenance` through OIDC, with no token anywhere.

  The staged version goes public only when a maintainer approves it on npmjs.com with 2FA.
- README: a "Releasing" section that documents the tag → stage → approve flow.

Out of scope: automating the GitHub release notes, CHANGELOG dating, and version bumps. Those stay with the maintainer before tagging.

## Capabilities

### New Capabilities

- `release`: how a tagged version reaches the npm registry.

### Modified Capabilities

None.

## Impact

- New `.github/workflows/release.yml`; `README.md`.
- No source, test, or package changes. The Gaze protocol contract is unaffected.
