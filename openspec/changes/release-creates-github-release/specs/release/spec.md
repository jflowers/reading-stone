# Spec Delta

## MODIFIED Requirements

### Requirement: Tag-versioned dispatched npm release

The repository SHALL provide `.github/workflows/release.yml`, triggered only by `workflow_dispatch` with a required `tag` input, that creates the `v*` tag, stages the package, versioned from the tag, in the `npm` environment via OIDC trusted publishing (`npm stage publish --provenance`), and creates the GitHub release for the tag, never running `npm publish` or referencing an npm token. Workflow-level permissions SHALL be empty; the stage job SHALL hold only `contents: read` and `id-token: write`, and the GitHub release job only `contents: write`.

#### Scenario: A valid run tags and stages

- **WHEN** a maintainer runs the workflow from `main` with `tag` `vX.Y.Z`, `vX.Y.Z` does not exist and is newer than the latest tag, and `test (22)` and `test (24)` passed on `HEAD`
- **THEN** the preflight creates the annotated tag `vX.Y.Z` at `HEAD`. The stage job checks out the tag, runs the CI gates (`npm ci`, `npx biome check src/ tests/`, `npm run build`, `npx vitest run --coverage`) on it as committed, sets the package version to `X.Y.Z` without committing, and stages `reading-stone@X.Y.Z` with provenance, awaiting maintainer 2FA approval on npm

#### Scenario: The staged version is the tag

- **WHEN** the workflow stages a package for `tag` `vX.Y.Z`
- **THEN** the staged package's `version`, and the `VERSION` export of its entry point, equal `X.Y.Z` whatever version `package.json` declares on `main`

#### Scenario: Run dispatched off main

- **WHEN** the workflow is dispatched from any ref other than `refs/heads/main`
- **THEN** the workflow fails before any tag is created or anything is staged

#### Scenario: Prerelease versions stage under next

- **WHEN** the `tag` contains a prerelease identifier (`-`)
- **THEN** the package is staged with `--tag next`, never `latest`, and the GitHub release is marked as a prerelease

#### Scenario: Actions are pinned

- **WHEN** the workflow file is inspected
- **THEN** every `uses:` reference, reusable workflows included, is pinned to a full 40-character commit SHA

#### Scenario: The GitHub release follows staging

- **WHEN** the stage job succeeds for `tag` `vX.Y.Z`
- **THEN** a GitHub release for `vX.Y.Z` exists with generated notes; if it already existed, the job leaves it unchanged and succeeds

#### Scenario: An already-published version is not restaged

- **WHEN** the stage job runs for `tag` `vX.Y.Z` and `reading-stone@X.Y.Z` is already published on npm
- **THEN** the stage job skips the CI gates and staging and succeeds, and the GitHub release job still runs
