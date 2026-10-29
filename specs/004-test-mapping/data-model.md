# Data Model: Test-to-Assertion Mapping (test_mapping)

**Feature Branch**: `004-test-mapping`

**Date**: 2026-10-29

**Status**: Normative for implementation. The matcher/assert
classification table (Section 4) is pinned data — implementation
transcribes it verbatim into `src/quality/matchers.ts` and a
conformance suite diffs the module against this section (the
routing-table anti-drift pattern).

Sources: [spec.md](spec.md) (FR-001 through FR-016, assumptions 1–17),
[research.md](research.md) (R1–R12), the wire precedent of
`src/signals/types.ts`, the serializer precedent of `src/models.ts`,
the taxonomy (`src/taxonomy.ts`), and the reference analyzer's
test-mapping semantics.

---

## 1. Overview

The mapping pipeline is one request-scoped pass over a project tree:

```text
test_mapping(root_path, patterns)
  │
  ├─ prepareAnalysis(root, patterns, { includeTestArm: true })
  │    resolveRoot → walkTree → screenCandidates → classifyFiles
  │    ├─ source arm ── pattern filter ──► inScopePaths (targets)
  │    ├─ test arm (FULL, unfiltered) ────► testPaths
  │    ├─ preRead(inScope ++ testPaths) → buildProgramContext
  │    │    (program root set = both arms; parse-only map = both arms)
  │    └─ extractFunctions → records narrowed to inScope (targets)
  │         ══ the identical analyze file set (FR-006) ══
  │
  ├─ detectEffects(targetRecords, context) ──► per-target effect sets
  │    (the same effect sets analyze reports)
  │
  ├─ collectTestFunctions(testPaths, context) ──► TestFunction[]
  ├─ pairTests(tests, targets) ──► Pairing[] (three strategies)
  ├─ collectAssertions(paired tests) ──► AssertionSite[] per pair
  ├─ inferSideEffectType(assertion, pair, effects) ──► canonical type
  └─ assemble rows → sort by the FR-013 key → serializeMappingRow
       ══ {"mappings": [...]} ══
```

Both arms flow through the one shared discovery/screen/bootstrap
pipeline (research R2); the program-mode context admits the test arm so
checker queries can resolve test-file imports and calls, while the
target records remain the in-scope source set exactly as `analyze`
reports it.

---

## 2. Wire record: `MappingRow`

One row per (paired test, assertion) — US1-2: a test with three
assertions yields three rows sharing target fields with distinct
`assertion_location` values. Field names are the wire spellings
(snake_case per the protocol payload contract; `src/quality/types.ts`
keeps TypeScript identifiers identical to the wire names, the
`FunctionRecord.side_effects` precedent).

| Field | Type | Constraint |
|---|---|---|
| `test_function` | `string` | The describe-qualified title (Section 5.1); possibly empty (non-static titles) |
| `test_file` | `string` | Root-relative POSIX path of the test file |
| `assertion_location` | `string` | `"<relPath>:<line>"` — the expect/assert call's 1-based line; no column component |
| `assertion_type` | `string` | Exactly one of `equality`, `comparison`, `membership`, `error_check`, `""` — never `generic`, never `null` |
| `target_function` | `string` | The target record's declared name |
| `target_package` | `string` | `derivePackage(targetRecord.relPath)` — the dotted module path |
| `side_effect_type` | `string` | One of the 48 canonical taxonomy names (aliases never emitted) |
| `confidence` | `number` | Integer in [0, 100] — the pairing strategy's fixed value (90 / 70 / 80 / 75) |

```typescript
export interface MappingRow {
  readonly test_function: string;
  readonly test_file: string;
  readonly assertion_location: string;
  readonly assertion_type: AssertionKind; // "" | "equality" | "comparison" | "membership" | "error_check"
  readonly target_function: string;
  readonly target_package: string;
  readonly side_effect_type: SideEffectType;
  readonly confidence: number;
}

export interface TestMappingResult {
  /** The rows in FR-013's stable-key order; `[]` for empty inputs — never an error. */
  readonly mappings: readonly MappingRow[];
}
```

