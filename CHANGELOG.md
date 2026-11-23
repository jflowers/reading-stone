# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- Releases take their version from the tag given to the `release`
  workflow. `package.json` on `main` holds the placeholder
  `0.0.0-development`, and `VERSION` is read from the package's
  `package.json` instead of a hard-coded literal.

## [0.2.0] - 2026-11-23

First npm release. Implements the complete
[Gaze analyzer protocol](https://github.com/unbound-force/gaze) v1.2.0
for TypeScript and JavaScript projects.

### Added

- JSON-RPC 2.0 server over stdin/stdout (`reading-stone --stdio`).
- `initialize` / `shutdown` lifecycle; capabilities `discover`,
  `test_mapping`, `classify_signals`, `doc_coverage`, and
  `cognitive_complexity` advertised `true`, `streaming` `false`.
- `discover`: source/test file classification and test-framework
  detection (#2).
- `analyze`: side-effect detection across the 48-type Gaze taxonomy,
  with every effect classified by a deterministic signal pipeline (#3, #4).
- `complexity`: cyclomatic complexity per function (#3).
- `coverage`: per-function statement coverage read from an existing
  Istanbul `coverage/coverage-final.json` (never runs tests) (#3).
- `classify_signals`: the raw classification signal feed — `interface`,
  `visibility`, `caller_count`, `naming_convention`, `docstring`, and
  synthesized `contradiction` signals (#4).
- `test_mapping`: vitest/jest and `node:assert` test-to-assertion
  mapping with pairing confidences and side-effect inference (#5).
  `assertion_type` uses Gaze's assertion-type set (`equality`,
  `error_check`, `nil_check`, `diff_check`, `custom`), never empty (#28).
- `doc_coverage`: documentation coverage over the exported symbol
  surface (#6).
- `cognitive_complexity`: SonarSource cognitive complexity per
  function (#6).
- `gaze-analyzer-typescript` bin alias for Gaze's zero-config PATH
  discovery (`gaze ... --language typescript`).
- Program mode via the project's `tsconfig.json` (type-checker-backed
  signals and pairing), with a parse-only fallback when none is usable.

### Notes

- Runtime dependency `typescript` is pinned exactly at `7.0.2`
  (`typescript/unstable/*` API).
- The package `exports` map exposes only the root barrel and
  `./package.json`; deep imports of `dist/*` are unsupported.

[Unreleased]: https://github.com/zero-dot-force/reading-stone/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/zero-dot-force/reading-stone/releases/tag/v0.2.0
