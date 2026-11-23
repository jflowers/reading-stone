# Tasks

## 1. Workflow

- [ ] 1.1 Add `.github/workflows/release.yml`: `workflow_dispatch` with a required `tag` input; a verify job (main-only, tag = `v` + `package.json` version); the pinned `complytime/org-infra` preflight (`allow_prerelease: true`, `ci_checks: ["test (22)", "test (24)"]`); a stage job in the `npm` environment (`contents: read` + `id-token: write`, checks out the tag, SHA-pinned checkout/setup-node on Node 24 with no cache, pinned `npm@11.21.2`, CI gates, `npm stage publish --provenance`, `--tag next` for prereleases)

## 2. Documentation

- [ ] 2.1 README: "Releasing" section (bump and date on `main`, run the workflow with the tag, approve the environment, approve on npm, GitHub release)

## 3. Gates

- [ ] 3.1 `actionlint` passes on `release.yml`; CI parity gates pass (`npx biome check src/ tests/`, `npm run build`, `npx vitest run --coverage`)

## 4. Repository settings (maintainer)

- [ ] 4.1 `version tags` ruleset: add the GitHub Actions app (Integration 15368, `always`) as the sole bypass actor
- [ ] 4.2 `npm` environment: deployment policy `main` branch instead of the `v*` tag