**Serializer** (`serializeMappingRow`, `src/quality/types.ts`): the
`serializeSignal` house pattern — fail loud (Constitution I):
`assertion_type` membership in the closed five-value kind set
(including `""`); `side_effect_type` canonical membership through
`resolveSideEffectType` (a canonical name passes, anything else throws
— aliases are construction-time bugs that must not reach the wire);
`confidence` an integer in [0, 100]; every string field type-checked.
An empty analysis is a `{"mappings": []}` success (US1-8).

---

## 3. Assertion-type vocabulary

The closed kind set (FR-001/FR-008, spec assumptions 1–2):

| Kind | Denotation |
|---|---|
| `equality` | The assertion pins an exact value: `toBe` (documented strict equality / `Object.is`), structural equality, closeness, object-shape matching, with-argument mock forms |
| `comparison` | Ordered relations only: strictly the `toBeGreaterThan` / `toBeLessThan` families |
| `membership` | Containment and pattern matching: `toContain` family, `toMatch` |
| `error_check` | The assertion observes the error channel: `toThrow` family, every matcher under `.rejects`, `assert.throws` family |
| `""` | Recognized assertion, unclassified kind: property, truthiness, type, bare-occurrence, count, and snapshot forms; unknown or custom matchers |

Two deliberate divergences from the reference analyzer's six-value set:
no `generic` (the empty string is the unclassified convention — the
platform's assertion-detection metric counts rows carrying a recognized
type, so `""` feeds it exactly), and no `identity` (Python's `is`
bucket has no distinct vitest/jest analog — `toBe` is documented
strict equality and routes to `equality`).

Negation semantics (assumption 3): `.not.` and `not`-prefixed assert
functions preserve the underlying kind — the `comparison` kind denotes
ordered relations only, never inequality. `resolves`/`rejects`
(assumption 4): `.resolves.` preserves the matcher's kind; `.rejects.`
routes to `error_check` (the assertion is about the rejection channel).

---

## 4. Normative MatcherTable (pinned data)

FR-007 pins this table as normative data. `src/quality/matchers.ts`
transcribes it verbatim; `tests/quality/matchers.test.ts` diffs the
module against this section. The lookup is total: a form absent from
the table routes to `""` through the miss path — never an exception,
never a drop (US3-6).

### 4.1 `expect()` matchers

| Matcher | Kind |
|---|---|
| `toBe` | `equality` |
| `toEqual` | `equality` |
| `toStrictEqual` | `equality` |
| `toBeCloseTo` | `equality` |
| `toMatchObject` | `equality` |
| `toHaveBeenCalledWith` | `equality` |
| `toHaveBeenLastCalledWith` | `equality` |
| `toHaveBeenNthCalledWith` | `equality` |
| `toHaveReturnedWith` | `equality` |
| `toHaveLastReturnedWith` | `equality` |
| `toHaveNthReturnedWith` | `equality` |
| `toBeCalledWith` | `equality` (legacy jest alias) |
| `lastCalledWith` | `equality` (legacy jest alias) |
| `nthCalledWith` | `equality` (legacy jest alias) |
| `toBeGreaterThan` | `comparison` |
| `toBeGreaterThanOrEqual` | `comparison` |
| `toBeLessThan` | `comparison` |
| `toBeLessThanOrEqual` | `comparison` |
| `toContain` | `membership` |
| `toContainEqual` | `membership` |
| `toMatch` | `membership` |
| `toThrow` | `error_check` |
| `toThrowError` | `error_check` |
| `toThrowErrorMatchingSnapshot` | `error_check` |
| `toThrowErrorMatchingInlineSnapshot` | `error_check` |
| `toBeTruthy` | `""` |
| `toBeFalsy` | `""` |
| `toBeNull` | `""` |
| `toBeUndefined` | `""` |
| `toBeDefined` | `""` |
| `toBeNaN` | `""` |
| `toBeInstanceOf` | `""` |
| `toHaveBeenCalled` | `""` |
| `toHaveBeenCalledTimes` | `""` |
| `toHaveReturned` | `""` |
| `toHaveReturnedTimes` | `""` |
| `toBeCalled` | `""` (legacy jest alias) |
| `toBeCalledTimes` | `""` (legacy jest alias) |
| `toHaveProperty` | `""` |
| `toHaveLength` | `""` |
| `toMatchSnapshot` | `""` |
| `toMatchInlineSnapshot` | `""` |
| `toBeTypeOf` | `""` (vitest) |
| `toSatisfy` | `""` (vitest) |

