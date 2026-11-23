# Tasks

## 1. Version source

- [ ] 1.1 `package.json`/`package-lock.json` version `0.0.0-development`; `src/index.ts` reads `VERSION` from `../package.json`; `tests/cli.test.ts` pins `VERSION` to the `package.json` version and `package.json` to the placeholder

## 2. Workflow

- [ ] 2.1 `release.yml`: verify job keeps only the main-only check; stage job runs `npm version "${TAG#v}" --no-git-tag-version` after the gates, before `npm stage publish`; prerelease detection reads the tag

## 3. Documentation

- [ ] 3.1 README "Releasing" (one dispatch, no bump) and status heading; `CHANGELOG.md` Unreleased note

## 4. Gates

- [ ] 4.1 `actionlint` passes on `release.yml`; CI parity gates pass (`npx biome check src/ tests/`, `npm run build`, `npx vitest run --coverage`)
