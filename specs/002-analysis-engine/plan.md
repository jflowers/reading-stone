# Implementation Plan: Analysis Engine (analyze, complexity, coverage)

**Branch**: `002-analysis-engine` | **Date**: 2026-10-27 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `/specs/002-analysis-engine/spec.md`

## Summary

Implement the core analysis engine — the three protocol methods that make
reading-stone an analyzer rather than a scaffold. `analyze` bootstraps a
`ts.Program` + `ts.TypeChecker` from the project's own `tsconfig.json`
(parse-only fallback without one), extracts function records (declarations,
methods, constructors, accessors, assigned arrows/expressions), and detects
observable side effects over the 48-type canonical taxonomy — six P0 types
at zero false negatives/positives, eleven P1 types wherever they occur,
TS-native P2 subset, best-effort P3/P4 — with dual emission for `throw`
(ErrorSignal + ErrorReturn), the FR-015 param-write split
(PointerArgMutation/SliceMutation/MapMutation/ContainerMutation),
ambiguity-marked effects for unresolvable constructs (Principle II), and
module-scope sentinels attached to the file's first function record.
`complexity` computes cyclomatic complexity (1 + closed decision-point list)
over the same extraction set; `coverage` parses the pre-existing Istanbul
`coverage-final.json` with innermost-function statement attribution and
empty-result fallbacks. `typescript` moves from devDependencies to
dependencies (runtime promotion, no version change). A 48-row disposition
table (`docs/effect-disposition.md`) records every type's detection
coverage with a conformance test. See [research.md](research.md) for
decisions and [data-model.md](data-model.md),
[contracts/analyze.md](contracts/analyze.md),
[contracts/complexity.md](contracts/complexity.md),
[contracts/coverage.md](contracts/coverage.md), [quickstart.md](quickstart.md)
for the Phase 1 design.

## Technical Context

**Language/Version**: TypeScript (compiler `typescript` ^7 promoted to a
runtime `dependency` by this change — FR-029), Node.js 22+ (`engines.node
>=22`), ES modules (`"type": "module"`, `module: NodeNext`).

**Primary Dependencies**: Runtime: `typescript` (the compiler API —
`ts.readConfigFile`, `ts.parseJsonConfigFileContent`, `ts.createProgram`,
`ts.createSourceFile`, `ts.TypeChecker`) plus Node.js stdlib. Dev:
`@biomejs/biome`, `vitest` + `@vitest/coverage-v8` (unchanged). No other
new dependencies.

**Storage**: N/A (stateless subprocess; filesystem reads only — the one
written artifact family, compiler emit, is force-disabled; see research R1).

**Testing**: vitest with `@vitest/coverage-v8`; injectable-stream harness
through `Server.run()`; `mkdtemp` fixture trees with known effects;
hand-authored Istanbul documents (Assumption 14); golden byte-identical
response tests; disposition-table conformance suite.

**Target Platform**: POSIX subprocess (stdin/stdout JSON-RPC) spawned by
Gaze; CI on ubuntu-latest, local dev on macOS.

**Project Type**: library/executable analyzer backend (`reading-stone` npm
package with `bin: dist/main.js`); no end-user CLI.

**Performance Goals**: Whole-tree analysis bounded by tree size; per-file
reads capped at 16 MiB (safe-reader cap applies to compiler-host transitive
reads too — research R1); AST visit depth budget (research R15); no latency
SLA in scope for this change.

**Constraints**: Determinism is absolute — byte-identical responses for
the same tree and analyzer version (Constitution I; FR-020/FR-022);
analyzed source is untrusted input — static analysis only, never execute,
never emit, all reads bounded (Constitution V); P0 detection zero
FN/FP on conformance fixtures (Constitution II); `initialize` capability
response unchanged (FR-028); 85% coverage thresholds, `biome check`, and
strict `tsc` are protected gates.

**Scale/Scope**: Arbitrary untrusted TypeScript/JavaScript projects;
resource bounds (16 MiB file cap, sync bounded compiler-host reads, AST
depth budget, no incremental state) prevent DoS.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

Pre-design evaluation against
[`.specify/memory/constitution.md`](../../.specify/memory/constitution.md)
(v1.0.1):

1. **Protocol Fidelity — PASS**. The three methods implement protocol
   v1.2.0 result shapes exactly: `analyze` → `{"functions": FunctionRecord[]}`
   (FR-020), `complexity` → `{"functions": ComplexityEntry[]}` (FR-022),
   `coverage` → `{"functions": CoverageEntry[]}` (FR-024), with field
   names, orderings, and error surfaces pinned in the contracts. The
   `initialize` capability response is unchanged (FR-028) — protocol
   v1.2.0 does not gate the core methods behind flags. Determinism is
   structural: fixed record/entry/effect orderings plus the existing
   sorted-key serializer; no timestamps or environment-dependent data.