**Modifier semantics** (applied to the invoked matcher's kind):

| Chain modifier | Effect |
|---|---|
| `.not.` anywhere in the chain | Preserves the matcher's kind |
| `.resolves.` | Preserves the matcher's kind |
| `.rejects.` | Routes to `error_check` regardless of matcher |
| any other intermediate property | Inert chain context (classification by the invoked matcher) |
| `await` wrapper | Transparent (US3-10: identical classification) |

An `expect(...)` chain with no matcher invocation is not an assertion
(US3-9). One row per matcher invocation (US3-10).

### 4.2 `node:assert` functions

Recognized through the file's import/require declarations with module
specifier exactly `node:assert`, `node:assert/strict`, or `assert`
(research R5). `node:assert/strict` changes call semantics, not
routing — the syntactic form routes identically.

| Assert form | Kind |
|---|---|
| `assert(value)` (bare) | `""` |
| `assert.ok` | `""` |
| `assert.ifError` | `""` |
| `assert.fail` | `""` |
| `assert.equal` / `assert.notEqual` | `equality` |
| `assert.strictEqual` / `assert.notStrictEqual` | `equality` |
| `assert.deepEqual` / `assert.notDeepEqual` | `equality` |
| `assert.deepStrictEqual` / `assert.notDeepStrictEqual` | `equality` |
| `assert.match` / `assert.doesNotMatch` | `membership` |
| `assert.throws` | `error_check` |
| `assert.doesNotThrow` | `error_check` |
| `assert.rejects` | `error_check` |
| `assert.doesNotReject` | `error_check` |

`not`-prefixed functions preserve their base kind (US3-7). An
unknown member call on an assert binding routes to `""`. The asserted
expression — provenance's subject — is the FIRST argument of every
assert form.

---

## 5. Internal types

### 5.1 `TestFunction` (src/quality/collect.ts)

| Field | Type | Notes |
|---|---|---|
| `title` | `string` | The invocation's first argument when a string literal or no-substitution template literal; `""` otherwise (never dropped, FR-002) |
| `qualifiedTitle` | `string` | Enclosing describe titles joined `" > "` outermost-to-innermost, then `title`; bare `title` at top level; empty segments join verbatim (FR-003) |
| `relPath` | `string` | Root-relative POSIX path of the test file |
| `describeTitles` | `readonly string[]` | The enclosing describe titles, outermost first (nearest for name pairing) |
| `callback` | `Node \| null` | The callback function-expression node — `null` when the callback argument is a reference, not a function expression (research R3) |
| `line` | `number` | 1-based line of the `it`/`test` invocation |
| `index` | `number` | 0-based source-order index within the file |

Collection rules (FR-002, research R3): the callee root — after
unwrapping intermediate calls (`it.each(table)(title, fn)`) — is an
identifier `it`/`test` or a property chain rooted at one (modifier set
open); the callback is the last function-expression argument; describe
callbacks are containers (title-stack walk); `bench` and the four
hooks are excluded by root; non-static titles collect as `""`.

### 5.2 `AssertionSite` (src/quality/assertions.ts)

| Field | Type | Notes |
|---|---|---|
| `kind` | `AssertionKind` | The classified kind or `""` (Section 4) |
| `line` | `number` | 1-based line of the `expect(` / assert call — the `assertion_location` anchor |
| `character` | `number` | 0-based column of the call — the row-order tie-break |
| `assertedExpression` | `Node \| null` | The provenance subject: `expect(...)`'s first argument, or the assert call's first argument; `null` when absent |
| `argumentSubtree` | `Node` | Pass 4's scan domain, pinned precisely: for expect chains, the invoked matcher invocation's `CallExpression` (its subtree spans both the `expect(...)` call's arguments and the matcher's own arguments — `expect(list).toContain(target(item))` scans `list` and `target(item)` alike); for `node:assert` forms, the assert call's full argument list |
| `expectChain` | `boolean` | `true` for expect-rooted forms, `false` for node:assert |

Collection scope: the paired test's callback subtree INCLUDING nested
function expressions (FR-007); hooks and describe-scope statements are
structurally outside (assumption 13). One site per matcher invocation;
expect chains with no matcher invocation collect nothing.

### 5.3 `Pairing` (src/quality/pairing.ts)

| Field | Type | Notes |
|---|---|---|
| `test` | `TestFunction` | Reference identity into the collector's output |
| `target` | `ExtractionRecord` | Reference identity into `prepareAnalysis`'s narrowed records |
| `strategy` | `"naming" \| "calls" \| "imports"` | The producing strategy |
| `confidence` | `90 \| 70 \| 80 \| 75` | The strategy tier's fixed integer |

### 5.4 `TargetIndex` (src/quality/pairing.ts)

The pairing-support view over the prepared analysis — built once per
pipeline run, consumed by all three strategies:

| Field | Type | Notes |
|---|---|---|
| `records` | `readonly ExtractionRecord[]` | The in-scope source records in `(file, line, name)` order (the identical `analyze` set) |
| `byName` | `ReadonlyMap<string, readonly ExtractionRecord[]>` | Name → records, for the naming strategy and parse-only matching |
| `byNode` | `ReadonlyMap<Node, ExtractionRecord>` | Declaration node → record, for checker-mode symbol-declaration matching |
| `effects` | `ReadonlyMap<ExtractionRecord, readonly Effect[]>` | `detectEffects`' output — the inference layer's effect sets |
| `context` | `ProgramContext` | Live during pairing (checker queries); the handler owns disposal |

### 5.5 Provenance inputs (src/quality/inference.ts)

Pass evaluation carries the pair's `TestFunction` (for the pass-2
local-binding search over the test callback's body), the
`AssertionSite`, the `TargetIndex` entry (record + effects), and the
test file's file-local helper table (pass 3's bridge domain:
file-scope declared functions and const-bound function expressions).
No separate wire-visible type — the passes return a `boolean` match;
the caller applies Section 7's selection rules.

