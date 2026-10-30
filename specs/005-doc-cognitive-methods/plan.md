# Implementation Plan: Protocol v1.2.0 doc_coverage and cognitive_complexity Methods

**Branch**: `005-doc-cognitive-methods` | **Date**: 2026-10-30 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `/specs/005-doc-cognitive-methods/spec.md`

**Note**: This template is filled in by the `/speckit.plan` command; its definition describes the execution workflow.

## Summary

Reading Stone implements the last two optional analysis methods of Gaze
protocol v1.2.0: `doc_coverage` (the exported-symbol documentation
surface — one row per exported module declaration and public member of
an exported class, with a `documented` flag and first-line
`doc_snippet`) and `cognitive_complexity` (the SonarSource cognitive
complexity score for every function record the extraction table
already produces). Both close the shared `prepareAnalysis` pipeline
(spec 002/003), register on the server's dispatch table, flip their
capability flags in the same protocol-state unit as registration, and
shrink the reserved `-32601` set to exactly `analyze/stream`. OpenSpec
main specs and the README are updated so every capability advertised
is a capability served (FR-014).

Technical approach (research R1–R15): two new flat modules —
`src/doc-coverage.ts` (symbol-surface declaration walk + `SymbolRow`
serializer) and `src/cognitive.ts` (nesting-aware AST walk +
`CognitiveRow` serializer) — both modeled on `src/complexity.ts`'s
entry-closes-pipeline, handler-owns-context-lifetime pattern. The
symbol surface is a fresh declaration walk over the in-scope source
files `collectSources` yields (exported from `extract.ts` as a pure
widening, R2); the cognitive score is a single `visit(node, nesting)`
walk per extraction record with SonarSource increments (R7–R10). The
`complexity` method's row set is the structural parity reference for
`cognitive_complexity` (FR-022); the `(file, line, name)` shared
total order governs both new row sets.

## Technical Context

**Language/Version**: TypeScript source on Node.js 22+; the runtime
compiler package is `typescript` 7.0.2 (the native compiler, consumed
via `typescript/unstable/ast` and `typescript/unstable/sync` — see
`src/program.ts`).

**Primary Dependencies**: `typescript` (sole runtime dependency —
compiler API for parsing, programs, and JSDoc rendering); dev:
`vitest` + `@vitest/coverage-v8`, `biome`. No new dependencies (P5).

**Storage**: N/A — stateless analysis subprocess; no persistence.

**Testing**: vitest with `@vitest/coverage-v8` (85% protected
thresholds on lines/statements/functions/branches). New suites
`tests/doc-coverage.test.ts` and `tests/cognitive.test.ts` mirror the
src tree; `tests/server.test.ts` and `tests/protocol.test.ts` gain
dispatch, capability, and reserved-set cases. The FR-010 fixture
table is a golden-value suite.

**Target Platform**: Node.js 22+ subprocess spawned by Gaze;
JSON-RPC 2.0 over stdin/stdout (`reading-stone --stdio`).

**Project Type**: library — a language analyzer implementing the
Gaze external analyzer protocol; no CLI of its own.

**Performance Goals**: a reading-stone-scale repository (≈60 source
files) analyzed well inside Gaze's per-request 5-minute timeout;
each method's marginal cost is one additional bounded AST pass over
already-prepared records/sources, within a small constant factor of
the existing `complexity` method.

**Constraints**: byte-identical deterministic responses (P1 — sorted
envelope keys, stable `(file, line, name)` row order); parse-only and
program modes produce identical rows (mode parity — recursion
detection is binding-blind text matching, R10, so program mode adds
nothing either method needs); no analyzed code is ever executed (P5);
file reads bounded by `safeio` via `prepareAnalysis`.

**Scale/Scope**: TypeScript/JavaScript repositories of the size Gaze
already analyzes (thousands of functions, hundreds of files). Both
walks revisit only trees extraction already admitted under its
`AST_DEPTH_BUDGET`, so memory and depth stay within existing budgets
(R12).

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

