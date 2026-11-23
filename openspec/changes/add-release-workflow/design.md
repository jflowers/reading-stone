# Design

## Context

The npm trust relationship pins three values that cannot be edited later: the workflow filename `release.yml`, the environment `npm`, and the repository `zero-dot-force/reading-stone`. It does not pin the trigger.

The `version tags` ruleset (id 27665496) blocks creation, deletion, and non-fast-forward updates of `refs/tags/v*`, and has no bypass actors. Maintainers cannot tag at all.

unbound-force/unbound-force releases through a `workflow_dispatch` that takes a `tag` input. Its first job is `complytime/org-infra`'s `reusable_release_preflight.yml`, which validates the tag and creates it. This change adopts that pattern.

## Decisions

- **Dispatch with a tag input, not a tag push; tags immutable, not creation-locked.** GitHub rejects the GitHub Actions app as a ruleset bypass actor ("must be part of the ruleset source or owner organization"), so the workflow's `GITHUB_TOKEN` can only create a `v*` tag if creation is allowed. The tag ruleset therefore follows gaze, dewey, and replicator's `release-tag-protection`: `refs/tags/v*`, rules `deletion` and `non_fast_forward` (no `creation`), with `OrganizationAdmin` as the bypass actor to repair a bad tag. It replaces the `version tags` ruleset. A hand-pushed `v*` tag publishes nothing, because the workflow runs only on `workflow_dispatch`. Staging still needs the dispatch, the `npm` environment approval, and the maintainer's npm 2FA approval. Both settings are declared in `zero-dot-force/.github` (`safe-settings/repos/reading-stone.yml`).
- **Verify before tagging.** A first job, with no permissions, fails unless the run is on `refs/heads/main` and the tag equals `v` + the `package.json` version at `HEAD`. This keeps a run dispatched from a feature branch, or with a mistyped tag, from creating a tag. The preflight would otherwise tag the dispatched `HEAD`, whatever it is.
- **Shared preflight, pinned.** The workflow calls `complytime/org-infra/.github/workflows/reusable_release_preflight.yml` at `8f347ba1aa2c7e9eb3b70e69c1709ddb456cd64a`, tag `v0.9.0`, the same pin unbound-force uses, re-verified against the GitHub API (CI-001, CI-002). It is called with `allow_prerelease: true` and explicit `ci_checks: ["test (22)", "test (24)"]`, the check names `ci.yml`'s matrix produces. Its job holds `contents: write` and `checks: read` only, to create the tag and read check runs.
- **Stage, never publish.** The trust relationship only allows `npm stage publish`. The workflow can put a version into the staged area, but only a maintainer can make it public, by approving it with 2FA on npmjs.com or with `npm stage approve`. The `npm` environment's required reviewers are a second gate in front of the stage job.
- **Environment policy follows the ref.** A dispatched run's `github.ref` is the branch it ran from, not the tag it creates. The `npm` environment's deployment policy therefore changes from the `v*` tag pattern to the `main` branch. The stage job checks out the created tag explicitly, so it builds exactly the tagged commit.
- **Provenance is explicit.** `npm stage publish` defaults `--provenance` to false, so the stage job passes it. This needs `id-token: write`, which the stage job requests along with `contents: read`. The workflow-level permissions are `{}` (CI-020, CI-021).
- **Pinned npm.** Staging needs npm ≥ 11.15.0 and OIDC needs ≥ 11.5.1. The stage job installs `npm@11.21.2`, an exact version more than two weeks old, on Node 24.
- **Gates repeated, no cache.** The stage job reruns `npm ci`, biome, build, and vitest with coverage on the tagged commit. `setup-node` runs without `cache: npm`, so a cache written by another workflow can't feed the publish job.
- **Prerelease dist-tag.** npm refuses to stage a prerelease without `--tag`, so a version containing `-` stages under `next`.
- **Filename.** `release.yml` is fixed by the trust relationship, and it matches unbound-force's own `release.yml`. CI-010's `ci_` prefix targets consumers of reusable workflows. That makes `release.yml` a consumer, of the preflight, but the npm pin overrides the prefix: renaming would break trusted publishing.

## Risks

- If the reviewer rejects the `npm` environment after the tag is created, the tag exists without an npm release. Re-running the workflow with the same tag is safe: the preflight detects a tag at `HEAD` as a re-run and skips creation.
- If `ci.yml`'s job names or matrix change, the `ci_checks` list must change too, or the preflight fails closed.
- If the trust relationship's `release.yml` and `npm` values drift, OIDC exchange fails and nothing is staged. The failure is loud.