2. **Detection Accuracy — PASS with documented precision surfaces**. The
   six P0 types are detected with zero false negatives and zero false
   positives on the conformance fixtures (FR-010/SC-001); the eleven P1
   types are detected wherever they occur with documented false-positive
   surfaces (parse-only defaults, name-form rules — FR-015, disposition
   table); unresolvable constructs report ambiguity-marked effects rather
   than omitting (FR-017 — Principle II's "ambiguity over omission").
   Every precision boundary (module-level effects, method-form
   receiver/global writes, parse-only call resolution) is recorded in the
   disposition table and spec assumptions — a documented boundary, never
   a silent skip.
3. **TypeScript-Native Analysis — PASS**. Detection and complexity run on
   the compiler's own infrastructure: `ts.Program` + `ts.TypeChecker`
   bootstrapped from the analyzed project's `tsconfig.json` (FR-003), with
   `ts.createSourceFile` parse-only fallback (FR-004) and type errors
   never aborting analysis (FR-005). The lexical scope tracker used for
   write classification is a bounded scope-address calculation, not a
   reimplementation of TypeScript semantics (research R5). JavaScript-family
   sources are analyzed, never skipped (FR-006); no annotation,
   restructuring, or configuration is required of the analyzed project.
4. **Testability — PASS**. Coverage strategy specified (research R13):
   per-module unit suites (patterns, bootstrap, extraction, detector,
   complexity, coverage), six P0 conformance fixtures, purity fixtures,
   ambiguity fixtures, protocol conformance through the injectable-stream
   harness, golden byte-identical determinism tests (SC-003/SC-006), and
   the disposition-table conformance suite (SC-008) — all at the protected
   85% thresholds with no external services.
5. **Analysis Safety — PASS**. Strictly static: analyzed code is never
   executed, imported, or required; the compiler program is constructed
   with emit, incremental, and composite state force-disabled (research
   R1) so analysis cannot write. All reads — in-scope files, the tsconfig,
   the coverage artifact, and compiler-resolved transitive files — flow
   through bounded guarded reads with one stderr diagnostic per skip
   (research R1/R10). The constitution's conflict-resolution record is
   FR-025: the protocol's "analyzer runs tests and collects coverage"
   wording is resolved in favor of Principle V — reading-stone consumes
   the pre-existing Istanbul artifact and reports empty coverage when
   none exists, never executing analyzed code. The `typescript` promotion
   (FR-029) adds no new supply-chain surface (same package, same version,
   already in the tree) and is justified by Principle III: the compiler
   API is the mandated analysis infrastructure.

**Post-design re-evaluation (after Phase 1)**: All five verdicts stand.
The Phase 1 artifacts introduce no new tension: the data model's
disposition table records every detection boundary with dispositions from
the closed set and non-empty N/A rationale (6 rows — Panic, MutexOp,
WaitGroupOp, RecoverBehavior, ReflectionMutation, UnsafeMutation — each
Go-runtime-specific with no TypeScript analog); the three contracts derive
their wire shapes, orderings, and error codes directly from protocol
v1.2.0 and the spec's FRs; the safety design (bounded compiler host,
no-emit program construction, depth-budgeted walks, artifact consumption
without test execution) satisfies Principle V with the FR-025 conflict
resolution recorded where the spec requires it. No principle conflicts
were found; no Complexity Tracking entries are required.

## Project Structure

### Documentation (this feature)

```text
specs/002-analysis-engine/
├── plan.md              # This file (/speckit.plan command output)
├── research.md          # Phase 0 output (/speckit.plan command)
├── data-model.md        # Phase 1 output (/speckit.plan command)
├── quickstart.md        # Phase 1 output (/speckit.plan command)
├── contracts/           # Phase 1 output (/speckit.plan command)
│   ├── analyze.md       # analyze JSON-RPC contract
│   ├── complexity.md    # complexity JSON-RPC contract
│   └── coverage.md      # coverage JSON-RPC contract
└── tasks.md             # Phase 2 output (/speckit.tasks command - NOT created by /speckit.plan)
```

### Source Code (repository root)