---

## 6. Pairing strategies and ordering

Fixed priority per test function, first-match-wins (FR-004, US2-7):
evaluation stops at the first strategy with any match; only that
strategy's pairs are emitted.

| Priority | Strategy | Match rule | Confidence |
|---|---|---|---|
| 1 | naming (exact) | Test title OR nearest enclosing describe title equals a target name (case-sensitive) | `90` |
| 1 | naming (case-insensitive) | Same comparison, case-insensitive-only (`toLowerCase` on both sides — platform-stable, no locale fold) | `70` |
| 2 | calls | The test's callback subtree contains a call resolving to the target — checker mode: callee symbol's declaration matches the target node; parse-only: callee terminal identifier text equals the target name | `80` |
| 3 | imports | The test file statically imports the target (checker: specifier symbol → declaring function, re-exports followed; parse-only: specifier path + name resolution) AND the binding is referenced outside the import clause (lexical identifier scan, both modes) — every still-unpaired test in the file pairs | `75` |

**Parse-only specifier containment** (FR-004, Constitution V):
parse-only import resolution is a pure lookup — a module specifier is
resolved against the test file's directory using the walk's six
extensions and `index` files ONLY as key computations over the
discovered in-root file set (keyed by root-relative path); a candidate
path that escapes the resolved root resolves to nothing, and
resolution MUST NOT access the filesystem beyond the discovered set —
file paths are resolved and checked for traversal at point of use,
never probed.

Within the naming strategy, the exact tier shadows the
case-insensitive tier per test (a test matching one target exactly and
another case-insensitively emits only the exact pair — research R4).

