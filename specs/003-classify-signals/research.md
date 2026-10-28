# Research: Classification Signal Pipeline (classify_signals)

**Feature Branch**: `003-classify-signals`

**Date**: 2026-10-28

**Status**: Complete — the spec is decision-complete (16 assumptions, 18
FRs, 3 resolved clarifications); this document verifies the technical
mechanics behind each pinned decision and records the
implementation-strategy choices the spec leaves open, each with rationale
and rejected alternatives. The Technical Context in
[plan.md](plan.md) contains no NEEDS CLARIFICATION entries.

Sources consulted: Gaze analyzer protocol v1.2.0 (pinned by the
constitution), the feature spec (`specs/003-classify-signals/spec.md` with
its three Dewey-resolved clarifications), the reading-stone codebase
(`src/models.ts`, `src/server.ts`, `src/protocol.ts`, `src/analysis.ts`,
`src/program.ts`, `src/extract.ts`, `src/detector.ts`,
`src/taxonomy.ts`, spec 001/002 artifacts — the foundation this change
builds on), the installed `typescript@7.0.2` unstable API surface
(`node_modules/typescript/dist/api/sync/api.d.ts`,
`dist/ast/jsdoc.d.ts` — every named method below was verified against
the shipped declarations), the snake-eyes reference implementation (its
classify-signals change is the direct precedent for the extractor
package, raw-signal semantics, fan-out, and ordering), and Dewey prior
learnings (snake-eyes classify-signals design decisions; Gaze's
`mergeClassifications`/`ComputeScore` consumption semantics; the
typescript@7.0.2 unstable-API gotcha; the disposition-table
conformance-test anti-drift pattern).

---

## R1: Signal model — the wire record and its closed vocabulary

**Decision**: `src/signals/types.ts` defines the `Signal` value record —
`function` (unqualified record name), `package` (`derivePackage(relPath)`),
`side_effect_type` (canonical taxonomy name — aliases never emitted),
`source`, integer `weight`, optional `reasoning` — plus a fail-loud
`serializeSignal` following `models.ts` house style: membership in the
closed source set `{"interface", "visibility", "caller_count",
"naming_convention", "docstring", "contradiction"}`, canonical type
resolution through `resolveSideEffectType`, integer-weight check, and a
non-empty-string check on `reasoning` when present. The result payload is
`{"signals": Signal[]}`.

**Rationale**: FR-001 pins the field set and the closed source set (the
reference analyzer's five values plus the `contradiction` extension the
spec's Q1 clarification pins). The wire source string for documentation
evidence is `docstring` — the protocol's established value (Clarification
Q2; Gaze's `adapter.mergeClassifications` copies analyzer signals'
`Source` verbatim into `ComputeScore`, so a divergent `jsdoc` string
would emit a value outside the platform vocabulary). Internal module
naming (`src/signals/jsdoc.ts`) is free; the wire string is not. The
identity fields are `function` + `package`, never `name` (spec
assumption 9). Extractors always include a short non-empty `reasoning`
(reference-analyzer precedent, assumption 8); the contract only bounds
its shape. Reasoning strings are deterministic fixed templates —
implementation-defined wording, stable per analyzer version, pinned by
golden tests exactly like effect `description` strings (spec 002
research R6.6).

**Alternatives considered**:
- *`jsdoc` as the wire source string*: rejected — Clarification Q2
  resolves this for `docstring` on Protocol Fidelity grounds.
- *Omit `reasoning` by default*: rejected — the reference always
  includes it and the platform surfaces it in reports; determinism is
  preserved through fixed templates.
- *A `label` field on signals*: rejected — FR-001 forbids labels on raw
  signals; classification lives on `analyze` effects only.

## R2: The routing table — normative data, totality, and the anti-drift pin

**Decision**: `src/signals/routing.ts` holds the routing table as
`Readonly<Record<SideEffectType, RoutingBranch>>` where
`RoutingBranch = { naming, docTags, docIndirect, docIncidental }` — the
agreeing naming prefixes, direct JSDoc tags, indirect verbs, and
incidental verbs for that effect type. Every prefix, tag, and verb comes
from the closed lists FR-005/FR-006 pin (18 contractual + 4 incidental
prefixes; `@returns`/`@throws`; nine indirect verbs; four incidental
verbs). The full 48-row table is rendered as normative data in
[data-model.md](data-model.md) and conformance-pinned by
`tests/signals/routing.test.ts`: (a) the code table is keyed by exactly
the 48 canonical types (`Record` exhaustiveness makes this compile-time;
the test asserts it at runtime against `SIDE_EFFECT_TYPES`), (b) every
entry's vocabulary is drawn from the closed lists, (c) the rendered
data-model table matches the code table — the `tests/disposition.test.ts`
parse-the-document anti-drift pattern.

