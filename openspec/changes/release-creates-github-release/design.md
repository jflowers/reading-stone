# Design

## Context

See `proposal.md`. The workflow already creates the tag (preflight) and stages the package (stage job); this change adds the GitHub release and drops one approval.

## Decisions

- **A separate `github-release` job, not a step in the stage job.** The stage job holds the OIDC token permission; keeping `contents: write` in a job that checks out nothing and runs only `gh` keeps each job's permissions minimal.
- **Created after staging, not after npm approval.** npm has no supported approval callback, and a job polling npm for hours would burn runner time and hit the 6-hour job limit. The tag is already permanent when the release is created, so the release adds no new exposure; a rejected stage means deleting the release by hand.
- **Skip staging when the version is already on npm.** `npm view reading-stone@X.Y.Z version` succeeds only for published versions. On a re-run after the maintainer approved, the stage job then succeeds without work and the release job still runs. A version that is staged but not yet approved still fails `npm stage publish` (staged and published versions share one version index); OIDC trust tokens cannot run `npm stage list` to detect that case.
- **Release idempotence.** `gh release view` before `gh release create` makes the job a no-op when the release already exists.
- **Environment kept, reviewer removed.** The npm trust relationship pins the `npm` environment, and its `main`-only policy still limits which runs can obtain the OIDC token.

## Risks

- Anyone with write access can now stage a version without a second person. It stays private until the maintainer approves it with 2FA; an unwanted stage is rejected with `npm stage reject`.
