# Research: Test-to-Assertion Mapping (test_mapping)

**Feature Branch**: `004-test-mapping`

**Date**: 2026-10-29

**Status**: Complete — the spec is decision-complete (18 assumptions, 16
FRs, no clarification markers); this document verifies the technical
mechanics behind each pinned decision and records the
implementation-strategy choices the spec leaves open, each with rationale
and rejected alternatives. The Technical Context in
[plan.md](plan.md) contains no NEEDS CLARIFICATION entries.

Sources consulted: Gaze analyzer protocol v1.2.0 (pinned by the
constitution), the feature spec (`specs/004-test-mapping/spec.md`) and
the originating issue (zero-dot-force/reading-stone#5), the
reading-stone codebase (`src/server.ts`, `src/protocol.ts`,
`src/analysis.ts`, `src/program.ts`, `src/discovery.ts`,
`src/extract.ts`, `src/detector.ts`, `src/models.ts`,
`src/taxonomy.ts`, `src/internal.ts`, the `src/signals/` package —
spec 003's precedent for a sub-package with a wire-record module, a
normative-data module, and a compiler seam), spec 001/002/003
artifacts, the installed `typescript@7.0.2` unstable API surface
(every AST guard named below was verified against the shipped
`typescript/unstable/ast` module; `Checker.getSymbolAtLocation` and
`Program.getSourceFile` are the instance surfaces `src/signals/` and
`src/program.ts` already ride), the snake-eyes reference implementation
(its test-mapping change and its container-mutation follow-up — the
direct precedent for the pairing strategies, assertion forms, fallback
chains, and the conservative provenance boundary), and Dewey prior
learnings (snake-eyes test-mapping design decisions; the
generator-target contract-coverage lesson; the disposition-table
conformance-test anti-drift pattern; Gaze's test_mapping row
consumption semantics).

---

## R1: Module layout — the quality package and the entry placement

**Decision**: A new `src/quality/` package with seven modules:
`types.ts` (the `MappingRow` wire record, its fail-loud serializer, and
the `TestMappingResult` shape), `matchers.ts` (the normative
assertion-classification table — pure fixed data), `collect.ts`
(test-function collection), `assertions.ts` (assertion detection),
`pairing.ts` (the three strategies), `inference.ts` (effect-type
inference), and `pipeline.ts` (the `testMapping()` method entry plus
row assembly and ordering). The method entry lives in
`quality/pipeline.ts`, not beside `analyze` in `src/analysis.ts`.

**Rationale**: The issue proposed `src/quality/` with
`pairing.ts`/`assertions.ts`/`mapping.ts`/`pipeline.ts`; spec assumption
15 grants plan-time adjustment. The adjustments follow two house
precedents: (1) `signals/types.ts` — every wire record gets its own
types module with a fail-loud serializer, so `mapping.ts`'s row-shape
content splits into `types.ts` (record + serializer) and the
row-assembly stage of `pipeline.ts`; (2) `signals/routing.ts` — every
normative data table gets its own pure-data module with a
conformance-pinned doc-parity test, so the matcher classification table
is `matchers.ts`. `collect.ts` and `inference.ts` are stages the issue's
list implied but did not name. Entry placement: spec 003 put
`classifySignals()` in `analysis.ts` because it runs `analyze`'s
identical stages; the mapping pipeline's stages diverge immediately
after `prepareAnalysis` (test-arm collection, pairing, assertion
detection — stages `analyze` never runs), so a separate entry keeps
`analysis.ts` the home of the analysis-method entries proper. Dependency
direction is acyclic (convention pack AP-005):
`server → quality/pipeline → {analysis (prepareAnalysis only),
detector, extract, taxonomy, models, internal, program, quality/*}`, with
`taxonomy`/`models`/`internal` and `quality/{types, matchers}` as
leaves; nothing under `src/quality/` imports `server.ts` or
`analysis.ts` back beyond `prepareAnalysis`'s import, and `analysis.ts`
imports nothing under `src/quality/`.

**Alternatives considered**: (a) Placing `testMapping()` in
`src/analysis.ts` beside `analyze`/`classifySignals` — rejected: the
shared surface is one function (`prepareAnalysis`), and co-locating the
entry would pull test-arm collection concerns into the analysis-method
module while bloating it (496 lines already). (b) Keeping the issue's
four-file layout exactly — rejected: `mapping.ts` as a fifth stage file
mixes wire-shape and orchestration concerns the house pattern splits,
and there is no home for the normative matcher table (the routing.ts
precedent demands its own module for the doc-parity conformance test).
(c) A top-level `src/mapping.ts` flat module — rejected: seven
 cohesive stages (≈ the signals package's ten modules) exceed flat-file
 size, and the package boundary documents the capability's boundary the
 way `src/signals/` documents spec 003's.

---

## R2: The `prepareAnalysis` test-arm widening — program admission and target parity

**Decision**: `prepareAnalysis` gains an optional fourth parameter —
`options` with a single `includeTestArm: boolean` flag — and a new
result field `testPaths: readonly string[]` (always present; `[]` when
the flag is unset). When the flag is set: (1) the discovered,
exclusion-screened test arm (classifyFiles' `testFiles`, pattern-UNfiltered
— FR-006 pins patterns to the target arm only) is pre-read through the
same bounded `readBounded` and appended to the bootstrap input, so the
extender config's `files` root set and the parse-only sources map both
admit the test files; (2) `testPaths` carries the full test arm back to
the caller; (3) the extraction records are STILL narrowed to the
in-scope source set — test-file records are dropped, so the target set
is the identical `analyze` file set, record-for-record. The three
existing callers pass no flag and observe no behavior change beyond the
inert new field.

**Rationale**: FR-006 requires targets to be "the function set the
shared analysis pipeline extracts" and FR-012 requires "target analysis
over the shared `prepareAnalysis` pipeline" — one pipeline, no second
discovery/bootstrap/extraction path to drift. Checker-mode
import-graph resolution and direct-call resolution must answer semantic
questions about nodes INSIDE test files (which source declaration does
this import specifier denote? which target does this call invoke?),
and the spec's edge cases pin checker-mode precision for both (edge
case 1 reserves lexical matching for parse-only; edge case 7 pins that
checker-mode resolution follows barrel re-exports). A compiler `Checker`
can only resolve nodes belonging to its program, so program mode must
admit the test files. Admission through the root set is safe for target
parity: the program-mode host already serves any in-root path on demand
(`createProgramFileSystem` route 3 — a source file importing a
test-classified file already pulls it into `analyze`'s program
transitively), so admitting test files as root files changes no
resolution semantics that target-side checker answers depend on — the
compiler's view of the in-root tree was already total; what the root set
adds is guaranteed presence and upfront parsing. Extraction is lexical
(the R4/R5 form table and scope tracker — spec 001 research), so
records over source files are identical either way, and the in-scope
narrowing (already in place) drops the test arm's records. The
extender-config `files` order stays deterministic (sorted source arm,
then sorted test arm). In parse-only mode the test files join the
sources map keyed by root-relative path — the collector consumes them
through the same map the analysis sources use.

**Alternatives considered**: (a) The quality pipeline re-composing
`resolveRoot`/`walkTree`/`screenCandidates`/`classifyFiles` itself, the
way `discover()` does — rejected: duplicates the pipeline order and
re-opens the drift FR-006 exists to close (two discovery walks over one
request). (b) Bootstrapping a SECOND `ProgramContext` over the test arm
— rejected: a second native compiler server per request (waste), and
cross-context symbol resolution between the source program and the test
program is impossible anyway (the checker cannot follow a test-file
import into a program it does not own). (c) Parsing test files
client-side with `ts.createSourceFile` and resolving imports by
hand-rolled module-specifier path resolution in BOTH modes — rejected
for checker mode: reimplements TypeScript module resolution (Constitution
III), cannot cross barrel re-exports (the edge case explicitly pins
that checker mode does), and surrenders `getSymbolAtLocation`'s
declaration matching; retained only as the parse-only fallback (R12).
(d) Always including the test arm (no flag) — rejected: the existing
three method entries' bootstrap inputs would change (extra root files,
extra pre-reads) with no consumer, a silent behavior widening of
protected methods.

