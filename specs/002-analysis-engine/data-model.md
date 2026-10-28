# Data Model: Analysis Engine (analyze, complexity, coverage)

**Feature Branch**: `002-analysis-engine`
**Date**: 2026-10-27

Entities extracted from the feature spec. Wire-format field names are
snake_case (protocol payload shape); TypeScript identifiers are camelCase
per convention pack CS-006. The 48-row disposition table below is
normative: `docs/effect-disposition.md` (FR-030) is its rendered form and
the conformance test (SC-008) asserts against it.

---

## AnalyzeResult

The `analyze` response payload (FR-020) — `{"functions": FunctionRecord[]}`
where `FunctionRecord` is the spec 001 model (unchanged; this feature is
its first protocol consumer).

| Field | Type | Required | Serialization |
|-------|------|----------|---------------|
| `functions` | `readonly FunctionRecord[]` | yes | always emitted; `[]` for an empty tree, a pattern set matching nothing, or a tree with no in-scope source files |

`FunctionRecord` (`name`, `package`, `file`, `line`, `side_effects`) and
`Effect` (`type`, `description`, `location?`, `target?`, `detail?`,
`classification?`) are exactly as defined in
[specs/001-discovery-shared-analysis/data-model.md](../001-discovery-shared-analysis/data-model.md).
This change's rules:

- `package` = `derivePackage(file)` (existing helper).
- `line` = 1-based declaration line.
- Effects **never** set `classification` (FR-019) — the field is omitted
  per the omit-unset-optionals rule (wire-equivalent to the protocol's
  `null` fallback; Assumption 4).
- `type` is always a canonical name (FR-018); aliases resolve through
  `resolveSideEffectType` before construction and never appear on the wire.
- `location` is the effect construct's root-relative `file:line:col`.
- `target` is the written path as written (`this.x`, `p.x`, base
  identifier for element writes, binding name for identifier writes);
  for `throw new X(...)` the constructor name; omitted otherwise.
- `detail` appears only on ambiguity effects: `{"confidence":
  "ambiguous"}` (FR-017; Assumption 9).
- `description` strings are deterministic fixed templates
  (implementation-defined wording, stable per analyzer version — pinned
  by golden tests, not by the contract).

**Validation** (existing serializers, fail-loud): non-canonical types,
non-string fields, non-positive lines throw — never invalid protocol data.

**Ordering**: records sorted by `(file, line, name)` — stable sort over
source-order emission, so same-line ties (getter/setter pair) resolve by
AST position. Effects within a record sorted by `(line, column,
canonical type name)`. Both orders are total and documented (FR-020).

## ComplexityEntry / ComplexityResult

One `complexity` response element (FR-022) and its payload.

| Field | Type | Required | Validation |
|-------|------|----------|------------|
| `name` | `string` | yes | extraction identity (FR-008) |
| `package` | `string` | yes | `derivePackage(file)` |
| `file` | `string` | yes | root-relative POSIX path |
| `line` | `number` | yes | 1-based declaration line, positive integer |
| `complexity` | `number` | yes | integer ≥ 1 |

`ComplexityResult` = `{"functions": ComplexityEntry[]}` — exactly these
five fields per entry, over the same extraction set, scope, and ordering
as `analyze` (FR-022). Entries are computed by the closed decision-point
rule (FR-021 / research R9): 1 + the count of `if`, `for`, `for-of`,
`for-in`, `while`, `do`, `case` clauses (`default` excluded), `catch`,
ternary conditionals, and `&&`/`||`/`??` operators in the function's own
body — nested extracted functions count toward their own entries only;
logical-assignment operators are excluded (Assumption 10).

## CoverageEntry / CoverageResult

One `coverage` response element (FR-024) and its payload.

| Field | Type | Required | Validation |
|-------|------|----------|------------|
| `file` | `string` | yes | root-relative POSIX path |
| `function` | `string` | yes | fnMap name verbatim (including `(anonymous_N)`) |
| `start_line` | `number` | yes | fnMap `decl.start.line` (1-based) |
| `end_line` | `number` | yes | fnMap `loc.end.line` |
| `covered_stmts` | `number` | yes | integer ≥ 0 — attributed statements with count > 0 |
| `total_stmts` | `number` | yes | integer ≥ 0 — all attributed statements |
| `percentage` | `number` | yes | `(covered / total) * 100` at full float precision; exactly `0.0` when `total_stmts` is 0 |

