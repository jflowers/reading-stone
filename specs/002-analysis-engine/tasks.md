---
description: "Task list for Analysis Engine (analyze, complexity, coverage) implementation"
---

# Tasks: Analysis Engine (analyze, complexity, coverage)

**Input**: Design documents from `/specs/002-analysis-engine/`

**Prerequisites**: plan.md ✓, spec.md ✓, research.md ✓, data-model.md ✓, contracts/analyze.md ✓, contracts/complexity.md ✓, contracts/coverage.md ✓, quickstart.md ✓ — all present in this feature directory.

**Tests**: REQUIRED — the feature specification mandates them (Constitution Principle IV; SC-001 through SC-008; research R13's per-module strategy: unit suites mirroring modules one-to-one, the six-P0-fixture conformance suite, golden byte-identical determinism tests, protocol conformance through the injectable-stream harness, and the disposition-table conformance suite). Test tasks are listed FIRST within each story and MUST be written and observed to FAIL before the paired implementation lands.

**Organization**: Tasks grouped by user story (US1–US5 from spec.md). One deliberate execution-order inversion against priority order: **US2 (program bootstrap, P2) is scheduled before US1 (analyze, P1)** because US2's own priority rationale names the bootstrap "the foundation the detector and complexity engine build on" — `analyze` cannot satisfy FR-003 without `ProgramContext`. The dependency graph below records the true completion order; priority still governs value (US1 remains the MVP story).

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies on incomplete tasks)
- **[Story]**: Which user story this task belongs to (US1–US5); setup/foundational/polish tasks carry no story label
- Every task names its exact file path(s); constraints are quoted from data-model.md / contracts/ so no implementation-time discretion is required

## Path Conventions

Single project: `src/` and `tests/` at the repository root (per plan.md Project Structure). Tests mirror source modules one-to-one. `tests/helpers/fixtures.ts` (spec 001) already provides `createFixtureTree(files: Record<string, string>)` — mkdtemp trees from a root-relative file map with a cleanup callback — and is reused by every new suite; hand-authored Istanbul JSON documents are ordinary fixture-map entries (Assumption 14 — hermetic, no test run occurs during analysis). `tests/server.test.ts` provides the `drive()` injectable-stream harness and the reserved-method `it.each` list (currently at tests/server.test.ts:346).

---

## Phase 1: Setup

**Purpose**: Confirm the baseline is green and land the runtime dependency promotion before any analysis code exists.

- [x] T001 Verify the baseline before any change: from the repository root run `npm ci`, `npx biome check src/ tests/`, `npm run build`, and `npx vitest run --coverage`, and confirm all four protected gates pass (CI parity gate, AGENTS.md / .github/workflows/ci.yml — never lower a gate to make it pass)
- [x] T002 [P] Promote `typescript` from `devDependencies` to `dependencies` in package.json (FR-029): same range `^7.0.2`, no version change — the runtime promotion of an existing dependency (Principle III: `ts.createSourceFile`, `ts.Program`, and `ts.TypeChecker` are required at runtime when Gaze spawns the analyzer; no new supply-chain surface, same package already in the lockfile). Run `npm install` to refresh package-lock.json's dev flags, then re-run `npm ci` and `npm run build` to prove lockfile integrity and the strict build still pass

**Checkpoint**: Clean baseline confirmed; `typescript` is a runtime dependency with an intact lockfile.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: The shared-infrastructure edits every analysis story consumes. No protocol surface changes; both are pure widenings the existing green suites must survive.

**⚠️ CRITICAL**: US1/US3/US4 (the tree-consuming methods) cannot begin until T003 lands; US2's program mode cannot begin until T004 lands.

- [x] T003 [P] Export the analysis pipeline's entry points from src/discovery.ts (plan.md Project Structure; research R12): add `export` to `resolveRoot` (currently private at src/discovery.ts:942 — validates and realpath-resolves the root, still throwing `InvalidRootPathError` for nonexistent/not-a-directory/inaccessible roots so the server keeps mapping it to `-32602`) and to `screenCandidates` (currently private at src/discovery.ts:824 — the per-candidate precedence chain's excluding stages: safety skip → `.d.ts` → generated marker). Identical behavior, no other change — the analysis pipeline composes `resolveRoot → walkTree → screenCandidates → classifyFiles` exactly as `discover()` does (discovery keeps owning root validation; no layering inversion)
- [x] T004 [P] Add the synchronous bounded read to src/safeio.ts (plan.md; research R1): `readBoundedSync(absPath: string, stderr: Writable): string | undefined` implementing, in order: `lstatSync` regular-file check (FIFOs, devices, sockets, and symlinks skipped — the pre-open guard), `MAX_FILE_BYTES` (16 MiB) size cap checked before open, bounded `readFileSync`, strict UTF-8 decode (`TextDecoder("utf-8", { fatal: true })`, the existing module decoder). Every skip writes exactly one `reading-stone: skipping <path>: <reason>` line to the injected stderr and returns `undefined`; never throws for skip conditions. Required because the TypeScript `CompilerHost.readFile` contract is synchronous — the async `readBounded` cannot serve it

**Checkpoint**: Foundation ready — root resolution, screening, and the sync bounded read are exported and the existing suites stay green.

---

## Phase 3: User Story 2 — Bootstrap TypeScript programs with the compiler API (Priority: P2 — scheduled first as US1's foundation)

**Goal**: `src/program.ts` bootstraps analysis context from the analyzed project itself — a discovered `tsconfig.json` drives a `ts.Program` + `ts.TypeChecker` covering every in-scope file; projects without a usable tsconfig fall back to per-file parsing; type errors never abort; JavaScript-family sources are analyzed; every compiler read is bounded.

**Independent Test**: Unit tests against fixture trees with a valid tsconfig, no tsconfig, an unparseable tsconfig, and type-erroring code — asserting program construction, fallback behavior, and completion without error (spec.md US2 Independent Test).

**Why before US1**: the spec's own US2 priority rationale — "The bootstrap is the foundation the detector and complexity engine build on" — makes US2 a blocking prerequisite of US1's FR-003; `analyze` cannot ship without `ProgramContext`.

### Tests for User Story 2 (write FIRST; must FAIL before implementation)