---

## R3: Test-function collection — roots, modifier chains, and titles

**Decision**: `collect.ts` walks each test file's statements and
collects a `TestFunction` for every callback passed to an `it`/`test`
invocation. Detection: a `CallExpression` whose callee — after
unwrapping any intermediate call-expression wrappers (the
`it.each(table)(title, fn)` form's inner call) — is either an
identifier named `it` or `test`, or a property-access chain rooted at
such an identifier (`it.only`, `test.concurrent`, `it.skipIf`,
`it.each`'s outer spelling, and any sibling modifier — the modifier set
is deliberately NOT closed: within discovered test files the `it`/`test`
roots are framework surface, and an open chain keeps
`skipIf`/`runIf`/future modifiers available rather than silently
dropped — the availability-first reading of FR-002's "and siblings").
The callback is the last argument that is a function expression or
arrow function (robust to trailing `timeout` arguments); an invocation
whose callback argument is a bare identifier (a referenced test
function) still collects the test — with no callback subtree, so its
assertion set is empty and direct-call pairing cannot fire for it, but
title-based and import-graph pairing still apply (never dropped —
Principle II). The title is the invocation's first argument when it is
a string literal or a no-substitution template literal (static text);
any other first argument yields the empty string and the test is still
collected (FR-002's non-static-title rule). `describe` invocations are
containers, not tests: the collector maintains a describe-title stack
(the same first-argument static-text rule per level; a non-static
describe title is the empty string segment) and qualifies each test's
identity as `FR-003` pins — enclosing describe titles joined with
`" > "` outermost-to-innermost, then the test title (bare title at top
level; empty segments join verbatim, so the identity is always a
deterministic function of the static text). `bench` callbacks, and the
`beforeEach`/`afterEach`/`beforeAll`/`afterAll` hooks, are excluded by
root matching (their callee roots are `bench`/`beforeEach`/…, never
`it`/`test`). Collection order is source order; the collector's output
is sorted by `(relPath, collection index)` — a stable, deterministic
input to pairing. The walk domain (amended, iteration-2 consented fix):
statement positions at the file top level and inside describe callback
bodies, PLUS their control-flow interiors — `if`/`else`, `for` /
`for-of` / `for-in` / `while` / `do-while`, and plain blocks — so
loop-generated (`for (const c of cases) it(c.label, ...)`) and
conditional (`if (cond) it(...)`) registrations collect; arbitrary
nested function expressions are never entered (an `it` reachable only
through a helper call is outside the suite's static structure — the
documented boundary between suite structure and arbitrary code). The
walk is depth-bounded (plan.md Scale/Scope): past the mapping-walk
budget the whole file skips with exactly one diagnostic — the
`extractFromFile` discipline, never a request crash (Constitution V).

**Rationale**: The syntax-driven rule matches the spec's edge case 11
(vitest and jest share the `it`/`test`/`describe`/`expect` surface;
the discovered framework string stays informational). The each-form
unwrapping handles `it.each(table)("title", fn)` — the callback and
title live on the OUTER call, the modifier chain on the inner (edge
case 5: one test function per callback; the title is the static
template text, `$a` placeholders included verbatim). Last-function-argument
selection survives `it(title, fn, timeout)` and any option-object
forms without enumerating them. Identifier-callback collection follows
Principle II's never-drop rule while honestly degrading: no callback
subtree means no assertions to map (a zero-assertion paired test emits
no rows — US3-8), which is the truthful outcome, not a silent drop.

**Alternatives considered**: (a) A closed modifier whitelist
(`only|skip|concurrent|fails|each|todo`) — rejected: `todo` carries no
callback (excluded by the callback requirement anyway), and the closed
list drops `skipIf`/`runIf`/jest's `failing` and whatever lands next;
within test files the open chain is safe (the roots are framework
surface) and matches FR-002's "modifier variants … and siblings".
(b) Requiring the callback as exactly the second argument — rejected:
breaks on trailing timeouts and forces enumerating every option form.
(c) Dropping identifier-callback tests — rejected: Principle II
(never silently drop a real test), and the title still carries pairing
evidence. (d) Resolving identifier callbacks to their declarations —
rejected: crosses the file's statement flow into arbitrary
data-flow (which FR-011's own boundary refuses even inside callbacks);
the conservative boundary keeps collection deterministic.

---

## R4: Pairing strategies — semantics, resolution modes, and ordering

**Decision**: `pairing.ts` evaluates three strategies per test function
in fixed priority order — (1) naming conventions, (2) direct calls,
(3) import graph — first-match-wins per test (evaluation stops at the
first strategy with any match; only that strategy's pairs are emitted,
FR-004/US2-7). Per strategy:

1. **Naming conventions (exact 90 / case-insensitive 70)**: the test's
   title, or its nearest enclosing describe title, is compared against
   every target's name. An exact (case-sensitive) match pairs at
   confidence 90; a case-insensitive-only match pairs at 70. Every
   same-named target pairs (FR-005: each distinct
   `(target_package, target_function)`), deterministically ordered by
   the analyze record order `(file, line, name)` (`compareFileLineName`).
   The exact tier shadows the case-insensitive tier per test: a test
   whose title exactly matches one target and case-insensitively
   matches another emits only the exact pair at 90 (first-match-wins at
   the strategy's internal tier order too — the reference's design).
2. **Direct calls (80)**: the test's callback subtree (when present) is
   scanned for `CallExpression`s. In checker mode, each callee is
   resolved through `checker.getSymbolAtLocation` and its declaration
   matched against the target records' nodes (method and property
   callees included — the symbol identifies the declaring function);
   in parse-only mode, the callee's terminal identifier text is matched
   against target names (a documented false-positive surface — edge
   case 1). Each distinct target reached pairs at 80, in record order.
3. **Import graph (75)**: for each test file, the import declarations
   are resolved to target records — in checker mode through
   `checker.getSymbolAtLocation` on each import specifier, following
   re-exports to the declaring function (edge case 7's barrel rule);
   in parse-only mode through module-specifier path resolution
   (specifier resolved against the test file's directory with the
   walk's six extensions and `index` files, then imported-name matching
   against the target records in that file — barrels cannot be
   crossed, the documented imprecision). A binding pairs only when it
   is referenced somewhere in the file OUTSIDE the import clause —
   reference presence is a lexical identifier scan in BOTH modes (a
   shadowed same-named local counting as a reference is the documented
   conservative imprecision). Every test in the file not already paired
   by a higher-priority strategy pairs with each such referenced
   target at 75, in record order.

Pair dedup (amended, iteration-2 and iteration-3 consented fixes):
within one test function's emitted pairs, no duplicate
`(test_function, test_file, target_package, target_function)` pair
exists. The per-test first-match-wins evaluation makes duplicate
strategy emissions structurally impossible. The residual unsoundness
the original pin missed — wire-indistinguishable targets with
identical pair keys — resolves by first-wins in analyze record order
`(file, line, name)`, the `byNode` node-key discipline: the pair set
keeps the FIRST record's pair and collapses the later record as a
documented conservative imprecision (FR-005). Iteration-2 covered the
same-file case (two distinct records sharing one file and one declared
name — same-named methods of different classes in one file);
iteration-3 extended the collapse to the derived wire key
`(derivePackage(relPath), name)` because `derivePackage` is not
injective over files — same-stem different extensions
(`util.js`/`util.cjs`), a dot in a stem vs a nested directory
(`a.b.ts`/`a/b.ts`), and a file vs its directory index
(`pkg.ts`/`pkg/index.ts`) all derive one package, so same-named records
in those colliding-package files are wire-indistinguishable exactly
like the same-file case and collapse the same way. Wire tuples narrower
than the pair key legitimately collide: same-named
targets across genuinely different derived packages are distinct pairs
(disambiguated by
`target_package`), and same-titled sibling tests inside one `describe`
share the identical `test_function` — they are distinct test functions
that each keep their own pairs, and their rows disambiguate through
`assertion_location`. Unmatched tests produce no pairs and therefore
no rows (US1-3 — never confidence-0 rows).

**Rationale**: The priority order and confidences are the spec's pins
(assumption 6: the issue's list order was enumeration, not priority —
a direct call is stronger evidence than a bare import). Checker-mode
resolution through `getSymbolAtLocation` is the same verified surface
`signals/evidence.ts` rides (Constitution III), and declaration-matching
against target nodes is precise where name matching is not. The lexical
reference-presence scan is a deliberate precision concession: a
per-identifier `getSymbolAtLocation` query would cost one checker
round-trip per identifier in every test file, disproportionate to the
75-confidence evidence class the strategy serves — the conservative
direction errs toward availability (an unused import still pairs
nothing in the overwhelmingly common no-shadowing case, which is what
US2-5 pins). Parse-only module-specifier resolution is the minimal
deterministic subset of TypeScript resolution (relative specifiers,
extension and index resolution over the discovered file set) — package
specifiers (`node:...`, bare package names) resolve to nothing
in-root and pair nothing, which is correct (they denote no target).

**Alternatives considered**: (a) Per-identifier symbol queries for
reference presence in checker mode — rejected on cost/benefit (above).
(b) Reusing `buildCallerIndex`'s `getSignatureUsage` for the
direct-call strategy (query each TARGET for its usages, then filter to
the test callback's span) — rejected: the index answers "who calls this
record" over in-scope SOURCE files (test files were never in its file
set), it costs one query per target rather than per call site, and the
test callback's span filter would need positional containment over
nodes the index does not carry; the per-callee forward query is the
simpler, more precise instrument here. (c) Case-insensitive matching
normalized by lowercasing with locale folding — rejected: `toLowerCase`
without locale arguments is the platform-stable, deterministic form
(the string-comparison discipline — UTF-16 code-unit order); a full Unicode case fold is
neither pinned by the spec nor stable across Node ICU versions.
(d) Pairing every test with every file-imported target regardless of
reference presence — rejected: US2-5 explicitly pins the unused-import
rule.

---

## R5: Assertion detection — expect chains, node:assert tables, and per-matcher rows

**Decision**: `assertions.ts` collects assertions from each PAIRED
test's callback subtree (including nested function expressions within
it — a callback's inner closures carry expects; hooks and
describe-scope statements are structurally outside every callback).
Two forms:

1. **`expect()` chains**: the detector walks the subtree for
   `CallExpression`s and reconstructs chains: an invocation qualifies
   when its callee is a property access whose base chain — through
   intermediate property accesses (`.not`, `.resolves`, `.rejects` and
   any other modifier properties) and `await` wrappers — roots at a
   call whose callee is the identifier `expect`. The INVOKED property
   is the matcher name; the intermediate properties form the modifier
   chain. One row is emitted per matcher invocation (US3-10): the
   matcher's kind comes from the table (R6), `.not.` preserves the
   kind, `.resolves.` preserves the kind, `.rejects.` routes to
   `error_check` (FR-008). An `expect(...)` chain with NO matcher
   invocation is not an assertion (US3-9 — `expect(x).resolves` alone
   or a bare `expect(x)` statement collects nothing). Unknown matcher
   names are recognized assertions classified `""` (US3-6). The
   assertion's `assertion_location` is the line of its anchor — the
   outermost wrapper of the matcher invocation (`await` and
   parenthesized wrappers unwrapped upward, every matcher invocation on
   one shared chain reporting the same anchor) — as `<relPath>:<line>`
   (US1-1).
2. **`node:assert` calls**: the detector builds, per test file, an
   assert-binding table from the file's import/require declarations —
   the closed module-specifier set `{"node:assert",
   "node:assert/strict", "assert"}` matched syntactically in both
   modes, with the binding forms `import assert from …` (default),
   `import * as assert from …` (namespace), `import { equal, … } from
   …` (named, each name mapped to its assert function), and
   `const assert = require(…)` (CJS). Calls recognized: `assert(...)`
   (default/namespace binding, bare truthiness form), `assert.fn(...)`
   (default/namespace member), and bare named-binding calls
   (`equal(a, b)`). Classification follows the table (R6);
   `not`-prefixed functions preserve their base kind (US3-7). The
   asserted expression — the provenance passes' subject (R7) — is the
   FIRST argument for every assert form. The assertion's location is
   the line of the assert call's outermost wrapper (the same anchoring
   rule as expect chains).

**Rationale**: Chain reconstruction by walking from the invocation down
to the `expect(` root handles every pinned form in one rule: plain
(`expect(x).toBe(y)`), negated (`.not.`), awaited
(`await expect(p).resolves.toEqual(v)` — the await wrapper is
transparent), rejects (`expect(p).rejects.toThrow(e)` → error_check
regardless of matcher), and the per-invocation rule emits two rows for
a chain carrying two matcher invocations. Modifier properties are not
enumerated (`.not`/`.resolves`/`.rejects` recognized by name for
classification; any other intermediate property is inert chain
context). The syntactic assert-binding table works identically in both
modes because the module-specifier set is closed text; checker-mode
"import resolution" (FR-007's phrase) is realized as the same table —
node:assert admits no in-root re-export, so specifier text is the
complete resolution. The first-argument asserted-expression pin is the
natural reading of `assert.equal(actual, expected)` and matches the
reference analyzer's actual-operand convention. A chai project's
`expect(x).to.equal(y)` collects as an expect-rooted invocation with
unknown matcher `equal` → `""` — the honest classification for an
out-of-scope library whose surface is syntactically indistinguishable
(edge case 11's syntax-driven detection); chai's non-expect forms
(`should`, chai's own `assert` import) are not collected unless the
import specifier is literally `assert` — a parse-only-documented
false-positive surface only when a project shadows the specifier.

**Alternatives considered**: (a) Recognizing only `.not`/`.resolves`/
`.rejects` as chain modifiers and rejecting other intermediate
properties — rejected: `expect(x).someModifier.toBe(y)` is still an
expect-rooted assertion in spirit; the open-chain reading errs toward
availability and classifies by the invoked matcher. (b) Mapping
node:assert through the checker's type system (resolve the assert
binding's declared type to node:assert's d.ts) — rejected: the
specifier table is deterministic, mode-independent, and total; type-level
resolution would add checker round-trips to distinguish what a closed
string set already decides. (c) Taking `expect`'s FULL argument list
as asserted expressions for provenance — rejected: FR-011's passes are
pinned over "the asserted expression" (singular); the first argument
is the actual operand in every standard form.

---

## R6: The matcher table — normative data, totality, and the unknown-form fallback

**Decision**: `matchers.ts` is pure fixed data — the FR-007 routing
table: every standard vitest/jest matcher and `node:assert` function
routed to a classification kind or explicitly to none (`""`),
transcribed verbatim from `data-model.md` Section 4 (the normative
source; the module is its rendering, the routing.ts pattern). The
closed kind set is `{"equality", "comparison", "membership",
"error_check"}` plus `""`. Unknown or custom matcher names route to
`""` through the lookup's miss path — a total function, never an
exception, never a drop (US3-6: recognized assertion, unclassified
kind). Negation (`.not.`, `not`-prefixed assert functions) preserves
the underlying kind; `.resolves.` preserves the matcher's kind;
`.rejects.` routes to `error_check` (FR-008). The conformance suite
diffs the table against `data-model.md` Section 4 itself (the
disposition-table anti-drift pattern).

**Rationale**: FR-007 pins the table as normative data precisely so
implementation-time discretion cannot reshape it (Constitution I — the
table is deterministic, version-stable data). Routing unknowns to `""`
rather than dropping keeps assertion DETECTION total while
classification stays honest — the empty string is the spec's pinned
unclassified convention (assumption 1: the deliberate divergence from
the reference's `generic`). The two deliberate vocabulary divergences
from the reference's six-value set are the spec's pins, not this
plan's: no `identity` (Python's `is`-operator bucket has no distinct
vitest/jest analog — `toBe` is documented strict equality), no
`generic` (the empty string feeds the platform's
recognized-assertion-type metric).

**Alternatives considered**: (a) Classifying unknown matchers by suffix
heuristics (`*CalledWith` → equality) — rejected: unpinned,
version-fragile pattern matching where the spec demands a pinned table
plus an honest miss path. (b) Dropping unclassified assertions —
rejected twice over: US3-6 pins the `""` row, and the row still carries
pairing and location evidence the platform counts. (c) Placing the
table inside `assertions.ts` — rejected: the routing.ts precedent
(normative data gets its own module + doc-parity test) keeps
`assertions.ts` about detection mechanics.

---

## R7: Effect-type inference — the four passes, boundaries, and fallback chains

**Decision**: `inference.ts` computes each row's `side_effect_type`
from the paired target's effect type set (the `detectEffects` output
for the target record — the same effect sets `analyze` reports) in two
layers:

**Error rows** (`assertion_type === "error_check"`): selected by
assertion type alone, never by provenance (FR-009) — `ErrorReturn`
when the target carries it, else `ErrorSignal` when it carries it,
else the `ErrorReturn` fallback.

**Value rows** (`equality`, `comparison`, `membership`, `""`):
provenance first, then the fallback chain. The four passes run in
fixed order over the asserted expression (R5's first-argument pin):

1. **Direct identity**: the asserted expression is exactly a call
   resolving to the paired target (checker: callee symbol's
   declaration matches the target node; parse-only: callee terminal
   identifier text equals the target name).
2. **Indirect root resolution**: the asserted expression's root
   identifier (the leftmost identifier of its expression tree —
   `result` in `result.items`, with `await` wrappers transparent) is
   locally bound in the test function by a declaration whose
   initializer is a direct call to the target, with `await` wrappers
   (`const r = await target()`) and destructuring patterns
   (`const { items } = target()`, `const [first] = target()`)
   transparent.
3. **Helper function bridging**: the root resolves through a single
   file-local helper — the asserted expression's root is a call to a
   file-local function (declared function, or const-bound arrow/
   function expression at file scope) whose returned value derives
   from a direct call to the target (a `return [await] target(...)`
   statement, or an expression-bodied arrow `() => target(...)`).
4. **Inline call matching**: a call resolving to the target appears
   inline anywhere within the assertion's argument subtree — for
   expect chains the invoked matcher invocation's full `CallExpression`
   subtree (spanning the `expect(...)` arguments and the matcher's own
   arguments), for node:assert forms the assert call's full argument
   list (`expect(list).toContain(target(item))`).

When a pass succeeds and the target carries a return-family effect,
`side_effect_type` is the first present of `ReturnValue` →
`GeneratorYield` → `AsyncGeneratorYield` (US4-1: a generator target
with `GeneratorYield` and a P0 effect but no `ReturnValue` maps
`GeneratorYield` — provenance prefers the return family). When
provenance succeeds but no return-family effect is present, the
standard fallback chain governs (US4-7 — provenance only REORDERS the
return family ahead of it). When no pass succeeds, the standard
fallback chain (FR-010): `ReturnValue` when present, else the target's
first P0 effect in effect-array order, else `GeneratorYield`, else
`AsyncGeneratorYield`, else the `ReturnValue` fallback (total — a
target with no detected effects maps `ReturnValue`, US1-7).

**Boundaries** (FR-011's conservative pins): provenance MUST NOT cross
nested functions other than the single pass-3 helper bridge (an
expect inside a callback's inner closure whose asserted expression
binds through that closure's parameters does not resolve — the pass-2
binding search is the TEST FUNCTION's locals only); MUST NOT follow
alias chains (a binding whose initializer is a bare identifier
reference — `const b = a` — does not qualify, const or let alike; only
direct call initializers with await/destructuring transparency do);
MUST NOT cross control-flow merges (a `let` binding assigned inside an
`if`/loop is not a pass-2 binding — only declarator initializers
qualify, so merge points are structurally unreachable). Unsupported
provenance falls back deterministically rather than guessing (US4-8).

**Rationale**: The passes are the spec's informed pinning (assumption
10) of the issue's four names, grounded in the reference's
target-result tracing plus its explicitly-excluded helper bridge,
which the issue added. The boundaries transcribe the reference's
hardest-won conservatism (its own design record: "Evidence will not
cross helper calls, nested functions, attributes, mutable alias
chains, or control-flow merges … Unsupported or ambiguous provenance
keeps the existing mapping instead of guessing") — with the single
helper bridge added because the issue names it. The return-family
preference ahead of the chain is what makes generator targets map
truthfully (the reference's contract-coverage lesson, assumption 11).
The first-P0 fallback reads the effect array in detection order —
`detectEffects`' emission order is deterministic (the detector's
source-order walk), so "first P0" is a stable pin.

**Alternatives considered**: (a) Following const-alias chains
(`const b = a; expect(b)`) — rejected: the conservative boundary keeps
provenance deterministic and cheap; alias following adds a
graph-search surface the reference deliberately excluded, and the
fallback chain still produces a truthful (if less specific) mapping.
(b) Searching the whole FILE's locals in pass 2 rather than the test
function's — rejected: the spec pins "locally bound in the test
function"; describe-scope bindings shared across tests are exactly the
control-flow-shaped ambiguity the boundary exists to refuse. (c)
Provenance for error rows — rejected: FR-009 pins the error family by
assertion type alone (a `toThrow` assertion observes the error channel
regardless of which expression raised). (d) Preferring the return
family even without provenance — rejected: that is FR-010's own
ordering (ReturnValue first); the passes' observable effect is exactly
the GeneratorYield/AsyncGeneratorYield promotion (US4-1 vs US4-6).

---

## R8: Row assembly, ordering, and serialization

**Decision**: `pipeline.ts` assembles one `MappingRow` per (paired
test, assertion): `test_function` (the describe-qualified title),
`test_file` (root-relative POSIX path), `assertion_location`
(`<relPath>:<line>` of the expect/assert call, no column),
`assertion_type` (the classified kind or `""`), `target_function`
(the record's name), `target_package` (`derivePackage(record.relPath)`),
`side_effect_type` (R7's inference), `confidence` (the pair's strategy
integer). Rows are sorted by the stable key `(test_file,
test_function, target_package, target_function, assertion source
position)` — UTF-16 code-unit comparison (JavaScript's default `<`)
for the string keys, then the
assertion's `(line, character)` numeric pair — and mapped through a
fail-loud `serializeMappingRow` (`quality/types.ts`): membership in
the closed kind set, canonical `side_effect_type` membership through
`resolveSideEffectType` (aliases never emitted), integer confidence in
[0, 100], string fields type-checked — the `serializeSignal` house
pattern. The result payload is `{"mappings": [...]}` typed against a
`TestMappingResult` interface whose `mappings` key is
`readonly MappingRow[]`; the pipeline entry constructs its result
against the interface and returns the complete one-key envelope, and
the server handler types the entry's return against the interface —
adding no wrapper — so the one-key wire shape is compile-time pinned
end to end (the `ClassifySignalsResult` pattern, the envelope
assembled in the entry rather than the handler). Empty inputs
— no test files, no production targets, a pattern set matching
nothing, or no pairs — yield `{"mappings": []}`, never an error (US1-8,
edge case 10).

**Rationale**: The row order is FR-013's pin; sorting by the
assertion's source position within a (test, target) group keeps rows
from one pair in source order (US1-2: three assertions, distinct
`assertion_location` values in source order). The serializer's
fail-loud validation is Constitution I's rule that invalid record
content never reaches the wire — a malformed row is an analyzer bug.
`target_package` through `derivePackage` is US1-1's pin (the dotted
module path of the target's file) and reuses the existing derivation
so `analyze`'s `package` field and the row's `target_package` can
never disagree. The result interface mirrors spec 003's compile-time
pinning pattern.

**Alternatives considered**: (a) Sorting by `assertion_location`
string rather than (line, character) — rejected: lexicographic line
ordering breaks at line 10 vs line 9 (`"10" < "9"`); the numeric pair
is the correct source order. (b) Emitting the matcher invocation's
line as `assertion_location` — rejected: US1-1 pins the `expect(`
call's line; the expect call is the assertion's anchor in every
pinned scenario. (c) A generic record serializer (serialize-any-row) —
rejected: the house pattern is one fail-loud serializer per wire
record with the record's own closed sets.

---

## R9: Method wiring, capability flip, and cross-pipeline bookkeeping

**Decision**: `server.ts` registers `test_mapping` beside
`classify_signals` — the SAME `validateAnalysisParams` surface, the
`mapRootPathError` mapping (`InvalidRootPathError` → the shared
`-32602` root message; every other failure rethrows for handleLine's
`-32603`), the handler body calling `testMapping(rootPath, patterns,
this.stderr)` — the entry assembles and returns the typed
`TestMappingResult` whole, so the handler passes it through with no
wrapper — skip diagnostics flow to the server's stderr,
never stdout (spec 001 FR-017 discipline). `protocol.ts`'s `initializeResult()`
flips `test_mapping: true` with the other five flags unchanged
(FR-014); the reserved `-32601` set shrinks to exactly
`analyze/stream`, `doc_coverage`, `cognitive_complexity`. The same
change updates the materialized OpenSpec specs (FR-015):
`openspec/specs/server/spec.md` (dispatch-table requirement and
reserved-method scenario) and `openspec/specs/protocol/spec.md`
(initialize capability assertions and scenario), plus `README.md`
(method table, capability note, project structure including the
`src/index.ts` re-export comment line, the `## Limits &
Troubleshooting` section — `test_mapping` joins the per-request
pipeline-cost bullet's method list, and fixed-scope entries cover the
assertion-library scope, parse-only degradation, the
same-titled-sibling `test_function` collision, and the wire-key pair
collapse (same-file and colliding-package same-named targets are
wire-indistinguishable — rows emit only for the first record in
analyze record order) — and the
ported-design attribution sentence), `AGENTS.md` (project structure
gains `src/quality/`, module map), and `NOTICE` (the attribution
sentence gains the test-mapping pipeline design). `src/index.ts`
re-exports the mapping pipeline's public surface (`testMapping`,
`serializeMappingRow`, the `MappingRow`/`TestMappingResult` types —
mirroring the signals re-exports).

**Rationale**: The handler mirrors `classify_signals`'s registration
exactly (the FR-013/FR-027 shared error table; capability registration
in the same change as the flag so no commit advertises a capability
the dispatch table lacks). The bookkeeping list transcribes FR-015
with the concrete grep-verified targets: server/spec.md lines 145/149
(the dispatch-table requirement and the reserved-methods scenario) and
protocol/spec.md lines 72/77 (the initialize capability wording and
scenario) are the materialized assertions that currently say
`test_mapping` answers `-32601` and advertises `false`. Spec 002
FR-031 and spec 003 FR-017 set the precedent: cross-pipeline
bookkeeping rides the implementation change, never a separate
afterthought commit.

**Alternatives considered**: (a) Registering the handler without the
OpenSpec updates — rejected: FR-015 is a MUST; the materialized specs
would contradict the code. (b) A distinct params validator for
`test_mapping` — rejected: FR-013 pins the SHARED table (spec 002
FR-027); a second validator is drift surface.

---

## R10: Determinism rules (Constitution I)

**Decision**: The mapping pipeline is a pure function of the analyzed
tree and analyzer version: collection, pairing, assertion detection,
and inference read only compiler-produced nodes, the extraction
records, and the effect sets — no timestamps, no environment-dependent
data, no Map iteration order reaching the wire (every emitted
collection is sorted by an explicit total order before assembly:
pairs by record order, rows by the FR-013 stable key). Strategy
confidences are fixed integers; the matcher table is fixed data;
reasoning-free rows carry no free-text templates beyond the pinned
field values. Golden tests pin byte-identical repeat responses over
the same tree (SC-005/US1-6), including a full second `testMapping`
call over a fresh `prepareAnalysis` (a second walk and bootstrap must
reproduce the first response exactly).

**Rationale**: Constitution I's byte-identical rule is absolute for
every method; the mapping pipeline's new nondeterminism risks are
iteration order over per-file maps (pairing groups) and checker query
ordering — both neutralized by explicit sorting before emission. The
two-walk golden test is the strongest available pin: it exercises the
whole pipeline twice, not just serialization caching.

**Alternatives considered**: (a) Determinism tests over a single
pipeline invocation's serialized output twice — rejected as too weak:
it pins the serializer, not the pipeline; the reference analyzer's
hash-seed instability lesson says the WALK must be re-run.

---

## R11: Testing and coverage strategy (Constitution IV)

**Decision**: `tests/quality/` mirrors `src/quality/` one-to-one
(seven suites), plus edits to `tests/analysis.test.ts` (the
`prepareAnalysis` widening) and `tests/server.test.ts` (dispatch
conformance). The ladder:

1. **Pure-rule table tests** (`matchers.test.ts`): every enumerated
   matcher and assert form's classification, the modifier semantics
   (`.not.`/`not-` preserve, `.resolves.` preserves, `.rejects.` →
   error_check), the unknown-matcher `""` fallback, and the
   data-model Section 4 doc-parity diff (the disposition-table
   anti-drift pattern).
2. **Pinning fixture trees** (`mkdtemp`, the tests/helpers pattern):
   one fixture per pairing strategy (title-exact 90, title-case-only
   70, call-only 80, import-only-via-file-local-helper 75, multi-target
   ordering, first-match-wins, unpaired-emits-nothing — SC-004);
   matcher-table fixtures (one per classification kind plus negated,
   awaited, `resolves`/`rejects`, no-matcher, two-matcher, node:assert
   forms — SC-002); provenance-pass fixtures (one per pass, generator
   targets, error family, P0-only, effect-less targets — SC-003);
   zero/partial/full assertion-coverage fixtures (SC-002); each
   asserting the exact eight-key row set including confidences.
3. **Pipeline end-to-end** (`pipeline.test.ts`): whole-tree fixtures
   with expected full row arrays in FR-013 order; parse-only
   degradation fixtures (no tsconfig — lexical matching, barrels
   uncrossed); the two-walk byte-identical golden (R10); the
   static-analysis canary (a throwing module planted inside the
   compiler's resolved import graph — the caller-index precedent,
   Constitution V).
4. **Protocol conformance** (`server.test.ts` edits): `test_mapping`
   dispatch through the injectable-stream harness; the shared
   `-32602` error table rows (non-object params, missing/non-string
   root_path, bad patterns, unknown keys, unusable root); `initialize`
   capability assertions (six flags, `test_mapping` now true —
   SC-005); the reserved `-32601` set shrunk to exactly three names;
   golden response bytes.
5. **Widening parity** (`analysis.test.ts` edits): flag-off calls
   unchanged (testPaths `[]`, identical records/inScopePaths); flag-on
   target records identical to `analyze`'s over the same tree
   (FR-006's parity asserted, not assumed).

All suites run under the protected 85% thresholds
(`npx vitest run --coverage`), with `npx biome check src/ tests/` and
`npm run build` as the CI-parity gates (FR-016).

**Rationale**: The ladder follows spec 002/003's proven shape — pure
rules table-tested without compiler fixtures (the dependency-inversion
seam: `matchers.ts` is data, `pairing.ts`/`inference.ts` take plain
inputs), semantics pinning fixtures for everything requiring a parsed
tree, protocol conformance at the JSON-RPC seam (Constitution IV's
canned request/response mandate), and golden determinism tests. The
parity test (rung 5) is FR-006's structural guarantee made executable.

**Alternatives considered**: (a) Snapshot tests instead of exact-row
assertions — rejected: snapshots drift silently; SC-001 demands
100% exact-match pinning. (b) Running fixture trees through the real
stdio server for everything — rejected for unit scope: the harness
seam exists for protocol tests; tree semantics test the pipeline entry
directly.

---

## R12: Parse-only degradation surface

**Decision**: With no usable tsconfig (parse-only context), the
mapping pipeline degrades precisely, never failing: import-graph
resolution and direct-call resolution fall back to lexical name
matching (R4's parse-only rules — module-specifier path resolution and
terminal-identifier matching; barrels uncrossable, edge case 7);
assertion detection is unchanged (the expect surface and the
assert-binding table are syntactic); the provenance passes are
unchanged (AST-level, mode-independent — edge case 1); pairing
confidences are unchanged (75 and 80 still emitted on lexical
evidence); row shape and ordering are unchanged. Documented
false-positive surfaces: local bindings or property names colliding
with production function names, and a bare `assert` import specifier
shadowed by a same-named local module. The quickstart demonstrates
the degradation (a no-tsconfig fixture tree producing rows with the
same confidences).

**Rationale**: The spec's philosophy pin (edge case 1, quoting spec
002 FR-004): degradation reduces precision, never availability. The
fallbacks are the minimal deterministic subsets of the checker-mode
rules, each documented where it can over-pair.

**Alternatives considered**: (a) Emitting no pairs in parse-only mode
— rejected: availability loss violating the philosophy pin.
(b) Downgrading confidences in parse-only mode (e.g. 80 → 70) —
rejected: the confidences are FR-004's fixed integers; mode-dependent
confidences would be a second, unpinned semantics dimension.