The routing families (full table in data-model.md): a **value family**
(`Get`/`Fetch`/`Load`/`Read`/`Compute`/`Analyze`/`Classify`/`Parse`/
`Build`/`New` → `ReturnValue`, `GeneratorYield`, `AsyncGeneratorYield`;
`@returns`/`returns` agree with the same family), an **error family**
(`@throws` → `ErrorReturn`, `ErrorSignal`, `SentinelError`; no naming
prefix — neither closed list carries a throw vocabulary), a **mutation
family** (`Update`/`Set`/`Delete`/`Remove` and
`modifies`/`updates`/`sets`/`deletes`/`removes` → the eleven
state-mutation types), a **write family** (`Save`/`Write` and `writes`
→ file/database/writer/response/stream output; `persists`/`stores` →
file/database writes), an **output family** (`Write` and `writes`, plus
the incidental `log`/`debug`/`trace`/`print` prefixes and
`logs`/`prints`/`traces`/`debugs` verbs → `LogWrite`, `StdoutWrite`,
`StderrWrite`), a **handler family** (`Handle`/`Process` →
`HTTPResponseWrite`, `ChannelSend`), a **construction family**
(`Build`/`New` → `GoroutineSpawn`, `DescriptorEffect`,
`FinalizerRegistration`, `CgoCall`), a **delete family**
(`Delete`/`Remove`, `deletes`/`removes` → `FileSystemDelete`), and
**explicitly-none rows** for every type with no agreeing vocabulary in
the closed lists (`ChannelClose`, `DatabaseTransaction`,
`CallbackInvocation`, `ContextCancellation`, `ResourceManagement`,
`TimeDependency`, `ProcessExit`, and the seven N/A types whose routing
is moot because they are never emitted).

**Rationale**: FR-007 demands a total, normative table — every type
routed to a branch or explicitly to none — grounded in the disposition
table's TypeScript mappings. Agreement semantics: a prefix or keyword
agrees with an effect type when the verb names the operation that
produces the effect (`Get` → returning a value; `log` → writing a log
line; `Update` → mutating state). Routing the incidental vocabulary only
to the logging-output family is what makes negative evidence possible at
all: incidental prefixes/verbs are logging vocabulary, so they agree only
where logging happens. The `Record<SideEffectType, …>` shape inherits
`TIER_MAP`'s compile-time exhaustiveness (taxonomy's core safety
mechanism); the doc-parity test inherits the disposition-table pattern
Dewey records (`learning/documentation-…`: when a prose document restates
a normative code constant set, make a test parse the document so the
prose cannot drift).

Deliberate deviations from the snake-eyes branch mapping (its task 2.7
mapped `StreamOutput` next to the return-like branch): `StreamOutput`
routes to the write family — TypeScript's construct is `.pipe(...)`,
writing to a stream, not yielding values. Documented here as the
grounded-for-TypeScript choice the spec's "TypeScript mapping" framing
(invoking the disposition table) expects.

**Alternatives considered**:
- *Route every prefix to every type (no gate)*: rejected — FR-007's
  gate is the false-positive control; ungated `Get` would +10 every
  effect on every getter.
- *Per-type strong-prose vocabularies beyond the pinned lists*:
  rejected — Clarification Q1 explicitly rejects inventing normative
  data the issue never asks for.
- *Table keyed by prefix → type set (inverted)*: rejected — the
  per-type shape matches `TIER_MAP`'s exhaustive-`Record` pattern and
  the data model's per-type rendering.

## R3: Naming extractor — longest prefix, case, and the sentinel special case

**Decision**: `src/signals/naming.ts` selects the **longest applicable
prefix** over the union of the 22 closed prefixes, matching
case-insensitively against the record name's leading characters. If the
effect type is `SentinelError` and the name begins with `Err`
(case-insensitive), the extractor emits the sentinel special case —
weight +30, source `naming_convention`, reasoning naming the sentinel
match — **in place of** the prefix rules for that effect. Otherwise the
selected prefix emits a signal only when the routing table lists it as
agreeing with the effect type: contractual prefixes +10, incidental
prefixes −10. No applicable prefix, or a prefix that does not agree with
the effect type, emits nothing.

