# Proposal

## Why

`test_mapping` classifies assertions into a vocabulary adapted from snake-eyes — `equality`, `comparison`, `membership`, `error_check`, plus `""` for 19 standard matchers it leaves unclassified (`toBeUndefined`, `toBeNull`, `toBeTruthy`, `toHaveLength`, `toHaveBeenCalled`, snapshots, …). That vocabulary is not Gaze's:

- Gaze's porting contract (`docs/porting/taxonomy-reference.md` § Assertion Types — a declared contract in `.uf/sibling-repos.yaml`) and the `assertion_type` enum of Gaze's JSON report schema (`internal/report/schema.go`) are exactly `equality`, `error_check`, `nil_check`, `diff_check`, `custom`. Reading Stone's `comparison`, `membership`, and `""` fall outside it.
- Gaze's external-analyzer adapter computes `AssertionDetectionConfidence` as the share of mapping rows with a non-empty `assertion_type` (`internal/adapter/quality.go` `classificationConfidence`). Every `""` row lowers it. On reading-stone's own suite, 324 of 3,820 rows (8.5%) were `""`; truthiness- or mock-heavy suites fare much worse.
- Gaze's Go-native detector never emits `""`: testify `Nil`/`NotNil` → `nil_check`, unknown forms → `custom`.

v0.2.0 is unpublished, so the wire vocabulary can change now without breaking any consumer.

## What Changes

- The closed kind set becomes Gaze's five values; `""`, `comparison`, and `membership` are removed.
- Routing principle: each vitest/jest/`node:assert` form takes the kind Gaze's Go detector assigns its testify analog (`classifyTestifyCall` + `mapKindToType`):
  - `equality`: all value checks — previous `equality` forms plus the `toBeGreaterThan`/`toBeLessThan` families (testify `Greater`/`Less`), `toContain`/`toContainEqual`/`toMatch`/`assert.match`/`doesNotMatch` (`Contains`/`Regexp`), `toBeTruthy`/`toBeFalsy`/`assert(value)`/`assert.ok` (`True`/`False`), `toHaveLength` (`Len`), `toBeInstanceOf`/`toBeTypeOf` (`IsType`), `toHaveProperty`, `toBeNaN`.
  - `error_check`: unchanged, plus `assert.ifError` (testify `NoError`).
  - `nil_check`: `toBeNull`, `toBeUndefined`, `toBeDefined` (`Nil`/`NotNil`).
  - `diff_check`: `toMatchSnapshot`, `toMatchInlineSnapshot` (go-cmp `Diff`).
  - `custom`: mock occurrence/count forms (`toHaveBeenCalled[Times]`, `toHaveReturned[Times]`, `toBeCalled[Times]`), `toSatisfy`, `assert.fail`, and the miss path (unknown/custom matchers).
- Negation, `.resolves.`, and `.rejects.` semantics are unchanged.
- Amends the 004 normative sources in place: `spec.md` (US3 scenarios, FR-001, FR-008, FR-010, assumptions 1–2, 5), `data-model.md` (Sections 2–4, 6, 7.2, invariants), `contracts/test-mapping.md`, and an amendment note on `research.md` R6.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

None in `openspec/specs/` — the `test_mapping` contract lives in `specs/004-test-mapping/`, amended in place (above).

## Impact

- `src/quality/types.ts` — `AssertionKind` union and the serializer's closed set.
- `src/quality/matchers.ts` — both normative tables and the miss path.
- `src/quality/assertions.ts`, `src/quality/inference.ts` — doc comments only (inference branches on `error_check` alone; `assert.ifError` rows now take the error fallback chain, as an error-channel observation should).
- `tests/quality/*` — kind expectations; the doc-parity suite re-diffs the code against the amended data-model tables.
- Wire: `test_mapping` `assertion_type` values change; `analyze`, `classify_signals`, and every other method are unaffected. Gaze consumes `assertion_type` as an opaque string, so no Gaze change is needed.
- Cross-repo: snake-eyes carries the same divergence (`comparison`, `membership`, `identity`, `generic`); tracked as a follow-up there.

## Constitution Alignment

- **I. Protocol Fidelity — PASS**: aligns the wire vocabulary with Gaze's own taxonomy and report schema; deterministic, table-driven.
- **II. Detection Accuracy — PASS**: detection is unchanged (same assertions, same rows); classification now feeds Gaze's metric correctly instead of under-reporting recognized assertions.
- **III. TypeScript-Native Analysis — N/A**: no compiler-API changes.
- **IV. Testability — PASS**: coverage strategy — the existing doc-parity suite diffs `matchers.ts` against the amended data-model tables row by row; assertion, inference, and pipeline suites pin per-kind fixtures including the new `nil_check`, `diff_check`, `custom`, and `ifError → error_check` rows; 85% gate unchanged.
- **V. Analysis Safety — PASS**: no new dependencies; no I/O changes.
