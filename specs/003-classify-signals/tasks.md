---
description: "Task list for Classification Signal Pipeline (classify_signals) implementation"
---

# Tasks: Classification Signal Pipeline (classify_signals)

**Input**: Design documents from `/specs/003-classify-signals/`

**Prerequisites**: plan.md ✓, spec.md ✓, research.md ✓, data-model.md ✓, contracts/classify-signals.md ✓, contracts/analyze-classification.md ✓, quickstart.md ✓ — all present in this feature directory.

**Tests**: REQUIRED — the feature specification mandates them (Constitution Principle IV; SC-001 through SC-007; research R13's per-module strategy: pure-rule table tests over hand-built evidence snapshots, compiler-seam fixtures over `mkdtemp` trees, controlled-signal-profile fixtures with exact `{label, confidence}` arithmetic, routing-table conformance with data-model doc parity, analyze wiring tests, and protocol conformance through the injectable-stream harness with golden byte-identical determinism checks). Test tasks are listed FIRST within each story and MUST be written and observed to FAIL before the paired implementation lands.

**Organization**: Tasks grouped by user story (US1–US3 from spec.md). One deliberate execution-order inversion against priority order: **US3 (caller inference, P2) is scheduled before US1 (analyze classification, P1)** because US1's SC-001 signal-category fixtures and the canonical quickstart tree require the caller signal (`formatLabel`'s 93 = 50 + 25 + caller 10 + visibility 8), and US1's evidence seam consumes US3's caller index — the same bootstrap-first pattern spec 002 used when it scheduled its program-context story ahead of `analyze`. **US2 (P2) follows US1** because the `classify_signals` method wraps US1's shared pipeline (FR-013's one-pipeline guarantee is structural). The dependency graph below records the true completion order; priority still governs value (US1 remains the MVP story 🎯).

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies on incomplete tasks)
- **[Story]**: Which user story this task belongs to (US1–US3); setup/foundational/polish tasks carry no story label
- Every task names its exact file path(s); weights, lists, boundaries, and formulas are quoted from data-model.md / contracts / spec.md so no implementation-time discretion is required

## Path Conventions

Single project: `src/` and `tests/` at the repository root (per plan.md Project Structure). New code lands in the `src/signals/` package (ten modules) with test files mirroring source modules one-to-one under `tests/signals/`. Existing helpers are reused throughout — no new shared test helpers beyond one typed-field extension: `tests/helpers/fixtures.ts` provides `createFixtureTree(files)` (mkdtemp trees from a root-relative file map) and `memorySink()`; `tests/helpers/wire.ts` provides `WireRecord`/`WireEffect`, `analyzeTree`, `recordFor`, and `expectWireInvariants`; `tests/server.test.ts` provides the `drive()` injectable-stream harness and the reserved-method `it.each` list (currently at tests/server.test.ts:1066, listing five names). `vitest.config.ts` already includes `tests/**/*.test.ts` and pins the protected 85% coverage thresholds over `src/**`.

---

## Phase 1: Setup

**Purpose**: Confirm the baseline is green before any signal-pipeline code exists.

- [x] T001 Verify the baseline before any change: from the repository root run `npm ci`, `npx biome check src/ tests/`, `npm run build`, and `npx vitest run --coverage`, and confirm all four protected gates pass (CI parity gate, AGENTS.md / .github/workflows/ci.yml — never lower a gate to make it pass)

**Checkpoint**: Clean baseline confirmed — no new dependency is needed (plan.md: every compiler query rides the already-bootstrapped no-emit program; Constitution V dependency-necessity satisfied with zero additions).

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: The shared leaves every story consumes: the `Signal` wire record with its fail-loud serializer, the normative 48-row routing table with its conformance pin, and the one widening of `PreparedAnalysis` the caller index needs. No protocol surface changes; the existing green suites must survive.

**⚠️ CRITICAL**: No user story work can begin until this phase is complete — every extractor emits `Signal` values (T004), naming/docstring are routing-gated (T005), and US3's index filters by the in-scope file set (T006).