```text
src/
├── index.ts             # (edit) re-export new public analysis surface
├── main.ts              # (unchanged) CLI entry: reading-stone --stdio
├── protocol.ts          # (unchanged) initialize capability response per FR-028
├── server.ts            # (edit) register analyze/complexity/coverage handlers,
│                        #      shared analysis-params validation (FR-027)
├── taxonomy.ts          # (unchanged) canonical vocabulary + alias resolver
├── models.ts            # (unchanged) Effect/FunctionRecord serializers — first consumer arrives
├── safeio.ts            # (edit) add sync bounded read for the compiler host
├── discovery.ts         # (edit) export resolveRoot for the analysis pipeline
├── analysis.ts          # (new) pattern rules (FR-001), analysis scope, prepareAnalysis pipeline
├── program.ts           # (new) tsconfig bootstrap, bounded compiler host, parse-only
│                        #      fallback (FR-003–FR-006) -> ProgramContext
├── extract.ts           # (new) function extraction + lexical scope tracker
│                        #      (FR-007–FR-009) -> ExtractionRecord[]
├── detector.ts          # (new) effect detection (FR-010–FR-020) -> FunctionRecord[]
├── complexity.ts        # (new) cyclomatic complexity (FR-021–FR-022) -> ComplexityEntry[]
└── coverage.ts          # (new) Istanbul coverage parsing (FR-023–FR-026) -> CoverageEntry[]

docs/
└── effect-disposition.md # (new) 48-row disposition table (FR-030)

tests/
├── analysis.test.ts     # (new) pattern normalization/filtering, scope composition
├── program.test.ts      # (new) bootstrap: valid/absent/unparseable tsconfig, type errors, .js
├── extract.test.ts      # (new) extraction identity, naming, edge cases (overloads, accessors,
│                        #      default export, class-property initializers, IIFE attribution)
├── detector.test.ts     # (new) six P0 conformance fixtures, P1 rule fixtures, purity,
│                        #      ambiguity, sentinel attribution, determinism
├── complexity.test.ts   # (new) decision-point closure, nesting, empty body, shared extraction set
├── coverage.test.ts     # (new) vitest/jest documents, missing/invalid, per-entry tolerance,
│                        #      out-of-root keys, patterns filter
├── disposition.test.ts  # (new) table conformance: 48 rows, closed set, N/A rationale (SC-008)
├── server.test.ts       # (edit) three-method dispatch, param validation, reserved -32601 set
└── (existing suites unchanged)
```

Implementation must also update, in the same change (FR-031, mirroring
spec 001 Assumption 12):

```text
openspec/specs/server/spec.md    # dispatch: initialize/shutdown/discover/analyze/complexity/coverage;
                                 # reserved -32601 list shrinks to test_mapping, classify_signals,
                                 # analyze/stream, doc_coverage, cognitive_complexity
openspec/specs/protocol/spec.md  # capability semantics note: core methods ungated (wording unchanged
                                 # where already correct; update any reserved-list assertion)
package.json                     # typescript: devDependencies -> dependencies (FR-029, same range)
README.md                        # method table: analyze/complexity/coverage -> Implemented
AGENTS.md                        # project structure + technology stack (runtime typescript dep)
```

**Structure Decision**: Single-project layout (existing flat `src/`
style), extending the 001 module family. The analysis engine is split by
responsibility mirroring the reference analyzer's proven layout
(snake-eyes `analysis/detector.py`, `analysis/complexity.py`,
`coverage.py`): `program.ts` owns bootstrap (Principle III infrastructure),
`extract.ts` owns the shared function-extraction surface that structurally
guarantees `analyze` and `complexity` report the same set (FR-022),
`detector.ts`/`complexity.ts`/`coverage.ts` are independent computations
over that surface, and `analysis.ts` composes scope + bootstrap +
extraction so both consumers share one pipeline. Dependency direction
`server → {analysis, detector, complexity, coverage} → {extract, program,
discovery, safeio, taxonomy, models}` with `taxonomy`/`models` as leaves —
acyclic, no layering inversion (discovery keeps throwing
`InvalidRootPathError` for the server to map to `-32602`). Test files
mirror source modules one-to-one, extending the existing vitest suites.

## Complexity Tracking

> **Fill ONLY if Constitution Check has violations that must be justified**

No violations. All five constitution principles PASS pre- and post-design.
The documented tradeoffs — parse-only precision surfaces (FR-015), the
lexical scope tracker in extraction (a scope-address calculation, not a
semantics reimplementation), the FR-025 Principle V conflict resolution,
and the typescript runtime promotion (FR-029) — are recorded in
research.md and the disposition table as decisions with rejected
alternatives, not principle violations.
