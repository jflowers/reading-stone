# Effect Disposition

The rendered disposition table for Reading Stone's side-effect taxonomy
(FR-030). For each of the 48 canonical side-effect types from
`src/taxonomy.ts`, this document records its tier, its disposition, the
TypeScript constructs detected (the mapping), and the rationale for
`N/A` rows.

The table is conformance-pinned by `tests/disposition.test.ts` (SC-008):
the suite parses this document and asserts it against
`SIDE_EFFECT_TYPES` — 48 rows, one per canonical type, no gaps, no
duplicates, no drift; dispositions from the closed set
`strict` / `must` / `partial` / `best-effort` / `N/A`; disposition
matches tier mechanically; every `N/A` row carries non-empty rationale.

The disposition label is tier-mechanical: `strict` for P0 (zero false
negatives / zero false positives on conformance fixtures), `must` for P1
(detected wherever they occur; documented false positives acceptable),
`partial` for P2 (TypeScript-native subset detected), `best-effort` for
P3/P4. `N/A` marks types with no TypeScript analog — each carries its
rationale. `N/A` is unavailable at P1 (P1 is must-detect).

Detection rules are closed lists — the mapping column is the auditable
rule surface. "Parse-only" notes apply when no TypeChecker is available
(the FR-004 fallback); name-form rules match in both modes.

## P0 — strict (zero false negatives / zero false positives on conformance fixtures)

| Type | Tier | Disposition | TypeScript mapping | Rationale |
| --- | --- | --- | --- | --- |
| `ReturnValue` | P0 | strict | `return <expr>` in any function form; arrow expression bodies (`x => x + 1`); bare `return;` never matches (FR-011) |  |
| `ErrorReturn` | P0 | strict | dual emission with every `throw`, `Promise.reject(...)`, and `throw` inside `async` functions (the rejection channel) — FR-012 |  |
| `SentinelError` | P0 | strict | module-scope `class X extends Error` declarations; module-scope Error-instance constants (`const e = new Error(...)` / built-in Error subclasses / project-local Error subclasses); attached to the file's first function record in source order, or unreported when the file declares no functions (FR-013) |  |
| `ReceiverMutation` | P0 | strict | writes targeting `this`: `this.x = v`, `this[k] = v`, compound writes (`+=`, `++`, …), `delete this.x` (FR-014) |  |
| `PointerArgMutation` | P0 | strict | dot-property writes on parameters: `p.x = v`, compound, `delete p.x`, `p.x++` (FR-015) |  |
| `ErrorSignal` | P0 | strict | dual emission with every `throw` / `Promise.reject` / async `throw`; also paired with `process.exit` (which never emits `ErrorReturn`) — FR-012 |  |

## P1 — must (detected wherever they occur; documented false positives acceptable)

| Type | Tier | Disposition | TypeScript mapping | Rationale |
| --- | --- | --- | --- | --- |
| `SliceMutation` | P1 | must | element writes (`p[i] = v`) and the mutating array methods `push`/`pop`/`shift`/`unshift`/`splice`/`sort`/`reverse`/`fill`/`copyWithin` on array-typed parameters (checker mode), including `p.length = 0` (the array-truncation carve-out — never `PointerArgMutation`). Parse-only: same method-name forms on parameters, type-blind (documented FP surface; FR-015) |  |
| `MapMutation` | P1 | must | computed-key writes (`p[k] = v`) on record/object-typed parameters and `p.set(k, v)` on Map-typed parameters. Parse-only: computed-key writes on parameters default to `MapMutation` (documented FP surface; FR-015) |  |
| `GlobalMutation` | P1 | must | assignment-form writes (simple, compound, increment/decrement, `delete`) from inside a function to a module-scope binding, including imported bindings. Method-form mutations of module bindings are out of v1 scope — documented boundary (see `ContainerMutation`) |  |
| `WriterOutput` | P1 | must | name-form `.write(...)`/`.writeLine(...)`/`.append(...)` on writer-like receivers — excluding `process.stdout`/`process.stderr` (→ Stdout/StderrWrite) and fs write APIs (→ FileSystemWrite); receiver-specific rules take precedence |  |
| `HTTPResponseWrite` | P1 | must | name-form `send`/`json`/`jsonp`/`writeHead`/`write`/`end` on receivers named `res`/`response` (parse-only) or typed `http.ServerResponse`/express-style Response (checker mode); documented FP surface |  |
| `ChannelSend` | P1 | must | `postMessage(...)` calls (Worker / MessagePort / BroadcastChannel / window) |  |
| `ChannelClose` | P1 | must | `.close()` on MessagePort / MessageChannel / BroadcastChannel / Worker receivers (typed in checker mode, name-form in parse-only); takes precedence over ResourceManagement |  |
| `DeferredReturnMutation` | P1 | must | writes to enclosing function-scope bindings from inside deferred callbacks — callbacks passed to `setTimeout`/`setInterval`/`queueMicrotask`/`process.nextTick`/`.then`/`.catch`/`.finally`/`addEventListener`. This is Assumption 8's documented deferred-callback attribution caveat (effects execute after the enclosing function returns) |  |
| `GeneratorYield` | P1 | must | `yield` / `yield*` expressions inside (synchronous) generator functions |  |
| `ContainerMutation` | P1 | must | membership-method calls — `Set.add/delete/clear`, `Map.delete/clear`, `WeakSet.add/delete`, `WeakMap.set/delete` — on non-parameter receivers (parameters follow the FR-015 split: `Map.set` → `MapMutation`; the rest → `ContainerMutation`) |  |
| `StreamOutput` | P1 | must | `.pipe(...)` on stream receivers; `pipeline(...)` (node:stream/promises form) |  |