- [x] T002 [P] Create tests/signals/types.test.ts — the Signal serializer validation suite (FR-001; research R1; data-model.md Section 2): `serializeSignal` accepts each of the six closed source values — `interface`, `visibility`, `caller_count`, `naming_convention`, `docstring`, `contradiction` — and throws on any other string; `side_effect_type` validates through `resolveSideEffectType` exactly as `serializeEffect` does (canonical passes; neither canonical nor alias throws; anything else fails loud — aliases never emitted); `weight` must be an integer (fractional and non-number throw); `function` and `package` must be strings; `reasoning` is optional — absent or `undefined` omits the field (never `null`, the omit-unset-optionals rule), present it must be a non-empty string (empty string throws); the classify_signals result shape is `{"signals": [...]}` with exactly one key
- [x] T003 [P] Create tests/signals/routing.test.ts — the routing-table conformance suite (FR-007; research R2; data-model.md Section 6 — the tests/disposition.test.ts anti-drift pattern): the code table is keyed by exactly the 48 canonical types (runtime assertion against `SIDE_EFFECT_TYPES` from src/taxonomy.ts; the `Readonly<Record<SideEffectType, RoutingBranch>>` shape makes exhaustiveness compile-time); every entry's vocabulary is drawn from the closed lists — 18 contractual prefixes (Get, Fetch, Load, Read, Save, Write, Update, Set, Delete, Remove, Handle, Process, Compute, Analyze, Classify, Parse, Build, New), 4 incidental prefixes (log, debug, trace, print), 2 direct tags (@returns, @throws), 9 indirect verbs (returns, writes, modifies, updates, sets, persists, stores, deletes, removes), 4 incidental verbs (logs, prints, traces, debugs) — no other token may appear in any row; doc parity — parse specs/003-classify-signals/data-model.md's Section 6 table (readFileSync, as tests/disposition.test.ts parses docs/effect-disposition.md) and diff all 48 rows and all five columns against the code table so the prose cannot drift; the `Err`+`SentinelError` special case is NOT a table row (assert it lives in the naming extractor, not the table)
- [x] T004 [P] Create src/signals/types.ts — the Signal wire record and serializer (FR-001; research R1; data-model.md Section 2): `export interface Signal` with readonly fields `function` (unqualified record name — never `name`), `package` (the `derivePackage(relPath)` value for the record's file), `side_effect_type` (canonical `SideEffectType`), `source`, integer `weight`, optional `reasoning` (non-empty when present); the closed source set as a `Set`-typed constant (own-data membership, the `CLASSIFICATION_LABELS` pattern from src/models.ts); `serializeSignal(signal)` following models.ts house style — fail-loud on closed-source membership, `resolveSideEffectType` type validation, integer weight, non-empty reasoning when present; the `{"signals": Signal[]}` result shape type. No label field — raw signals never carry classifications (FR-001)
- [x] T005 [P] Create src/signals/routing.ts — the normative routing table (FR-005/FR-006/FR-007; research R2; data-model.md Section 6, rendered verbatim): `export interface RoutingBranch { naming: readonly string[]; docTags: readonly string[]; docIndirect: readonly string[]; docIncidental: readonly string[] }`; the closed vocabulary constants (the 18/4/2/9/4 lists above, exported for the extractors and the conformance suite); `export const ROUTING_TABLE: Readonly<Record<SideEffectType, RoutingBranch>>` — all 48 rows exactly as data-model.md Section 6 pins them: the value family (Get/Fetch/Load/Read/Compute/Analyze/Classify/Parse/Build/New + @returns + returns → ReturnValue, GeneratorYield, AsyncGeneratorYield), the error family (@throws → ErrorReturn, ErrorSignal, SentinelError; no naming prefix), the mutation family (Update/Set/Delete/Remove + modifies/updates/sets/deletes/removes → the eleven state-mutation types), the write family (Save/Write + writes, with persists/stores on FileSystemWrite and DatabaseWrite), the output family (Write + writes, plus the incidental log/debug/trace/print prefixes and logs/prints/traces/debugs verbs → LogWrite, StdoutWrite, StderrWrite), the handler family (Handle/Process → HTTPResponseWrite, ChannelSend), the construction family (Build/New → GoroutineSpawn, DescriptorEffect, FinalizerRegistration, CgoCall), the delete family (Delete/Remove + deletes/removes → FileSystemDelete), Load → ImportSideEffect, and explicitly-empty rows for every type with no agreeing vocabulary — totality: every canonical type routed to a branch or explicitly to none, never an exception at runtime
- [x] T006 [P] Extend src/analysis.ts — expose the in-scope file set on `PreparedAnalysis` (FR-016's file-set parity; research R7): add `readonly inScopePaths: readonly string[]` to the `PreparedAnalysis` interface and return the pattern-filtered, test-excluded, sorted source list `prepareAnalysis` already computes internally (the `inScope` local at src/analysis.ts:225) — a pure additive widening; the caller index (T009) filters call sites by this set so US3-7's identical-file-set guarantee is structural; the existing analysis suite stays green (no behavior change)

**Checkpoint**: Foundation ready — the Signal record serializes fail-loud, the 48-row routing table is conformance-pinned against data-model.md, and `PreparedAnalysis` carries the in-scope set. User story implementation can now begin.

---

## Phase 3: User Story 3 — Caller dependency inference over the import graph (Priority: P2 — scheduled first as US1's foundation)

**Goal**: `src/signals/caller-index.ts` derives each analyzed function's inbound distinct-module caller count through the checker's own cross-module reference machinery (`getSignatureUsage` — one query per record, never executed code), and `src/signals/caller.ts` maps the count to FR-004's buckets — so the caller signal reflects real usage structure without heuristic name matching.

**Independent Test**: Unit-test the caller index against multi-module fixture trees — functions called from 0, 1, 2, 3, and 4+ distinct modules, multiple call sites within one module, and self-recursion — asserting exact distinct-module counts and bucket weights (spec.md US3 Independent Test).

**Why before US1**: US1's SC-001 requires one fixture per signal category — caller included — and the canonical quickstart tree pins `formatLabel` at 93 only with the caller signal; US1's evidence seam consumes this index (`RecordEvidence.callerModuleCount`). The spec's own US3 rationale names this "the bootstrap story's position in spec 002": no standalone protocol surface, value realized through US1/US2.

### Tests for User Story 3 (write FIRST; must FAIL before implementation)

- [x] T007 [P] [US3] Create tests/signals/caller-index.test.ts — multi-module fixtures over `createFixtureTree` trees with a valid tsconfig (US3 scenarios 1–7; FR-016; research R7, R13; data-model.md Section 5.2): functions called from exactly 0, 1, 2, 3, and 4+ distinct modules yield exact distinct-module counts; multiple call sites to one function within a single module count once (US3-5); a function that calls itself (recursion) is not an inbound caller — positions inside the record's own body span are excluded (US3-6); the defining module counts when OTHER functions in it call the record; instance-method calls (`counter.bump()`) and aliased imports resolve through the checker; calls positioned in test-classified files are dropped — the index is built over the identical discovered, pattern-filtered, exclusion-filtered file set as `analyze`, asserted by driving both over the same request (US3-7, via T006's `inScopePaths`); a parse-only tree (no tsconfig) yields an empty index; the index never executes or imports analyzed code (Constitution V — strictly static)
- [x] T008 [P] [US3] Create tests/signals/caller.test.ts — the bucket table over hand-built counts (FR-004; US3 scenarios 1–4; data-model.md Section 7): 0 distinct modules → NO signal (weight 0 is neutral evidence and is not emitted); exactly 1 → weight +5 with source `caller_count`; 2 → +10; 3 → +10; 4 → +15; 5 and beyond → +15; every emitted signal carries the identity fields `function`, `package`, `side_effect_type` and a non-empty `reasoning`

### Implementation for User Story 3

- [x] T009 [P] [US3] Create src/signals/caller-index.ts — the checker-resolved caller index (FR-016; research R7; data-model.md Section 5.2): `buildCallerIndex(context: ProgramContext, records: readonly ExtractionRecord[], inScopePaths: readonly string[])` returning the per-record distinct-module count map — in program mode, one `checker.getSignatureUsage(recordNode)` query per extracted record (the verified `typescript/unstable/sync` API returning, per usage, the reference name handle paired with its call-expression handle when invoked); for each usage carrying a call expression: map the call handle's `path` to a root-relative path, keep it only when it is in the passed in-scope set, and exclude calls positioned inside the record's own body span (self-recursion); the count is the number of DISTINCT in-scope modules with at least one qualifying call site; in parse-only mode the index is empty — no `caller_count` signals are emitted (research R7's documented degradation boundary); strictly static — never executes, imports, or requires analyzed code (Constitution V)
- [x] T010 [P] [US3] Create src/signals/caller.ts — the distinct-module bucket extractor (FR-004; research R7; data-model.md Section 7): a pure function of the distinct-module count and the pair's identity fields — exactly 1 → +5, 2–3 → +10, 4 or more → +15, 0 → no signal — emitting the `caller_count` Signal through src/signals/types.ts with a fixed-template reasoning naming the count; no compiler interaction (the adapter passes `RecordEvidence.callerModuleCount` once evidence lands in T019 — the rule is exhaustively testable with hand-built counts per the evidence seam, research R12)

**Checkpoint**: User Story 3 complete — the caller index answers exact distinct-module counts over multi-module fixtures and the bucket rule emits FR-004's weights. No protocol surface yet (by design — the caller signal's value is realized through US1's classifications and US2's signals).

---

## Phase 4: User Story 1 — Classified effects on every `analyze` response (Priority: P1) 🎯 MVP

**Goal**: Every effect in every `analyze` response carries `classification: {label, confidence}` computed by the deterministic signal pipeline — five mechanical extractors run per (function record, canonical effect type) pair over a per-record evidence snapshot, the adapter synthesizes exactly one −20 `contradiction` signal for mixed-polarity pairs, and `confidence = clamp[0,100](50 + tier_boost + Σ(signal weights) − 20)` with labels `contractual` ≥ 80, `ambiguous` [50, 80), `incidental` < 50 — superseding spec 002 FR-019's omission rule (FR-012).

**Independent Test**: Analyze controlled-signal-profile fixtures — one per signal category, every contributing signal pinned — and assert the exact returned `{label, confidence}` per effect (exact arithmetic), plus golden byte-identical response tests. No protocol-method addition is required (spec.md US1 Independent Test).

### Tests for User Story 1 (write FIRST; must FAIL before implementation)

- [x] T011 [P] [US1] Create tests/signals/evidence.test.ts — the compiler-seam fixtures (research R5, R6, R7, R13; data-model.md Section 5.1): exportedness forms over `createFixtureTree` trees — ESM `export` modifier (including `export default` and export-assignment/root variable statement forms), CJS `module.exports.<name> = …`, `module.exports = …`, and `exports.<name> = …` targeting the binding in the same file all count as exported (spec edge case 5 — JavaScript-family sources are first-class); class-member records never take the function component (they take the receiver component); `exportedReturnType` — an explicit return type annotation referencing an exported type fires, primitives (`string`/`number`/`void`), literal types, object-literal types, and unresolved/error annotations do not (program mode); `exportedReceiver` — the enclosing class-like declaration exported (both modes); `docText`/`docTags` — the flattened JSDoc comment text and the `getJSDocTags` tag list, including variable-declaration unification (`/** … */ const f = () => {}` documents the record) and parent-node tag inheritance (accepted compiler semantics, fixture-pinned); `interfaceMember` — a class-member declared by an interface in the enclosing class's heritage fires; a class base does not; the `toString` apparent-member hazard — an interface NOT declaring `toString` never fires for a `toString` method (declared-member tables, never apparent-member lookup); parse-only degradation — `interfaceMember` false, `exportedReturnType` false, `callerModuleCount` 0, syntactic components intact; every field computed ONCE per record
- [x] T012 [P] [US1] Create tests/signals/interface.test.ts — the interface-satisfaction rule (FR-002; research R6): pure rule table over hand-built evidence snapshots — a class-member record with `interfaceMember` true emits exactly one `interface` signal, weight +30, with identity fields and non-empty fixed-template reasoning; a non-class-member record or `interfaceMember` false emits nothing; program-mode satisfaction fixtures through the evidence seam (implements and extends an interface declaring the member; the `toString` hazard; generic interfaces); parse-only emits no interface signal and never errors — undeterminable is absence of evidence, never an error (Constitution Principle II)
- [x] T013 [P] [US1] Create tests/signals/visibility.test.ts — the component-sum rule (FR-003; research R5; data-model.md Section 7): over hand-built evidence snapshots — exported function alone → +8; exported return type alone → +6 (a module-private function with an exported return type still emits +6 — components are independent); exported receiver alone → +6; all three → +20 (the clamp is arithmetically inert at 8+6+6 = 20 and is retained as the pinned guard — never removed to simplify tests); zero applicable components → NO signal (positive-only — assumption 4; a module-private function emits nothing, never a negative signal); the emitted weight is the clamped sum with source `visibility`; parse-only keeps the +8 and receiver components (syntactic) and loses only the return-type component
- [x] T014 [P] [US1] Create tests/signals/naming.test.ts — the naming-convention rule (FR-005; research R3; data-model.md Section 6 routing): each contractual prefix emits +10 when the routing table lists it for the effect type (Get → ReturnValue); each incidental prefix emits −10 when routed (log → LogWrite); prefix matching is case-insensitive on the name's leading characters (`getTotal`/`GetTotal` match identically); the longest applicable prefix wins over the union of the 22 closed prefixes; the routing gate — a matched prefix NOT listed for the effect type emits nothing (`Handle` agrees with `HTTPResponseWrite`, not with `StdoutWrite` — the quickstart `handle` case); the sentinel special case takes precedence: an `Err`-prefixed name evaluated for a `SentinelError` effect emits +30 in place of the prefix rules, and an `Err`-prefixed name on a non-`SentinelError` effect falls back to the ordinary prefix rules (`Err` is in neither list — typically no signal); stem-boundary imprecision is pinned as documented false-positive surface (`readyCheckout` matches the `Read` stem — assumption 5); at most one naming signal per (function, effect-type) pair
- [x] T015 [P] [US1] Create tests/signals/jsdoc.test.ts — the documentation rule (FR-006; research R4; Clarification Q1/Q2; data-model.md Section 6 routing): direct tier — a `@returns` tag routed to the value family or a `@throws` tag routed to the error family emits +15; a tag present but not routed to the effect type emits nothing; indirect tier — one of the nine indirect verbs matched in `docText` (case-insensitive, word-boundary delimited) and routed emits +5; incidental tier — one of the four incidental verbs matched and routed emits −15; at most ONE signal per pair, resolved to the strongest agreeing tier present (direct > indirect > incidental); within a tier the first verb in the pinned list order names the match in the reasoning (deterministic tie-break); word-boundary matching — `Logs` matches `logs`, `debugging` does NOT match `debugs`; the wire source string is `docstring` (never `jsdoc` — Clarification Q2: the protocol's established value; the module name is internal only); the routing gate (`writes` agrees with `FileSystemWrite`, not with `ReturnValue`)
- [x] T016 [P] [US1] Create tests/signals/adapter.test.ts — fan-out, contradiction, and the formula (FR-008–FR-011; research R8, R9; data-model.md Sections 4, 5.4, 7): fan-out — every extractor runs once per (function record, canonical effect type) pair, never per effect instance; two same-type effect instances on one record receive identical signals and identical classifications; a function with zero effects yields zero signals; extractor results are NOT deduplicated across sources (a naming and a documentation match on one pair yield two signals); contradiction — a pair whose extractor signals include at least one positive-weight and at least one negative-weight entry gets exactly ONE additional signal with source `contradiction`, weight −20, the standard identity fields, and fixed-template reasoning, and the −20 is applied exactly once (the formula's Σ sums the five extractors' signals; the contradiction entry is the separate term — a consumer summing all emitted signals reproduces the identical confidence, the FR-011 sum-invariant); formula — `clamp(0, 100, 50 + tierBoost + Σ(extractor weights) − (contradiction ? 20 : 0))` with `tierBoost` read from `TIER_MAP` (P0 → +25, P1 → +10, P2/P3/P4 → +0 — the taxonomy is the single tier authority, never a second tier table); labels — 80 → `contractual`, 79 → `ambiguous`, 50 → `ambiguous`, 49 → `incidental` (SC-001 boundary fixtures); clamping — raw scores beyond the bounds yield exactly 0 or 100; the ambiguous floor — a pair with no signals yields 50 + tierBoost (75/60/50 by tier, SC-003); ordering — signals ordered by `(package, function, side_effect_type, source)` codepoint comparison, duplicate-free by pair keying (total order, no tie-break rule)
- [x] T017 [P] [US1] Extend tests/analysis.test.ts — the analyze wiring and controlled-signal-profile fixtures (FR-012/FR-013; SC-001–SC-004; research R10, R13; quickstart.md Sections 3, 5, 8; contracts/analyze-classification.md): first extend tests/helpers/wire.ts — `WireEffect` gains the optional `classification?: {label, confidence}` field mirroring src/models.ts so profile assertions are typed; then — every effect in every fixture `analyze` response carries a serializer-valid `classification: {label, confidence}` (SC-004 — no omitted field, spec 002 FR-019 superseded); the controlled-signal-profile suite with the quickstart tree as canonical fixture (tsconfig + calc/noise/banner/quiet/print/util/main1/main2) asserting exact `{label, confidence}` — `getTotal` 85 contractual (50+25+naming 10), `logMessage` 25 incidental (50−10−15, all-negative, no contradiction), `writeBanner` 25 incidental (50+10−15−20, contradiction fires exactly once with the three-signal wire set), `tweak` 75 ambiguous (the P0 floor), `handle` 80 contractual (the boundary), `formatLabel` 93 contractual (caller +10, visibility +8), `main1`/`main2` 83 contractual (visibility +8); same-type effects on one record share the identical classification; tier-offset fixtures — identical signal profiles on P0, P1, and P2+ effects produce exactly the +25/+10/+0 offsets (SC-003); clamp fixtures — profiles whose raw score exceeds 100 or falls below 0 yield exactly 100 or 0; parse-only degradation — the same tree minus tsconfig: every effect STILL carries a classification (SC-004 holds in both modes), `handle` shifts 80 → 50 and `formatLabel` 93 → 83 (interface and caller_count signals absent; the syntactic visibility +8 survives); detection-ambiguity markers (`detail.confidence: "ambiguous"`) are untouched — detection confidence and classification label are distinct notions (assumption 14); golden byte-identical repeat responses including classification fields

### Implementation for User Story 1

- [x] T018 [US1] Create src/signals/evidence.ts — the RecordEvidence snapshot and its syntactic components (FR-002–FR-006 inputs; research R5, R12; data-model.md Section 5.1): `export interface RecordEvidence` with the full readonly field set — `record` (the `ExtractionRecord`), `exportedFunction`, `exportedReturnType`, `exportedReceiver`, `docText`, `docTags` (readonly `{tag, text}[]`), `interfaceMember`, `callerModuleCount`; this task implements the mode-independent components — `exportedFunction` (ESM: an `export` modifier on the declaration or its root variable statement / export assignment, `export default` included; CJS: a `module.exports.<name> = …` / `module.exports = …` / `exports.<name> = …` assignment targeting the binding in the same file; applies to module-scope function records and object-literal members rooted at an exported binding; class-member records never take it), `exportedReceiver` (the enclosing class-like declaration is exported — the same closed rule, both modes), and `docText`/`docTags` (the compiler's own JSDoc attachment — `getJSDocTags` and `getTextOfJSDocComment` from `typescript/unstable/ast`, including variable-declaration unification; never custom regex doc parsing — Principle III); computed ONCE per function record, never per pair (plan.md's performance goal); checker-dependent fields are declared but computed false/0 until T019
- [x] T019 [P] [US1] Extend src/signals/evidence.ts — the checker-resolved components (research R6, R7; data-model.md Section 5.1; program mode only): `interfaceMember` — heritage resolution through the checker: `checker.getSymbolAtLocation(heritageTypeNode)` → the base symbol's declarations are `NodeHandle`s; a base counts only when a declaration's `kind` is `InterfaceDeclaration`; the interface symbol's `getMembers()` declared-member table (verified on `Symbol` — never apparent-member lookup, which would find `Object`-prototype members and manufacture +30 signals on every `toString`-alike) is checked for the record's escaped name; `exportedReturnType` — the declaration's explicit return type annotation contains at least one type reference resolving through the checker to an exported or ambient symbol (primitives, literal types, object-literal types, and unresolved/error annotations do not fire); `callerModuleCount` — wired from `buildCallerIndex` (T009) over the prepared analysis; parse-only mode: `interfaceMember` false, `exportedReturnType` false, `callerModuleCount` 0 — degradation reduces precision, never availability
- [x] T020 [P] [US1] Create src/signals/interface.ts — the interface-satisfaction extractor (FR-002; research R6): a pure function `(evidence, effectType) → Signal | undefined` — a class-member record whose `evidence.interfaceMember` is true emits exactly one `interface` signal, weight +30, identity fields from the record (`function` = record name, `package` = `derivePackage(record.relPath)`), fixed-template reasoning; otherwise no signal; no compiler interaction (the evidence seam owns that — research R12)
- [x] T021 [P] [US1] Create src/signals/visibility.ts — the API-visibility extractor (FR-003; research R5; data-model.md Section 7): a pure function over the evidence snapshot — sum the applicable components (`exportedFunction` +8, `exportedReturnType` +6, `exportedReceiver` +6 — independent), clamp the total to a maximum of +20, and emit one `visibility` signal with the clamped total; zero applicable components emit no signal (positive-only, assumption 4)
- [x] T022 [P] [US1] Create src/signals/naming.ts — the naming-convention and sentinel extractor (FR-005; research R3): a pure function — first the sentinel special case: effect type `SentinelError` AND the record name begins with `Err` (case-insensitive) → emit +30 with source `naming_convention` IN PLACE of the prefix rules for that effect; otherwise select the longest applicable prefix over the union of the 22 closed prefixes (from src/signals/routing.ts), matching case-insensitively against the record name's leading characters, and emit only when the routing table lists the selected prefix as agreeing with the effect type — contractual +10, incidental −10; no applicable prefix or no agreement emits nothing; at most one naming signal per pair
- [x] T023 [P] [US1] Create src/signals/jsdoc.ts — the documentation extractor, wire source `docstring` (FR-006; research R4; Clarification Q1/Q2): a pure function over `evidence.docTags` and `evidence.docText` — direct: a `@returns`/`@throws` tag present and routed to the effect type (src/signals/routing.ts `docTags` column) emits +15; indirect: one of the nine indirect verbs matched in `docText` case-insensitively with word-boundary delimitation and routed emits +5; incidental: one of the four incidental verbs matched and routed emits −15; at most one signal per pair resolved to the strongest agreeing tier (direct > indirect > incidental); within a tier the first verb in the pinned list order names the match in the reasoning (deterministic tie-break); the emitted source string is `docstring` — the module path `jsdoc.ts` is internal naming only
- [x] T024 [US1] Create src/signals/adapter.ts — the fan-out core, contradiction synthesis, and confidence formula (FR-008–FR-011; research R8, R9, R10; data-model.md Sections 4, 5.4): the shared core both `analyze` (T025) and the `classify_signals` entry (T029) consume — given the prepared analysis (records + `ProgramContext` + `inScopePaths`) and the detected effects: build the caller index while the context is live (T009), compute `RecordEvidence` once per record (T018/T019), and for each (function record, DISTINCT canonical effect type) pair run the five extractors (interface, visibility, caller, naming, jsdoc) — pair keying: never per effect instance, so same-type effects share identical outputs and the FR-011 sum-invariant holds; emit one signal per applying rule (no dedup across sources); when a pair's extractor signals mix at least one positive-weight and at least one negative-weight entry, append exactly one synthesized signal — source `contradiction`, weight −20, standard identity fields, short fixed-template reasoning — and apply the −20 exactly once; `confidence = clamp(0, 100, 50 + tierBoost + Σ(extractor weights) − (contradiction ? 20 : 0))` with `tierBoost` read from `TIER_MAP` (P0 +25, P1 +10, P2–P4 +0); labels: `contractual` ≥ 80, `ambiguous` [50, 80), `incidental` < 50; produce the pair's `Classification` (the existing src/models.ts record) and the classified effect instances (new immutable `Effect` values with `classification` set — rebuild, never mutation; convention pack AP-004); signals serialized through `serializeSignal` and ordered by `(package, function, side_effect_type, source)` codepoint comparison — duplicate-free by pair keying, a total order with no tie-break rule; reasoning strings are deterministic fixed templates (stable per analyzer version, pinned by golden tests — research R1)
- [x] T025 [US1] Extend src/analysis.ts — wire classifications onto every analyze effect (FR-012/FR-013; research R10; contracts/analyze-classification.md): `analyze()` keeps its shape — `prepareAnalysis` → `detectEffects` → assemble → serialize — and inserts the T024 signal core between detection and assembly, passing the classified effect instances to `assembleFunctionRecords` so every effect of a pair carries the identical `classification: {label, confidence}`; the detector is untouched (its FR-019-era contract is superseded at the wiring layer, exactly where FR-012 places the change); `serializeClassification`'s fail-loud validation (closed label set, integer 0–100) is now exercised on every `analyze` response; the program-mode context's dispose lifetime is unchanged (the existing `finally`); deterministic — byte-identical repeat responses including classification fields (Constitution I / SC-005)

**Checkpoint**: User Story 1 is fully functional and independently testable — **the MVP**. `analyze` answers end-to-end over stdio with every effect classified: exact-arithmetic profile fixtures (SC-001), the contradiction penalty (SC-002), tier offsets (SC-003), 100%-classified responses (SC-004), and golden byte-identical repeats. The quickstart's analyze halves (Sections 2, 3, 5, 6, 8) are achievable at this point.

---

## Phase 5: User Story 2 — Raw signals over `classify_signals` (Priority: P2)

**Goal**: The `classify_signals` JSON-RPC method returns the raw evidence behind the classifications — one signal per (function, effect-type, source) triple a rule matched, deterministically ordered by `(package, function, side_effect_type, source)` — with the shared analysis-params validation and `-32602` error table, the capability flag flipped to `true`, and the reserved `-32601` set shrunk to exactly four names.

**Independent Test**: Send `classify_signals` requests over fixture trees and assert the exact signals array (function, package, side_effect_type, source, weight), plus golden byte-identical response tests and the capability-flag / reserved-method conformance checks (spec.md US2 Independent Test).

### Tests for User Story 2 (write FIRST; must FAIL before implementation)

- [x] T026 [P] [US2] Extend tests/server.test.ts with classify_signals dispatch cases through the existing `drive()` harness (FR-014/FR-015; SC-005/SC-006; contracts/classify-signals.md conformance requirements 1–6): a canned classify_signals request against the quickstart-style fixture tree returns the exact 11-signal result — the quickstart Section 4 array with `function`/`package`/`side_effect_type`/`source`/`weight` in the `(package, function, side_effect_type, source)` order — with the request id echoed; the full shared `-32602` matrix with the IDENTICAL message strings `analyze` produces for the same input (params absent/`null`/array → `Invalid params: params must be an object`; `root_path` missing or non-string → `Invalid params: root_path must be a string`; `patterns` present but not an array of strings → `Invalid params: patterns must be an array of strings`; any extra key → `Invalid params: params must contain only root_path and patterns`; nonexistent/not-a-directory root → `Invalid params: root_path is not a directory: <path>`); the reserved `it.each` list (tests/server.test.ts:1066) drops `classify_signals`, leaving exactly `test_mapping`, `analyze/stream`, `doc_coverage`, `cognitive_complexity`; the initialize capability response — `classify_signals: true`, `discover: true`, the other four flags `false` (SC-006); the golden determinism check — the same canned classify_signals request sent twice produces two byte-identical response lines (SC-005); a pattern set matching nothing → `{"signals": []}` success, never an error
- [x] T027 [P] [US2] Edit tests/protocol.test.ts — the capability assertions flip (FR-015; SC-006): the initialize result asserts `classify_signals: true` with the other five flags unchanged (`discover` true; `test_mapping`, `streaming`, `doc_coverage`, `cognitive_complexity` false) — updating the two current assertions that pin `classify_signals: false` (tests/protocol.test.ts:147 and the serialized-result string at tests/protocol.test.ts:166)
- [x] T028 [P] [US2] Extend tests/analysis.test.ts with the cross-method consistency suite (FR-013/FR-011; data-model.md Sections 8–9; contracts/analyze-classification.md Section 3): over fixture trees (the quickstart tree canonical), for every (function record, canonical effect type) pair — the labels `analyze` reports equal the classification derived from the `classifySignals` feed via the sum-invariant: `50 + tierBoost − Σ(all emitted signal weights for the pair, the contradiction row included)` = the reported confidence; the parse-only signal-count shrink asserted through the feed — the quickstart tree drops from 11 to 9 signals without the tsconfig (the checker-dependent `interface` and `caller_count` signals absent)

### Implementation for User Story 2

- [ ] T029 [US2] Extend src/signals/adapter.ts — the classifySignals entry (FR-014; research R10, R11): `classifySignals(rootPath, patterns, stderr)` running the IDENTICAL stages as `analyze` — `prepareAnalysis` → `detectEffects` → the T024 core (caller index while the context is live → evidence → extractors) — owning the program-mode context's dispose lifetime exactly as `analyze` does (the same `finally` discipline); returns the serialized `Signal[]` in the FR-014 order (the server wraps as `{"signals": [...]}`); `InvalidRootPathError` propagates for the server to map to `-32602`; deterministic — byte-identical repeat responses, no timestamps or environment-dependent data (Constitution I)
- [ ] T030 [US2] Register the classify_signals handler in src/server.ts and flip the initialize capability in src/protocol.ts (FR-014/FR-015; research R11; contracts/classify-signals.md Sections 2, 4, 5): the handler mirrors the existing analysis handlers exactly — `validateAnalysisParams` (the existing module-level shared validator: same checks, same message strings, same order — one validator, one error table, never a copy), then `classifySignals(rootPath, patterns, this.stderr)` wrapped as `{"signals": [...]}`, with `mapRootPathError(error) ?? error` mapping `InvalidRootPathError` to the shared `-32602` root message and everything else rethrowing to handleLine's `-32603`; the method registers unconditionally (no runtime toggle); in src/protocol.ts's `initializeResult()`, flip `classify_signals` to `true` with the other five flags unchanged; land the registration and the flip as ONE protocol-state unit (same commit or immediately adjacent commits) so no commit advertises a capability the dispatch table lacks
- [ ] T031 [P] [US2] Update openspec/specs/server/spec.md (FR-017; research R14; the "Dispatch table scope" requirement at line 145 and the reserved-methods scenario at line 149): the dispatch table registers `initialize`, `shutdown`, `discover`, `analyze`, `complexity`, `coverage`, and `classify_signals`; the reserved `-32601` list and its "Reserved methods are not implemented" scenario shrink to exactly `test_mapping`, `analyze/stream`, `doc_coverage`, `cognitive_complexity`
- [ ] T032 [P] [US2] Update openspec/specs/protocol/spec.md (FR-017; research R14; the initialize capability requirement at line 72 and its scenario at line 77): `classify_signals` becomes `true`; the "the other five flags `false`" wording becomes "the other four" (`discover` stays `true`; `test_mapping`, `streaming`, `doc_coverage`, `cognitive_complexity` stay `false`); the scenario asserts the six capability keys with `discover` and `classify_signals` true

**Checkpoint**: All three stories deliver — `classify_signals` answers over stdio with the exact 11-signal quickstart feed, the shared `-32602` table, the shrunk reserved set, and byte-identical repeats; `analyze` and `classify_signals` provably derive from one pipeline (the sum-invariant holds for every pair). The quickstart is fully achievable end-to-end.

---

## Phase 6: Polish & Cross-Cutting Concerns

**Purpose**: Package surface, documentation truthfulness, and final validation across all stories.

- [ ] T033 [P] Re-export the signal pipeline's public surface from src/index.ts alongside the existing exports (plan.md Project Structure; zero-waste — a consumable package API, not orphaned code): `classifySignals` and the adapter core entry from src/signals/adapter.ts; the `Signal` type and `serializeSignal` from src/signals/types.ts; the `RecordEvidence` type from src/signals/evidence.ts; the extractor entries from src/signals/interface.ts, src/signals/visibility.ts, src/signals/caller.ts, src/signals/naming.ts, and src/signals/jsdoc.ts; the routing table and closed vocabulary lists from src/signals/routing.ts — `export type` clauses for types per the existing index.ts convention
- [ ] T034 [P] Update repository docs to match shipped behavior (FR-017; research R14): README.md — move `classify_signals` in the method table to Implemented (params `{root_path, patterns}`; result `{"signals": [...]}`) and update the capability note (classify_signals advertised `true`; the remaining four reserved flags); AGENTS.md — the project structure gains `src/signals/` with its ten modules and the `tests/signals/` one-to-one mirror; note the classification pipeline in the architecture/mission sections (Reading Stone owns TypeScript/JavaScript-specific classification signals; scoring remains Gaze's)
- [ ] T035 Run the full manual end-to-end validation from specs/003-classify-signals/quickstart.md against a fresh `npm run build` (SC-001/SC-004/SC-005/SC-006): the scratch tree with tsconfig (the eight src files per quickstart Section 1); initialize → `classify_signals: true` with `discover: true` and the other four false; analyze → the exact eight-record classification table (quickstart Section 3: writeBanner 25, getTotal 85, main1/main2 83, logMessage 25, handle 80, tweak 75, formatLabel 93); classify_signals → the exact 11 signals in FR-014 order (Section 4); the arithmetic walkthrough table (Section 5); the determinism byte-compare (each method reports `2 <identical line>` — Section 6); the error-surface checks (`-32602` nonexistent root / `patterns` not an array of strings / extra param key, `-32601` reserved `test_mapping`, `{"signals":[]}` for a matching-nothing pattern — Section 7); the parse-only degradation check (remove tsconfig — every effect still classified, signal count 11 → 9, `handle` 80 → 50, `formatLabel` 93 → 83 — Section 8). Record that every observed output matches quickstart.md exactly
- [ ] T036 Run the final CI parity gate from the repository root and confirm all protected gates pass (SC-007/FR-018; AGENTS.md; .github/workflows/ci.yml): `npx biome check src/ tests/`, `npm run build`, and `npx vitest run --coverage` with lines, statements, functions, and branches coverage each at or above the protected 85% thresholds. Never modify a gate to make it pass — if a gate fails, fix the implementation and re-run

**Checkpoint**: Feature complete — package surface exported, docs truthful, quickstart validated end-to-end in both modes, all protected gates green.

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — start immediately.
- **Foundational (Phase 2)**: After Phase 1. T004 (Signal type) and T005 (routing table) block every story's extractors; T006 (in-scope exposure) blocks US3's index and US1's adapter.
- **US3 (Phase 3)**: After Phase 2 (T004, T006). Blocks US1's evidence checker components (T019's `callerModuleCount`) and adapter (T024) — the deliberate priority inversion (US1's SC-001 caller fixture and the canonical quickstart tree require the caller signal; the spec's own US3 rationale names the bootstrap position).
- **US1 (Phase 4)**: After Phase 2 + US3. Delivers the MVP. Its pure-rule tasks (T018, T020–T023) are US3-independent and can proceed in parallel with US3's tail.
- **US2 (Phase 5)**: After US1 — `classifySignals` wraps the T024 shared core (FR-013's one-pipeline guarantee is structural).
- **Polish (Phase 6)**: After all user stories are complete.

### User Story Dependencies

- **US1 (P1)**: Depends on Foundational + US3 (the caller index feeds `RecordEvidence.callerModuleCount`; the caller bucket rule is one of the five extractors). No dependency on US2.
- **US2 (P2)**: Depends on US1 (the method serializes the same pair-keyed signals the T024 core produces; consistency is structural, never a second walk). Independent of US3 beyond US1's own dependency.
- **US3 (P2)**: Depends on Foundational only (T004 Signal type, T006 in-scope paths). File-disjoint from US1's pure-rule modules and US2 entirely.

### Within Each User Story

- Test tasks are written first and observed to FAIL, then implementation lands and turns them green; bookkeeping (openspec specs) lands last.
- US3: tests (T007 ∥ T008) red → caller-index (T009) ∥ caller rule (T010) — distinct files, no mutual dependency.
- US1 implementation: evidence create (T018, defines the full RecordEvidence type) → then T019 (evidence checker extend) ∥ T020 (interface) ∥ T021 (visibility) ∥ T022 (naming) ∥ T023 (jsdoc) — five distinct files after the type exists → adapter (T024, needs all extractors + evidence + the US3 index) → analyze wiring (T025) → green.
- US2: tests (T026 ∥ T027 ∥ T028) red → adapter entry (T029) → server registration + capability flip (T030, one protocol-state unit) → openspec bookkeeping (T031 ∥ T032).
- Run the CI parity commands (`npx biome check src/ tests/`, `npm run build`, `npx vitest run --coverage`) before marking any task complete (AGENTS.md CI Parity Gate), and mark each task `- [x]` immediately upon completion — never in a batch.

### Parallel Opportunities

- Phase 2: T002 ∥ T003 (test files); then T004 ∥ T005 ∥ T006 (src/signals/types.ts vs src/signals/routing.ts vs src/analysis.ts).
- US3: T007 ∥ T008; then T009 ∥ T010.
- US1 tests: T011 ∥ T012 ∥ T013 ∥ T014 ∥ T015 ∥ T016 ∥ T017 (seven distinct test files).
- US1 implementation: after T018 lands, T019 ∥ T020 ∥ T021 ∥ T022 ∥ T023 (five distinct files).
- US2: T026 ∥ T027 ∥ T028; bookkeeping T031 ∥ T032 (disjoint from src work — can start once T030's behavior is known).
- Polish: T033 ∥ T034 (src/index.ts vs README.md/AGENTS.md); T035 and T036 are sequential and final.
- Cross-story: a second implementer can build US3 (T007–T010) while the first writes US1's tests and lands T018 + T020–T023 (the pure rules are file-disjoint from US3); they converge at T024. Every shared-file touchpoint (src/analysis.ts, src/server.ts, tests/analysis.test.ts, tests/server.test.ts) is an explicitly ordered task.

---

## Parallel Execution Examples

### User Story 1

```bash
# Launch the seven US1 test tasks together (distinct files):
Task: "Create tests/signals/evidence.test.ts"    # T011
Task: "Create tests/signals/interface.test.ts"   # T012
Task: "Create tests/signals/visibility.test.ts"  # T013
Task: "Create tests/signals/naming.test.ts"      # T014
Task: "Create tests/signals/jsdoc.test.ts"       # T015
Task: "Create tests/signals/adapter.test.ts"     # T016
Task: "Extend tests/analysis.test.ts"            # T017

# After the tests are red, create the evidence snapshot first:
Task: "Create src/signals/evidence.ts"           # T018

# After T018 lands, launch together (distinct files):
Task: "Extend evidence.ts checker components"    # T019
Task: "Create src/signals/interface.ts"          # T020
Task: "Create src/signals/visibility.ts"         # T021
Task: "Create src/signals/naming.ts"             # T022
Task: "Create src/signals/jsdoc.ts"              # T023
```

### User Story 3 (parallel-friendly)

```bash
# While US1's tests are being written, a second implementer builds the caller foundation:
Task: "Create tests/signals/caller-index.test.ts"  # T007
Task: "Create tests/signals/caller.test.ts"        # T008
# then (distinct files):
Task: "Create src/signals/caller-index.ts"         # T009
Task: "Create src/signals/caller.ts"               # T010
```

---

## Implementation Strategy

### MVP First (Phases 1–4: Setup + Foundational + US3 + US1)

1. Complete Phase 1: Setup (baseline green — no new dependencies).
2. Complete Phase 2: Foundational (Signal model, routing table, in-scope exposure).
3. Complete Phase 3: User Story 3 (caller index + bucket rule — US1's mandated foundation).
4. Complete Phase 4: User Story 1 (the classification pipeline wired onto `analyze`).
5. **STOP and VALIDATE**: every `analyze` effect carries an exact-arithmetic classification — profile fixtures (SC-001), contradiction (SC-002), tier offsets (SC-003), 100% classified (SC-004), byte-identical repeats. The quickstart's analyze halves (Sections 2, 3, 5, 6, 8) are achievable. The MVP is US1's value delivered on US3's foundation (the spec's priority ordering governs value; the dependency graph governs order).

### Incremental Delivery

1. Setup + Foundational → foundation ready.
2. Add US3 → caller index conformance-tested in isolation.
3. Add US1 → test independently → **MVP** (classified `analyze` over JSON-RPC).
4. Add US2 → test independently → `classify_signals` over the same pipeline (capability flip + reserved-set shrink).
5. Polish → package surface, docs truthful, quickstart validated end-to-end, all gates green.

### Parallel Team Strategy

With multiple implementers after Phase 2 completes:

- Implementer A: US3 (tests/signals/caller-index.test.ts, tests/signals/caller.test.ts, src/signals/caller-index.ts, src/signals/caller.ts).
- Implementer B: US1's tests (T011–T017), then T018 and the four pure extractors (T020–T023) — file-disjoint from US3.
- Converge: one implementer takes T024 (adapter) → T025 (wiring); the other can start US2's test extensions (T026–T028).
- Then one implementer takes the US2 server sequence (T029 → T030) with bookkeeping (T031 ∥ T032), another starts Polish docs (T033 ∥ T034); T035/T036 close.

---

## Notes

- [P] tasks = different files, no dependencies on incomplete tasks.
- [Story] labels map tasks to spec.md user stories for traceability: US1 = classified effects on `analyze` (FR-001–FR-013), US2 = the `classify_signals` method (FR-014/FR-015, plus the FR-017 server/protocol bookkeeping in T031/T032), US3 = caller inference (FR-004/FR-016). FR-007's routing data is foundational (T003/T005); FR-017's docs truthfulness is T031/T032/T034; FR-018's gates are T001/T036 plus the CI parity run before every completion.
- The US3-before-US1 phase order is a deliberate execution-order inversion, not a priority change — recorded here and in the Dependencies section with the spec's own rationale. US1 remains the MVP story (🎯).
- The parse-only degradation boundary (research R7's flagged extension): without a checker, BOTH the `interface` and `caller_count` signals are absent (plus the exported-return-type visibility component); the remaining signals still classify every effect — degradation reduces precision, never availability. Fixtures pin it (T011, T017, T028; quickstart Section 8).
- Signal `reasoning` wording is implementation-defined but deterministic — fixed templates, stable per analyzer version, pinned by the golden tests exactly like effect `description` strings (research R1; spec assumption 8).
- The FR-011 sum-invariant is the cross-method contract: a consumer (Gaze's `ComputeScore`) summing all emitted signals for a pair reproduces the reported confidence. Pair keying (never per effect instance) is what keeps it exact — data-model Section 8.
- Verify tests fail before implementing; commit after each task or logical group; mark `- [x]` immediately upon completion (AGENTS.md Task Completion Bookkeeping). Spec artifacts are committed before implementation begins; implementation commits never mix spec and source changes (AGENTS.md ordering constraints).
- Protected gates (85% coverage thresholds, `biome check`, strict `tsc`, `npm ci` lockfile integrity) must never be lowered to make an implementation pass — report blockers instead (Gatekeeping Value Protection).
- Design decisions behind these tasks: research.md R1–R15 (signal model, routing table, naming rules, documentation tiers, visibility components, interface heritage, the checker-resolved caller index and its parse-only boundary, pair-keyed fan-out and the contradiction invariant, formula and labels, analyze wiring, server wiring, module layout and the evidence seam, testing strategy, cross-pipeline bookkeeping, determinism).
- Existing helpers are reused throughout (`createFixtureTree`, `memorySink`, `drive()`, the wire.ts projections); the only helper change is T017's typed `classification` field on `WireEffect`.
- The `Err`+`SentinelError` special case fires only when the carrying function's name begins with `Err` — sentinel effects attach to the file's first function record (spec 002 FR-013), so the carrying record's name governs (spec edge case 3).

---

## Requirement Traceability

| Requirement | Tasks |
|---|---|
| FR-001 signal model + closed source set | T002, T004 |
| FR-002 interface satisfaction | T011, T012, T018, T019, T020 |
| FR-003 API visibility | T011, T013, T018, T019, T021 |
| FR-004 caller dependency buckets | T008, T010 |
| FR-005 naming conventions | T014, T022 (routing data: T003, T005) |
| FR-006 documentation signal | T015, T023 (routing data: T003, T005) |
| FR-007 effect-type routing table | T003, T005 |
| FR-008 adapter fan-out | T016, T024 |
| FR-009 confidence formula | T016, T024 |
| FR-010 labels and boundaries | T016, T024 |
| FR-011 contradiction signal | T016, T017, T024, T028 |
| FR-012 every analyze effect classified | T017, T025 |
| FR-013 one shared pipeline (consistency) | T024, T025, T028, T029 |
| FR-014 classify_signals method | T026, T029, T030 |
| FR-015 capability flag + reserved set | T026, T027, T030, T031, T032 |
| FR-016 caller index (import graph) | T006, T007, T009 |
| FR-017 openspec + docs bookkeeping | T031, T032, T034 |
| FR-018 protected quality gates | T001, T036 (+ CI parity before every completion) |
