# Tasks

## 1. Workflow

- [ ] 1.1 `release.yml`: the stage job skips the gates and staging when `reading-stone@X.Y.Z` is already on npm; a `github-release` job (needs stage, `contents: write` only) creates the release with generated notes (`--prerelease` for prerelease tags), skipping when it exists

## 2. Documentation

- [ ] 2.1 README "Releasing": dispatch, approve on npm; rejected-stage cleanup

## 3. Gates

- [ ] 3.1 `actionlint` passes on `release.yml`; CI parity gates pass (`npx biome check src/ tests/`, `npm run build`, `npx vitest run --coverage`)

## 4. Repository settings (maintainer)

- [ ] 4.1 `npm` environment: remove the required reviewer, keep the `main` deployment policy (zero-dot-force/.github)
