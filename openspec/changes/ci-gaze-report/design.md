# Design

## Context

See `proposal.md`. Locally, Gaze v2.5.0 runs on Reading Stone with:

```bash
gaze report ./src/... --analyzer gaze-analyzer-typescript --format=markdown
```

All sections come back, in about 17 seconds. For `src/` it reports:
- 360 functions, 94.8% average line coverage;
- CRAPload 9;
- GazeCRAPload 165.

## Decisions

- **A job in `ci.yml`, not a separate workflow.** It reuses the test leg's coverage instead of running the suite again. It also runs on the same triggers and is cancelled with the rest of the run.
- **Coverage comes from `test (24)` as an artifact.** Reading Stone's `coverage` method reads `coverage/coverage-final.json`, which vitest's default v8 reporters write. Its paths are absolute runner paths, which match in the `gaze` job because both jobs check out to the same workspace.
- **Fail if the coverage file is missing.** Without the file, the report silently shows 0% line coverage and a wildly inflated CRAPload. The job checks for the file before running Gaze.
- **`./src/...`, not `./...`.** Discovery prunes only `node_modules`, `dist`, `build`, `coverage` and `.git`. The default pattern adds 645 scaffolded `.opencode/` plugin functions, which drags the numbers down: 1005 functions, 34% coverage, CRAPload 280. Changing discovery's exclusions is a separate change.
- **`--analyzer`, not `--language typescript`.** Gaze v2.5.0 doesn't honor `--language` alone (unbound-force/gaze#282).
- **The analyzer is the PR's own build.** `dist/main.js` (made executable; `tsc` doesn't set the bit) is symlinked into a PATH directory as `gaze-analyzer-typescript`. This avoids `npm link` and global installs.
- **Gaze is installed with `go install …/cmd/gaze@v2.5.0`.** That's an exact version, checked by the Go checksum database. Go 1.25 matches Gaze's `go.mod`. Bump the version by editing it.
- **Report-only.** Thresholds are governance values for a maintainer to choose. GazeCRAPload and contract coverage are too low to gate yet. The job fails only when Gaze or the analyzer fails.
- **No AI report.** `--ai=opencode` needs a secret and Gaze's reusable workflow (unbound-force/gaze#375).

## Risks

- **Coverage file layout:** a change in vitest's or the v8 coverage provider's default reporters could stop writing `coverage-final.json`. The existence check turns that into a clear failure.
- **Gaze bumps:** upgrading Gaze can change scores. The job is report-only, so this shows up as a report change, not a failure.