`CoverageResult` = `{"functions": CoverageEntry[]}` — exactly these seven
fields per entry, ordered by `(file, start_line, function)`. Entries for
file keys not under the resolved root are skipped; `patterns` filters
entries by the FR-001 prefix rules; absent/unreadable/unparseable/
structurally invalid documents yield `{"functions": []}` (FR-025);
non-conforming individual file entries are skipped while conforming
entries report (FR-026).

**Statement attribution** (FR-023): each `statementMap` statement is
assigned to the innermost `fnMap` function whose `loc` range contains the
statement's start, compared as `(line, column)`; innermost = smallest
span; ties broken by fnMap key lexicographic order. Statements inside a
nested function's range count toward the innermost enclosing function
only.

## Istanbul document model (parsed input, untrusted)

The consumed shape of `<root>/coverage/coverage-final.json`:

```text
CoverageDocument     ::= { absoluteFilePath: FileCoverage }
FileCoverage         ::= {
  statementMap: { statementId: Loc },   // Loc = {start: Pos, end: Pos}
  fnMap:        { functionId:  { name: string, decl: Loc, loc: Loc } },
  s:            { statementId: number }  // execution counts
}
Pos                  ::= { line: number, column: number }  // Istanbul: 1-based lines
```

`branchMap`/`b`/`f` may be present and are ignored. Per-entry tolerance
(FR-026): a file entry is conforming when `statementMap`, `fnMap`, and
`s` are objects and the referenced shapes hold; non-conforming entries
are skipped deterministically. The document is read through the bounded
safe reader at the full 16 MiB budget (JSON cannot parse from a
truncated prefix).

