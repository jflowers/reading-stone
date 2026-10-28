# Implementation Plan: Classification Signal Pipeline (classify_signals)

**Branch**: `003-classify-signals` | **Date**: 2026-10-28 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `/specs/003-classify-signals/spec.md`

## Summary

Implement the classification signal pipeline — the evidence layer behind
every `{label, confidence}` classification and the `classify_signals`
protocol method. Five mechanical signal extractors run per (function,
effect-type) pair over the same extraction set `analyze` reports:
interface satisfaction (+30, checker-resolved heritage membership), API
visibility (+8 exported function / +6 exported return type / +6 exported
receiver type, clamped to +20), caller dependency (distinct-module inbound
buckets +5/+10/+15 through a checker-resolved caller index), naming
conventions (18 contractual prefixes +10, 4 incidental prefixes −10, the
`Err`-prefixed `SentinelError` special case +30 — all gated by a 48-type
routing table), and documentation (JSDoc `@returns`/`@throws` tags +15
direct, nine prose verbs +5 indirect, four incidental verbs −15, same
routing gate; wire source string `docstring`). The adapter fans the
extractors out per pair, synthesizes exactly one −20 `contradiction`
signal for mixed-polarity pairs, and computes
`confidence = clamp[0,100](50 + tier_boost + Σ(signal weights) − 20)` with
labels `contractual` ≥ 80, `ambiguous` [50, 80), `incidental` < 50.
`analyze` wires the computed classification onto every reported effect
(superseding spec 002 FR-019's omission rule — FR-012); the new
`classify_signals` method returns the raw signals deterministically
ordered by `(package, function, side_effect_type, source)` (FR-014);
`initialize` advertises `classify_signals: true` and the reserved
`-32601` set shrinks to exactly four names (FR-015). The materialized
OpenSpec server/protocol specs are updated in the same change (FR-017).
See [research.md](research.md) for decisions,
[data-model.md](data-model.md) for entities and the normative routing
table, [contracts/classify-signals.md](contracts/classify-signals.md) and
[contracts/analyze-classification.md](contracts/analyze-classification.md)
for the wire contracts, and [quickstart.md](quickstart.md) for runnable
validation scenarios.

## Technical Context

**Language/Version**: TypeScript (runtime dependency `typescript` pinned
`7.0.2`, promoted by spec 002; the native-compiler surface
`typescript/unstable/sync` + `typescript/unstable/ast` is the analysis
infrastructure), Node.js 22+ (`engines.node >=22`), ES modules
(`"type": "module"`, `module: NodeNext`).

**Primary Dependencies**: Runtime: `typescript` unstable API — `Checker`
(`getSymbolAtLocation`, `getDeclaredTypeOfSymbol`, `getBaseTypes`,
`getSignatureUsage`, symbol member tables) for interface satisfaction,
return-type resolution, and caller resolution; `getJSDocTags` /
`getTextOfJSDocComment` from the ast layer for documentation evidence —
plus Node.js stdlib. Dev: `@biomejs/biome`, `vitest` +
`@vitest/coverage-v8` (unchanged). **No new dependencies** (Constitution
V dependency-necessity: every compiler query rides the already-bootstrapped
no-emit program from `prepareAnalysis`).

**Storage**: N/A (stateless subprocess; filesystem reads only — the signal
pipeline adds no filesystem surface beyond the existing
`prepareAnalysis` walk).

**Testing**: vitest with `@vitest/coverage-v8`; pure-rule table tests over
per-record evidence snapshots (extractors are pure functions — no compiler
in unit scope); `mkdtemp` controlled-signal-profile fixture trees with
every contributing signal pinned and exact-arithmetic `{label, confidence}`
assertions (SC-001/SC-002/SC-003); multi-module caller-index fixtures
(US3-1..7); protocol conformance through the injectable-stream
`Server.run()` harness; golden byte-identical determinism tests
(SC-005/SC-006); routing-table conformance including data-model doc parity
(the `tests/disposition.test.ts` anti-drift pattern).

**Target Platform**: POSIX subprocess (stdin/stdout JSON-RPC) spawned by
Gaze; CI on ubuntu-latest, local dev on macOS.

**Project Type**: library/executable analyzer backend (`reading-stone` npm
package with `bin: dist/main.js`); no end-user CLI.

**Performance Goals**: Whole-tree signal extraction bounded by tree size;
record-level evidence (exportedness, documentation, interface membership,
caller count) computed **once per record**, never per pair; the caller
index costs one `getSignatureUsage` query per extracted record (the same
order as the detector's existing per-callee checker queries); no latency
SLA in scope for this change.

**Constraints**: Determinism is absolute — byte-identical responses for
the same tree and analyzer version (Constitution I; FR-014), total
orderings and fixed reasoning templates; the confidence formula, weights,
clamp, and label boundaries are pinned arithmetic (FR-009/FR-010) —
deviations are bugs; the signal source set is closed at six values
(`interface`, `visibility`, `caller_count`, `naming_convention`,
`docstring`, `contradiction` — FR-001/FR-011); analyzed source is
untrusted input — static analysis only, never execute, all compiler
queries over the bounded no-emit program (Constitution V); parse-only
degradation reduces precision, never availability (spec edge case 1);
85% coverage thresholds, `biome check`, strict `tsc`, and `npm ci` are
protected gates (FR-018).

**Scale/Scope**: Arbitrary untrusted TypeScript/JavaScript projects;
signal cardinality bounded by (records × distinct effect types × ≤ 5
sources + ≤ 1 contradiction per pair); resource bounds inherited from the
`prepareAnalysis` pipeline (16 MiB file cap, AST depth budget, no
incremental state).

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

Pre-design evaluation against
[`.specify/memory/constitution.md`](../../.specify/memory/constitution.md)
(v1.0.1):

1. **Protocol Fidelity — PASS**. `classify_signals` implements the
   protocol's method shape exactly: the shared analysis-params surface
   (`root_path` + optional `patterns`) with the same `-32602` error table
   as `analyze` (FR-014, reusing `validateAnalysisParams`), the result
   `{"signals": [...]}` with field names `function`/`package` (never
   `name`), canonical `side_effect_type`, the closed six-value source set
   carrying the protocol's established `docstring` string (spec
   Clarification Q2), integer weights, and optional short `reasoning`.
   The capability flip (`classify_signals: true`, FR-015) is the
   protocol's own gating mechanism — Gaze calls the method when and only
   when the flag is true. `analyze`'s classification field is now always
   present with a serializer-validated `{label, confidence}` (FR-012),
   superseding spec 002 FR-019 through the spec'd evolution path; the
   existing fail-loud `serializeClassification` (closed label set,
   integer confidence 0–100) stays in force. Determinism is structural:
   the `(package, function, side_effect_type, source)` total order,
   fixed reasoning templates, and the sorted-key envelope serializer; no
   timestamps or environment-dependent data; golden tests pin
   byte-identical repeat responses (SC-005, US1-7).
2. **Detection Accuracy — PASS with documented precision surfaces**. The
   pipeline never drops an effect: the formula is total, so every effect
   carries a classification — an effect with no signals yields
   `50 + tier_boost` (the ambiguous floor, US1-3; Principle II's
   ambiguity-over-omission). Signals are heuristic evidence with
   documented, fixture-pinned imprecision surfaces: prefix
   stem-boundary false positives (`readyCheckout` matching `Read`, spec
   assumption 5), routing-gated keyword matching, and the parse-only
   degradation set (interface and caller_count signals absent — research
   R7). Detection confidence (spec 002 FR-017 marker) and classification
   label remain distinct notions (assumption 14). The −20 contradiction
   penalty and clamp keep mixed-polarity and extreme evidence inside the
   pinned arithmetic (FR-009/FR-011).
3. **TypeScript-Native Analysis — PASS**. Every semantic question routes
   through the compiler: interface satisfaction through the checker's
   heritage resolution and declared-member tables (research R6), caller
   resolution through `getSignatureUsage` — the checker's own
   cross-module reference machinery (research R7; Constitution III's
   "name resolution … SHOULD use the TypeScript Program/TypeChecker"),
   the return-type visibility component through checker symbol
   resolution, and documentation evidence through the compiler's own
   JSDoc attachment (`getJSDocTags`, research R4). The remaining rules —
   name-prefix matching, keyword matching, exportedness forms — are
   closed lexical string rules over compiler-produced names and
   declarations (the same rule class as the detector's name-form rules),
   not reimplemented TypeScript semantics. JavaScript-family sources are
   first-class (the CJS `module.exports` exportedness form, spec edge
   case 5).
4. **Testability — PASS**. Coverage strategy specified (research R13):
   extractors are pure functions over per-record evidence snapshots
   (dependency inversion — the only module touching `ProgramContext` is
   `evidence.ts`/`caller-index.ts`), enabling exhaustive table tests
   without compiler fixtures; controlled-signal-profile fixture trees pin
   exact arithmetic per signal category (SC-001), contradiction
   (SC-002), and tier offsets (SC-003); the caller index is unit-tested
   against multi-module fixtures with exact distinct-module counts
   (US3-1..7); protocol conformance runs through the injectable-stream
   harness with the shared `-32602` table, capability flag, and shrunk
   reserved set (SC-006); golden byte-identical determinism tests
   (SC-005); the routing table is conformance-pinned against
   `data-model.md` (the disposition-table anti-drift pattern) — all at
   the protected 85% thresholds with no external services.
5. **Analysis Safety — PASS**. Strictly static: analyzed code is never
   executed, imported, or required — caller counting is checker-resolved
   reference finding over the already-bootstrapped no-emit program, not
   instrumentation (FR-016's explicit mandate). All compiler reads
   already flow through the bounded compiler host (spec 002 research
   R1); this change adds no filesystem surface and no dependency. The
   contradiction signal and reasoning strings are pure functions of the
   tree. No constitution conflict requires a resolution record beyond
   the parse-only degradation boundary (research R7), which follows the
   spec's own "degradation reduces precision, never availability"
   philosophy.

**Post-design re-evaluation (after Phase 1)**: All five verdicts stand.
The Phase 1 artifacts introduce no new tension: the data model's routing
table routes all 48 canonical types to a branch or explicitly to none
(FR-007 totality), with the closed prefix/keyword/tag lists exactly as
FR-005/FR-006 pin them; the contracts derive their wire shapes, orderings,
and error codes from the shared analysis-params surface and the spec's
FR-014/FR-015; the analyze-classification contract records the FR-012
supersession of spec 002 FR-019 as a spec'd evolution with the serializer
unchanged; the parse-only degradation set (interface, caller_count) is
recorded in the data model and quickstart as a documented boundary. No
principle conflicts were found; no Complexity Tracking entries are
required.

## Project Structure

### Documentation (this feature)

```text
specs/003-classify-signals/
├── plan.md                        # This file (/speckit.plan command output)
├── research.md                    # Phase 0 output (/speckit.plan command)
├── data-model.md                  # Phase 1 output (/speckit.plan command)
├── quickstart.md                  # Phase 1 output (/speckit.plan command)
├── contracts/                     # Phase 1 output (/speckit.plan command)
│   ├── classify-signals.md        # classify_signals JSON-RPC contract
│   └── analyze-classification.md  # analyze response classification contract
├── checklists/                    # Spec-phase checklist (existing, unmodified)
└── tasks.md                       # Phase 2 output (/speckit.tasks command - NOT created by /speckit.plan)
```

### Source Code (repository root)

```text
src/
├── index.ts             # (edit) re-export the signal pipeline's public surface
├── main.ts              # (unchanged) CLI entry: reading-stone --stdio
├── protocol.ts          # (edit) initialize capability: classify_signals -> true (FR-015)
├── server.ts            # (edit) register the classify_signals handler over the shared
│                        #      analysis-params validation and -32602 mapping (FR-014)
├── taxonomy.ts          # (unchanged) TIER_MAP feeds the tier boost (FR-009)
├── models.ts            # (unchanged) Classification + serializer — first producer arrives (FR-012)
├── analysis.ts          # (edit) analyze wires computed classifications onto effects (FR-012/FR-013)
├── program.ts           # (unchanged) ProgramContext — the checker the signal pipeline consumes
├── extract.ts           # (unchanged) ExtractionRecord — the fan-out unit
├── detector.ts          # (unchanged) detectEffects / assembleFunctionRecords
├── complexity.ts        # (unchanged)
├── coverage.ts          # (unchanged)
├── internal.ts          # (unchanged)
├── safeio.ts            # (unchanged)
├── discovery.ts         # (unchanged)
└── signals/             # (new) the classification signal package (FR-001–FR-016)
    ├── types.ts         # Signal record + fail-loud serializer + result shape
    ├── routing.ts       # normative 48-type routing table + closed lists + agreement
    │                    #      predicates (FR-007); Record<SideEffectType, …> exhaustive
    ├── evidence.ts      # per-record evidence snapshot — the one compiler seam the
    │                    #      extractors depend on (exportedness, doc, interface, callers)
    ├── interface.ts     # interface-satisfaction extractor: +30 (FR-002)
    ├── visibility.ts    # API-visibility extractor: +8/+6/+6, clamp +20 (FR-003)
    ├── caller-index.ts  # checker-resolved import-graph caller index (FR-016)
    ├── caller.ts        # distinct-module bucket extractor: +5/+10/+15 (FR-004)
    ├── naming.ts        # naming-convention + sentinel extractor: ±10, +30 (FR-005)
    ├── jsdoc.ts         # documentation extractor, wire source `docstring` (FR-006)
    └── adapter.ts       # fan-out, contradiction synthesis, confidence formula,
                         #      classifySignals() + the analyze wiring seam (FR-008–FR-013)

tests/
├── signals/                    # (new) mirrors the signal package one-to-one
│   ├── types.test.ts           # serializer validation: closed source set, canonical types,
│   │                           #      integer weights, reasoning shape
│   ├── routing.test.ts         # table conformance: 48 keys, closed lists, data-model parity
│   ├── evidence.test.ts        # exportedness forms (ESM/CJS), doc extraction, interface
│   │                           #      membership, parse-only degradation
│   ├── interface.test.ts       # pure rule table + program-mode satisfaction fixtures
│   ├── visibility.test.ts      # pure rule table + component/edge fixtures (clamp inertness)
│   ├── caller-index.test.ts    # multi-module fixtures: 0/1/2/3/4+ callers, one module many
│   │                           #      sites, self-recursion, method calls, file-set parity
│   ├── caller.test.ts          # bucket table: 1→+5, 2–3→+10, ≥4→+15, 0→none
│   ├── naming.test.ts          # prefix table, case-insensitivity, longest-wins, sentinel
│   │                           #      special case, routing gate
│   ├── jsdoc.test.ts           # tag/prose table, strongest-tier resolution, word boundaries
│   └── adapter.test.ts         # fan-out, pair keying, contradiction, formula/clamp/labels
│                               #      (boundary fixtures 80/79/50/49), tier offsets, ordering
├── analysis.test.ts            # (edit) every effect classified (SC-004), analyze/classify_signals
│                               #      consistency (FR-013), parse-only degradation, determinism
└── server.test.ts              # (edit) classify_signals dispatch, shared -32602 table,
                                #      capability flag + reserved set (SC-006), golden responses
```

Implementation must also update, in the same change (FR-017, mirroring
spec 002 FR-031):

```text
openspec/specs/server/spec.md    # dispatch table: classify_signals joins the built-ins; the
                                 # reserved -32601 list shrinks to test_mapping, analyze/stream,
                                 # doc_coverage, cognitive_complexity; scenario updated
openspec/specs/protocol/spec.md  # initialize capability assertions: classify_signals true
                                 # (the "other five flags false" wording and scenario)
README.md                        # method table: classify_signals -> Implemented; capability note
AGENTS.md                        # project structure gains src/signals/; mission notes
```

**Structure Decision**: Single-project layout (existing flat `src/` style)
plus one new package directory, `src/signals/`, mirroring the reference
analyzer's proven split (snake-eyes `signals/` package: one module per
source, an adapter that fans out, no scoring engine — the platform owns
scoring). The package is the issue's proposed layout realized at plan
time (spec assumption 16 grants the adjustment): the caller index lives
at `src/signals/caller-index.ts` rather than the issue's
`src/analysis/inference.ts`, because `src/analysis.ts` (a file) and
`src/analysis/` (a directory) would shadow each other in imports and the
index's only consumer is the signal pipeline (research R12). The
extractors are pure functions over an evidence snapshot computed once per
record (`evidence.ts`) — the dependency-inversion seam that keeps compiler
interaction out of the rule modules and makes every rule trivially table-
testable (Constitution IV). Dependency direction
`server → {analysis, signals/adapter} → {signals/*, detector, extract, program, discovery, safeio, taxonomy, models}` with `taxonomy`/`models`
and `signals/{types, routing}` as leaves — acyclic, no layering
inversion (`analysis.ts` keeps throwing `InvalidRootPathError` for the
server to map to `-32602`). The signal pipeline consumes the
`ProgramContext` inside the handlers' existing dispose lifetime; test
files mirror source modules one-to-one under `tests/signals/`.

## Complexity Tracking

> **Fill ONLY if Constitution Check has violations that must be justified**

No violations. All five constitution principles PASS pre- and post-design.
The documented tradeoffs — the parse-only degradation set (interface and
caller_count signals absent without a checker; research R7), prefix
stem-boundary imprecision (spec assumption 5), the routing-gated
keyword surface (research R2), and the pair-keyed fan-out interpretation
(research R8, which keeps FR-011's sum-invariant exact) — are recorded in
research.md and the data model as decisions with rejected alternatives,
not principle violations.
