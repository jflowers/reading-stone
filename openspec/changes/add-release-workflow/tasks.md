# Tasks

## 1. Workflow

- [x] 1.1 Add `.github/workflows/release.yml`: `v*` tag trigger, `npm` environment, job-scoped `contents: read` + `id-token: write`, SHA-pinned checkout/setup-node (Node 24, no cache), pinned `npm@11.21.2`, tag/version guard, CI gates, `npm stage publish --provenance` (`--tag next` for prereleases)

## 2. Documentation

- [x] 2.1 README: "Releasing" section (bump, CHANGELOG date, tag, environment approval, npm stage approval)

## 3. Gates

- [x] 3.1 `actionlint` passes on `release.yml`; CI parity gates pass (`npx biome check src/ tests/`, `npm run build`, `npx vitest run --coverage`)