**Rationale**: FR-005 pins the lists, the case-insensitive
leading-character match, longest-prefix-wins, and the sentinel
precedence. Because at most one prefix is selected per name, the
extractor emits at most one signal per (function, effect-type) pair —
the routing gate then decides per effect type whether that prefix is
evidence for *this* effect (the same `getTotal` name yields +10 on its
`ReturnValue` effect and nothing on a hypothetical `LogWrite` effect).
Longest-wins is nearly moot over the closed lists (no prefix is a strict
prefix of another) but is pinned anyway and fixture-tested — it is the
rule that governs if the lists ever grow. The sentinel rule's
carrier-function semantics (the effect attaches to the file's first
function record, spec 002 FR-013, so the carrying function's name
governs) falls out of the pair keying: the signal is computed from the
record the effect lives on. Stem-boundary imprecision
(`readyCheckout` matching `Read`, `ErrorMapper` matching `Err`) is the
spec's documented, fixture-pinned false-positive surface (assumption 5).

**Alternatives considered**:
- *All matching prefixes emit*: rejected — FR-005 pins longest-wins;
  multiple signals from one name would double-count name evidence.
- *Case-sensitive contractual, case-insensitive incidental*: rejected —
  FR-005 pins case-insensitivity for the match as a whole; JavaScript
  naming conventions mix `getFoo`/`GetFoo` freely.
- *Sentinel special case emitting in addition to a routed prefix*:
  rejected — "in place of the prefix rules" (FR-005) is explicit.

## R4: Documentation extractor — JSDoc tags direct, prose verbs, one strongest signal

**Decision**: `src/signals/jsdoc.ts` (wire source `docstring`) reads the
documentation comment the compiler attaches to the record's declaration —
tags through `getJSDocTags(node)` from `typescript/unstable/ast`, prose
through the flattened comment text (`getTextOfJSDocComment` over the
attached JSDoc comment nodes). Direct evidence: a `@returns` or
`@throws` tag present on the declaration and routed to agree with the
effect type (`@returns` → value family, `@throws` → error family) emits
+15. Indirect evidence: one of the nine indirect verbs matched in the
comment text — case-insensitive, word-boundary delimited — and routed to
agree emits +5. Incidental evidence: one of the four incidental verbs
matched and routed to agree emits −15. The extractor emits **at most one
signal per (function, effect-type) pair**, resolved to the strongest
agreeing tier present (direct > indirect > incidental); within a tier the
first verb in the pinned list order names the match in the reasoning
string (deterministic tie-break).

**Rationale**: Clarification Q1 pins the tiers and the structural-tag
form of direct evidence — the TypeScript-native counterpart of the
reference's "documentation structurally names the effect's contract"
(the 15/5/−15 weight convention is Gaze's own: maxGodocWeight=15,
reducedGodocWeight=5, −15 incidental). Word-boundary matching keeps
`debugging` from matching `debugs` while `Logs` matches `logs`.
Strongest-tier resolution follows the reference adapter's shape —
snake-eyes' extractors return a single signal or `None` per
(function, effect) pair (task 4.2/4.3), and the spec's assumption 7
inherits it ("one signal per applying rule per effect" — the rules are
the five FR-002..FR-006 extractors); it also makes within-extractor
polarity conflicts structurally impossible, so a contradiction can only
arise across sources, which is FR-011's model. The compiler's own JSDoc
attachment (including its variable-declaration unification, so
`/** … */ const f = () => {}` documents the record) is used verbatim —
Principle III: do not reimplement the compiler's doc-comment
association. Parent-node tag inheritance (the documented behavior of
`getJSDocTags` — "including those on parent nodes") is accepted as the
compiler's own semantics and fixture-pinned; a documented imprecision
surface of a heuristic signal, in the same class as prefix
stem-boundary slippage.

**Alternatives considered**:
- *One signal per matched keyword*: rejected — breaks the reference
  adapter's one-signal-per-extractor shape and would let one verbose
  comment stack multiple ±weights; the strongest-tier rule keeps the
  evidence bounded and deterministic.
- *Tag-only extraction (no prose)*: rejected — FR-006 pins the nine
  indirect and four incidental prose verbs verbatim.
- *Custom doc-comment parsing (regex over source text)*: rejected —
  Principle III; the compiler already attaches JSDoc to declarations.

## R5: Visibility extractor — components, exportedness forms, and the clamp

**Decision**: `src/signals/visibility.ts` sums the applicable components
and emits one `visibility` signal with the clamped total (0 → no signal):

- **Exported function (+8)**: the record's declaration is exported from
  its module — ESM: an `export` modifier on the declaration or its root
  variable statement / export assignment (`export default` included);
  CJS: a `module.exports.<name> = …` or `module.exports = …` /
  `exports.<name> = …` assignment targeting the binding in the same
  file (spec edge case 5: both export forms count — JavaScript-family
  sources are first-class). Applies to module-scope function records and
  object-literal members rooted at an exported binding; class-member
  records never take it (they take the receiver component).
