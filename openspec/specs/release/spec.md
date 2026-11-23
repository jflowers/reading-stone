# release Specification

## Purpose
How reading-stone versions are released: the dispatched `release` workflow that creates the `v*` tag and stages the package to npm through trusted publishing for maintainer approval.

## Requirements

### Requirement: Dispatched staged npm release

The repository SHALL provide `.github/workflows/release.yml`, triggered only by `workflow_dispatch` with a required `tag` input, that creates the `v*` tag and stages the package in the `npm` environment via OIDC trusted publishing (`npm stage publish --provenance`), never running `npm publish` or referencing an npm token. Workflow-level permissions SHALL be empty; the stage job SHALL hold only `contents: read` and `id-token: write`.

#### Scenario: A valid run tags and stages

- **WHEN** a maintainer runs the workflow from `main` with `tag` `vX.Y.Z`, the `package.json` version at `HEAD` is `X.Y.Z`, `vX.Y.Z` does not exist and is newer than the latest tag, and `test (22)` and `test (24)` passed on `HEAD`
- **THEN** the preflight creates the annotated tag `vX.Y.Z` at `HEAD`. After environment approval, the stage job checks out the tag, runs the CI gates (`npm ci`, `npx biome check src/ tests/`, `npm run build`, `npx vitest run --coverage`), and stages `reading-stone@X.Y.Z` with provenance, awaiting maintainer 2FA approval

#### Scenario: Tag and package version disagree

- **WHEN** the `tag` input is not `v` followed by the `package.json` version at `HEAD`
- **THEN** the workflow fails before any tag is created or anything is staged

#### Scenario: Run dispatched off main

- **WHEN** the workflow is dispatched from any ref other than `refs/heads/main`
- **THEN** the workflow fails before any tag is created or anything is staged

#### Scenario: Prerelease versions stage under next

- **WHEN** the `package.json` version contains a prerelease identifier (`-`)
- **THEN** the package is staged with `--tag next`, never `latest`

#### Scenario: Actions are pinned

- **WHEN** the workflow file is inspected
- **THEN** every `uses:` reference, reusable workflows included, is pinned to a full 40-character commit SHA