**Pair ordering and dedup** (FR-005): when a strategy matches multiple
targets, each distinct `(target_package, target_function)` pairs,
ordered by the analyze record order `(file, line, name)`
(`compareFileLineName`). Pairing is idempotent per (test function,
target record): no duplicate `(test_function, test_file,
target_package, target_function)` pair exists (the reference
analyzer's landed key) — per-test first-match-wins plus
record-ordered distinct-target emission make duplicates structurally
impossible. Wire tuples narrower than the pair key legitimately
collide and are not uniqueness violations: same-named targets across
different packages collide on `(test_function, test_file,
target_function)` and are disambiguated by `target_package` in the
pair key; same-titled sibling tests inside one `describe` (spec edge
case 2) collide on `test_function` itself and their rows are
disambiguated by `assertion_location`. A test matched by no strategy
produces no pairs and no rows — never confidence-0 rows (US1-3).

**Arm scoping** (FR-006): targets are the pattern-filtered,
exclusion-screened source arm (the identical `analyze` file set);
tests are collected over the FULL exclusion-screened test arm —
`patterns` narrow the target arm only (assumption 9). Generated and
skipped files are excluded from both arms by the existing screening.

---

## 7. Effect-type inference

Selection is two-layered over the target's effect type set
(`TargetIndex.effects`, the same sets `analyze` reports):

### 7.1 Error rows (`assertion_type === "error_check"`, FR-009)

By assertion type alone — never provenance:

```text
ErrorReturn if present, else ErrorSignal if present, else ErrorReturn
```

### 7.2 Value rows (`equality`, `comparison`, `membership`, `""`)

**Standard fallback chain** (FR-010 — the reference's final
semantics, generator-aware from the start):

```text
ReturnValue if present
  else the target's first P0 effect in effect-array order
  else GeneratorYield if present
  else AsyncGeneratorYield if present
  else ReturnValue            (the total fallback — US1-7)
```

P0 membership reads `TIER_MAP` (the six P0 types). "First P0 effect"
is the first P0-typed effect in the record's effect array —
`detectEffects`' deterministic source-order emission makes the pin
stable.

**Provenance passes** (FR-011, research R7) — run in fixed order over
the asserted expression (first argument); the first succeeding pass
establishes provenance:

| Pass | Rule |
|---|---|
| 1. Direct identity | The asserted expression is exactly a call resolving to the paired target |
| 2. Indirect root resolution | The asserted expression's root identifier (leftmost identifier, `await` transparent) is locally bound IN THE TEST FUNCTION by a declarator whose initializer is a direct call to the target — `await` wrappers and destructuring patterns (`const { items } = target()`, `const [first] = target()`) transparent |
| 3. Helper function bridging | The root resolves through a single file-local helper — the asserted expression's root is a call to a file-scope function whose returned value derives from a direct call to the target (`return [await] target(...)`, or an expression-bodied arrow) |
| 4. Inline call matching | A call resolving to the target appears inline within the assertion's argument subtree — the invoked matcher invocation's full `CallExpression` subtree for expect chains, the assert call's full argument list for `node:assert` forms (Section 5.2's `argumentSubtree` pin) |

When provenance is established AND the target carries a return-family
effect, `side_effect_type` is the first present of `ReturnValue` →
`GeneratorYield` → `AsyncGeneratorYield` (US4-1). When provenance
succeeds but no return-family effect is present, the standard chain
governs (US4-7 — provenance only reorders the return family ahead of
it). When no pass succeeds, the standard chain governs (US4-6).

**Conservative boundaries** (US4-8): provenance MUST NOT cross nested
functions other than the single pass-3 helper bridge (pass 2 searches
the test function's own locals — a binding in a describe scope or an
inner closure does not qualify); MUST NOT follow alias chains (a
declarator whose initializer is a bare identifier reference — `const
b = a` — never qualifies, `const` and `let` alike); MUST NOT cross
control-flow merges (only declarator initializers qualify — a `let`
assigned inside `if`/loop branches is structurally unreachable).
Unsupported provenance falls back deterministically rather than
guessing.

Out of scope (assumption 12): the reference's container-mutation
refinement (mapping membership/size/subscript observations of returned
containers to `ContainerMutation`) is deferred — inference covers the
return family and the fallback chains only.

---

## 8. Row ordering and location formats

**Row order** (FR-013) — the stable key, compared in order:

```text
(test_file, test_function, target_package, target_function,
 assertion line, assertion character)
```

String keys compare in UTF-16 code-unit order (JavaScript's default
`<`) — code-unit order, not code-point order; the two differ for
astral characters (surrogate pairs), and code-unit order is the pinned
comparator. Line and character compare numerically. One row per
(paired test, assertion). The stable key is not injective by
construction: two matcher invocations on one expect chain (US3-10)
share the chain's single call anchor — identical assertion line AND
character — so distinct rows can tie on the full key. The pinned final
tie-break is a stable sort over the deterministic AST-walk collection
order: rows tied on the key emit in the assertion-collection order of
the source walk (matcher invocations in source order within the
chain), preserving byte-identical repeat responses (Constitution I).