**Null END columns** (review fix; the vitest v8 emitter's real shape):
Istanbul's v8 coverage pipeline writes `"column": null` on END positions
whenever the sourcemap carries no column information (the motivating
real artifact had null end columns on 1542 of 1558 statementMap records).
Conformance therefore requires a numeric `line` on both positions and a
numeric START `column`, accepts a null or absent END `column`, and
normalizes it to an end-of-line sentinel — the parsed `Pos` is always
numeric, and a null-ended range deterministically contains every
position on its end line. A document that parses yet has no conforming
file entry writes one stderr diagnostic line (the not-silent rung of
FR-025's ladder); budget-skipped entries (contracts/coverage.md) are
conforming and never trigger it.

## ProgramContext (internal — not protocol-visible)

The bootstrapped analysis context (spec Key Entities; research R1/R2),
produced by `src/program.ts`:

```text
ProgramContext ::=
  | { mode: "program",    program: ts.Program, checker: ts.TypeChecker }
  | { mode: "parse-only", sources: ReadonlyMap<relPath, ts.SourceFile> }
```

- `"program"`: built from a valid root `tsconfig.json` — rootNames are
  the in-scope discovered files (FR-003 coverage guarantee), options
  adjusted (`noEmit`, `incremental: false`, `composite: false`,
  `skipLibCheck`, `allowJs`, `checkJs: false`) and all compiler reads
  funneled through bounded guarded reads (Constitution V).
- `"parse-only"`: one `ts.createSourceFile` per in-scope file (FR-004),
  explicit ScriptKind per extension, `ScriptTarget.Latest`, parse
  diagnostics ignored.
- Type errors never abort either mode (FR-005).

## ExtractionRecord / lexical scopes (internal — not protocol-visible)

One extracted function-like (FR-007/FR-008; research R4/R5), produced by
`src/extract.ts` and consumed by the detector and complexity engine
(the structural guarantee behind FR-022):

| Field | Type | Notes |
|-------|------|-------|
| `name` | `string` | identity per the R4 table (declared/variable/property name, `"constructor"`, `"default"`) |
| `relPath` | `string` | root-relative POSIX path |
| `line` | `number` | 1-based declaration line |
| `node` | function-like `ts.Node` | body owner; walk stops at nested extracted function-likes |
| `scopeChain` | scope stack | module vs function declaration scopes for write classification (R5) |
| `deferred` | `boolean` flag on the walk | set inside callbacks passed to the scheduling constructs (R6) |

The scope tracker maps binding names to declaration scope kinds (module
scope: `SourceFile`-level variables, functions, classes, imports;
function scope: parameters and locals). Writes resolve against it:
module-scope binding written from inside a function → `GlobalMutation`;
enclosing function-scope binding → `ClosureCaptureMutation` (P4), or
`DeferredReturnMutation` (P1) when the write sits inside a deferred
callback; own-scope binding → no effect.

## PatternSet (internal — not protocol-visible)

Normalized pattern state (FR-001; research R11):

```text
PatternSet ::= null                       // whole tree (absent, null, empty,
                                          // or exact ["./..."] / ["..."])
            | readonly string[]           // normalized directory prefixes
```

Normalization per element: strip one leading `./`, then one trailing
`/...`. In-scope test: path equals a prefix or begins `prefix + "/"`;
patterns union. Empty-string, `"."`, and non-singleton `"..."` elements
match nothing (documented edge cases).

## EffectDisposition (documentation entity — FR-030)

One row of `docs/effect-disposition.md`: taxonomy type, tier, disposition
(from the closed set `strict` / `must` / `partial` / `best-effort` /
`N/A`), TypeScript mapping (constructs detected), rationale (required
non-empty for `N/A`). The disposition label is tier-mechanical: `strict`
for P0, `must` for P1, `partial` for P2, `best-effort` for P3/P4; `N/A`
is unavailable at P1 (P1 is must-detect). The conformance test asserts:
48 rows, one per canonical type, closed-set dispositions, non-empty N/A
rationale, P1 rows carry detect mappings.

### Normative disposition table (all 48 canonical types)

Detection rules are closed lists — the mapping column is the auditable
rule surface. "Parse-only" notes apply when no TypeChecker is available
(FR-004 fallback); name-form rules match in both modes.

#### P0 — strict (zero false negatives / zero false positives on conformance fixtures)

| Type | Tier | Disposition | TypeScript mapping |
|------|------|-------------|---------------------|
| `ReturnValue` | P0 | strict | `return <expr>` in any function form; arrow expression bodies (`x => x + 1`); bare `return;` never matches (FR-011) |
| `ErrorReturn` | P0 | strict | dual emission with every `throw`, `Promise.reject(...)`, and `throw` inside `async` functions (the rejection channel) — FR-012 |
| `SentinelError` | P0 | strict | module-scope `class X extends Error` declarations; module-scope Error-instance constants (`const e = new Error(...)` / built-in Error subclasses / project-local Error subclasses); attached to the file's first function record in source order, or unreported when the file declares no functions (FR-013) |
| `ReceiverMutation` | P0 | strict | writes targeting `this`: `this.x = v`, `this[k] = v`, compound writes (`+=`, `++`, …), `delete this.x` (FR-014) |
| `PointerArgMutation` | P0 | strict | dot-property writes on parameters: `p.x = v`, compound, `delete p.x`, `p.x++` (FR-015) |
| `ErrorSignal` | P0 | strict | dual emission with every `throw` / `Promise.reject` / async `throw`; also paired with `process.exit` (which never emits `ErrorReturn`) — FR-012 |

#### P1 — must (detected wherever they occur; documented false positives acceptable)

| Type | Tier | Disposition | TypeScript mapping |
|------|------|-------------|---------------------|
| `SliceMutation` | P1 | must | element writes (`p[i] = v`) and the mutating array methods `push`/`pop`/`shift`/`unshift`/`splice`/`sort`/`reverse`/`fill`/`copyWithin` on array-typed parameters (checker mode), including `p.length = 0` (the array-truncation carve-out — never `PointerArgMutation`). Parse-only: same method-name forms on parameters, type-blind (documented FP surface; FR-015) |
| `MapMutation` | P1 | must | computed-key writes (`p[k] = v`) on record/object-typed parameters and `p.set(k, v)` on Map-typed parameters. Parse-only: computed-key writes on parameters default to `MapMutation` (documented FP surface; FR-015) |
| `GlobalMutation` | P1 | must | assignment-form writes (simple, compound, increment/decrement, `delete`) from inside a function to a module-scope binding, including imported bindings. Method-form mutations of module bindings are out of v1 scope — documented boundary (see `ContainerMutation`) |
| `WriterOutput` | P1 | must | name-form `.write(...)`/`.writeLine(...)`/`.append(...)` on writer-like receivers — excluding `process.stdout`/`process.stderr` (→ Stdout/StderrWrite) and fs write APIs (→ FileSystemWrite); receiver-specific rules take precedence |
| `HTTPResponseWrite` | P1 | must | name-form `send`/`json`/`jsonp`/`writeHead`/`write`/`end` on receivers named `res`/`response` (both modes) or typed `http.ServerResponse`/express-style Response (checker mode); documented FP surface |
| `ChannelSend` | P1 | must | `postMessage(...)` calls (Worker / MessagePort / BroadcastChannel / window) |
| `ChannelClose` | P1 | must | `.close()` on channel receivers — typed MessagePort / MessageChannel / BroadcastChannel / Worker in checker mode, name-form receivers `port`/`channel`/`worker` in both modes; takes precedence over ResourceManagement |
| `DeferredReturnMutation` | P1 | must | writes to enclosing function-scope bindings from inside deferred callbacks — callbacks passed to `setTimeout`/`setInterval`/`queueMicrotask`/`process.nextTick`/`.then`/`.catch`/`.finally`/`addEventListener`. This is Assumption 8's documented deferred-callback attribution caveat (effects execute after the enclosing function returns) |
| `GeneratorYield` | P1 | must | `yield` / `yield*` expressions inside (synchronous) generator functions |
| `ContainerMutation` | P1 | must | membership-method calls — `Set.add/delete/clear`, `Map.delete/clear`, `WeakSet.add/delete`, `WeakMap.set/delete` — on non-parameter receivers (parameters follow the FR-015 split: `Map.set` → `MapMutation`; the rest → `ContainerMutation`) |
| `StreamOutput` | P1 | must | `.pipe(...)` on stream receivers; `pipeline(...)` (node:stream/promises form) |

#### P2 — partial (TS-native subset detected; partial acceptable)

| Type | Tier | Disposition | TypeScript mapping |
|------|------|-------------|---------------------|
| `FileSystemWrite` | P2 | partial | fs write-family calls `writeFile`/`appendFile`/`rename`/`truncate`/`createWriteStream` and their `Sync`/promises variants, on `fs`/`node:fs/promises` receivers or default-imported fs bindings |
| `FileSystemDelete` | P2 | partial | `unlink`/`rm`/`rmdir` (+Sync/promises variants) |
| `FileSystemMeta` | P2 | partial | `chmod`/`chown`/`utimes`/`lutimes`/`mkdir` (+variants); `stat`/`lstat` are reads and are not mapped |
| `DatabaseWrite` | P2 | partial | name-form `insertOne`/`insertMany`/`updateOne`/`updateMany`/`deleteOne`/`deleteMany`/`findOneAndUpdate`/`bulkWrite` on any receiver; documented FP surface |
| `DatabaseTransaction` | P2 | partial | name-form `beginTransaction`/`commit`/`rollback`/`transact` |
| `GoroutineSpawn` | P2 | partial | `new Promise(...)`, `setTimeout`, `setInterval`, `queueMicrotask`, `process.nextTick` (FR-016 mandate; matched as the `AsyncTaskSpawn` alias and resolved through the taxonomy — the alias is never emitted) |
| `Panic` | P2 | N/A | **Rationale**: TypeScript has no panic mechanism distinct from exceptions; the exception channel is fully covered by the ErrorSignal/ErrorReturn dual emission (FR-012), and emitting `Panic` for `throw` would double-count the same construct |
| `CallbackInvocation` | P2 | partial | invocations of function-typed parameters/properties (callbacks); the FR-017 ambiguity carrier — `eval`, `new Function`, computed-member calls (`obj[key]()`), calls on `any`/error-typed or lexically-unresolvable receivers (program mode adds unknown-global callees) — with `detail: {"confidence": "ambiguous"}`; resolved callees are never re-reported (parse-only boundary documented in research R7) |
| `LogWrite` | P2 | partial | logger name-form calls — `.info`/`.warn`/`.error`/`.debug`/`.log`/`.trace` on receivers named `log`/`logger` or typed as loggers; excludes `console.*` (→ Stdout/StderrWrite) |
| `ContextCancellation` | P2 | partial | `.abort()` — receiver-blind in both modes (the method name is cancellation-specific); `AbortSignal.throwIfAborted()` |
| `AsyncGeneratorYield` | P2 | partial | `yield` / `yield*` inside async generator functions |
| `MetaprogrammingMutation` | P2 | partial | `Reflect.set` / `Reflect.deleteProperty` / `Object.defineProperty` calls targeting existing objects |
| `DescriptorEffect` | P2 | partial | decorator applications (`@dec`, decorator factories) on classes and class members |
| `ResourceManagement` | P2 | partial | `using` / `await using` declarations; name-form `.close()`/`.dispose()` on resource receivers (file handles, connections) — below ChannelClose's typed receivers in precedence |
| `ImportSideEffect` | P2 | partial | dynamic `import(...)` and `require(...)` calls inside function bodies; module-level import side effects have no carrier record in v1 (Assumption 11) |
| `MonkeyPatch` | P2 | partial | writes to `X.prototype.*` targets; property writes on imported namespace objects (`importedNS.prop = v`); takes precedence over GlobalMutation for these forms |

#### P3 — best-effort (or N/A with rationale)

| Type | Tier | Disposition | TypeScript mapping |
|------|------|-------------|---------------------|
| `StdoutWrite` | P3 | best-effort | `console.log`/`info`/`debug`/`trace`; `process.stdout.write` — detected |
| `StderrWrite` | P3 | best-effort | `console.error`/`warn`; `process.stderr.write` — detected |
| `EnvVarMutation` | P3 | best-effort | writes to `process.env.X` (assignment, compound, `delete`) — detected |
| `MutexOp` | P3 | N/A | **Rationale**: JavaScript/TypeScript has no language-level mutual-exclusion primitive — the event loop serializes execution; library mutex APIs (e.g. `runExclusive`) are indistinguishable from arbitrary method names without project-specific type knowledge, and speculative matching would manufacture false positives (Principle II) |
| `WaitGroupOp` | P3 | N/A | **Rationale**: Go `sync.WaitGroup` coordinated-completion semantics have no TypeScript analog in the event-loop model |
| `AtomicOp` | P3 | best-effort | `Atomics.*` calls (`add`, `store`, `compareExchange`, `exchange`, `and`, `or`, `sub`, `xor`, …) — detected |
| `TimeDependency` | P3 | best-effort | `Date.now()`, `new Date()`, `performance.now()`, `process.hrtime`/`hrtime.bigint()` — detected |
| `ProcessExit` | P3 | best-effort | `process.exit(...)` — detected as the FR-012 triple (`ProcessExit` + `ErrorSignal`, never `ErrorReturn`) |
| `RecoverBehavior` | P3 | N/A | **Rationale**: Go's `recover()` has no TypeScript analog; `catch` clauses are error handling (counted as complexity decision points, FR-021), and the exception channel is covered by ErrorSignal/ErrorReturn — reporting every catch would double-count |

#### P4 — best-effort (or N/A with rationale)

| Type | Tier | Disposition | TypeScript mapping |
|------|------|-------------|---------------------|
| `ReflectionMutation` | P4 | N/A | **Rationale**: structural mutation through reflective APIs (`Reflect.set`, `Object.defineProperty`) is mapped to `MetaprogrammingMutation`; a second reflective bucket would double-count the same constructs |
| `UnsafeMutation` | P4 | N/A | **Rationale**: Go unsafe-pointer mutation has no JavaScript analog — memory is managed and unaddressable |
| `CgoCall` | P4 | best-effort | WebAssembly FFI surface: `new WebAssembly.Instance(...)` / `WebAssembly.instantiate(...)` — detected (the closest foreign-function surface) |
| `FinalizerRegistration` | P4 | best-effort | `FinalizationRegistry` construction and `.register(...)` on FinalizationRegistry receivers — detected |
| `SyncPoolOp` | P4 | N/A | **Rationale**: Go `sync.Pool` object pooling has no TypeScript analog; pooling patterns are ordinary object reuse, not an observable effect |
| `ClosureCaptureMutation` | P4 | best-effort | synchronous writes to enclosing function-scope bindings (FR-014: never reported as `GlobalMutation`); deferred-callback writes escalate to `DeferredReturnMutation` — detected |

**Table invariants** (asserted by the conformance test, SC-008): 48 rows
— one per canonical type; dispositions from the closed set
{strict, must, partial, best-effort, N/A}; disposition matches tier
mechanically (P0→strict, P1→must, P2→partial, P3/P4→best-effort) except
N/A rows; every N/A row enumerated in the tables above carries non-empty
rationale; no P1 row is N/A and every P1 row carries a detect mapping.

## Relationships

- `AnalyzeResult.functions` ↔ `ComplexityResult.functions`: same
  extraction set, scope, and ordering (FR-022) — one pipeline, two
  computations.
- `Effect` → taxonomy: every `type` is a canonical `SideEffectType`
  (spec 001); this table records how each canonical type is produced.
- `CoverageEntry` ↔ analysis functions: none — coverage is keyed by the
  Istanbul document's own fnMap names, not by extraction records
  (FR-024 fields are document-derived; correlation is Gaze's job).
- `ProgramContext` → `ExtractionRecord` → `FunctionRecord` /
  `ComplexityEntry`: the internal pipeline order.
