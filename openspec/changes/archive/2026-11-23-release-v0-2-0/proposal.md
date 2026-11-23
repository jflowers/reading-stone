# Proposal

## Why

All eight analysis methods of Gaze analyzer protocol v1.2.0 have landed (#2–#6) and the `gaze-analyzer-typescript` bin alias has merged, but the package still reports version `0.1.0` and has never been published. Issue #7 tracks the v0.2.0 release: the first npm publication of `reading-stone`. A release-readiness audit also found packaging defects that must be fixed before the first publish:

- The npm tarball omits `NOTICE`. `files` lists only `dist`, and npm does not auto-include `NOTICE`, so the published package would distribute snake-eyes-derived code without the attribution Apache License 2.0 §4(d) requires.
- The tarball ships 34 `dist/**/*.map` source maps whose `sources` point at `../src/*.ts`, which is not shipped — dead weight that resolves to nothing.
- `package.json` lacks `homepage`, `bugs`, `keywords`, and an `exports` map.
- No end-to-end test drives the built server through the full protocol lifecycle in one session; the subprocess suite covers `initialize`/`shutdown`, `doc_coverage`, and `cognitive_complexity` only.
- The `cli` main spec has drifted: it still pins version `0.1.0`, a single bin, and a `^7.0.2` caret range, while the code ships two bins and an exact `7.0.2` pin (review dispatch 44e85014).
- The completed `align-protocol-v1-2-0` change was never archived.

## What Changes

- Version `0.1.0` → `0.2.0`: `package.json`, `package-lock.json`, `VERSION` in `src/index.ts`, the README status heading, and the `tests/cli.test.ts` metadata pins.
- `package.json` packaging: `files` becomes `["dist", "!dist/**/*.map", "NOTICE"]`; add `homepage`, `bugs`, `keywords`, and an `exports` map (`"."` → `dist/index.js` with types, plus `./package.json`).
- A tarball-contents test pins the shipped file set (via `npm pack --dry-run --json`): `NOTICE`, `LICENSE`, `README.md`, `package.json`, and `dist/` with no `.map` files.
- A full-lifecycle stdio smoke test against `dist/main.js`: `initialize` → `discover` → `analyze` → `complexity` → `coverage` → `test_mapping` → `classify_signals` → `doc_coverage` → `cognitive_complexity` → `shutdown` in one session over a fixture project, asserting every response is a success with the method's single result key and a non-empty row array, and that the process exits 0.
- `CHANGELOG.md` (Keep a Changelog format) with the v0.2.0 entry.
- README: v0.2.0 status heading, npm-install path promoted, note on the exact `typescript` pin.
- AGENTS.md: correct "v0.1.0 shipped" (v0.1.0 was never published).
- Archive `align-protocol-v1-2-0` with `--skip-specs`: its main-spec text was materialized at merge time and since advanced by 005, so re-applying its deltas would regress the capability scenario.

Out of scope: the publish itself (manual `npm publish` by a maintainer), a release workflow (follow-up after npm trusted publishing is configured), and the blog post (#19).

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `cli`: the `Package scaffold and entry point` requirement moves to version `0.2.0`, both bin names, the exact `typescript` `7.0.2` pin, and the `exports` map; a new `Published package contents` requirement pins the tarball file set (NOTICE included, source maps excluded).

## Impact

- `package.json`, `package-lock.json`, `src/index.ts` (`VERSION` only).
- `tests/cli.test.ts` — version pins, tarball-contents test, full-lifecycle smoke test.
- `README.md`, `AGENTS.md`, new `CHANGELOG.md`.
- `openspec/specs/cli/spec.md` via this change's delta; `openspec/changes/align-protocol-v1-2-0/` → `openspec/changes/archive/`.
- No runtime behavior change: no change to `server.ts`, `main.ts`, protocol, or any analysis module. No dependency changes.
- Gaze protocol contract: unchanged (v1.2.0); the `initialize` handshake does not report the package version, so its bytes are identical.

## Constitution Alignment

- **I. Protocol Fidelity — PASS**: no protocol change; the new lifecycle test asserts the built server answers every v1.2.0 method in sequence.
- **II. Detection Accuracy — N/A**: no detection code changes.
- **III. TypeScript-Native Analysis — N/A**: no analysis code changes.
- **IV. Testability — PASS**: coverage strategy — the lifecycle smoke test and tarball-contents test extend `tests/cli.test.ts`; both run in CI after `npm run build`; the 85% gate is unchanged.
- **V. Analysis Safety — PASS**: no new dependencies; the lifecycle fixture is static source plus a hand-authored Istanbul document, never executed.
