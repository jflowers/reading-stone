# Design

## Context

The npm trust relationship pins three values that cannot be edited later: the workflow filename `release.yml`, the environment `npm`, and the repository `zero-dot-force/reading-stone`. The filename is therefore fixed. CI-010's `ci_` prefix applies to consumers of reusable workflows. `release.yml` calls none, and neither does `ci.yml`, which sets the precedent.

## Decisions

- **Stage, never publish.** The trust relationship only allows `npm stage publish`. The workflow can put a version into the staged area, but only a maintainer can make it public, by approving it with 2FA on npmjs.com or with `npm stage approve`. A compromised workflow run can therefore never publish a version on its own. The `npm` environment's required reviewers are a second gate in front of the run itself.
- **Provenance is explicit.** `npm stage publish` defaults `--provenance` to false, unlike `npm publish` under trusted publishing, so the workflow passes `--provenance`. This needs `id-token: write`, which the job requests along with `contents: read`. The workflow-level permissions are `{}` (CI-020, CI-021).
- **Pinned npm.** Staging needs npm ≥ 11.15.0 and OIDC needs ≥ 11.5.1. The npm bundled with the runner's Node 24 isn't pinned, so the job installs `npm@11.21.2`, an exact version more than two weeks old. Node 24 matches the newest leg of the CI matrix.
- **Tag/version guard.** A `v*` tag whose version differs from `package.json` fails before anything is staged. That catches a tag pushed on the wrong commit, or a bump that was never committed.
- **Gates repeated.** The job reruns `npm ci`, biome, build, and vitest with coverage, so the staged tarball is built from a commit that passes the same checks as `ci.yml`.
- **No dependency cache.** `setup-node` runs without `cache: npm`, so a cache written by another workflow can't feed the publish job.
- **Prerelease dist-tag.** npm refuses to stage a prerelease without `--tag`. A version containing `-` is staged under `next`; anything else stages under the default `latest`.
- **Actions pinned by SHA.** These are the same `actions/checkout` v7.0.1 and `actions/setup-node` v7.1.0 commits that `ci.yml` uses, re-verified against the GitHub API (CI-001, CI-002).

## Risks

- The trust relationship's `release.yml` and `npm` values must match exactly. If they drift, OIDC exchange fails and nothing is staged. That fails loudly in the run, and nothing is half-published.
- Tag creation is restricted by a repository ruleset, so tagging stays a deliberate maintainer action.