1. **Protocol Fidelity — PASS.** Wire shapes, field names, capability
   flags, error codes, and degradation contracts come verbatim from
   protocol.md v1.2.0 (sibling clone, commit `fa2212e`). Rows sort by
   the shared `(file, line, name)` total order; the server serializer
   sorts envelope keys; FR-010's fixture values are golden tests. The
   protocol doc's `patterns` "required" table cell diverges from
   FR-001's optional pin — the spec is authoritative (the same
   divergence note the `complexity` contract carries for spec 002
   FR-027 semantics).
2. **Detection Accuracy — PASS.** The symbol surface is
   declaration-driven with every gap a *documented boundary* (R3/R4:
   expression default exports, export clauses, CJS spellings,
   destructuring patterns), never a silent omission; cognitive scores
   match SonarSource reference values on the normative fixture table;
   recursion detection includes both `f(...)` and `this.f(...)`
   spellings (ambiguity over omission).
3. **TypeScript-Native Analysis — PASS.** Parsing via
   `ts.createSourceFile`/`ts.Program`; JSDoc text rendered by the
   compiler's own `getTextOfJSDocComment`; exportedness via
   `ModifierFlags`; no custom doc parser, no reimplemented TypeScript
   semantics. The cognitive walk is a metric over the compiler's AST,
   exactly as cyclomatic complexity already is.
4. **Testability — PASS.** Both entries take
   `(rootPath, patterns, stderr)` and close `prepareAnalysis`, so
   each is testable against a fixture tree in isolation; the walk
   cores are pure functions of AST nodes; serializer suites pin wire
   invariants (FR-015's coverage strategy).
5. **Analysis Safety — PASS.** Static analysis only; analyzed source
   never executes; no new runtime dependencies; reads bounded by
   `safeio` through `prepareAnalysis`.

*Re-check after Phase 1 design:* still PASS — the data model and
contracts below introduce no violations, so Complexity Tracking is
empty.

## Project Structure

### Documentation (this feature)

```text
specs/005-doc-cognitive-methods/
├── plan.md              # This file (/speckit.plan command output)
├── research.md          # Phase 0 output (/speckit.plan command)
├── data-model.md        # Phase 1 output (/speckit.plan command)
├── quickstart.md        # Phase 1 output (/speckit.plan command)
├── contracts/           # Phase 1 output (/speckit.plan command)
│   ├── doc-coverage.md
│   └── cognitive-complexity.md
└── tasks.md             # Phase 2 output (/speckit.tasks command - NOT created by /speckit.plan)
```

### Source Code (repository root)

```text
src/
├── analysis.ts          # unchanged — prepareAnalysis stays the shared entry
├── cognitive.ts         # NEW — CognitiveRow + serializer, nesting-aware walk, entry
├── doc-coverage.ts      # NEW — SymbolRow + SymbolKind + serializer, surface walk, entry
├── extract.ts           # collectSources exported (pure widening, research R2)
├── protocol.ts          # capability flags flip; result interfaces for both methods
├── server.ts            # dispatch table + reserved set shrink to analyze/stream
└── index.ts             # barrel re-exports for both new modules
tests/
├── cognitive.test.ts    # NEW — rule suite + FR-010 golden table + parity + wire invariants
├── doc-coverage.test.ts # NEW — surface walk, kind routing, snippets, serializer
├── server.test.ts       # extended — dispatch envelopes, error parity, determinism, reserved set
└── protocol.test.ts     # extended — capability flips
```

**Structure Decision**: two flat `src/` modules mirroring
`complexity.ts`/`coverage.ts` (research R1) — `src/doc-coverage.ts`
keeps issue #6's flat hyphenated name (no collision with
`src/coverage.ts`), and `src/cognitive.ts` adjusts issue #6's
`src/analysis/cognitive.ts` to flat because `src/analysis.ts` already
exists and a same-named directory invites import confusion. The
shared pipeline (`analysis.ts`, `extract.ts`, `program.ts`) is touched
only by the `collectSources` export widening. Tests mirror src
one-to-one per the repo's existing layout.

## Complexity Tracking

> **Fill ONLY if Constitution Check has violations that must be justified**

No violations — all five constitution principles PASS (see above).
