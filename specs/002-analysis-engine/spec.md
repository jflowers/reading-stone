# Feature Specification: Analysis Engine (analyze, complexity, coverage)

**Feature Branch**: `002-analysis-engine`

**Created**: 2026-10-27

**Status**: Draft

**Input**: User description: "Implement the core analysis engine: side-effect detection (`analyze`), cyclomatic complexity (`complexity`), and coverage parsing (`coverage`)."

**Originating issue**: [zero-dot-force/reading-stone#3](https://github.com/zero-dot-force/reading-stone/issues/3) — Side-effect detection, complexity, and coverage parsing (analyze, complexity, coverage methods). Depends on #1 (protocol alignment, complete) and #2 (discovery and shared analysis, complete); unblocks #4 (classification signals) and #6 (test mapping).

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Detect function side effects over `analyze` (Priority: P1)

As Gaze (the consuming platform), when I send an `analyze` request carrying a project root and optional path patterns, I receive one record per analyzed function — name, package, file, declaration line — with every observable side effect attributed to it using the platform's 48-type canonical taxonomy, so that my scoring engine can compute CRAP, GazeCRAP, and quadrants from accurate effect data.

**Why this priority**: Side-effect detection is the analyzer's core value proposition — every downstream Gaze metric depends on it. It is the largest and most constitution-sensitive slice (Principle II governs detection accuracy), and the other two analysis methods are independently shippable without it.

**Independent Test**: Can be fully tested by analyzing fixture trees whose functions exhibit known effects and asserting the exact returned records — correct canonical types, locations, and targets — with zero false negatives and zero false positives for the P0 tier, plus golden byte-identical response tests. No other new feature is required.

**Acceptance Scenarios**:

1. **Given** one fixture per P0 taxonomy type (`ReturnValue`, `ErrorReturn`, `SentinelError`, `ReceiverMutation`, `PointerArgMutation`, `ErrorSignal`), **When** `analyze` runs against the fixture tree, **Then** each fixture function reports exactly its expected P0 effect (correct type, correct `file:line:col` location, correct target) and nothing else — zero false negatives and zero false positives across the P0 fixture suite.
2. **Given** pure functions (no returns of values, no throws, no mutations, no I/O), **When** analyzed, **Then** their records carry empty `side_effects` arrays.
3. **Given** functions using dynamic constructs the analyzer cannot resolve (`eval`, `new Function`, dynamically-dispatched calls on untyped receivers), **When** analyzed, **Then** an effect carrying the ambiguity marker (see FR-017) is reported — never silently omitted (Constitution Principle II).
4. **Given** the same input tree analyzed twice by the same analyzer version and protocol version, **When** both serialized responses are compared byte-for-byte, **Then** they are identical (Constitution Principle I).
5. **Given** any reported effect, **When** inspected, **Then** its `type` is one of the 48 canonical taxonomy names (aliases are resolved before construction, never emitted), and it carries no `classification` field.
6. **Given** a tree containing test files and generated files, **When** analyzed, **Then** no function declared in them appears in the response.
7. **Given** an `analyze` request whose `patterns` restrict analysis to a subtree, **When** handled, **Then** only functions from in-scope files are reported; a pattern set matching nothing yields an empty `functions` array, not an error.

---

### User Story 2 - Bootstrap TypeScript programs with the compiler API (Priority: P2)

As the detector, I bootstrap analysis context from the analyzed project itself — a discovered `tsconfig.json` drives a `ts.Program` with `ts.TypeChecker`; projects without a usable tsconfig fall back to per-file parsing — so that detection uses TypeScript's own semantics, works with the project's code as it exists, and never fails because the analyzed code has type errors.

**Why this priority**: The bootstrap is the foundation the detector and complexity engine build on (Constitution Principle III), but it has no standalone protocol surface — its value is realized through the analysis methods, so it ranks below `analyze` itself.

**Independent Test**: Can be fully tested by unit-testing the bootstrap against fixture trees with a valid tsconfig, no tsconfig, an invalid tsconfig, and type-erroring code, asserting program construction, fallback behavior, and completion without error.

**Acceptance Scenarios**:

1. **Given** a tree with a valid `tsconfig.json` at the root, **When** analysis runs, **Then** a `ts.Program` with a `ts.TypeChecker` is bootstrapped from the tsconfig's compiler options and covers every in-scope discovered file.
2. **Given** a tree with no `tsconfig.json`, **When** analysis runs, **Then** each in-scope file is analyzed from its own parsed source file (parse-only mode) and the request completes normally with results.
3. **Given** a tree whose code contains type errors, **When** analysis runs, **Then** analysis proceeds on syntactic structure — semantic diagnostics never abort the request.
4. **Given** in-scope `.js`/`.jsx`/`.mjs`/`.cjs` files, **When** analysis runs, **Then** their functions are analyzed and reported — JavaScript-family sources are never silently skipped (Constitution Principle III).
5. **Given** a tree with an unparseable `tsconfig.json`, **When** analysis runs, **Then** the parse-only fallback is used and the request completes normally (a broken tsconfig degrades precision, never availability).
6. **Given** projects in strict or non-strict mode with no analyzer-specific configuration, **When** analyzed, **Then** analysis works on the code as it exists — no annotation, restructuring, or configuration is required of the analyzed project.

---

### User Story 3 - Compute cyclomatic complexity over `complexity` (Priority: P2)

As Gaze, when I send a `complexity` request, I receive one entry per analyzed function with its cyclomatic complexity computed by a fixed, documented rule — 1 plus the count of decision points — so that CRAP scoring has a deterministic complexity input that matches the same function set `analyze` reports.

**Why this priority**: Complexity is a required protocol method and one of the two inputs (with coverage) to CRAP scoring, but it is a smaller, self-contained computation than effect detection.

**Independent Test**: Can be fully tested by analyzing fixture functions with known decision-point counts and asserting the exact returned complexity values, plus a golden byte-identical response test.

**Acceptance Scenarios**:

1. **Given** a function containing decision points from the closed list (FR-021), **When** complexity is computed, **Then** the value is exactly 1 plus the number of decision points in the function's own body.
2. **Given** a function with an empty body, **When** complexity is computed, **Then** the value is 1.
3. **Given** a function containing a nested extracted function with its own decision points, **When** complexity is computed, **Then** the nested function's decision points count toward the nested function's entry only, not the enclosing function's.
4. **Given** a `complexity` response, **When** inspected, **Then** entries carry exactly `name`, `package`, `file`, `line`, and `complexity`, cover the same function extraction set as `analyze` over the same request, and are deterministically ordered.
5. **Given** the same tree analyzed twice, **When** responses are compared byte-for-byte, **Then** they are identical.

---

### User Story 4 - Parse coverage data over `coverage` (Priority: P2)

As Gaze, when I send a `coverage` request, I receive per-function statement coverage derived from the project's existing Istanbul-format coverage artifact, so that CRAP scoring can combine complexity with coverage — and when no usable artifact exists, I receive an empty result rather than an error.

**Why this priority**: Coverage is a required protocol method and the second CRAP input, but it consumes pre-existing artifacts rather than performing analysis itself, making it independent of the detector's fate.

**Independent Test**: Can be fully tested with fixture coverage documents (both vitest- and jest-emitted) plus missing and invalid files, asserting exact attribution results and the empty-result fallbacks.

**Acceptance Scenarios**:

1. **Given** a valid vitest-emitted `coverage-final.json` under the project's `coverage/` directory, **When** `coverage` is called, **Then** one entry per covered function is returned with `covered_stmts`, `total_stmts`, and `percentage` computed by statement attribution to the enclosing function range (FR-023).
2. **Given** a valid jest-emitted `coverage-final.json`, **When** `coverage` is called, **Then** the same attribution produces correct entries — both emitters' documents are supported.
3. **Given** no coverage file at the conventional location, **When** `coverage` is called, **Then** the result is `{"functions": []}` and no error is returned.
4. **Given** an unreadable, unparseable, or structurally invalid coverage file, **When** `coverage` is called, **Then** the result is `{"functions": []}` and no error is returned.
5. **Given** a parseable coverage document in which some individual file entries are non-conforming, **When** `coverage` is called, **Then** the conforming entries are reported and the non-conforming entries are skipped deterministically.
6. **Given** a `coverage` request with `patterns`, **When** handled, **Then** returned entries are filtered by the same path-prefix rules as `analyze`.
7. **Given** statements inside a nested function's range, **When** attributed, **Then** they count toward the innermost enclosing function only.

---

### User Story 5 - Document the TypeScript effect disposition (Priority: P3)

As a maintainer of reading-stone and of future platform analyzers, I have a complete disposition table recording, for each of the 48 canonical taxonomy types, whether and how TypeScript detection covers it — with rationale for every type declared N/A — so that detection coverage is transparent, reviewable, and conformance-tested against the taxonomy.

**Why this priority**: The table records and constrains decisions the detector makes, but the detector functions without it; the table's value is transparency and drift prevention, which ranks below working analysis.

**Independent Test**: Can be fully tested by a conformance test asserting the table covers all 48 canonical types exactly once, every disposition is from the closed set, and every N/A row carries non-empty rationale.

**Acceptance Scenarios**:

1. **Given** `docs/effect-disposition.md`, **When** inspected, **Then** all 48 canonical types appear exactly once, each with its tier, disposition, TypeScript mapping, and rationale; every `N/A` disposition carries a non-empty rationale.
2. **Given** the table and the shipped taxonomy, **When** the conformance test runs, **Then** the table's type set matches the 48 canonical names exactly — no drift, no gaps.

---

### Edge Cases

- **Parameter validation**: `params` not an object, `root_path` missing or not a string, `patterns` present but not an array of strings, or `params` carrying keys other than `root_path`/`patterns` → the request fails with `-32602` (FR-027).
- **Root validation**: a `root_path` that does not exist, is not a directory, or cannot be accessed → `-32602` with the same shared message as `discover` (FR-027).
- **Patterns matching nothing**: empty `functions` arrays, never an error.
- **Empty tree**: a root with no in-scope source files → `{"functions": []}` for all three methods.
- **Unparseable source file**: the TypeScript parser is error-tolerant; analysis proceeds on the recovered syntax tree and parse diagnostics are ignored (the file is never dropped for failing to parse).
- **Function overloads**: only the overload *implementation* (the declaration with a body) is extracted; body-less overload signatures contribute no records (and no complexity entries).
- **Body-less declarations**: interface method signatures, ambient `declare function`, and abstract method declarations have no bodies and are not extracted.
- **Anonymous default export**: `export default function () {}` (or an arrow/function expression as default export) is extracted and named `"default"`.
- **Accessors**: a getter and setter for the same property yield two records, both named by the property, distinguished by declaration line.
- **Class-property function initializers**: `handler = () => {...}` on a class is extracted and named by the property.
- **Inline anonymous function expressions** (call arguments, IIFEs, unassigned expressions): not extracted as separate records; their bodies are scanned as part of the innermost enclosing extracted function (FR-009 convention). At module level — no enclosing extracted function — such effects have no carrier record and are unreported in v1.
- **Module-level statements**: effects of top-level code (including side-effectful imports) attach to no function record in v1, mirroring the reference analyzer's function-record scope; only module-level sentinel declarations are attached (FR-013).
- **Coverage entries outside the root**: file keys in the coverage document that do not resolve under the analysis root are skipped.
- **Function with zero statements**: `total_stmts` 0 and `percentage` 0.0 — never a division error.
- **Anonymous coverage names**: fnMap names such as `(anonymous_0)` are passed through verbatim as the `function` field.
- **Empty coverage document**: `{}` → `{"functions": []}`.
- **Array property carve-out**: writing `p.length = 0` on an array-typed parameter is a `SliceMutation` (array truncation), not a `PointerArgMutation`.
- **Parse-only precision**: without a TypeChecker, computed-key writes on parameters default to `MapMutation` and receiver-arrays are inferred syntactically — a documented false-positive surface acceptable at P1 (FR-015).
- **Reserved methods**: after this change, `test_mapping`, `classify_signals`, `analyze/stream`, `doc_coverage`, and `cognitive_complexity` still answer `-32601`.

---

## Requirements *(mandatory)*

### Functional Requirements

**Analysis scope**

- **FR-001**: The `analyze`, `complexity`, and `coverage` methods MUST accept params carrying `root_path` (string, required) and `patterns` (array of strings, optional). `patterns` MUST be treated as path prefixes relative to `root_path`: absent, `null`, empty, or the catch-all forms `["./..."]`/`["..."]` mean the whole tree; each other pattern is normalized by stripping a leading `./` and a trailing `/...` into a directory prefix; a file is in scope when its root-relative POSIX path equals a prefix or begins with `prefix + "/"`; multiple patterns union; a pattern set matching no files yields empty results, never an error.
- **FR-002**: The in-scope file set MUST be produced by the existing discovery walk and exclusion chain (pruned directories, `.d.ts` exclusion, generated-marker exclusion, safe-read skips), with test-classified files additionally excluded from analysis — test files and generated files MUST NOT be analyzed by any of the three methods.

**Program bootstrap**

- **FR-003**: When a valid `tsconfig.json` exists at the resolved analysis root, the system MUST bootstrap a `ts.Program` with `ts.TypeChecker` from its compiler options, constructed so that every in-scope discovered file is covered by the program (Constitution Principle III — the compiler's own semantics, not a reimplementation).
- **FR-004**: When no `tsconfig.json` exists at the root, or the discovered one is unparseable, the system MUST fall back to parse-only analysis: each in-scope file is parsed with `ts.createSourceFile` and analysis proceeds on syntactic structure. The fallback MUST NOT be reported as an error.
- **FR-005**: Type errors in analyzed code MUST NOT abort analysis: semantic diagnostics are ignored and analysis proceeds on syntactic structure; a request never fails because the analyzed project does not type-check.
- **FR-006**: In-scope JavaScript-family files (`.js`, `.jsx`, `.mjs`, `.cjs`) MUST be analyzed with the same extraction and detection as TypeScript files — never silently skipped — with compiler options adjusted as needed (for example `allowJs`) to guarantee their analyzability.

**Function extraction**

- **FR-007**: The system MUST extract function records for: function declarations (with bodies); class methods, constructors, and accessors; object-literal methods and function-valued properties; and arrow/function expressions assigned to variables or class properties. Nested extracted function-likes inside another function's body MUST be separate records.
- **FR-008**: Record identity MUST follow: the declared name for declarations and methods; the variable/property name for assigned expressions; `"constructor"` for constructors; the property name for accessors; `"default"` for default-export-assigned anonymous functions. Records MUST be deterministically ordered by `(file, line, name)`.
- **FR-009**: Effects and decision points MUST be attributed to the innermost enclosing extracted function. Bodies of anonymous function expressions outside the extraction set (inline callbacks, IIFEs) MUST be scanned as part of the enclosing extracted function — a documented attribution convention mirroring the reference analyzer's lambda handling — with the deferred-callback false-positive caveat recorded in the disposition table.

**Effect detection**

- **FR-010**: Detection precision MUST meet the tier requirements of the platform taxonomy: the six P0 types MUST be detected with zero false negatives and zero false positives on the conformance fixtures; the eleven P1 types MUST be detected wherever they occur, with documented false positives acceptable; the TS-native subset of the sixteen P2 types SHOULD be detected (partial acceptable); P3/P4 types are best effort (MAY).
- **FR-011** (`ReturnValue`): A function that returns a value — a `return` statement carrying an expression, in any function form including arrow expression bodies — MUST report `ReturnValue`; a bare `return;` MUST NOT (zero false positives).
- **FR-012** (throw split): A `throw` statement MUST report both `ErrorSignal` and `ErrorReturn` (dual emission — the protocol's own mapping lists the exception mechanism under both, and the reference analyzer dual-emits; omitting either would be a false negative). `Promise.reject(...)` and a `throw` inside an `async` function (the rejection channel) MUST report the same dual emission. `process.exit(...)` MUST report `ProcessExit` plus `ErrorSignal` and MUST NOT report `ErrorReturn` (terminal signal, not a caller-visible error return).
- **FR-013** (`SentinelError`): Module-scope declarations of Error subclasses (`class X extends Error`) and module-scope Error-instance constants (`const e = new Error(...)` and subclasses) MUST report `SentinelError`, attached to the file's first function record in source order (deterministic; the platform precedent for declaration-site effects) — or to no record when the file declares no functions.
- **FR-014** (receiver and global writes): Writes targeting `this` (`this.x = v`, `this[k] = v`, compound writes, `delete this.x`) MUST report `ReceiverMutation`. Writes from inside a function to a module-scope binding MUST report `GlobalMutation`; writes to an enclosing *function*-scope binding are closure captures (`ClosureCaptureMutation`, P4 best effort) and MUST NOT be reported as `GlobalMutation`.
- **FR-015** (param-write split): Writes on parameters MUST be classified by form and resolved type — dot-property writes → `PointerArgMutation`; element writes and mutating array methods (`push`, `pop`, `shift`, `unshift`, `splice`, `sort`, `reverse`, `fill`, `copyWithin`) on array-typed parameters (including `p.length = 0`) → `SliceMutation`; computed-key writes on record/object parameters and `Map.set(k, v)` on Map-typed parameters → `MapMutation`; remaining membership-container methods (`Set.add/delete/clear`, `Map.delete/clear`, `WeakSet.add/delete`, `WeakMap.set/delete`) → `ContainerMutation`. In parse-only mode (no type information), computed-key writes default to `MapMutation` — a documented false-positive surface acceptable at P1.
- **FR-016** (async spawn): Constructs that spawn concurrent tasks — `new Promise(...)`, `setTimeout`, `setInterval`, `queueMicrotask`, `process.nextTick` — MUST report the canonical `GoroutineSpawn` (detection matches the language-neutral `AsyncTaskSpawn` alias and resolves it through the taxonomy before constructing the record; the alias is never emitted).
- **FR-017** (ambiguity rules): When detection cannot determine an effect with confidence — `eval(...)`, `new Function(...)`, calls through computed members, calls on `any`-typed or unresolvable receivers — the analyzer MUST report an effect (carrier type `CallbackInvocation`, `detail` carrying `{"confidence": "ambiguous"}`, description naming the unresolved construct) rather than omitting it (Constitution Principle II). Calls that resolve to known-pure targets (locally-defined functions, resolved pure callees) MUST NOT be reported (the zero-false-positive carve-out). The `detail.confidence` marker is the pre-#4 ambiguity signal; classification labels land in issue #4.
- **FR-018**: Every reported effect MUST use a canonical taxonomy name — detection code MUST resolve alias spellings through the taxonomy resolver before constructing records (spec 001 FR-012); no local type names, no alias emission (Constitution Principle I).
- **FR-019**: Effects MUST NOT carry a `classification` field in this change. Field omission is wire-equivalent to the protocol's `classification: null` (the consumer treats absent and null identically and falls back to tier defaults); the established omit-unset-optionals rule (spec 001 FR-013) prohibits emitting `null`. Classification labels arrive with issue #4.

**`analyze` response**

- **FR-020**: The `analyze` result MUST be `{"functions": [...]}` — an array of serialized function records (`name`, `package`, `file`, `line`, `side_effects` per the spec 001 models) — and MUST be deterministic: stable record order (FR-008), stable effect order within a record (a documented deterministic sort), and byte-identical serialization across repeated analyses of the same tree by the same analyzer version (Constitution Principle I).

**Cyclomatic complexity**

- **FR-021**: Cyclomatic complexity MUST equal 1 plus the count of decision points in the function's own body, where decision points are exactly: `if` (each `else if` is a nested `if`), `for`, `for-of`, `for-in`, `while`, `do`, each `case` clause (`default` excluded), `catch`, conditional (ternary) expressions, and the binary logical operators `&&`, `||`, `??`. The list is closed: logical-assignment operators (`&&=`, `||=`, `??=`) are not counted (documented exclusion).
- **FR-022**: The `complexity` result MUST be `{"functions": [...]}` with entries carrying exactly `name`, `package`, `file`, `line`, and `complexity` (integer ≥ 1), over the same extraction set, scope, and ordering as `analyze` (FR-007/FR-008), and MUST be deterministic (byte-identical repeat responses).

**Coverage**

- **FR-023**: The coverage parser MUST read the Istanbul-format `coverage-final.json` at `<root>/coverage/coverage-final.json` and, per file entry, attribute each statement in `statementMap` to the innermost function in `fnMap` whose `loc` range contains the statement's start; `covered_stmts` counts attributed statements with execution count > 0 in `s`, `total_stmts` counts all attributed statements, and `percentage` is `(covered / total) * 100` — exactly `0.0` when `total_stmts` is 0.
- **FR-024**: The `coverage` result MUST be `{"functions": [...]}` with entries carrying exactly `file` (root-relative POSIX path), `function` (fnMap name verbatim, including anonymous forms), `start_line` (declaration start line), `end_line` (body end line), `covered_stmts`, `total_stmts`, and `percentage`; entries for files not under the resolved root MUST be skipped; `patterns` filter entries by the FR-001 prefix rules; entries are deterministically ordered by `(file, start_line, function)`.
- **FR-025**: An absent, unreadable, unparseable, or structurally invalid coverage file MUST yield `{"functions": []}` — never a JSON-RPC error. This resolves the protocol's "the analyzer is responsible for running tests and collecting coverage internally" wording against Constitution Principle V (never execute analyzed code): reading-stone never runs the analyzed project's tests; it consumes the pre-existing Istanbul artifact the project's own test run produced, and reports empty coverage when no artifact exists. Documented as the constitution's required conflict-resolution record (see Assumptions).
- **FR-026**: Within a parseable coverage document, individual non-conforming file entries MUST be skipped deterministically while conforming entries are reported (per-entry tolerance; the document is not rejected wholesale).

**Server wiring**

- **FR-027**: The dispatch layer MUST register `analyze`, `complexity`, and `coverage` handlers. Each MUST reject with `-32602`: non-object `params`, missing or non-string `root_path`, `patterns` present but not an array of strings, or `params` carrying keys other than `root_path`/`patterns`; and MUST reject a `root_path` that does not exist, is not a directory, or cannot be accessed with `-32602` (same shared message as `discover`). Analyzer-internal failures remain `-32603` with a stderr stack trace.
- **FR-028**: The `initialize` capability response MUST remain unchanged — `discover: true`, the other five flags `false` — because protocol v1.2.0 does not gate the core methods (`analyze`, `complexity`, `coverage`) behind capability flags. The reserved `-32601` set shrinks to `test_mapping`, `classify_signals`, `analyze/stream`, `doc_coverage`, `cognitive_complexity`.

**Dependency and documentation**

- **FR-029**: The `typescript` package MUST move from `devDependencies` to `dependencies` (no version change). Dependency-necessity justification (Constitution Principle V / Principle III): the TypeScript compiler API is the analysis engine itself — `ts.createSourceFile`, `ts.Program`, and `ts.TypeChecker` are required at runtime when Gaze spawns the analyzer; it is not a new dependency, but the runtime promotion of an existing one, and no smaller-surface alternative provides TypeScript semantics.
- **FR-030**: `docs/effect-disposition.md` MUST record, for each of the 48 canonical types, its tier, disposition (`strict` for P0, `must` for P1, `partial` for P2, `best-effort` for P3/P4, or `N/A`), the TypeScript mapping (constructs detected), and rationale — every `N/A` row carrying non-empty rationale for why no TypeScript analog exists. A conformance test MUST assert the table covers the 48 canonical names exactly once with dispositions from the closed set. P1 rows MUST carry detect mappings (P1 is must-detect; `N/A` is not available at P1).
- **FR-031**: The materialized OpenSpec specifications that currently assert only `initialize`/`shutdown`/`discover` are dispatch handlers MUST be updated in the same change to register the three new methods and shrink the reserved-method list (cross-pipeline bookkeeping, mirroring spec 001 Assumption 12).

### Key Entities

- **AnalyzeResult**: The `analyze` response payload — `{"functions": FunctionRecord[]}` (record shape per spec 001: `name`, `package`, `file`, `line`, `side_effects`).
- **ComplexityEntry**: One `complexity` response element — `name` (string), `package` (string), `file` (root-relative POSIX path), `line` (1-based declaration line), `complexity` (integer ≥ 1).
- **CoverageEntry**: One `coverage` response element — `file` (root-relative POSIX path), `function` (string, fnMap name verbatim), `start_line`/`end_line` (integers), `covered_stmts`/`total_stmts` (integers), `percentage` (number 0.0–100.0).
- **EffectDisposition**: One row of `docs/effect-disposition.md` — taxonomy type, tier, disposition, TypeScript mapping, rationale. Documentation entity; not runtime-consumed.
- **ProgramContext** (internal, not protocol-visible): the bootstrapped analysis context — either a `ts.Program` + `ts.TypeChecker` or the parse-only per-file source set — produced by the bootstrap module and consumed by the detector and complexity engine.
- **Effect / FunctionRecord / Classification** (existing, spec 001): unchanged; this feature is their first protocol consumer.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: The P0 conformance fixture suite passes with 100% accuracy — one fixture per P0 type, zero false negatives and zero false positives, verified by automated tests.
- **SC-002**: Pure-function fixtures return empty `side_effects` arrays — 100% of purity scenarios pass.
- **SC-003**: Golden byte-identical response tests pass for `analyze`, `complexity`, and `coverage` against canned requests on fixture trees.
- **SC-004**: Coverage fixtures for both vitest- and jest-emitted `coverage-final.json` documents return the exact expected entries; missing and invalid files return `{"functions": []}` — 100% of coverage scenarios pass.
- **SC-005**: Test files and generated files are verifiably excluded from analysis results — fixtures containing them produce no records from them.
- **SC-006**: Repeat analysis of the same tree produces byte-identical serialized responses for all three methods.
- **SC-007**: All protected project quality gates pass — `npx biome check src/ tests/`, `npm run build`, and `npx vitest run --coverage` at the protected 85% thresholds (lines, statements, functions, branches).
- **SC-008**: The disposition-table conformance test passes — 48 rows, one per canonical type, closed-set dispositions, non-empty N/A rationale.

## Assumptions

1. **Throw dual emission**: `throw` reports both `ErrorSignal` and `ErrorReturn` because the protocol's taxonomy table maps the exception mechanism to both types and the reference analyzer dual-emits; emitting one would be a silent false negative on the other. Promise rejection (`Promise.reject`, async `throw`) is treated as the async error channel and dual-emits identically.
2. **Param-write boundary**: The split follows the originating issue's assignment verbatim — `MapMutation` owns key-value writes (record computed-key writes and `Map.set`); `ContainerMutation` owns the remaining Set/Map/WeakMap membership methods (`Set.add/delete/clear`, `Map.delete/clear`, `WeakSet.add/delete`, `WeakMap.set/delete`). Parse-only mode defaults computed-key writes to `MapMutation` (documented P1 false-positive surface).
3. **SentinelError attribution**: Module-scope sentinel declarations attach to the file's first function record (source order) because the protocol has no module-level record slot; this mirrors the reference analyzer's convention and is deterministic. No functions in the file → the sentinel has no carrier and is unreported.
4. **Classification omission, not null**: The issue's "emits `classification: null`" is realized as field omission per the ratified omit-unset-optionals rule (spec 001 FR-013); the protocol consumer's documented null-fallback (tier defaults) applies identically to an absent field.
5. **Coverage artifact location**: `<root>/coverage/coverage-final.json` — the conventional output location for both vitest's and jest's Istanbul JSON reporters. Not configurable via params in v1 (protocol v1.2.0 defines only `root_path`/`patterns`); projects writing coverage elsewhere report empty coverage (documented limitation, extensible later).
6. **Percentage precision**: full floating-point precision from `(covered / total) * 100`, deterministically serialized; no rounding rule is introduced.
7. **`patterns` optionality**: absent `patterns` means the whole tree. Params strictness (rejecting keys beyond `root_path`/`patterns`) mirrors spec 001's strict-surface decision: the protocol defines exactly these fields, so strictness fails loud rather than ignoring caller intent.
8. **Inline anonymous functions**: bodies of unassigned function expressions scan into the enclosing extracted function (reference-analyzer lambda precedent); the deferred-callback false-positive caveat (for example `setTimeout` callbacks) is documented in the disposition table rather than resolved with unextractable records.
9. **Ambiguity carrier**: `CallbackInvocation` with `detail: {"confidence": "ambiguous"}` is the pre-#4 ambiguity signal (reference-analyzer precedent); the `classification` label arrives with issue #4's signals work.
10. **Complexity operator closure**: the decision-point list is exactly the originating issue's list; logical-assignment operators are excluded to keep the rule closed and unambiguous.
11. **Module-level effects**: top-level statements (including side-effectful imports) have no function record in v1; only sentinel declarations attach (Assumption 3). Recorded as a scope boundary, not a silent skip.
12. **Cross-pipeline bookkeeping**: the materialized OpenSpec server/protocol specs assert the current dispatch table and reserved-method list; this change must update those assertions in the same change (FR-031). This specification records the impact but does not modify those files.
13. **Runtime dependency**: the `typescript` promotion adds no new supply-chain surface (same package, same version, already in the tree) and is justified by Principle III — the compiler API is the mandated analysis infrastructure (FR-029).
14. **Fixture sourcing**: coverage fixtures are hand-authored documents shaped exactly like vitest- and jest-emitted `coverage-final.json` (committed fixtures keep tests hermetic — no test run occurs during analysis, per Principle V).
