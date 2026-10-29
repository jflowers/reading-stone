# Implementation Plan: Test-to-Assertion Mapping (test_mapping)

**Branch**: `004-test-mapping` | **Date**: 2026-10-29 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `/specs/004-test-mapping/spec.md`

## Summary

Implement the test-to-assertion mapping pipeline — the `test_mapping`
protocol method (originating issue
[reading-stone#5](https://github.com/zero-dot-force/reading-stone/issues/5),
porting snake-eyes' hardest-learned capability). The pipeline pairs
collected vitest/jest test functions with production targets through three
first-match-wins strategies — naming conventions (exact title match `90`,
case-insensitive-only `70`), direct calls (`80`), and the import graph
(`75`, restricted to file-referenced imported bindings) — then detects
every assertion in each paired test's callback subtree (`expect()`
matcher invocations, one row per matcher, plus `node:assert` calls),
classifies each into `equality` / `comparison` / `membership` /
`error_check` or the empty string via a normative matcher table, infers
the assertion's side-effect type through four pinned provenance passes
(direct identity, indirect root resolution, helper bridging, inline call
matching) with total fallback chains (value rows: `ReturnValue` → first
P0 effect → `GeneratorYield` → `AsyncGeneratorYield` → `ReturnValue`;
error rows: `ErrorReturn` → `ErrorSignal` → `ErrorReturn`), and emits one
eight-key `MappingRow` per (paired test, assertion) — deterministically
ordered by `(test_file, test_function, target_package, target_function,
assertion source position)` and byte-identical across repeat requests
(FR-013). The `prepareAnalysis` pipeline gains an additive, opt-in
test-arm widening (targets stay the identical `analyze` file set,
FR-006); `initialize` advertises `test_mapping: true` and the reserved
`-32601` set shrinks to exactly `analyze/stream`, `doc_coverage`,
`cognitive_complexity` (FR-014). The materialized OpenSpec
server/protocol specs are updated in the same change, with README and
AGENTS bookkeeping (FR-015). See [research.md](research.md) for
decisions, [data-model.md](data-model.md) for entities and the normative
matcher table, [contracts/test-mapping.md](contracts/test-mapping.md)
for the wire contract, and [quickstart.md](quickstart.md) for runnable
validation scenarios.

## Technical Context

**Language/Version**: TypeScript (runtime dependency `typescript` pinned
`7.0.2`, promoted by spec 002; the native-compiler surface
`typescript/unstable/sync` + `typescript/unstable/ast` is the analysis
infrastructure), Node.js 22+ (`engines.node >=22`), ES modules
(`"type": "module"`, `module: NodeNext`).

**Primary Dependencies**: Runtime: `typescript` unstable API — the AST
guards (`isCallExpression`, `isPropertyAccessExpression`,
`isFunctionExpression`, `isArrowFunction`, `isImportDeclaration`, …) for
the test-function collector, assertion detector, and provenance walker;
`Checker.getSymbolAtLocation` (the verified `typescript/unstable/sync`
surface spec 003 already rides) for import-graph resolution and
direct-call resolution over test files; `Program.getSourceFile` for
reaching test-file sources in program mode — plus Node.js stdlib. Dev:
`@biomejs/biome`, `vitest` + `@vitest/coverage-v8` (unchanged). **No new
dependencies** (Constitution V dependency-necessity: every compiler
query rides a context bootstrapped by the already-shared
`prepareAnalysis` pipeline).

**Storage**: N/A (stateless subprocess; filesystem reads only — the
mapping pipeline adds no filesystem surface beyond the existing
`prepareAnalysis` walk, which widens additively to pre-read the test
arm through the same bounded `readBounded`).

**Testing**: vitest with `@vitest/coverage-v8`; pure-rule table tests
for the matcher classification table (including data-model doc parity —
the disposition-table anti-drift pattern), the pairing name rules, and
the fallback chains; `mkdtemp` fixture trees pinning exact eight-key rows
per strategy, per provenance pass, and per assertion form (SC-001
through SC-004); protocol conformance through the injectable-stream
`Server.run()` harness (capability flag, shrunk reserved set, the shared
`-32602` table — SC-005); golden byte-identical determinism tests;
static-analysis canary trees (a throwing module planted in the compiler's
resolved import graph — the caller-index precedent, Constitution V).
Protected 85% thresholds on lines, statements, functions, branches.

**Target Platform**: POSIX subprocess (stdin/stdout JSON-RPC) spawned by
Gaze; CI on ubuntu-latest, local dev on macOS.

**Project Type**: library/executable analyzer backend (`reading-stone`
npm package with `bin: dist/main.js`); no end-user CLI.

**Performance Goals**: Whole-tree mapping bounded by tree size; one
`getSymbolAtLocation` query per import specifier per test file (the
import-graph binding pass) and per call expression inside test callbacks
(direct-call resolution) — the same order as the detector's existing
per-callee checker traffic; evidence never recomputed per assertion.
Reference-presence checks (is an imported binding used outside its
import clause?) are lexical identifier scans, deliberately not per-node
checker queries (research R4). No latency SLA in scope for this change.

**Constraints**: Determinism is absolute — byte-identical responses for
the same tree and analyzer version (Constitution I; FR-013), the pinned
row order, and fixed strategy confidences (90/70/80/75 — deviations are
bugs); the assertion-kind vocabulary is closed at four values plus the
empty string (FR-001/FR-008); `side_effect_type` is one of the 48
canonical taxonomy names (aliases never emitted); unpaired tests and
assertion-less paired tests produce no rows — never confidence-0 rows
(FR-005, US1-3); inference is total — every value row carries a
`side_effect_type` even for effect-less targets (US1-7); analyzed source
is untrusted input — strictly static, test files are parsed by the
compiler API and never executed or imported (Constitution V, FR-012);
parse-only degradation reduces precision, never availability (spec edge
case 1); 85% coverage thresholds, `biome check`, strict `tsc`, and
`npm ci` are protected gates (FR-016).

**Scale/Scope**: Arbitrary untrusted TypeScript/JavaScript projects; row
cardinality bounded by Σ(paired test functions × collected assertions);
target set bounded by the in-scope extraction records; test arm bounded
by the discovered, exclusion-screened test files; resource bounds
inherited from the `prepareAnalysis` pipeline (16 MiB file cap, AST
depth budget, bounded compiler host).

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

Pre-design evaluation against
[`.specify/memory/constitution.md`](../../.specify/memory/constitution.md)
(v1.0.1):

1. **Protocol Fidelity — PASS**. `test_mapping` implements the
   protocol's method shape exactly: the shared analysis-params surface
   (`root_path` + optional `patterns`) with the same `-32602` error table
   as `analyze` (FR-013, reusing `validateAnalysisParams` verbatim), the
   result `{"mappings": [...]}` with exactly the eight pinned keys per
   row (FR-001), integer confidences in [0, 100], the closed
   assertion-kind set (`equality`, `comparison`, `membership`,
   `error_check`, `""` — never `generic`, never `null`), canonical
   `side_effect_type` membership, `<path>:<line>` assertion locations
   with no column component, and root-relative POSIX `test_file` paths.
   Row serialization fails loud on invalid field content — the
   `serializeSignal`/`serializeFunctionRecord` house convention extended
   to `serializeMappingRow`. The capability flip (`test_mapping: true`,
   FR-014) is the protocol's own gating mechanism, registered in the
   same change as the dispatch handler so no commit advertises a
   capability the dispatch table lacks. Determinism is structural: the
   `(test_file, test_function, target_package, target_function,
   assertion source position)` total order and the sorted-key envelope
   serializer; no timestamps or environment-dependent data; golden tests
   pin byte-identical repeat responses (SC-005, US1-6).
2. **Detection Accuracy — PASS with documented precision surfaces**.
   Pairing is heuristic evidence with pinned, fixture-pinned confidence
   semantics: the three strategies are evaluated first-match-wins per
   test (FR-004), each pair carrying its strategy's integer confidence,
   and unpaired tests emit nothing rather than confidence-0 rows
   (US1-3) — availability through pairing breadth, precision through
   strategy ordering. The inference layer is total: every value row
   carries a `side_effect_type` through the fallback chains (FR-009/
   FR-010) even when provenance fails or the target has no detected
   effects (US1-7) — the reference analyzer's hardest-learned lesson
   (mismatched inference silently zeroed contract coverage for
   generator targets) is built in from the start via the
   generator-aware fallback chain. Documented imprecision surfaces:
   parse-only degradation (import-graph and call resolution fall back to
   lexical name matching; barrels cannot be crossed — spec edge cases 1
   and 7), same-titled sibling tests sharing a `test_function` identity
   (edge case 2), and conservative provenance boundaries that keep the
   deterministic mapping rather than guessing (FR-011).
3. **TypeScript-Native Analysis — PASS**. Every structural question
   routes through the compiler API: test-function collection, assertion
   detection, and provenance are AST walks over compiler-produced
   source files (`isCallExpression` guards and the node kinds the
   extractor already consumes — the same rule class as the detector's
   pattern rules); import-graph resolution and direct-call resolution
   use `Checker.getSymbolAtLocation` over test files admitted to the
   program through the `prepareAnalysis` widening (Constitution III's
   "name resolution … SHOULD use the TypeScript Program/TypeChecker"),
   following re-exports to declaring functions exactly as the edge case
   pins for checker mode. The remaining rules — title matching, matcher
   names, describe-title qualification — are closed lexical string rules
   over compiler-produced nodes, not reimplemented TypeScript
   semantics. Both `.ts` and `.js` test files are first-class (the
   discovery walk's six extensions).
4. **Testability — PASS**. Coverage strategy specified (research R11;
   FR-016): the matcher table is pure normative data conformance-pinned
   against `data-model.md` (the routing-table anti-drift pattern); the
   pairing strategies, assertion forms, and provenance passes are
   pinning fixtures — one `mkdtemp` fixture tree per strategy, per pass,
   per classification kind, each asserting the exact eight-key row
   including the confidence (SC-001 through SC-004); the pipeline
   modules take the injected `PreparedAnalysis`-shaped inputs and the
   injected stderr sink (no hidden filesystem or compiler state);
   protocol conformance runs through the injectable-stream harness with
   the shared `-32602` table, the capability flag, and the shrunk
   reserved set (SC-005); golden byte-identical determinism tests
   (US1-6); static-analysis canary trees pin Principle V. All at the
   protected 85% thresholds with no external services.
5. **Analysis Safety — PASS**. Strictly static: test files are untrusted
   input, parsed with the compiler API inside the already-bounded
   hermetic host, never executed, imported, or required (FR-012's
   explicit mandate; canary fixtures pin it). The test-arm widening
   adds reads only through the existing bounded `readBounded` (16 MiB
   cap) and the existing walk/screen chain — no new filesystem surface
   beyond pre-reading the already-discovered test arm, and the program
   host's on-demand serving semantics are unchanged (in-root paths were
   already served transitively; research R2). No new dependency. No
   constitution conflict requires a resolution record beyond the
   documented parse-only degradation boundary and the pairing
   precision surfaces, which follow the spec's own "degradation reduces
   precision, never availability" philosophy.

**Post-design re-evaluation (after Phase 1)**: All five verdicts stand.
The Phase 1 artifacts introduce no new tension: the data model's
matcher table routes every enumerated standard matcher and assert form
to a kind or explicitly to none (FR-007/FR-008 totality, unknown forms
routed to `""` by the pinned fallback rule rather than dropped); the
contract derives its wire shape, ordering, and error codes from the
shared analysis-params surface and FR-013/FR-014; the `prepareAnalysis`
widening is additive and opt-in (targets stay the identical `analyze`
file set — FR-006 parity is structural); the provenance boundaries and
fallback chains are pinned exactly as FR-009/FR-010/FR-011 require, with
the reference analyzer's conservative-trace rationale recorded. No
principle conflicts were found; no Complexity Tracking entries are
required.

## Project Structure

### Documentation (this feature)

```text
specs/004-test-mapping/
├── plan.md              # This file (/speckit.plan command output)
├── research.md          # Phase 0 output (/speckit.plan command)
├── data-model.md        # Phase 1 output (/speckit.plan command)
├── quickstart.md        # Phase 1 output (/speckit.plan command)
├── contracts/           # Phase 1 output (/speckit.plan command)
│   └── test-mapping.md  # test_mapping JSON-RPC contract
├── checklists/          # Spec-phase checklist (existing, unmodified)
└── tasks.md             # Phase 2 output (/speckit.tasks command - NOT created by /speckit.plan)
```

### Source Code (repository root)

```text
src/
├── index.ts             # (edit) re-export the mapping pipeline's public surface
├── main.ts              # (unchanged) CLI entry: reading-stone --stdio
├── protocol.ts          # (edit) initialize capability: test_mapping -> true (FR-014)
├── server.ts            # (edit) register the test_mapping handler over the shared
│                        #      analysis-params validation and -32602 mapping (FR-013)
├── taxonomy.ts          # (unchanged) canonical names + TIER_MAP feed the fallback chains
├── models.ts            # (unchanged) derivePackage feeds target_package
├── analysis.ts          # (edit) prepareAnalysis gains the additive, opt-in test-arm
│                        #      widening: an includeTestArm option and a testPaths result
│                        #      field; test files join the bootstrap input so the checker
│                        #      can resolve test-file imports; records stay narrowed to
│                        #      the in-scope source arm (FR-006 parity, research R2)
├── program.ts           # (unchanged) ProgramContext — both arms' sources and the checker
├── extract.ts           # (unchanged) ExtractionRecord — the target records
├── detector.ts          # (unchanged) detectEffects — the targets' effect sets
├── complexity.ts        # (unchanged)
├── coverage.ts          # (unchanged)
├── internal.ts          # (unchanged) compareFileLineName / relativeUnderBase
├── safeio.ts            # (unchanged)
├── discovery.ts         # (unchanged) classifyFiles — the test/source partition
├── signals/             # (unchanged) the classification signal pipeline
└── quality/             # (new) the test-mapping package (FR-001–FR-013)
    ├── types.ts         # MappingRow wire record + fail-loud serializer + result shape
    ├── matchers.ts      # normative MatcherTable: expect matchers + node:assert forms
    │                    #      routed to kinds or explicitly to none (FR-007/FR-008)
    ├── collect.ts       # test-function collection: it/test/describe walk, modifier
    │                    #      chains, describe-qualified titles (FR-002/FR-003)
    ├── assertions.ts    # assertion detection: expect-chain reconstruction, node:assert
    │                    #      import tables, one row per matcher invocation (FR-007)
    ├── pairing.ts       # three first-match-wins strategies, pinned confidences,
    │                    #      deterministic pair order and dedup (FR-004/FR-005)
    ├── inference.ts     # four provenance passes + the fallback chains (FR-009–FR-011)
    └── pipeline.ts      # testMapping() entry — the orchestration over prepareAnalysis's
                         #      widened output and the row assembly + ordering (FR-012/FR-013)

tests/
├── quality/                    # (new) mirrors the mapping package one-to-one
│   ├── types.test.ts           # serializer validation: closed kind set, canonical types,
│   │                           #      integer confidence, field shapes
│   ├── matchers.test.ts        # table conformance: every enumerated form routed, negation/
│   │                           #      resolves/rejects semantics, data-model parity
│   ├── collect.test.ts         # it/test/describe fixtures: modifiers, each-forms, titles,
│   │                           #      hooks excluded, non-static titles, identity collisions
│   ├── assertions.test.ts      # expect-chain fixtures (one per kind + unclassified, negated,
│   │                           #      awaited, resolves/rejects, no-matcher, two matchers),
│   │                           #      node:assert fixtures, assertion_location pinning
│   ├── pairing.test.ts         # strategy fixtures: 90/70/80/75 exact, first-match-wins,
│   │                           #      multi-target ordering, dedup, unpaired emits nothing
│   ├── inference.test.ts       # pass fixtures (one per pass), generator targets, error
│   │                           #      family, fallback chains, conservative boundaries
│   └── pipeline.test.ts        # end-to-end fixture trees: exact row sets, zero/partial/
│                               #      full assertion coverage, determinism goldens, canary
├── analysis.test.ts            # (edit) prepareAnalysis widening: testPaths additive,
│                               #      default behavior unchanged, target-set parity
└── server.test.ts              # (edit) test_mapping dispatch, shared -32602 table,
                                #      capability flag + shrunk reserved set (SC-005)
```

Implementation must also update, in the same change (FR-015, mirroring
spec 002 FR-031 and spec 003 FR-017):

```text
openspec/specs/server/spec.md    # dispatch table: test_mapping joins the built-ins; the
                                 # reserved -32601 list shrinks to analyze/stream,
                                 # doc_coverage, cognitive_complexity; scenario updated
openspec/specs/protocol/spec.md  # initialize capability assertions: test_mapping true
                                 # (the "other four flags false" wording and scenario)
README.md                        # method table: test_mapping -> Implemented; capability
                                 # note and reserved-set wording; project structure
                                 # (incl. the src/index.ts re-export comment line);
                                 # Limits & Troubleshooting: pipeline-cost bullet's
                                 # method list + fixed-scope entries (assertion-library
                                 # scope, parse-only degradation, sibling collisions);
                                 # ported-design attribution sentence
NOTICE                           # attribution sentence gains the test-mapping
                                 # pipeline design
AGENTS.md                        # project structure gains src/quality/; module map notes
```

**Structure Decision**: Single-project layout (existing flat `src/`
style) plus one new package directory, `src/quality/` — the issue's
proposed layout realized at plan time (spec assumption 15 grants the
adjustment): `pairing.ts` and `pipeline.ts` keep the issue's names;
`assertions.ts` keeps its name but absorbs the expect-chain and
node:assert detection; the issue's `mapping.ts` splits into `types.ts`
(the wire record and serializer — the signals package's house pattern)
and the row-assembly stage of `pipeline.ts`; `matchers.ts` (normative
classification data, the routing.ts precedent), `collect.ts`
(test-function collection), and `inference.ts` (effect-type inference)
are additions the issue's list implied but did not name. The method
entry `testMapping()` lives in `src/quality/pipeline.ts` rather than
`src/analysis.ts`: unlike `classify_signals` (which runs `analyze`'s
identical stages and therefore lives beside it), the mapping pipeline's
stages diverge after `prepareAnalysis`, and the entry's only
shared-pipeline dependency is the widened `prepareAnalysis` import —
dependency direction `server → quality/pipeline → {analysis
(prepareAnalysis), quality/*, detector, extract, taxonomy, models,
internal, program}` with `taxonomy`/`models`/`internal` and
`quality/{types, matchers}` as leaves — acyclic, no layering inversion
(convention pack AP-005; `analysis.ts` keeps throwing
`InvalidRootPathError` for the server to map to `-32602`). The pipeline
consumes the `ProgramContext` inside the handler's existing dispose
lifetime; test files mirror source modules one-to-one under
`tests/quality/`.

## Complexity Tracking

> **Fill ONLY if Constitution Check has violations that must be justified**

No violations. All five constitution principles PASS pre- and post-design.
The documented tradeoffs — the parse-only degradation set (lexical
name matching for import-graph and call resolution; barrels uncrossed —
spec edge cases 1 and 7), the pairing strategies' heuristic confidence
semantics (pinned integers, first-match-wins — spec assumptions 6/7),
the conservative provenance boundary (FR-011), the empty-string
unclassified convention (spec assumptions 1/2), and the `prepareAnalysis`
opt-in widening (research R2, which keeps FR-006's target parity
structural) — are recorded in research.md and the data model as
decisions with rejected alternatives, not principle violations.
