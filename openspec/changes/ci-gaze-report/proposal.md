# Proposal

## Why

Reading Stone exists to let Gaze score TypeScript, but Gaze never runs on Reading Stone itself. Running it on every PR dogfoods the analyzer built from that PR. A bad analyzer change then fails its own report or visibly skews it, and reviewers see CRAP, contract coverage and docs on the code they're reviewing.

`gaze init` is already applied: the agents, commands and the registered `divisor-gaze-testing` reviewer are present, and Gaze v2.5.0 `gaze init --force` changes nothing. `gaze init --ci` skips here because there's no `go.mod`, and Gaze's reusable AI-report workflow is Go-only (unbound-force/gaze#375). So the job lives in this repository (#40).

## What Changes

- `ci.yml`: the `test (24)` leg uploads `coverage/coverage-final.json` as an artifact.
- A new `gaze` job, which needs `test`:
  - builds Reading Stone and downloads that coverage, failing if the file is missing;
  - installs Gaze v2.5.0;
  - puts the built `dist/main.js` on PATH as `gaze-analyzer-typescript`;
  - runs `gaze report ./src/... --analyzer gaze-analyzer-typescript --format=markdown`;
  - writes the report to the job summary and uploads it as an artifact.
- Report-only: no thresholds, no AI adapter, no secrets.

## Capabilities

### New Capabilities

- `ci`: the CI workflow's Gaze self-report.

### Modified Capabilities

None.

## Impact

- **Files:** `.github/workflows/ci.yml` only.
- **Run time:** one more job, about 2 minutes (install, build, Gaze install, a 17-second report).
- **Release:** the `gaze` job isn't in `release.yml`'s `ci_checks`; releases still require only `test (22)` and `test (24)`.
- **Gaze protocol contract and package contents:** unchanged.

## Constitution Alignment

- **I. Protocol Fidelity: PASS.** Gaze consumes Reading Stone's protocol responses on every PR, so a protocol regression fails the job.
- **II. Detection Accuracy: N/A.** No detection code changes.
- **III. TypeScript-Native Analysis: N/A.** No analysis code changes.
- **IV. Testability: PASS.** The CI parity gates are unchanged. The new job adds an end-to-end protocol check of the built analyzer.
- **V. Analysis Safety: PASS.**
  - No new npm dependencies.
  - Gaze is installed by an exact module version, verified by the Go checksum database.
  - The analyzer reads the repository's own sources statically, and the job holds only `contents: read`.