## P2 — partial (TS-native subset detected; partial acceptable)

| Type | Tier | Disposition | TypeScript mapping | Rationale |
| --- | --- | --- | --- | --- |
| `FileSystemWrite` | P2 | partial | fs write-family calls `writeFile`/`appendFile`/`rename`/`truncate`/`createWriteStream` and their `Sync`/promises variants, on `fs`/`node:fs/promises` receivers or default-imported fs bindings |  |
| `FileSystemDelete` | P2 | partial | `unlink`/`rm`/`rmdir` (+Sync/promises variants) |  |
| `FileSystemMeta` | P2 | partial | `chmod`/`chown`/`utimes`/`lutimes`/`mkdir` (+variants); `stat`/`lstat` are reads and are not mapped |  |
| `DatabaseWrite` | P2 | partial | name-form `insertOne`/`insertMany`/`updateOne`/`updateMany`/`deleteOne`/`deleteMany`/`findOneAndUpdate`/`bulkWrite` on any receiver; documented FP surface |  |
| `DatabaseTransaction` | P2 | partial | name-form `beginTransaction`/`commit`/`rollback`/`transact` |  |
| `GoroutineSpawn` | P2 | partial | `new Promise(...)`, `setTimeout`, `setInterval`, `queueMicrotask`, `process.nextTick` (FR-016 mandate; matched as the `AsyncTaskSpawn` alias and resolved through the taxonomy — the alias is never emitted) |  |
| `Panic` | P2 | N/A | none | TypeScript has no panic mechanism distinct from exceptions; the exception channel is fully covered by the ErrorSignal/ErrorReturn dual emission (FR-012), and emitting `Panic` for `throw` would double-count the same construct |
| `CallbackInvocation` | P2 | partial | invocations of function-typed parameters/properties (callbacks); the FR-017 ambiguity carrier — `eval`, `new Function`, computed-member calls (`obj[key]()`), calls on `any`/error-typed or lexically-unresolvable receivers (program mode adds unknown-global callees) — with `detail: {"confidence": "ambiguous"}`; resolved callees are never re-reported (parse-only boundary documented in research R7) |  |
| `LogWrite` | P2 | partial | logger name-form calls — `.info`/`.warn`/`.error`/`.debug`/`.log`/`.trace` on receivers named `log`/`logger` or typed as loggers; excludes `console.*` (→ Stdout/StderrWrite) |  |
| `ContextCancellation` | P2 | partial | `.abort()` on AbortController receivers; `AbortSignal.throwIfAborted()` |  |
| `AsyncGeneratorYield` | P2 | partial | `yield` / `yield*` inside async generator functions |  |
| `MetaprogrammingMutation` | P2 | partial | `Reflect.set` / `Reflect.deleteProperty` / `Object.defineProperty` calls targeting existing objects |  |
| `DescriptorEffect` | P2 | partial | decorator applications (`@dec`, decorator factories) on classes and class members |  |
| `ResourceManagement` | P2 | partial | `using` / `await using` declarations; name-form `.close()`/`.dispose()` on resource receivers (file handles, connections) — below ChannelClose's typed receivers in precedence |  |
| `ImportSideEffect` | P2 | partial | dynamic `import(...)` and `require(...)` calls inside function bodies; module-level import side effects have no carrier record in v1 (Assumption 11) |  |
| `MonkeyPatch` | P2 | partial | writes to `X.prototype.*` targets; property writes on imported namespace objects (`importedNS.prop = v`); takes precedence over GlobalMutation for these forms |  |

