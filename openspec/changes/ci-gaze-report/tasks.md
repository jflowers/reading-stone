# Tasks

## 1. Workflow

- [x] 1.1 `ci.yml`: the `test` job's Node 24 leg uploads `coverage/coverage-final.json` as the `coverage` artifact
- [x] 1.2 `ci.yml`: a `gaze` job (needs `test`, `contents: read`)
  - builds, downloads the coverage and fails if it's missing;
  - installs Gaze v2.5.0 and links `dist/main.js` as `gaze-analyzer-typescript`;
  - runs `gaze report ./src/... --analyzer gaze-analyzer-typescript --format=markdown`;
  - writes the report to the job summary and uploads it as the `gaze-report` artifact.

## 2. Gates

- [x] 2.1 `actionlint` passes on `ci.yml`; CI parity gates pass (`npm ci`, `npx biome check src/ tests/`, `npm run build`, `npx vitest run --coverage`)
- [ ] 2.2 The `gaze` job passes on the PR and its summary shows the report with non-zero line coverage
