## ADDED Requirements

### Requirement: Gaze self-report in CI

The `ci` workflow SHALL run Gaze on Reading Stone's own `src/` on every push and pull request to `main`. The analyzer SHALL be the Reading Stone build from the same commit, exposed as `gaze-analyzer-typescript`. Coverage SHALL come from the `test` job's Node 24 vitest run. The job SHALL hold only `contents: read`, use no secrets and no AI adapter, and enforce no thresholds.

#### Scenario: A pull request gets a Gaze report

- **WHEN** the `ci` workflow runs and `test (24)` passes
- **THEN** the `gaze` job runs `gaze report ./src/... --analyzer gaze-analyzer-typescript --format=markdown` with the pinned Gaze version, using the analyzer built from that commit, and publishes the report in the job summary and as the `gaze-report` artifact

#### Scenario: Missing coverage fails the job

- **WHEN** `coverage/coverage-final.json` is not present after downloading the `coverage` artifact
- **THEN** the `gaze` job fails before running Gaze, rather than reporting 0% line coverage

#### Scenario: An analyzer failure fails the job

- **WHEN** Gaze exits non-zero, for example because the built analyzer fails the protocol handshake or a required method
- **THEN** the `gaze` job fails

#### Scenario: Scores do not gate the job

- **WHEN** Gaze completes, whatever its CRAPload, GazeCRAPload or contract coverage
- **THEN** the `gaze` job passes