**Location formats**: `assertion_location` is
`"<relPath>:<line>"` — root-relative POSIX path, 1-based line of the
`expect(` / assert call, no column (US1-1). `test_file` is the
root-relative POSIX path. Both derive from the same discovery
spellings every other method reports.

**Determinism** (Constitution I, research R10): the pipeline is a
pure function of the analyzed tree and analyzer version; every emitted
collection is explicitly sorted before assembly; confidences and the
matcher table are fixed data; golden tests pin byte-identical repeat
responses including a full second pipeline run.

---

## 9. Key relationships and invariants

1. **Target parity** (FR-006): `TargetIndex.records` ≡ the records
   `analyze(root, patterns)` reports over the same tree — asserted by
   the widening-parity test (research R11 rung 5), structural through
   the shared `prepareAnalysis` narrowing.
2. **One pipeline** (FR-012): discovery, screening, bootstrap, and
   extraction exist once (`prepareAnalysis`); the mapping pipeline
   composes them with the opt-in test-arm widening — no second walk.
3. **Row totality per pair** (FR-001): every collected assertion of a
   paired test yields exactly one row; zero-assertion paired tests
   yield none (US3-8); unpaired tests yield none (US1-3).
4. **Inference totality** (FR-009/FR-010): every row carries a
   canonical `side_effect_type` — the fallback chains terminate in a
   fixed final value for every effect-set shape, including the empty
   set (US1-7).
5. **Confidence sharing** (assumption 17): every assertion row from
   one pair shares the pair's strategy confidence; there is no
   per-assertion confidence.
6. **Kind totality** (FR-007/FR-008): every expect matcher invocation
   and recognized assert call classifies to a kind or `""` — the
   table's miss path is total.
7. **Static analysis only** (FR-012, Constitution V): test files are
   parsed by the compiler API inside the bounded hermetic host, never
   executed or imported — pinned by canary fixtures.
8. **Capability coupling** (FR-014): the dispatch registration and
   the `initialize` flag flip land in the same change; the reserved
   `-32601` set is exactly `{analyze/stream, doc_coverage,
   cognitive_complexity}`.

---

## 10. Verification checkpoints

| Checkpoint | Pin | Suite |
|---|---|---|
| Matcher table doc parity | Section 4 diffed against `src/quality/matchers.ts` | `tests/quality/matchers.test.ts` |
| Exact rows per strategy | 90/70/80/75, first-match-wins, multi-target order, no duplicate pairs (SC-004) | `tests/quality/pairing.test.ts` |
| Assertion classification | One row per matcher invocation; every kind, negated, awaited, resolves/rejects, node:assert forms; no-matcher chains collect nothing (SC-002) | `tests/quality/assertions.test.ts` |
| Assertion-coverage profiles | Zero/partial/full fixtures produce exactly the expected row sets (SC-002) | `tests/quality/pipeline.test.ts` |
| Provenance passes | One fixture per pass pinning `side_effect_type`; generator targets; error family; fallback fixtures (SC-003) | `tests/quality/inference.test.ts` |
| Collection rules | Modifiers, each-forms, describe qualification, non-static titles, hooks excluded, identity collisions (edge cases 2–5) | `tests/quality/collect.test.ts` |
| Serializer validation | Closed kind set, canonical types, integer confidence | `tests/quality/types.test.ts` |
| Target parity | Widened `prepareAnalysis` yields `analyze`'s records; flag-off unchanged | `tests/analysis.test.ts` |
| Protocol conformance | Capability flag, shrunk reserved set, shared `-32602` table, `{"mappings": []}` on empty inputs (SC-005) | `tests/server.test.ts` |
| Determinism | Byte-identical repeat responses over a second full pipeline run (US1-6, SC-005) | `tests/quality/pipeline.test.ts` |
| Static-analysis safety | Throwing-module canary inside the resolved import graph | `tests/quality/pipeline.test.ts` |
| Parse-only degradation | Lexical matching, barrels uncrossed, confidences unchanged | `tests/quality/pipeline.test.ts` |