## P3 — best-effort (or N/A with rationale)

| Type | Tier | Disposition | TypeScript mapping | Rationale |
| --- | --- | --- | --- | --- |
| `StdoutWrite` | P3 | best-effort | `console.log`/`info`/`debug`/`trace`; `process.stdout.write` — detected |  |
| `StderrWrite` | P3 | best-effort | `console.error`/`warn`; `process.stderr.write` — detected |  |
| `EnvVarMutation` | P3 | best-effort | writes to `process.env.X` (assignment, compound, `delete`) — detected |  |
| `MutexOp` | P3 | N/A | none | JavaScript/TypeScript has no language-level mutual-exclusion primitive — the event loop serializes execution; library mutex APIs (e.g. `runExclusive`) are indistinguishable from arbitrary method names without project-specific type knowledge, and speculative matching would manufacture false positives (Principle II) |
| `WaitGroupOp` | P3 | N/A | none | Go `sync.WaitGroup` coordinated-completion semantics have no TypeScript analog in the event-loop model |
| `AtomicOp` | P3 | best-effort | `Atomics.*` calls (`add`, `store`, `compareExchange`, `exchange`, `and`, `or`, `sub`, `xor`, …) — detected |  |
| `TimeDependency` | P3 | best-effort | `Date.now()`, `new Date()`, `performance.now()`, `process.hrtime`/`hrtime.bigint()` — detected |  |
| `ProcessExit` | P3 | best-effort | `process.exit(...)` — detected as the FR-012 triple (`ProcessExit` + `ErrorSignal`, never `ErrorReturn`) |  |
| `RecoverBehavior` | P3 | N/A | none | Go's `recover()` has no TypeScript analog; `catch` clauses are error handling (counted as complexity decision points, FR-021), and the exception channel is covered by ErrorSignal/ErrorReturn — reporting every catch would double-count |

## P4 — best-effort (or N/A with rationale)

| Type | Tier | Disposition | TypeScript mapping | Rationale |
| --- | --- | --- | --- | --- |
| `ReflectionMutation` | P4 | N/A | none | structural mutation through reflective APIs (`Reflect.set`, `Object.defineProperty`) is mapped to `MetaprogrammingMutation`; a second reflective bucket would double-count the same constructs |
| `UnsafeMutation` | P4 | N/A | none | Go unsafe-pointer mutation has no JavaScript analog — memory is managed and unaddressable |
| `CgoCall` | P4 | best-effort | WebAssembly FFI surface: `new WebAssembly.Instance(...)` / `WebAssembly.instantiate(...)` — detected (the closest foreign-function surface) |  |
| `FinalizerRegistration` | P4 | best-effort | `FinalizationRegistry` construction and `.register(...)` on FinalizationRegistry receivers — detected |  |
| `SyncPoolOp` | P4 | N/A | none | Go `sync.Pool` object pooling has no TypeScript analog; pooling patterns are ordinary object reuse, not an observable effect |
| `ClosureCaptureMutation` | P4 | best-effort | synchronous writes to enclosing function-scope bindings (FR-014: never reported as `GlobalMutation`); deferred-callback writes escalate to `DeferredReturnMutation` — detected |  |

## Table invariants (asserted by the conformance test, SC-008)

48 rows — one per canonical type; dispositions from the closed set
{strict, must, partial, best-effort, N/A}; disposition matches tier
mechanically (P0→strict, P1→must, P2→partial, P3/P4→best-effort) except
N/A rows; all 7 N/A rows (Panic, MutexOp, WaitGroupOp, RecoverBehavior,
ReflectionMutation, UnsafeMutation, SyncPoolOp) carry non-empty
rationale; no P1 row is N/A and every P1 row carries a detect mapping.