- **Exported return type (+6)**: program mode only — the declaration
  carries an explicit return type annotation containing at least one
  type reference that resolves through the checker to an exported or
  ambient symbol (a named, non-primitive type). Primitives
  (`string`/`number`/`void`/…), literal types, object-literal types, and
  unresolved/error annotations do not fire it.
- **Exported receiver type (+6)**: class-member records whose enclosing
  class-like declaration is exported (same closed exportedness rule) —
  both modes (syntactic).

Components are independent (FR-003's "sum of its applicable
components"): a module-private function with an exported return type
still emits +6. The sum is clamped to +20 — currently arithmetically
inert (8+6+6 = 20 exactly), retained as the pinned guard.

**Rationale**: FR-003 defines exactly these components and the clamp.
The exportedness rule is a closed syntactic form-class — the same rule
class as the detector's name-form rules — keeping the +8 and receiver
components available in parse-only mode; only the return-type component
genuinely requires the checker (resolving a type reference to a symbol
and its export state is semantics, Principle III). Parse-only
degradation therefore costs at most the +6 return-type component.

**Alternatives considered**:
- *Checker-driven exportedness for all components*: rejected — would
  lose the +8/receiver components in parse-only mode for no precision
  gain (export modifiers are syntactic facts).
- *A negative visibility component for module-private functions*:
  rejected — spec assumption 4 pins positive-only visibility.
- *Dropping the inert clamp*: rejected — FR-003 pins it; removing a
  pinned guard to simplify tests is a gate-weakening move.

## R6: Interface extractor — heritage resolution with declared members

**Decision**: `src/signals/interface.ts` emits +30 (source `interface`)
for a **class-member record** when the enclosing class-like declaration's
heritage clauses (`extends`/`implements`) resolve, through the checker,
to an interface type whose **declared** members include a member with
the record's name. Route: `checker.getSymbolAtLocation(heritageTypeNode)`
(or the resolved type of the clause) → the base symbol's declarations
are `NodeHandle`s; a base counts only when a declaration's `kind` is
`InterfaceDeclaration`; the interface symbol's `getMembers()` table
(the declared-member map, verified on `Symbol`) is then checked for the
method's escaped name. Program mode only — parse-only emits no interface
signal (FR-002: undeterminable is absence of evidence, never an error).

**Rationale**: The reference's semantics (a method that is part of an
interface contract) map to TypeScript's nominal heritage: the class
*declares* the contract by extending/implementing the interface.
Looking up the member in the interface symbol's **declared** member
table — not `getPropertyOfType`, which walks apparent members — is
load-bearing: apparent-member lookup would find `Object`-prototype
members (`toString`) on every interface and manufacture +30 signals on
every `toString`-alike method (a Principle II false positive). The
escaped-name mapping (names beginning with `_` are escaped with a
`__` prefix in the checker's `__String` keys) is a deterministic
implementation detail pinned by unit tests. Object-literal methods
satisfying an interface structurally (contextual typing) are explicitly
out: the contract is not declared at the method's class, and checking
every interface in the program for structural match is both expensive
and beyond the reference's semantics.

**Alternatives considered**:
- *`getPropertyOfType` on the base type*: rejected — apparent-member
  false positives (the `toString` hazard above).
- *Structural satisfaction (scan all interfaces, `isTypeAssignableTo`)*:
  rejected — the checker exposes `isTypeAssignableTo` (verified), but
  nominal declaration is the reference's semantics and the cost is
  O(interfaces × classes).
- *`getBaseTypes` on the class's declared type*: viable secondary route
  (verified on `Checker`); the heritage-clause resolution is chosen as
  primary because it keeps the interface-or-class discrimination
  syntactic (declaration kind) before any type query — the same
  cheap-check-first shape as the detector's rules.

## R7: Caller index — checker-resolved call sites, and the parse-only boundary

**Decision**: `src/signals/caller-index.ts` builds the index in program
mode with one `checker.getSignatureUsage(recordNode)` query per
extracted record (the verified API returns, per usage, the reference
name handle paired with its **call-expression handle when invoked**).
For each usage carrying a call expression: map the call handle's `path`
to a root-relative path, keep it only when it is in the request's
in-scope file set, and exclude calls positioned inside the record's own
body span (self-recursion). The index answers, per record, the count of
**distinct in-scope modules** with at least one qualifying call site —
the defining module counts when *other* functions in it call the record
(US3's letter: distinct modules, self-calls excluded, module counted
once regardless of site count). In parse-only mode the index is empty:
no `caller_count` signals are emitted. `src/signals/caller.ts` maps the
count to FR-004's buckets (1 → +5, 2–3 → +10, ≥4 → +15, 0 → no signal).

**Rationale** (the change's most consequential interpretation, flagged
deliberately): Constitution III states name resolution, symbol
resolution, and cross-module import analysis **SHOULD** use the
`Program`/`TypeChecker` rather than custom implementations, and US3's
story demands callers "without heuristic name matching".
`getSignatureUsage` is the checker's own call-site machinery — it
resolves instance-method calls (`counter.bump()`), aliased imports, and
re-exports exactly, where a lexical import-graph resolver cannot resolve
receiver-typed calls at all (the dominant form in class-based
TypeScript) and would systematically under-count (a Principle II
false-negative surface on the caller signal). One query per record (not
per call site) keeps the cost proportional to project size — the same
order as the detector's existing per-callee checker queries. "Through
the analyzed project's import graph" (FR-016) describes the semantics —
callers found via module resolution, not via project-wide name matching
— which checker resolution satisfies by construction.

The parse-only consequence is a **documented extension** of the spec's
degradation example (edge case 1 and assumption 10 name only the
interface signal): without a checker, both checker-dependent signals
(interface and caller_count) are absent. The assumption's letter still
holds — the remaining signals (visibility partial, naming, docstring)
classify every effect, and degradation reduces precision, never
availability — but the plan records this boundary explicitly in the
data model and quickstart rather than leaving it implicit. If lexical
parse-only caller counting is wanted, that is a scope decision for the
human, not a silent plan choice.

**Alternatives considered**:
- *Lexical import-graph resolution in both modes* (the issue's
  `src/analysis/inference.ts` concept): rejected as the primary
  mechanism — a custom cross-module resolver (Constitution III tension)
  that cannot resolve instance-method calls; kept on record as the
  fallback should `getSignatureUsage` prove incomplete for a form at
  implementation time (the per-call-site `getResolvedSymbol` single
  pass is the intermediate variant, also verified available).
- *Per-call-site resolution walk* (`getResolvedSymbol` on every callee):
  viable, more queries for the same answer; `getSignatureUsage` is the
  purpose-built primitive.
- *Hybrid (lexical in parse-only, checker in program)*: rejected — two
  code paths for one signal invites drift between modes; the codebase's
  mode splits are per-rule defaults, not duplicate inference engines.

## R8: Adapter fan-out — pair keying and the contradiction invariant

**Decision**: `src/signals/adapter.ts` runs the five extractors once per
**(function record, canonical effect type)** pair — the distinct effect
types present on each record, not one run per effect instance. Signals
are keyed and emitted per pair; every effect of the same type on a
record receives the identical classification. When a pair's extractor
signals include both at least one positive-weight and at least one
negative-weight entry, the adapter appends exactly one synthesized
signal — source `contradiction`, weight −20, the standard identity
fields, a short fixed-template reasoning describing the mixed-polarity
evidence — and the confidence formula applies the −20 once.

**Rationale**: The extractors' inputs (name, documentation, exportedness,
interface membership, caller count, effect type) are all record-level or
type-level — nothing distinguishes two same-type effect instances — so
identical classifications are forced by construction, and running
extractors per instance would only duplicate work. More decisively,
FR-011's ratified wire semantics require it: Gaze's
`mergeClassifications` copies analyzer signals verbatim into
`ComputeScore`, which sums every signal matched to the effect — "a
consumer summing all emitted signals (extractors plus the contradiction
entry) reproduces the identical confidence". Duplicated per-instance
rows would double that sum and break the invariant. Pair keying also
makes FR-014's ordering key `(package, function, side_effect_type,
source)` duplicate-free, keeping the order total without tie-breaks.
The contradiction signal is the wire realization of the formula's
separate −20 term (Clarification Q1, option (a)); emitting it per pair
matches the exactly-once penalty.

**Alternatives considered**:
- *Per-effect-instance fan-out with duplicate rows*: rejected — breaks
  the FR-011 sum-invariant (the decisive argument) and clutters the
  feed.
- *Contradiction recorded analyzer-internally only*: rejected —
  Clarification Q1 rejects it as unobservable and untestable.
- *Contradiction inside the `analyze` classification payload*: rejected
  — classifications carry only `{label, confidence}` (no source-carrying
  surface).

## R9: Confidence formula, labels, and boundaries

**Decision**: For each pair:
`confidence = clamp(0, 100, 50 + tierBoost(type) + Σ(extractor weights) − (contradiction ? 20 : 0))`
where `tierBoost` is +25 for P0, +10 for P1, +0 for P2–P4 (read from
`TIER_MAP` — never a second tier table), Σ sums the five extractors'
signals (the contradiction entry is not in Σ; it is the separate term),
and the label is `contractual` for confidence ≥ 80, `ambiguous` for
[50, 80), `incidental` for < 50. The classification is attached to every
effect of the pair through the existing `Classification` record;
`serializeClassification`'s fail-loud validation (closed label set,
integer 0–100) is unchanged and now exercised on every `analyze`
response.

**Rationale**: FR-009/FR-010 pin the arithmetic; reading the tier from
`TIER_MAP` keeps one tier authority (taxonomy's fixed data — an analyzer
must never re-tier). The spec's worked examples verify exactly:
naming-only +10 on P0 → 85 `contractual`; incidental −10 and −15 on P2
→ 25 `incidental`; no signals → 75/60/50 `ambiguous`; +10 and −15 on a
tier-+10 effect with contradiction → 35 `incidental`; clamping at
0/100; label boundaries 80/79/50/49. All are fixture-pinned (SC-001
through SC-003) with pure-formula unit tests alongside.

**Alternatives considered**: none — the formula is the org
constitution's classification contract (CC-006 substance), owned by
Gaze's scoring engine and mirrored here; deviation is a bug, not a
choice.

## R10: `analyze` wiring — the shared pipeline and the classification seam

**Decision**: `analyze()` (in `src/analysis.ts`) keeps its shape —
`prepareAnalysis` → `detectEffects` → assemble → serialize — and inserts
the signal pipeline between detection and assembly: build the caller
index (while the `ProgramContext` is live), compute the per-record
evidence once, run the extractors per pair, and produce classified
effects (new immutable `Effect` values with `classification` set —
records are `readonly`, so classification is attached by rebuild, never
mutation) before `assembleFunctionRecords`. `classifySignals()` (in
`src/signals/adapter.ts`) runs the identical stages —
`prepareAnalysis` → `detectEffects` → caller index → evidence →
extractors — and serializes the pair-keyed signals in the FR-014 order.
Both handlers own the program-mode context's dispose lifetime exactly as
`analyze` does today.

**Rationale**: FR-013's one-shared-pipeline requirement is structural:
both methods consume `prepareAnalysis` (the identical discovered,
pattern-filtered, exclusion-filtered file set — there is no second walk)
and one signal-extraction core, so `analyze` labels and
`classify_signals` evidence cannot drift. Attaching classification after
detection keeps the detector untouched (its FR-019-era contract — no
classification — is superseded at the wiring layer, exactly where
FR-012 places the change) and keeps `assembleFunctionRecords` /
`serializeFunctionRecord` unchanged. The FR-011 sum-invariant is the
cross-method consistency check: for every pair, `50 + tierBoost −
Σ(all emitted signals for the pair)` equals the reported confidence —
asserted in tests.

**Alternatives considered**:
- *Detector computes classifications during detection*: rejected —
  couples detection to signal evidence and breaks the detector's
  standalone test surface; FR-012 places the wiring after detection.
- *A second `classify` walk for `analyze`*: rejected — FR-013 forbids
  the drift risk; one shared core.
- *Mutable classification assignment*: rejected — records are immutable
  value records (convention pack AP-004); rebuild preserves it.

## R11: `classify_signals` method and server wiring

**Decision**: `src/server.ts` registers a `classify_signals` handler
with the same shape as the analysis handlers: `validateAnalysisParams`
(the existing module-level shared validator — same checks, same message
strings, same order), then `classifySignals(rootPath, patterns,
this.stderr)` wrapped as `{"signals": [...]}`, with
`mapRootPathError(error) ?? error` mapping `InvalidRootPathError` to the
shared `-32602` root message and everything else rethrowing to
handleLine's `-32603`. `src/protocol.ts`'s `initializeResult` flips
`classify_signals` to `true`; the other five flags are unchanged; the
reserved `-32601` set shrinks to exactly `test_mapping`,
`analyze/stream`, `doc_coverage`, `cognitive_complexity` (FR-014/FR-015).

**Rationale**: The dispatch layer mirrors the existing analysis handlers
exactly (the snake-eyes precedent: same validation, same error mapping,
same result-wrapper discipline), so the shared `-32602` error table
stays pinned in one place. The capability flip is the protocol's gating
mechanism — Gaze calls `classify_signals` when and only when the flag is
true (the platform's observed failure mode — treating every
unclassified effect as contractual, ~28% vs expected 60–70% coverage —
is what this change fixes). Skip diagnostics flow to the server's
stderr, never stdout. The result is already wire-shaped before the
envelope serializer, so repeated requests stay byte-identical.

**Alternatives considered**:
- *Method-specific params validation*: rejected — FR-014 pins the
  shared table; a copy would drift.
- *Gating `analyze` classifications behind the capability*: rejected —
  `analyze` is a core method, ungated (protocol v1.2.0; spec 002
  FR-028); classifications flow unconditionally (FR-012).

## R12: Module layout — the signals package and the evidence seam

**Decision** (full tree in [plan.md](plan.md)): a new `src/signals/`
package with `types.ts`, `routing.ts`, `evidence.ts`, `interface.ts`,
`visibility.ts`, `caller-index.ts`, `caller.ts`, `naming.ts`,
`jsdoc.ts`, and `adapter.ts`. The caller index lives at
`src/signals/caller-index.ts`, not the issue's proposed
`src/analysis/inference.ts`. Extractors are pure functions
`(evidence, effectType) → Signal | undefined`; `evidence.ts` is the one
module that computes record-level facts from the live
`ProgramContext`/records (exportedness components, documentation text
and tags, interface membership, caller count), once per record.

**Rationale**: The package mirrors the reference analyzer's proven split
(snake-eyes `signals/`: one module per source + adapter; the scoring
engine deliberately not ported — the platform owns scoring). The
`src/analysis/inference.ts` path is adjusted (spec assumption 16 grants
plan-time realization) because `src/analysis.ts` (file) and
`src/analysis/` (directory) would shadow each other in import
specifiers — legal on POSIX but a readability and review hazard — and
the index's only consumer is the signal pipeline. The evidence seam is
the dependency-inversion play: rule modules depend on a plain snapshot
type, not the compiler, so every rule is exhaustively table-testable and
the compiler interaction (the part that needs program-mode fixtures) is
isolated in two modules (`evidence.ts`, `caller-index.ts`) —
Constitution IV. Two modules beyond the issue's eight (`evidence.ts`,
`caller-index.ts` split out of `adapter.ts`/`caller.ts`) keep single
responsibilities: adapter = fan-out + formula; caller = bucket rule;
caller-index = checker machinery; evidence = the snapshot.

**Alternatives considered**:
- *Eight modules exactly as the issue lists*: rejected — folding
  evidence into the adapter and the index into `caller.ts` couples
  compiler interaction with pure rules and bloats the two hardest
  modules.
- *Flat `src/` modules (`src/signals-*.ts`)*: rejected — ten flat
  modules with `interface.ts`/`naming.ts`-grade generic names crowd the
  root; the package groups the cohesive subsystem.
- *`src/analysis/inference.ts` as proposed*: rejected — the
  file/directory shadowing hazard above.

## R13: Testing and coverage strategy (Constitution IV)

**Decision**: Suites mirror modules one-to-one under `tests/signals/`
plus edits to the two existing suites (tree in [plan.md](plan.md)):

- **Pure-rule table tests** (`interface`, `visibility`, `caller`,
  `naming`, `jsdoc`, `adapter` test files): every extractor and the
  formula exercised over hand-built evidence snapshots — prefix
  selection (case, longest-wins, sentinel, routing gate), component
  sums and the clamp, bucket boundaries (0/1/2/3/4), tag/verb tiers and
  word boundaries, fan-out and contradiction synthesis, formula
  arithmetic including clamp and the 80/79/50/49 label boundaries
  (SC-001's exact-match layer).
- **Compiler-seam fixtures** (`evidence`, `caller-index`,
  `interface`-program-mode): `mkdtemp` trees with a valid tsconfig —
  exportedness forms (ESM `export`, `export default`, CJS
  `module.exports`/`exports.X`), return-type component (primitive vs
  reference vs unresolved), heritage satisfaction (implements/extends,
  interface vs class bases, the `toString` apparent-member hazard,
  generic interfaces), caller index (0/1/2/3/4+ distinct modules,
  multiple sites in one module, self-recursion, instance-method calls,
  aliased imports, calls from excluded test files dropped, file-set
  parity with `analyze` — US3-1..7).
- **Controlled-signal-profile fixtures** (SC-001/SC-002/SC-003): one
  fixture per signal category with every contributing signal pinned and
  the exact `{label, confidence}` asserted through the full `analyze`
  pipeline (the quickstart tree is the canonical example: naming-only
  85, incidental 25, contradiction 25 with the three-signal wire set,
  ambiguous floor 75, interface boundary 80, caller+visibility 93).
- **Routing conformance** (`routing.test.ts`): 48 keys, closed-list
  vocabulary, data-model doc parity (R2).
- **Wiring tests** (`analysis.test.ts` edits): every effect in fixture
  responses carries a serializer-valid classification (SC-004);
  analyze/classify_signals consistency — labels derivable from the
  emitted signals via the FR-011 sum-invariant (FR-013); parse-only
  degradation (interface and caller_count absent, remaining signals
  intact); detection-ambiguity marker untouched (assumption 14).
- **Protocol conformance** (`server.test.ts` edits): canned
  request/response pairs through `Server.run()` for `classify_signals`;
  the full shared `-32602` table; the capability response
  (`classify_signals: true`, other five unchanged — SC-006); the
  reserved `-32601` set shrunk to four names; golden byte-identical
  repeat responses for both methods (SC-005, US1-7, US2-6).
- **Strategy**: fixtures are `mkdtemp` trees written in-test —
  hermetic, no network, no execution of analyzed code. Per-module
  coverage targets ≥ 85%, matching the protected project gate (SC-007);
  the gate is never lowered.

**Rationale**: Constitution IV requires the strategy in the plan and
conformance suites for the protocol; the evidence seam is what makes the
rule layer exhaustively testable without compiler fixtures, and the
profile fixtures are the spec's own SC-001 definition (exact arithmetic,
not snapshots).

**Alternatives considered**:
- *Snapshot tests for classifications*: rejected — exact arithmetic
  assertions are the contract (SC-001); golden byte-comparison covers
  serialization stability separately.
- *Testing extractors only through the full pipeline*: rejected —
  compiler-fixture dependence for pure rules; the seam exists for this.

## R14: Cross-pipeline bookkeeping (FR-017)

**Decision**: The same change updates: `openspec/specs/server/spec.md`
(the Dispatch table scope requirement and its reserved-methods scenario —
`classify_signals` joins the built-ins; the reserved list shrinks to
`test_mapping`, `analyze/stream`, `doc_coverage`,
`cognitive_complexity`), `openspec/specs/protocol/spec.md` (the
initialize capability requirement and scenario — `classify_signals`
becomes `true`; the "other five flags false" wording becomes "the other
four"), `README.md` (method table row → Implemented; capability
paragraph), and `AGENTS.md` (project structure gains `src/signals/`).

**Rationale**: FR-017 pins this, mirroring spec 002 FR-031 and spec 001
Assumption 12 — the materialized specs must not contradict the shipped
dispatch table or capability response. Adding `classify_signals` to the
dispatch table is sanctioned by the server spec's own text (the reserved
analysis method names are the protocol's forward-declared surface).

**Alternatives considered**: none — the bookkeeping is pinned by FR-017.

## R15: Determinism rules (Constitution I)

**Decision**: All outputs are pure functions of the input tree and
analyzer version:

- Signals ordered by `(package, function, side_effect_type, source)` —
  codepoint comparison; the pair keying (R8) keeps the key duplicate-
  free, so the order is total without tie-breaks.
- Classifications inherit the detector's existing deterministic record
  and effect orders (`(file, line, name)` records; `(line, column,
  type)` effects) — the wiring adds no reordering.
- Reasoning strings are fixed deterministic templates (functions of the
  matched rule and matched token), pinned by golden tests.
- Evidence snapshots, the caller index, and interface membership are
  functions of the compiler's own deterministic resolution over the
  identical file set; no timestamps, environment, host, or locale data
  anywhere; stderr diagnostics follow the existing fixed-template
  discipline.
- Golden tests repeat canned requests for `analyze` and
  `classify_signals` and byte-compare the serialized responses
  (SC-005/SC-006, US1-7, US2-6).

**Rationale**: Constitution I mandates byte-identical repeat responses;
every ordering is a documented total order and the compiler program is
constructed deterministically over a pre-read, sorted file set (spec
002's R1/R8 discipline, inherited unchanged).

**Alternatives considered**: none — the rules are FR-014 and
Constitution I made structural.

---

## Summary of resolved items

The Technical Context in [plan.md](plan.md) contains no NEEDS
CLARIFICATION entries: the spec pinned the product semantics (FR-001
through FR-018, Assumptions 1–16, and the three Dewey-resolved
clarifications — docstring source string, JSDoc-tag direct tier,
contradiction signal surface), and R1–R15 above resolve the
implementation mechanics (wire record and closed vocabulary, routing
table and its anti-drift pin, naming and documentation rules,
visibility components and exportedness forms, interface heritage
resolution, the checker-resolved caller index and its parse-only
boundary, pair-keyed fan-out and the contradiction invariant, formula
and labels, analyze wiring, server wiring, module layout and the
evidence seam, testing strategy, cross-pipeline bookkeeping, and
determinism) with rationale and rejected alternatives for each. The
normative 48-row routing table is in [data-model.md](data-model.md).
One interpretation extends the spec's parse-only example and is flagged
for human review: without a checker, both the interface and the
caller_count signals are absent (R7).
