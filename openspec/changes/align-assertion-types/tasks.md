# Tasks

## 1. Implementation

- [x] 1.1 `src/quality/types.ts`: `AssertionKind` = `equality | error_check | nil_check | diff_check | custom`; serializer closed set updated; `src/quality/matchers.ts`: both tables re-routed per data-model Section 4 and the miss path → `custom`; doc comments in `assertions.ts`/`inference.ts` updated
- [x] 1.2 Update `tests/quality/*` expectations (doc parity, assertions, inference, pipeline, types) and add pins for `nil_check` (`toBeUndefined`), `diff_check` (`toMatchSnapshot`), `custom` (unknown matcher, `toHaveBeenCalled`), and `assert.ifError` → `error_check`

## 2. Gates

- [x] 2.1 Run the CI parity gates — `npx biome check src/ tests/`, `npm run build`, `npx vitest run --coverage` — all pass at ≥85%; verify on reading-stone itself that no `test_mapping` row carries an `assertion_type` outside Gaze's five values
