# Tasks

## 1. Workflow

- [x] 1.1 Add `.github/workflows/release.yml`: `workflow_dispatch` with a required `tag` input; a verify job (main-only, tag = `v` + `package.json` version); the pinned `complytime/org-infra` preflight (`allow_prerelease: true`, `ci_checks: ["test (22)", "test (24)"]`); a stage job in the `npm` environment (`contents: read` + `id-token: write`, checks out the tag, SHA-pinned checkout/setup-node on Node 24 with no cache, pinned `npm@11.21.2`, CI gates, `npm stage publish --provenance`, `--tag next` for prereleases)

## 2. Documentation

- [x] 2.1 README: "Releasing" section (bump and date on `main`, run the workflow with the tag, approve the environment, approve on npm, GitHub release)

## 3. Gates

- [x] 3.1 `actionlint` passes on `release.yml`; CI parity gates pass (`npx biome check src/ tests/`, `npm run build`, `npx vitest run --coverage`)

## 4. Repository settings (maintainer)

- [ ] 4.1 Tag ruleset: replace `version tags` with gaze's `release-tag-protection` (`refs/tags/v*`; `deletion`, `non_fast_forward`; `OrganizationAdmin` bypass) via zero-dot-force/.github#35
- [x] 4.2 `npm` environment: deployment policy `main` branch instead of the `v*` tag (zero-dot-force/.github#33, applied by safe-settings sync run 45237222310)