- [ ] T005 [P] [US2] Create tests/program.test.ts — bootstrap fixtures over `createFixtureTree` trees (US2 scenarios 1–6; research R13): a tree with a valid root `tsconfig.json` bootstraps mode `"program"` whose context carries a `ts.Program` with a `ts.TypeChecker` and covers every in-scope discovered file (each in-scope root appears among `program.getSourceFiles()`); a tree with no tsconfig bootstraps mode `"parse-only"` with a source for every in-scope file and completes normally; a tree whose code contains type errors bootstraps and completes (semantic diagnostics never gate — FR-005); in-scope `.js`/`.jsx`/`.mjs`/`.cjs` files are analyzed in both modes, never silently skipped (FR-006); an unparseable `tsconfig.json` (e.g. `"{ not json"`) falls back to parse-only and completes (a broken tsconfig degrades precision, never availability); a tsconfig whose only config error is the no-inputs diagnostic (`"files": []`-style) still bootstraps program mode (research R3's exclusion); forced option adjustments are observable — `noEmit`, `incremental: false`, `composite: false`, `allowJs`, `checkJs: false`, `skipLibCheck` (research R1); an oversized transitive file (> 16 MiB, sparse via `fs.truncate`) is skipped with exactly one stderr diagnostic rather than read unbounded (the bounded compiler host)

### Implementation for User Story 2

- [ ] T006 [US2] Create src/program.ts — the `ProgramContext` type and parse-only mode (FR-004, FR-006; research R2; data-model.md ProgramContext): `export type ProgramContext = { mode: "program"; program: ts.Program; checker: ts.TypeChecker } | { mode: "parse-only"; sources: ReadonlyMap<string, ts.SourceFile> }` (internal — not protocol-visible); `buildProgramContext(realRoot, sourceFiles, stderr)` where `sourceFiles` are the in-scope `(relPath, text)` pairs pre-read through the async `readBounded` (16 MiB budget — a JSON-free whole-file read): a `null` read excludes the file (its diagnostic is already written); a `RangeError` escaping `ts.createSourceFile` on pathological nesting is caught and treated as the same skip-with-one-diagnostic (research R15); each file parses via `ts.createSourceFile(absPath, text, ts.ScriptTarget.Latest, /*setParentNodes*/ true, scriptKind)` with the explicit extension map `.ts`→`ts.ScriptKind.TS`, `.tsx`→`TSX`, `.js`/`.mjs`/`.cjs`→`JS`, `.jsx`→`JSX` (deterministic and auditable, not filename inference — research R2); parse diagnostics are ignored — the parser is error-tolerant and a file is never dropped for failing to parse; when no usable tsconfig exists, this parse-only context IS the result (the fallback is never an error and is invisible on the wire)
- [ ] T007 [US2] Extend src/program.ts — program mode with the bounded compiler host (FR-003, FR-005; research R1, R3): when `tsconfig.json` exists at the resolved root — (1) read it via `ts.readConfigFile(tsconfigPath, boundedRead)` with the config text through the bounded reader (a skip or parse error triggers the parse-only fallback); (2) `ts.parseJsonConfigFileContent(config.config, host, realRoot)` (any reported error except the no-inputs diagnostic triggers fallback — research R3); (3) `ts.createProgram(rootNames, options, host)` with **rootNames = the in-scope discovered files, NOT the tsconfig's `include`/`files` output** — this structurally guarantees FR-003's every-in-scope-file-covered regardless of the project's include/exclude patterns; option adjustments: `noEmit: true`, `incremental: false`, `composite: false`, `tsBuildInfoFile: undefined`, `skipLibCheck: true`, `allowJs: true`, `checkJs: false` — everything else (paths, baseUrl, strict, target, module resolution) verbatim from the project's config (US2 scenario 6: the code as it exists, no annotation or restructuring required); a custom `CompilerHost` wrapping `ts.createCompilerHost(options)` whose `readFile` serves in-scope file texts from the pre-read cache and applies T004's `readBoundedSync` to every other path — the `typescript` package's own `lib/*.d.ts` files are read bounded-but-without-root-containment (they are the analyzer's dependency, not analyzed-tree content), and any other compiler-resolved path outside the analysis root returns `undefined` with one diagnostic (skipped transitive files resolve as absent modules → `any` types → FR-017 ambiguity: graceful degradation, never a crash); `checker` from `program.getTypeChecker()`; type errors never abort — the bootstrap never consults syntactic/semantic diagnostics as a gate (FR-005)

**Checkpoint**: User Story 2 complete — `ProgramContext` bootstraps in both modes against fixture trees, every compiler read is bounded, and the existing suites stay green. No protocol surface yet (by design — the bootstrap's value is realized through the analysis methods).

---

## Phase 4: User Story 1 — Detect function side effects over `analyze` (Priority: P1) 🎯 MVP

**Goal**: `analyze` returns one record per analyzed function — name, package, file, declaration line — with every observable side effect attributed to it over the 48-type canonical taxonomy (six P0 types at zero false negatives/positives, eleven P1 types wherever they occur, TS-native P2 subset, best-effort P3/P4), deterministically byte-identical across repeats, with pattern scoping and test/generated-file exclusion per contracts/analyze.md.

**Independent Test**: Analyze fixture trees whose functions exhibit known effects and assert the exact returned records — correct canonical types, locations, targets — zero FN/FP on the P0 suite, plus golden byte-identical response tests (spec.md US1 Independent Test).

### Tests for User Story 1 (write FIRST; must FAIL before implementation)

- [ ] T008 [P] [US1] Create tests/analysis.test.ts — pattern normalization and analysis-scope tables (FR-001, FR-002; research R11; SC-005): normalization — absent/`null`/empty array/the exact `["./..."]`/the exact `["..."]` → whole tree; each other element strips one leading `./` then one trailing `/...` into a directory prefix; a file is in scope when its root-relative POSIX path equals a prefix or begins `prefix + "/"`; patterns union; empty-string and `"."` elements match nothing; a lone `"..."` element inside a larger array matches nothing (only the exact singleton forms are catch-alls); a pattern set matching nothing yields empty results, never an error; scope — fixture trees containing test files (`foo.test.ts`, `__tests__/x.ts`, `tests/y.ts`) and generated-marker files (`@generated` leading comment) produce no analysis records from them (FR-002/SC-005 — test files and generated files are never analyzed); a relative `root_path` resolves against `process.cwd()` and an invalid root rejects with `InvalidRootPathError`
- [ ] T009 [P] [US1] Create tests/extract.test.ts — extraction identity and edge cases (FR-007–FR-009; research R4; spec edge cases): every extraction form from the R4 table yields its named record — function declaration (declared name), class method (method name), object-literal method (method name), constructor (`"constructor"`), getter/setter (property name — a pair on one property yields two records distinguished by declaration line), variable-assigned arrow/function expression (variable name), object-literal function-valued property (property name), class-property function initializer (`handler = () => {...}` → `handler`), default-export anonymous function (`export default function () {}` → `"default"`); nested extracted function-likes inside another function's body are separate records; NOT extracted: body-less overload signatures (only the implementation declaration), `declare function`, abstract methods, interface method signatures, unassigned function expressions (IIFEs, inline call-argument callbacks — their bodies scan into the innermost enclosing extracted record per FR-009); declaration line is the 1-based line of the node's start via `sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))`; records deterministically ordered by `(file, line, name)` with the platform-default stable sort resolving same-line ties by AST position
- [ ] T010 [P] [US1] Create tests/detector.test.ts — the P0 conformance suite, purity, P1 rules, ambiguity, sentinel, determinism (SC-001, SC-002; FR-010–FR-019; research R6, R7): **one fixture per P0 type** asserting exact type, `file:line:col` location, and target with ZERO extra effects — `ReturnValue` (`return a + b` in any function form including arrow expression bodies; a bare `return;` NEVER matches), `ErrorReturn`/`ErrorSignal` (every `throw` dual-emits both at one construct; `Promise.reject(...)` and `throw` inside an `async` function dual-emit identically; `process.exit(...)` emits `ProcessExit` + `ErrorSignal` and NEVER `ErrorReturn`), `SentinelError` (module-scope `class X extends Error` declarations and module-scope Error-instance constants attach to the file's FIRST function record in source order; a file declaring no functions carries no sentinel), `ReceiverMutation` (`this.x = v`, `this[k] = v`, compound `this.x += v`, `this.x++`, `delete this.x`), `PointerArgMutation` (`p.x = v`, compound, `delete p.x`, `p.x++`); purity fixtures (no returns of values, no throws, no mutations, no I/O) → empty `side_effects` (SC-002); P1 rules — the FR-015 param-write split (element writes `p[i] = v` and the mutating array methods `push`/`pop`/`shift`/`unshift`/`splice`/`sort`/`reverse`/`fill`/`copyWithin` on array-typed parameters, including `p.length = 0` → `SliceMutation`, never `PointerArgMutation`; computed-key writes on record/object-typed parameters and `p.set(k, v)` on Map-typed parameters → `MapMutation`; parse-only computed-key writes on parameters default to `MapMutation`; `Set.add/delete/clear`, `Map.delete/clear`, `WeakSet.add/delete`, `WeakMap.set/delete` → `ContainerMutation`), `GlobalMutation` (assignment-form writes from inside a function to module-scope bindings including imported bindings; writes to enclosing *function*-scope bindings are NEVER `GlobalMutation`), `GoroutineSpawn` (`new Promise(...)`, `setTimeout`, `setInterval`, `queueMicrotask`, `process.nextTick` — the `AsyncTaskSpawn` alias resolves through the taxonomy and is never emitted), `DeferredReturnMutation` (writes to enclosing function-scope bindings inside the closed scheduling callbacks), `GeneratorYield` (`yield`/`yield*` in synchronous generators); ambiguity (FR-017) — `eval(...)`, `new Function(...)`, calls through computed members (`obj[key]()`), and (program mode only) calls on `any`-typed or unresolvable receivers each report a `CallbackInvocation` effect with `detail: {"confidence": "ambiguous"}`; calls resolving to locally-defined functions or known name-form APIs are NEVER reported (the zero-false-positive carve-out); wire shape — every `type` is one of the 48 canonical names (FR-018), no effect ever carries a `classification` field (FR-019), `target` is the written path as written (or the constructor name for `throw new X(...)`), effects within a record sorted by `(line, column, type)`, records by `(file, line, name)`
- [ ] T011 [P] [US1] Extend tests/server.test.ts with analyze dispatch cases through the existing `drive()` harness (FR-027, FR-020; SC-003/SC-006; contracts/analyze.md error table): a canned analyze request against a fixture tree returns the exact `{"functions": [...]}` result (records with `name`, `package`, `file`, `line`, `side_effects`) with the request id echoed; the `-32602` matrix with exact messages — params absent/`null`/array → `Invalid params: params must be an object`, `root_path` missing or non-string → `Invalid params: root_path must be a string`, `patterns` present but not an array of strings → `Invalid params: patterns must be an array of strings`, any extra key → `Invalid params: params must contain only root_path and patterns`, nonexistent/not-a-directory/inaccessible root → `Invalid params: root_path is not a directory: <path>` (the shared discover message); the reserved `it.each` list at tests/server.test.ts:346 drops `analyze` (the remaining seven stay `-32601`); the golden determinism check — the same canned analyze request sent twice produces two byte-identical response lines (SC-003/SC-006); the initialize capability response is unchanged (`discover: true`, the other five flags `false` — FR-028)

### Implementation for User Story 1

- [ ] T012 [P] [US1] Create src/analysis.ts — pattern rules (FR-001; research R11; data-model.md PatternSet): `export type PatternSet = null | readonly string[]` (`null` = whole tree); `export function normalizePatterns(patterns: unknown): PatternSet` — absent/`null`/empty array/exactly `["./..."]`/exactly `["..."]` → `null`; otherwise each element strips one leading `./` then one trailing `/...` into a directory prefix (empty-string, `"."`, and non-singleton `"..."` elements normalize to prefixes that match nothing — documented edge cases); `export function pathInScope(relPath: string, patternSet: PatternSet): boolean` — `true` when `patternSet` is `null`, or the root-relative POSIX path equals a prefix or begins with `prefix + "/"`; patterns union. Pure functions — no filesystem, no walk
- [ ] T013 [P] [US1] Create src/extract.ts — function extraction and the lexical scope tracker (FR-007–FR-009; research R4, R5; data-model.md ExtractionRecord): the table-driven extractor implementing the R4 form table (nine forms with their record names, including `"constructor"`, accessor property names, and `"default"`); `ExtractionRecord` carrying `name`, `relPath`, `line` (1-based declaration line), the body-owning function-like `node`, the `scopeChain`, and the `deferred` walk flag; the per-record walk starts at its own body and STOPS descending at nested extracted function-likes (they own their bodies) while traversing anonymous function-expression bodies as part of the enclosing record, setting the `deferred` flag inside callbacks passed to the closed scheduling set `setTimeout`/`setInterval`/`queueMicrotask`/`process.nextTick`/`.then`/`.catch`/`.finally`/`addEventListener` (research R6.5 — the DeferredReturnMutation boundary); the lexical scope tracker — a stack of scopes mapping binding names to declaration scope kinds (module scope: `SourceFile`-level variables, functions, classes, imports; function scope: parameters and locals) consumed by write classification, purely lexical and identical in both modes (a scope-address calculation over the compiler's AST, never a reimplementation of type semantics — the TypeChecker stays the type authority); the AST visit depth budget as a fixed constant (e.g. 2000) — on exceed, abort the walk for that file with one `reading-stone: skipping <relPath>: ast depth exceeds budget` stderr diagnostic and no records from it (research R15 — diagnosed degradation, never a silent omission, never a crash); records emitted in source order then stably sorted by `(file, line, name)`
- [ ] T014 [US1] Extend src/analysis.ts — the shared `prepareAnalysis` pipeline (FR-002; research R12): `prepareAnalysis(rootPath, patterns, stderr)` composing `resolveRoot` (T003) → `walkTree` → `screenCandidates` → `classifyFiles` (the same walk/screen/classify chain `discover()` uses, minus framework detection) → **test files additionally excluded from analysis** (test files and generated files are never analyzed — FR-002) → the FR-001 pattern filter (`normalizePatterns`/`pathInScope`) → `buildProgramContext` (T006/T007, fed the in-scope files) → extraction (T013), returning the `ProgramContext` plus `ExtractionRecord[]` that the analyze and complexity handlers both consume — one pipeline, structurally guaranteeing FR-022's same-extraction-set/scope/ordering for both methods; `InvalidRootPathError` propagates for the server to map to `-32602`
- [ ] T015 [US1] Create src/detector.ts — P0 detection rules (FR-011–FR-014; the six strict rows of data-model.md's disposition table; research R6): `ReturnValue` — a `return` statement carrying an expression in any function form including arrow expression bodies; a bare `return;` never matches (zero false positives); the throw split (FR-012) — every `throw` dual-emits `ErrorSignal` + `ErrorReturn`, as do `Promise.reject(...)` and `throw` inside `async` functions (the rejection channel); `process.exit(...)` emits `ProcessExit` + `ErrorSignal` and never `ErrorReturn` (terminal signal, not a caller-visible error return); `SentinelError` (FR-013) — module-scope Error-subclass class declarations and module-scope Error-instance constants, attached with their own declaration location to the file's first record by minimal `(line, position)` identified BEFORE the global sort, or to no record when the file declares no functions; `ReceiverMutation` (FR-014) — writes targeting `this` (simple, compound, increment/decrement, element, `delete`); `PointerArgMutation` — dot-property writes on parameters (simple, compound, increment/decrement, `delete`); every effect constructed through `resolveSideEffectType` (FR-018 — canonical names only, aliases never emitted) and carrying no `classification` (FR-019); `target` fields per research R6.6 (the written path as written — `this.x`, `p.x`, base identifier for element writes, binding name for identifier writes; the constructor name for `throw new X(...)`); `location` always the construct's root-relative `file:line:col`
- [ ] T016 [US1] Extend src/detector.ts — P1 detection rules (FR-015, FR-016; the eleven must rows of the disposition table; research R6): the param-write split — element writes and the mutating array methods `push`/`pop`/`shift`/`unshift`/`splice`/`sort`/`reverse`/`fill`/`copyWithin` on array-typed parameters (including `p.length = 0`, the array-truncation carve-out) → `SliceMutation`; computed-key writes on record/object-typed parameters and `Map.set(k, v)` on Map-typed parameters → `MapMutation`; the remaining membership methods (`Set.add/delete/clear`, `Map.delete/clear`, `WeakSet.add/delete`, `WeakMap.set/delete`) → `ContainerMutation`; in parse-only mode (no type information) computed-key writes on parameters default to `MapMutation` — the documented false-positive surface acceptable at P1; `GlobalMutation` — assignment-form writes (simple, compound, increment/decrement, `delete`) from inside a function to module-scope bindings including imported bindings (method-form mutations of module bindings are a documented v1 boundary); `GoroutineSpawn` — `new Promise(...)`, `setTimeout`, `setInterval`, `queueMicrotask`, `process.nextTick`, matched as the `AsyncTaskSpawn` alias and resolved through the taxonomy before constructing the record (FR-016); `DeferredReturnMutation` — writes to enclosing function-scope bindings from inside the deferred callbacks T013 flags; `GeneratorYield` — `yield`/`yield*` inside synchronous generator functions; `WriterOutput`, `HTTPResponseWrite`, `ChannelSend`, `ChannelClose`, `StreamOutput` per the disposition table's name-form (parse-only) and typed (checker mode) rules
- [ ] T017 [US1] Extend src/detector.ts — P2/P3/P4 partial and best-effort rules with precedence (the disposition table's P2–P4 rows; research R6.4): `FileSystemWrite`/`FileSystemDelete`/`FileSystemMeta` (the fs write-family name lists with `Sync`/promises variants), `DatabaseWrite`/`DatabaseTransaction`, `CallbackInvocation` (invocations of function-typed parameters/properties), `LogWrite`, `ContextCancellation`, `AsyncGeneratorYield`, `MetaprogrammingMutation`, `DescriptorEffect`, `ResourceManagement` (`using`/`await using`; name-form `.close()`/`.dispose()`), `ImportSideEffect` (dynamic `import(...)`/`require(...)` inside function bodies), `MonkeyPatch`, `StdoutWrite`/`StderrWrite` (`console.log/info/debug/trace` and `console.error/warn`; `process.stdout/stderr.write`), `EnvVarMutation` (writes to `process.env.X`), `AtomicOp` (`Atomics.*`), `TimeDependency` (`Date.now()`, `new Date()`, `performance.now()`, `process.hrtime`/`hrtime.bigint()`), `CgoCall` (`new WebAssembly.Instance(...)`/`WebAssembly.instantiate(...)`), `FinalizerRegistration`, `ClosureCaptureMutation` (synchronous writes to enclosing function-scope bindings — never `GlobalMutation`); precedence among overlapping name-form rules — receiver-specific rules win over generic ones (`console.*`/`process.stdout.write` → Stdout/StderrWrite, not WriterOutput; fs write APIs → FileSystemWrite, not WriterOutput; MessagePort-family `.close()` → ChannelClose, not ResourceManagement; `X.prototype.*` writes and imported-namespace property writes → MonkeyPatch, not GlobalMutation); N/A types are NEVER fabricated (`Panic`, `MutexOp`, `WaitGroupOp`, `RecoverBehavior`, `ReflectionMutation`, `UnsafeMutation`, `SyncPoolOp`)
- [ ] T018 [US1] Extend src/detector.ts — ambiguity rules and response assembly (FR-017, FR-020; research R7, R8): ambiguity emission — always (syntactic forms, both modes): `eval(...)`, `new Function(...)`, calls through computed members (`obj[key]()`), calls on lexically-unresolvable identifier receivers; program mode only (type-based): calls on `any`/error-typed receivers and calls whose callee resolves to no declaration — each reports `CallbackInvocation` with `detail: {"confidence": "ambiguous"}` and a description naming the unresolved construct (never silently omitted — Constitution Principle II); the zero-false-positive carve-out — calls resolving to known-pure targets (locally-defined functions, resolved pure callees, name-form-known APIs matched by a detection rule) are never reported; parse-only mode applies the syntactic forms only (the documented mode boundary — flooding parse-only output with an ambiguous effect per call would make the mode useless); the analyze entry over `prepareAnalysis` output returning serialized `FunctionRecord[]` — `package` via `derivePackage(file)`, `line` the 1-based declaration line, records sorted by `(file, line, name)`, effects within a record sorted by `(line, column, canonical type name)` (both total documented orders), description strings deterministic fixed templates (stable per analyzer version, pinned by golden tests), serialization through the existing sorted-key serializer for byte-identical repeats (Constitution I / SC-006)
- [ ] T019 [US1] Register the analyze handler in src/server.ts (FR-027, FR-020; research R12; contracts/analyze.md error table): extract the shared analysis-params validation helper used by all three methods — params is an object (else `-32602` `Invalid params: params must be an object`), `root_path` is a string (else `-32602` `Invalid params: root_path must be a string`), `patterns` when present is an array of strings (else `-32602` `Invalid params: patterns must be an array of strings`), params carries only `root_path`/`patterns` (else `-32602` `Invalid params: params must contain only root_path and patterns`); the analyze handler runs the T014 pipeline + T018 detector and returns `{"functions": [...]}`; `InvalidRootPathError` maps to `-32602` `Invalid params: root_path is not a directory: <path>` (the message shared with discover); the `initialize` capability response is UNCHANGED (FR-028 — protocol v1.2.0 does not gate the core methods behind capability flags)
- [ ] T020 [P] [US1] Update openspec/specs/server/spec.md (FR-031; the "Dispatch table scope" requirement at lines 145–150): the dispatch table registers `initialize`, `shutdown`, `discover`, and `analyze`; the reserved `-32601` list and its "Reserved methods are not implemented" scenario drop `analyze` (`complexity`, `coverage`, `test_mapping`, `classify_signals`, `analyze/stream`, `doc_coverage`, `cognitive_complexity` remain reserved until their stories land). Verified during task generation: openspec/specs/protocol/spec.md already carries the correct core-methods-ungated wording (line 72) and contains no reserved-list assertion naming the three methods — no protocol-spec edit is required (FR-031's "wording unchanged where already correct")

**Checkpoint**: User Story 1 is fully functional and independently testable — **the MVP**. `analyze` answers end-to-end over stdio: the P0 fixture suite at zero FN/FP (SC-001), purity with empty effects (SC-002), golden byte-identical repeats (SC-003/SC-006), test/generated exclusion (SC-005), and the full `-32602`/`-32601` error surface per contracts/analyze.md.

---

## Phase 5: User Story 3 — Compute cyclomatic complexity over `complexity` (Priority: P2)

**Goal**: `complexity` returns one entry per analyzed function with cyclomatic complexity computed by the fixed closed rule — 1 plus the count of decision points in the function's own body — over the same extraction set, scope, and ordering as `analyze`, so CRAP scoring has a deterministic complexity input.

**Independent Test**: Analyze fixture functions with known decision-point counts and assert the exact returned values, plus a golden byte-identical response test (spec.md US3 Independent Test).

### Tests for User Story 3 (write FIRST; must FAIL before implementation)

- [ ] T021 [P] [US3] Create tests/complexity.test.ts — decision-point closure fixtures (FR-021; US3 scenarios 1–5; research R9): each decision-point kind counts exactly once per occurrence — `if` (each `else if` is a nested `if` and counts), `for`, `for-of`, `for-in`, `while`, `do`, each `case` clause (`default` excluded), `catch`, conditional (ternary) expressions, and the binary logical operators `&&`, `||`, `??`; logical-assignment operators (`&&=`, `||=`, `??=`) are NOT counted (closed list, Assumption 10); an empty body scores exactly 1; decision points inside a nested extracted function count toward that function's entry only, never the enclosing function's; bodies of anonymous function expressions count toward the innermost enclosing extracted function (FR-009 attribution); entries carry exactly `name`, `package`, `file`, `line`, `complexity` (integer ≥ 1) with `package` = `derivePackage(file)`; the same fixture tree analyzed through the complexity and analyze surfaces yields the identical extraction set and `(file, line, name)` ordering (FR-022); repeat responses are byte-identical
- [ ] T022 [P] [US3] Extend tests/server.test.ts with complexity dispatch cases (FR-027, FR-022; contracts/complexity.md): a canned complexity request against a fixture tree returns the exact `{"functions": [...]}` five-field entries with the id echoed; the shared `-32602` matrix applies identically to analyze (params object, `root_path` string, `patterns` string array, only-`root_path`/`patterns` keys, invalid root — same messages); the reserved `it.each` list drops `complexity`; the golden determinism check — the same request twice produces byte-identical lines

### Implementation for User Story 3

- [ ] T023 [US3] Create src/complexity.ts (FR-021, FR-022; research R9): compute over the SAME extraction set and attribution walk as analyze — consume T014's `prepareAnalysis` output so there is no second extraction path to drift: cyclomatic complexity = 1 + the count of `IfStatement`, `ForStatement`, `ForOfStatement`, `ForInStatement`, `WhileStatement`, `DoStatement`, `CaseClause` (`DefaultClause` excluded), `CatchClause`, `ConditionalExpression`, and `BinaryExpression` nodes whose operator is `&&`, `||`, or `??`, within the function's own body with the walk stopping at nested extracted function-likes; entries carry exactly `name`, `package` (`derivePackage`), `file` (root-relative POSIX), `line` (1-based declaration line), `complexity` (integer ≥ 1); entries sorted by `(file, line, name)` — identical to `analyze` over the same request; serialization through the existing sorted-key serializer
- [ ] T024 [US3] Register the complexity handler in src/server.ts (FR-027; research R12): reuse the shared analysis-params validation helper from T019 unchanged; the handler runs the T014 pipeline + T023 computation and returns `{"functions": [...]}`; `InvalidRootPathError` maps to the shared `-32602` root message; the capability response is unchanged (FR-028)
- [ ] T025 [P] [US3] Update openspec/specs/server/spec.md (FR-031): the dispatch table adds `complexity`; the reserved `-32601` list and scenario drop `complexity` (`coverage`, `test_mapping`, `classify_signals`, `analyze/stream`, `doc_coverage`, `cognitive_complexity` remain)

**Checkpoint**: User Stories 1 and 3 both answer independently — `complexity` reports the identical function set `analyze` reports, with the closed decision-point rule and byte-identical repeats.

---

## Phase 6: User Story 4 — Parse coverage data over `coverage` (Priority: P2)

**Goal**: `coverage` returns per-function statement coverage derived from the project's pre-existing Istanbul `coverage-final.json` with innermost-function statement attribution — and `{"functions": []}` (never an error) when no usable artifact exists.

**Independent Test**: Fixture coverage documents (both vitest- and jest-emitted shapes) plus missing and invalid files — assert exact attribution results and the empty-result fallbacks (spec.md US4 Independent Test). The coverage computation is independent of the detector: it consumes the artifact, not the analysis pipeline.

### Tests for User Story 4 (write FIRST; must FAIL before implementation)

- [ ] T026 [P] [US4] Create tests/coverage.test.ts — attribution and degradation fixtures (FR-023–FR-026; US4 scenarios 1–7; SC-004; research R10; Assumption 14 — hand-authored documents as fixture-map entries): a vitest-shaped and a jest-shaped `coverage/coverage-final.json` both produce the exact expected entries — `file` (root-relative POSIX), `function` (fnMap name verbatim, including anonymous forms such as `(anonymous_0)`), `start_line` (fnMap `decl.start.line`), `end_line` (`loc.end.line`), `covered_stmts`, `total_stmts`, `percentage` (`(covered / total) * 100` at full floating-point precision — e.g. `66.66666666666667`; exactly `0.0` when `total_stmts` is 0, never a division error); innermost attribution — a statement inside a nested function's range counts toward the innermost enclosing function only (smallest span; ties broken by fnMap key lexicographic order); a root with no `coverage/coverage-final.json` → `{"functions": []}`; an unparseable and a structurally invalid document → `{"functions": []}`; an empty document `{}` → `{"functions": []}`; a parseable document with one non-conforming file entry (missing or malformed `statementMap`, `fnMap`, or `s`) skips that entry deterministically while the conforming entries report; file keys not under the resolved root are skipped; `patterns` filters entries by the FR-001 prefix rules (the same helpers as analyze); entries ordered by `(file, start_line, function)`
- [ ] T027 [P] [US4] Extend tests/server.test.ts with coverage dispatch cases (FR-027; contracts/coverage.md): a canned coverage request against a fixture tree with an authored artifact returns the exact `{"functions": [...]}` seven-field entries; the shared `-32602` matrix applies (the root must still exist and be a directory — the tree is not walked for coverage, but root validation is unchanged); the reserved `it.each` list drops `coverage` (leaving exactly `test_mapping`, `classify_signals`, `analyze/stream`, `doc_coverage`, `cognitive_complexity` — the FR-028 terminal set); the golden determinism check — byte-identical repeat lines

### Implementation for User Story 4

- [ ] T028 [US4] Create src/coverage.ts (FR-023–FR-026; research R10; data-model.md Istanbul document model): read `<root>/coverage/coverage-final.json` through the async `readBounded` at the full 16 MiB budget (JSON cannot parse from a truncated prefix — the package.json precedent; the `coverage/` directory is pruned from WALKING only, the artifact is read directly); degradation ladder — absent file, skipped read, JSON parse failure, non-object top level → `{"functions": []}`, never a JSON-RPC error (FR-025 — the Constitution V conflict-resolution record: consumption of the pre-existing artifact the project's own test run produced, never execution of analyzed code); per file entry: the conformance check (`statementMap`, `fnMap`, and `s` are objects with the referenced shapes — non-conforming entries are skipped deterministically while conforming entries report, FR-026); attribution — each `statementMap` statement is assigned to the innermost `fnMap` function whose `loc` range contains the statement's start, positions compared as `(line, column)`, innermost = smallest span, ties broken by fnMap key lexicographic order; `covered_stmts` counts attributed statements with `s[id] > 0`, `total_stmts` counts all attributed statements, `percentage = (covered / total) * 100` (exactly `0.0` when `total_stmts` is 0); `branchMap`/`b`/`f` may be present and are ignored; file keys not under the resolved root are skipped (lexical containment via `path.relative`); `patterns` filters entries through the FR-001 helpers from src/analysis.ts (structural "same path-prefix rules"); entries carry exactly the seven contract fields ordered by `(file, start_line, function)`; the root is still validated through `resolveRoot` → `InvalidRootPathError` → `-32602`
- [ ] T029 [US4] Register the coverage handler in src/server.ts (FR-027; research R12): reuse the shared analysis-params validation helper; the handler calls the T028 parser and returns `{"functions": [...]}`; the capability response is unchanged (FR-028)
- [ ] T030 [P] [US4] Update openspec/specs/server/spec.md (FR-031): the dispatch table registers all six built-ins (`initialize`, `shutdown`, `discover`, `analyze`, `complexity`, `coverage`); the reserved `-32601` list is exactly `test_mapping`, `classify_signals`, `analyze/stream`, `doc_coverage`, `cognitive_complexity` (the FR-028 terminal set)

**Checkpoint**: All three protocol methods answer — coverage consumes the Istanbul artifact with exact attribution and empty-result fallbacks; the reserved set has shrunk to its terminal five.

---

## Phase 7: User Story 5 — Document the TypeScript effect disposition (Priority: P3)

**Goal**: `docs/effect-disposition.md` records, for each of the 48 canonical taxonomy types, its tier, disposition, TypeScript mapping, and rationale — with non-empty rationale on every N/A row — and a conformance test pins the table against the shipped taxonomy so detection coverage is transparent, reviewable, and drift-proof.

**Independent Test**: The conformance test asserts the table covers all 48 canonical types exactly once, every disposition is from the closed set, and every N/A row carries non-empty rationale (spec.md US5 Independent Test).

### Tests for User Story 5 (write FIRST; must FAIL before implementation)

- [ ] T031 [P] [US5] Create tests/disposition.test.ts — the table conformance suite (SC-008, FR-030): parse docs/effect-disposition.md and assert against `SIDE_EFFECT_TYPES` from src/taxonomy.ts — the table covers the 48 canonical names exactly once each (no drift, no gaps, no duplicates); every disposition is from the closed set `{strict, must, partial, best-effort, N/A}`; disposition matches tier mechanically (P0→`strict`, P1→`must`, P2→`partial`, P3/P4→`best-effort`) except `N/A` rows; every `N/A` row carries non-empty rationale — write the assertion count-independently: the data-model.md disposition TABLES are the row-level normative source and contain seven N/A rows (`Panic`, `MutexOp`, `WaitGroupOp`, `RecoverBehavior`, `ReflectionMutation`, `UnsafeMutation`, `SyncPoolOp`); the "6 N/A rows" sentence in data-model.md's table-invariants paragraph omits `SyncPoolOp` and is superseded by the tables; no P1 row is `N/A` and every P1 row carries a detect mapping

### Implementation for User Story 5

- [ ] T032 [US5] Create docs/effect-disposition.md (FR-030): render the normative disposition table from specs/002-analysis-engine/data-model.md — all 48 canonical types by tier (6 P0, 11 P1, 16 P2, 9 P3, 6 P4) with columns for taxonomy type, tier, disposition, TypeScript mapping (constructs detected), and rationale; every `N/A` row carries its non-empty rationale verbatim from the data-model table; P1 rows carry detect mappings; include the parse-only precision notes where the table records them (SliceMutation's type-blind method-name surface, MapMutation's parse-only default, CallbackInvocation's mode boundary, the deferred-callback attribution caveat)

**Checkpoint**: The detection surface is transparent and conformance-pinned — 48 rows, closed-set dispositions, non-empty N/A rationale (SC-008).

---

## Phase 8: Polish & Cross-Cutting Concerns

**Purpose**: Package surface, documentation truthfulness, and final validation across all stories.

- [ ] T033 [P] Re-export the public analysis surface from src/index.ts alongside the existing exports (plan.md Project Structure; zero-waste — a consumable package API, not orphaned code): the per-method computation entry points from src/detector.ts, src/complexity.ts, and src/coverage.ts; the `ProgramContext` and extraction-record types from src/program.ts and src/extract.ts; and the pattern helpers (`PatternSet`, `normalizePatterns`, `pathInScope`) from src/analysis.ts — use `export type` clauses for types per the existing index.ts convention
- [ ] T034 [P] Update repository docs to match shipped behavior (research R14): README.md — move `analyze`, `complexity`, and `coverage` in the method table to Implemented (params `{root_path, patterns}`; results `{"functions": [...]}` per method) and add the new modules (`src/analysis.ts`, `src/program.ts`, `src/extract.ts`, `src/detector.ts`, `src/complexity.ts`, `src/coverage.ts`) to the project-structure section; AGENTS.md — record `typescript` as a runtime dependency in the technology stack and add the new modules to the project structure
- [ ] T035 Run the full manual end-to-end validation from specs/002-analysis-engine/quickstart.md against a fresh `npm run build` (SC-003/SC-006): the scratch-tree stdio demo (initialize → analyze → shutdown with the expected exact records — `bump`/`ReceiverMutation` at `src/mutate.ts:5:5`, `reset`/`PointerArgMutation`, `grade` with two `ReturnValue` effects, `add` with one); the complexity projection (`grade` = 2, the others 1); the coverage artifact check (`grade` at 2/3 statements, `percentage` `66.66666666666667`) and the empty-artifact fallback (`{"functions": []}`, no error); the determinism byte-compare (each method reports `2 <identical line>`); the error-surface checks (`-32602` nonexistent root / `patterns` not an array of strings / extra param key, `-32601` reserved method, `{"functions":[]}` for a matching-nothing pattern, `["src/utils/math.ts"]` for the `src/utils/...` subtree scoping); and the type-error tolerance check (`wrong` still reports its `ReturnValue` — FR-005). Record that every observed output matches quickstart.md exactly
- [ ] T036 Run the final CI parity gate from the repository root and confirm all protected gates pass (SC-007; AGENTS.md; .github/workflows/ci.yml): `npx biome check src/ tests/`, `npm run build`, and `npx vitest run --coverage` with lines, statements, functions, and branches coverage each at or above the protected 85% thresholds. Never modify a gate to make it pass — if a gate fails, fix the implementation and re-run

**Checkpoint**: Feature complete — package surface exported, docs truthful, quickstart validated end-to-end, all protected gates green.

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — start immediately.
- **Foundational (Phase 2)**: After Phase 1. T003 (discovery exports) blocks US1/US3/US4; T004 (sync bounded read) blocks US2's program mode.
- **US2 (Phase 3)**: After T004. Blocks US1 — the deliberate priority inversion (the spec's US2 rationale names the bootstrap the detector's foundation; FR-003 cannot ship without it).
- **US1 (Phase 4)**: After Phase 2 + US2. Delivers the MVP.
- **US3 (Phase 5)**: After US1 (needs T013's extraction surface, T014's shared pipeline, and T019's validation helper).
- **US4 (Phase 6)**: Coverage parsing (T026/T028) needs only Phase 2 + T012's pattern helpers; the server integration tasks (T027/T029) queue on the shared src/server.ts and tests/server.test.ts sequence (T019 → T024 → T029).
- **US5 (Phase 7)**: Only data-model.md is a true input; its files (docs/effect-disposition.md, tests/disposition.test.ts) are disjoint from every other story. Scheduled after US1 so the table documents the shipped detection rules.
- **Polish (Phase 8)**: After all user stories are complete.

### User Story Dependencies

- **US1 (P1)**: Depends on US2 + Foundational. No dependency on US3/US4/US5.
- **US2 (P2)**: Depends on Foundational (T004). Independent of every other story's files.
- **US3 (P2)**: Depends on US1 (shared extraction pipeline and validation helper) — the FR-022 same-set guarantee is structural.
- **US4 (P2)**: Depends on Foundational + T012 only for its parser; server integration follows the shared server-file sequence. Otherwise fully independent of US1/US2/US3.
- **US5 (P3)**: File-disjoint from all stories; consumes data-model.md's normative table.

### Within Each User Story

- Test tasks are written first and observed to FAIL, then implementation lands and turns them green; bookkeeping (openspec specs) lands last.
- US2: parse-only + type (T006) → program mode + host (T007) — sequential within src/program.ts.
- US1 implementation: patterns (T012) ∥ extraction (T013) → pipeline (T014, needs both + program.ts) ∥ detector P0 (T015, needs T013 only) → detector P1 (T016) → P2–P4 + precedence (T017) → ambiguity + assembly (T018) → registration (T019, needs T014 + T018) → openspec bookkeeping (T020).
- US3: complexity module (T023) → registration (T024) → bookkeeping (T025).
- US4: coverage module (T028) → registration (T029) → bookkeeping (T030).
- Run the CI parity commands (`npx biome check src/ tests/`, `npm run build`, `npx vitest run --coverage`) before marking any task complete (AGENTS.md CI Parity Gate), and mark each task `- [x]` immediately upon completion — never in a batch.

### Parallel Opportunities

- Phase 2: T003 ∥ T004 (src/discovery.ts vs src/safeio.ts).
- US2: after T005 is written red, T006 → T007 are sequential within one file; T005's suite is disjoint from all US1 test files.
- US1 tests: T008 ∥ T009 ∥ T010 ∥ T011 (four distinct test files).
- US1 implementation: T012 ∥ T013 (src/analysis.ts vs src/extract.ts); after T013 lands, T014 ∥ T015 (src/analysis.ts vs src/detector.ts); T020 lands last.
- US3: T021 ∥ T022 (test files); T025 is disjoint from src work.
- US4: T026 ∥ T027; T028 can be built in parallel with US1/US3 (disjoint module) — only T027/T029 wait on the server-file sequence.
- US5: T031 ∥ any story work (disjoint files); T032 follows T031.
- Polish: T033 ∥ T034 (src/index.ts vs README.md/AGENTS.md); T035 and T036 are sequential and final.
- Cross-story: a second implementer can build US4's parser (T026/T028) and US5's table (T031/T032) while US1 is in flight — every shared-file touchpoint (src/server.ts, tests/server.test.ts) is an explicitly ordered task.

---

## Parallel Execution Examples

### User Story 1

```bash
# Launch the four US1 test tasks together (distinct files):
Task: "Create tests/analysis.test.ts"     # T008
Task: "Create tests/extract.test.ts"      # T009
Task: "Create tests/detector.test.ts"     # T010
Task: "Extend tests/server.test.ts"       # T011

# After the tests are red, launch together (distinct files):
Task: "Create src/analysis.ts patterns"   # T012
Task: "Create src/extract.ts"             # T013

# After T013 lands, launch together (distinct files):
Task: "Add prepareAnalysis pipeline"      # T014
Task: "Create src/detector.ts P0 rules"   # T015
```

### User Story 4 (parallel-friendly)

```bash
# While US1/US3 are in flight, a second implementer builds the disjoint parser:
Task: "Create tests/coverage.test.ts"     # T026
Task: "Create src/coverage.ts"            # T028 (after T026 is red)
# Server integration (T027/T029) then queues behind the shared server-file sequence.
```

---

## Implementation Strategy

### MVP First (Phases 1–4: Setup + Foundational + US2 + US1)

1. Complete Phase 1: Setup (baseline green, `typescript` promoted to a runtime dependency).
2. Complete Phase 2: Foundational (discovery exports, sync bounded read).
3. Complete Phase 3: User Story 2 (ProgramContext bootstrap — US1's mandated foundation).
4. Complete Phase 4: User Story 1 (analyze end-to-end).
5. **STOP and VALIDATE**: `analyze` answers over stdio with the P0 suite at zero FN/FP, purity empty effects, golden byte-identical repeats, and the contract error surfaces — the quickstart.md sections 2, 3, 6, 7, and 8 are achievable at this point. The MVP is US1's value delivered on US2's foundation (the spec's priority ordering governs value; the dependency graph governs order).

### Incremental Delivery

1. Setup + Foundational → foundation ready.
2. Add US2 → bootstrap conformance-tested in isolation.
3. Add US1 → test independently → **MVP** (analyze over JSON-RPC).
4. Add US3 → test independently → complexity over the same extraction set.
5. Add US4 → test independently → coverage from the Istanbul artifact.
6. Add US5 → disposition table conformance-pinned.
7. Polish → package surface, docs truthful, quickstart validated, all gates green.

### Parallel Team Strategy

With multiple implementers after Phase 2 completes:

- Implementer A: US2 (src/program.ts) → then US1's pipeline + detector (src/analysis.ts, src/extract.ts, src/detector.ts).
- Implementer B: US4's parser (tests/coverage.test.ts, src/coverage.ts) and US5 (tests/disposition.test.ts, docs/effect-disposition.md) — disjoint files.
- Then one implementer takes the shared-file sequence (src/server.ts registrations T019 → T024 → T029 with their tests/server.test.ts extensions T011/T022/T027 and openspec bookkeeping T020/T025/T030), another starts Polish docs (T033/T034).

---

## Notes

- [P] tasks = different files, no dependencies on incomplete tasks.
- [Story] labels map tasks to spec.md user stories for traceability: US1 = analyze over JSON-RPC (FR-001, FR-002, FR-007–FR-020, FR-027, FR-028), US2 = program bootstrap (FR-003–FR-006), US3 = complexity (FR-021, FR-022), US4 = coverage (FR-023–FR-026), US5 = disposition table (FR-030). FR-029 (typescript promotion) is T002; FR-031 (openspec bookkeeping) is T020/T025/T030.
- The US2-before-US1 phase order is a deliberate execution-order inversion, not a priority change — recorded here and in the Dependencies section with the spec's own rationale. US1 remains the MVP story (🎯).
- Verify tests fail before implementing; commit after each task or logical group; mark `- [x]` immediately upon completion (AGENTS.md Task Completion Bookkeeping).
- Protected gates (85% coverage thresholds, `biome check`, strict `tsc`, `npm ci` lockfile integrity) must never be lowered to make an implementation pass — report blockers instead.
- Stop at any checkpoint to validate a story independently.
- The disposition table's N/A count: the data-model.md TABLES (normative, row-level) contain seven N/A rows; the "6 N/A rows" sentence in the same document's invariants paragraph omits `SyncPoolOp`. T031/T032 follow the tables; the conformance assertions are count-independent (matching SC-008's letter).
- Design decisions behind these tasks: research.md R1–R15 (bounded compiler host, parse-only fallback, broken-tsconfig boundary, extraction table, scope tracking, detection rules, ambiguity boundary, determinism, complexity counting, coverage parsing, patterns, module layout, testing strategy, dependency promotion, resource bounds).
- The existing `tests/helpers/fixtures.ts` `createFixtureTree` and `tests/server.test.ts` `drive()` harness (spec 001) are reused throughout; no new shared test helpers are needed.

---

## Requirement Traceability

| Requirement | Tasks |
|---|---|
| FR-001 patterns semantics | T008, T012, T014 (filter: T026, T028) |
| FR-002 in-scope set, test/generated exclusion | T008, T014 |
| FR-003 tsconfig → Program + Checker | T005, T007 |
| FR-004 parse-only fallback | T005, T006 |
| FR-005 type errors never abort | T005, T007 |
| FR-006 JS-family analyzed | T005, T006, T007 |
| FR-007 extraction forms | T009, T013 |
| FR-008 record identity + ordering | T009, T013 |
| FR-009 innermost attribution | T009, T013 |
| FR-010 detection precision tiers | T010, T015–T018 |
| FR-011 ReturnValue | T010, T015 |
| FR-012 throw split / process.exit | T010, T015 |
| FR-013 SentinelError | T010, T015 |
| FR-014 receiver/global writes | T010, T015, T016 |
| FR-015 param-write split | T010, T016 |
| FR-016 async spawn (alias-resolved) | T010, T016 |
| FR-017 ambiguity rules | T010, T018 |
| FR-018 canonical types only | T010, T015 |
| FR-019 no classification field | T010, T015 |
| FR-020 analyze result + determinism | T010, T011, T018, T019 |
| FR-021 complexity closed rule | T021, T023 |
| FR-022 complexity result shape | T021, T022, T023 |
| FR-023 coverage attribution | T026, T028 |
| FR-024 coverage result shape | T026, T028 |
| FR-025 coverage empty-result fallback | T026, T028 |
| FR-026 coverage per-entry tolerance | T026, T028 |
| FR-027 dispatch + param validation | T011, T019, T022, T024, T027, T029 |
| FR-028 capability response unchanged | T011, T019, T024, T029 |
| FR-029 typescript runtime promotion | T002 |
| FR-030 disposition table + conformance | T031, T032 |
| FR-031 openspec spec updates | T020, T025, T030 |
