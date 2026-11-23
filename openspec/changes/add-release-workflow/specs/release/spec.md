## ADDED Requirements

### Requirement: Tag-triggered staged npm release

The repository SHALL provide a GitHub Actions workflow at `.github/workflows/release.yml` that runs on pushed tags matching `v*`. The job runs in the `npm` environment. Its permissions are `contents: read` and `id-token: write`, and the workflow-level permissions are empty. It authenticates to npm only through OIDC trusted publishing: no npm token is referenced. It stages the package with `npm stage publish --provenance` and never runs `npm publish`.

#### Scenario: A version tag stages the package

- **WHEN** a tag `vX.Y.Z` is pushed and the `package.json` version is `X.Y.Z`
- **THEN** after environment approval, the workflow runs the CI gates (`npm ci`, `npx biome check src/ tests/`, `npm run build`, `npx vitest run --coverage`) and stages `reading-stone@X.Y.Z` with provenance, awaiting maintainer 2FA approval

#### Scenario: Tag and package version disagree

- **WHEN** the pushed tag is not `v` followed by the `package.json` version
- **THEN** the workflow fails before staging anything

#### Scenario: Prerelease versions stage under next

- **WHEN** the `package.json` version contains a prerelease identifier (`-`)
- **THEN** the package is staged with `--tag next`, never `latest`

#### Scenario: Actions are pinned

- **WHEN** the workflow file is inspected
- **THEN** every `uses:` reference is pinned to a full 40-character commit SHA
