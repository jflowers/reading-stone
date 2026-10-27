import {
  type ArrowFunction,
  type BindingName,
  type CallExpression,
  type ClassDeclaration,
  type ClassExpression,
  type ConstructorDeclaration,
  type ElementAccessExpression,
  type Expression,
  type FunctionDeclaration,
  type FunctionExpression,
  type GetAccessorDeclaration,
  isArrowFunction,
  isBinaryExpression,
  isBindingElement,
  isBlock,
  isCallExpression,
  isClassDeclaration,
  isClassExpression,
  isConstructorDeclaration,
  isDecorator,
  isDeleteExpression,
  isElementAccessExpression,
  isExportAssignment,
  isFunctionDeclaration,
  isFunctionExpression,
  isGetAccessorDeclaration,
  isIdentifier,
  isImportDeclaration,
  isMethodDeclaration,
  isNamespaceImport,
  isNewExpression,
  isParenthesizedExpression,
  isPostfixUnaryExpression,
  isPrefixUnaryExpression,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isPropertyDeclaration,
  isReturnStatement,
  isSetAccessorDeclaration,
  isStringLiteral,
  isThisExpression,
  isThrowStatement,
  isVariableDeclaration,
  isVariableStatement,
  isYieldExpression,
  type MethodDeclaration,
  ModifierFlags,
  type NewExpression,
  type Node,
  type NodeArray,
  NodeFlags,
  type ParameterDeclaration,
  type PropertyAccessExpression,
  type PropertyDeclaration,
  type SetAccessorDeclaration,
  type SourceFile,
  SyntaxKind,
  type ThrowStatement,
  type VariableStatement,
  type YieldExpression,
} from "typescript/unstable/ast";
import { type Checker, type Type, TypeFlags } from "typescript/unstable/sync";
import type { ExtractionRecord } from "./extract.js";
import { derivePackage, type Effect, type FunctionRecord } from "./models.js";
import type { ProgramContext } from "./program.js";
import { resolveSideEffectType } from "./taxonomy.js";

/**
 * The side-effect detection rules (FR-011 through FR-017; every row of
 * data-model.md's disposition table — the six strict rows, the eleven
 * must rows, and the P2–P4 partial/best-effort rows; research R6;
 * Constitution Principles I, II, and III). `detectEffects` walks each
 * extraction record's own body and reports exactly the constructs the
 * pinned tiers cover — zero false negatives and zero false positives on
 * the conformance fixtures:
 *
 * - `ReturnValue` (FR-011) — a `return` statement carrying an
 *   expression, in any function form, plus arrow expression bodies
 *   (the expression body is an implicit return; its start is the
 *   construct location). A bare `return;` never matches.
 * - The throw split (FR-012) — every `throw` dual-emits `ErrorReturn`
 *   + `ErrorSignal`, as do `Promise.reject(...)` and `throw` inside
 *   `async` functions (the rejection channel, identical emission);
 *   `process.exit(...)` emits `ProcessExit` + `ErrorSignal` and never
 *   `ErrorReturn` — a terminal signal, not a caller-visible error
 *   return.
 * - `SentinelError` (FR-013) — module-scope Error-subclass class
 *   declarations and module-scope Error-instance constants, attached
 *   with their own declaration location to the file's first record by
 *   minimal `(line, position)` — identified before any global record
 *   ordering, so a same-line name-sorted tie can never misattribute —
 *   or to no record when the file declares no functions.
 * - `ReceiverMutation` (FR-014) — assignment-form writes targeting
 *   `this`: simple, compound, increment/decrement, element, `delete`.
 * - `PointerArgMutation` — dot-property writes on parameters: simple,
 *   compound, increment/decrement, `delete`.
 * - The identifier-write split (FR-014; research R5) — a write to a
 *   module-scope binding from inside a function is `GlobalMutation`;
 *   a write to an enclosing function-scope binding from inside a
 *   deferred callback is `DeferredReturnMutation` (the mutation
 *   executes after the declaring function returned); other
 *   function-scope closure writes are P4 (`ClosureCaptureMutation`)
 *   and local writes report nothing.
 * - `GoroutineSpawn` (FR-016) — the five spawn forms (`new
 *   Promise(...)`, `setTimeout`, `setInterval`, `queueMicrotask`,
 *   `process.nextTick`), emitted through the `AsyncTaskSpawn` alias
 *   that the canonical-type resolver maps to `GoroutineSpawn` before
 *   the effect is constructed (FR-018) — the alias never appears on
 *   the wire.
 * - `GeneratorYield` (FR-016) — `yield` and `yield*` in synchronous
 *   generators. Async generators are P2 (`AsyncGeneratorYield`), never
 *   fabricated here.
 * - The param-write split (FR-015) — element writes and the nine
 *   mutating array methods on array-typed parameters are
 *   `SliceMutation`; element writes and `Map.set` on other parameters
 *   are `MapMutation`; `add`/`delete`/`clear` and non-parameter
 *   `Map.set` are `ContainerMutation`; `p.length = 0` on an
 *   array-typed parameter is the `SliceMutation` truncation carve-out
 *   (never `PointerArgMutation`); every other dot-property write on a
 *   parameter stays `PointerArgMutation`. The typed arms use the
 *   checker in program mode; parse-only takes the documented
 *   type-blind defaults.
 * - The receiver name-forms (FR-015; research R6.4) —
 *   `HTTPResponseWrite` on `res`/`response` receivers, `ChannelSend`
 *   on `postMessage`, `ChannelClose` on port/channel/worker receivers,
 *   `StreamOutput` on `pipe`, and `WriterOutput` on other writer-like
 *   receivers — closed method-name lists, receiver-specific families
 *   first.
 * - The P2 families (the disposition table's partial rows; research
 *   R6.4) — the fs write/delete/meta name lists (with `Sync`/promises
 *   variants) on `fs`-spelled, `.promises`-chained, or import-tracked
 *   fs receivers; the database write/transaction name lists on any
 *   receiver; `CallbackInvocation` as FR-017's ambiguity carrier —
 *   `eval(...)` and `new Function(...)` (both modes), computed-member
 *   calls (`obj[key]()`, both modes), lexically unresolvable receivers
 *   (parse-only), and, program mode only, `any`/error-typed receivers
 *   and bare callees resolving to no declaration — each with
 *   `detail: {"confidence": "ambiguous"}`; resolved callees are never
 *   re-reported (research R7's zero-false-positive carve-out);
 *   `LogWrite` on log/logger-named or
 *   Logger-typed receivers; `ContextCancellation` for `.abort()` and
 *   `AbortSignal.throwIfAborted()`; `AsyncGeneratorYield` in async
 *   generators; `MetaprogrammingMutation` for `Reflect.set`/
 *   `Reflect.deleteProperty`/`Object.defineProperty`;
 *   `DescriptorEffect` for decorators on classes and class members
 *   inside walked bodies; `ResourceManagement` for `using`/`await
 *   using` statements and the `.close()`/`.dispose()` name-form;
 *   `ImportSideEffect` for dynamic `import(...)`/`require(...)` inside
 *   function bodies; `MonkeyPatch` for `X.prototype.*` and
 *   imported-namespace property writes.
 * - The P3/P4 families (the best-effort rows) — `StdoutWrite`/
 *   `StderrWrite` for the console method split and
 *   `process.stdout`/`process.stderr` `.write`; `EnvVarMutation` for
 *   `process.env.X` writes; `AtomicOp` for `Atomics.*`; the clock
 *   reads as `TimeDependency`; `CgoCall` for the two WebAssembly
 *   forms; `FinalizerRegistration` for registry construction and
 *   typed `.register(...)`; `ClosureCaptureMutation` for synchronous
 *   writes to enclosing function-scope bindings. The seven N/A types
 *   (`Panic`, `MutexOp`, `WaitGroupOp`, `RecoverBehavior`,
 *   `ReflectionMutation`, `UnsafeMutation`, `SyncPoolOp`) have no
 *   JavaScript carrier, no rule, and are never fabricated.
 * - Precedence (research R6.4): receiver-specific rules win over
 *   generic ones — console/stdio before WriterOutput, the fs family
 *   before WriterOutput, ChannelClose's receivers before
 *   ResourceManagement's `.close()`, MonkeyPatch's prototype and
 *   namespace forms before GlobalMutation, `Reflect.set`/`Atomics.add`
 *   before the membership mutators — and every P1 name-form family
 *   keeps its claim against all later tiers.
 *
 * Every effect is constructed through `resolveSideEffectType` (FR-018 —
 * canonical names only; the resolver passes canonical spellings through
 * and this module fails loud on anything else) and carries no
 * `classification` (FR-019 — the field is omitted entirely). `target`
 * follows research R6.6: the written path as written (`this.x`, `p.x`),
 * the base identifier for element writes (`this` for `this[k] = v`, the
 * parameter for `p[k] = v`), the binding name for identifier writes,
 * the constructor name for `throw new X(...)`, and omitted otherwise;
 * `location` is always the construct's root-relative `file:line:col`
 * with 1-based line and column.
 *
 * Attribution walk (FR-009; research R4): the per-record walk starts at
 * the record's own function-like node, STOPS descending at nested
 * extracted function-likes (they own their bodies — the same R4 form
 * conditions `extract.ts` encodes, mirrored here through
 * `isExtractedFunctionLike`), and traverses anonymous function-expression
 * bodies as part of the enclosing record. Write classification resolves
 * the written base identifier against a scope stack built from the
 * record's `scopeChain` zipped with its ancestor function-likes: each
 * chain function frame corresponds 1:1 to a lexically enclosing
 * function-like node, whose `parameters` recover that frame's parameter
 * names (the chain itself carries names only, not their kinds).
 * Deferred-callback boundaries (research R6.5) track the scheduling
 * callbacks a record's walk is inside — seeded for `deferred` records
 * from the record's own ancestors, grown as the walk enters scheduling
 * callback arguments — mirroring the `deferred` flag `extract.ts`
 * computes, so deferral attribution consumes exactly the callbacks the
 * extractor flags.
 *
 * Rule surface (T015–T017): the walk is a per-record visitor whose
 * `visit` dispatch enumerates construct families — the P2/P3/P4 rules
 * were added to the same dispatch, with `visitMethodCall` ordering every
 * overlapping name-form family by research R6.4's precedence
 * (receiver-specific first). P0 is purely lexical (research R5); the
 * typed splits take the `ProgramContext` — the checker is live only in
 * program mode, and parse-only takes each split's documented
 * type-blind default. The detector deliberately adds no second AST
 * depth budget: extraction's budget already excluded any file whose
 * AST could exhaust the native stack (records exist only for
 * in-budget files), and this walk revisits exactly those materialized
 * subtrees.
 */

/**
 * One effect awaiting the within-record order pass: the constructed
 * `Effect` plus its 1-based `(line, column)` — the numeric keys of
 * FR-020's documented `(line, column, canonical type name)` effect
 * order, kept numeric here so the sort never re-parses location strings.
 */
type PendingEffect = {
  readonly effect: Effect;
  readonly line: number;
  readonly column: number;
};

/**
 * The shared empty name set for scopes that bind nothing (the module
 * frame's parameter set; the defensive fallback when the chain/ancestor
 * zip runs short). Never mutated: `DetectionScope.declares` only grows a
 * walk-entered frame's own live set.
 */
const EMPTY_NAMES: ReadonlySet<string> = new Set<string>();

/**
 * The built-in constructors whose instances are error values (FR-013's
 * "built-in Error subclasses"): the ECMAScript error constructors plus
 * `AggregateError`. A module-scope constant initialized with `new` of
 * any of these — or of a module-scope class that transitively extends
 * one — is an Error-instance constant.
 */
const BUILTIN_ERROR_CONSTRUCTORS: ReadonlySet<string> = new Set([
  "Error",
  "TypeError",
  "RangeError",
  "SyntaxError",
  "ReferenceError",
  "EvalError",
  "URIError",
  "AggregateError",
]);

/**
 * The bare timer globals shared by FR-016's spawn forms and research
 * R6.5's deferred-callback set: matched as whole callee identifiers,
 * receiver-blind. Together with the property-form scheduling methods
 * and `process.nextTick`, these are the closed scheduling set — the
 * exact set `extract.ts` mirrors for its `deferred` flag.
 */
const TIMER_GLOBAL_NAMES: ReadonlySet<string> = new Set([
  "setTimeout",
  "setInterval",
  "queueMicrotask",
]);

/**
 * The property-form scheduling methods (research R6.5): promise
 * continuations and DOM-style event registration, matched on the method
 * name alone. These set the deferred-callback boundary but are NOT
 * spawn forms — FR-016's closed spawn list has five members only.
 */
const DEFERRED_CALLBACK_METHODS: ReadonlySet<string> = new Set([
  "then",
  "catch",
  "finally",
  "addEventListener",
]);

/**
 * The nine mutating array methods of the param-write split (FR-015):
 * calls of these names on parameter receivers are `SliceMutation`,
 * type-blind in BOTH modes — the disposition table's documented
 * name-form surface (a `push` on a declared array parameter is a
 * caller-visible slice mutation regardless of what the checker says).
 */
const ARRAY_MUTATOR_METHODS: ReadonlySet<string> = new Set([
  "push",
  "pop",
  "shift",
  "unshift",
  "splice",
  "sort",
  "reverse",
  "fill",
  "copyWithin",
]);

/**
 * The membership mutators (FR-015): calls of these names fire
 * `ContainerMutation` on any receiver — `set` is deliberately absent;
 * it follows the parameter Map/WeakMap split instead.
 */
const MEMBERSHIP_MUTATOR_METHODS: ReadonlySet<string> = new Set([
  "add",
  "delete",
  "clear",
]);

/** `WriterOutput`'s name-form methods (the disposition table). */
const WRITER_OUTPUT_METHODS: ReadonlySet<string> = new Set([
  "write",
  "writeLine",
  "append",
]);

/**
 * `HTTPResponseWrite`'s name-form methods — checked before
 * `WriterOutput`'s families so `res.write(...)` is HTTP, never a
 * generic writer (research R6.4's precedence).
 */
const HTTP_RESPONSE_METHODS: ReadonlySet<string> = new Set([
  "send",
  "json",
  "jsonp",
  "writeHead",
  "write",
  "end",
]);

/** `HTTPResponseWrite`'s name-form receiver spellings. */
const HTTP_RESPONSE_RECEIVER_NAMES: ReadonlySet<string> = new Set(["res", "response"]);

/**
 * `HTTPResponseWrite`'s checker-mode receiver type names (Node's
 * `ServerResponse`; the fetch/express-style `Response`).
 */
const HTTP_RESPONSE_TYPE_NAMES: ReadonlySet<string> = new Set([
  "ServerResponse",
  "Response",
]);

/** `ChannelClose`'s name-form receiver spellings (the MessagePort family). */
const CHANNEL_CLOSE_RECEIVER_NAMES: ReadonlySet<string> = new Set([
  "port",
  "channel",
  "worker",
]);

/** `ChannelClose`'s checker-mode receiver type names. */
const CHANNEL_CLOSE_TYPE_NAMES: ReadonlySet<string> = new Set([
  "MessagePort",
  "MessageChannel",
  "BroadcastChannel",
  "Worker",
]);

/**
 * The fs module specifiers whose imported bindings count as fs receivers
 * (the disposition table's FileSystemWrite/Delete/Meta rows: "on
 * `fs`/`node:fs/promises` receivers or default-imported fs bindings").
 * Both the default-import form (`import fsp from "node:fs"`) and the
 * namespace form (`import * as fsp from "node:fs"`) bind the module's
 * API surface, so both count — excluding the namespace form would be a
 * false negative with no precision gain.
 */
const FS_MODULE_SPECIFIERS: ReadonlySet<string> = new Set([
  "fs",
  "node:fs",
  "fs/promises",
  "node:fs/promises",
]);

/**
 * `FileSystemWrite`'s name-form methods (the disposition table): the
 * write family — `writeFile`/`appendFile`/`rename`/`truncate`/
 * `createWriteStream` — plus their `Sync` variants (the promises forms
 * spell identically to the base names) and the low-level fd-based
 * `write`, research R6.4's pinned precedence carve-out — `.write` on an
 * fs receiver is FileSystemWrite, never WriterOutput.
 */
const FILE_SYSTEM_WRITE_METHODS: ReadonlySet<string> = new Set([
  "write",
  "writeFile",
  "writeFileSync",
  "appendFile",
  "appendFileSync",
  "rename",
  "renameSync",
  "truncate",
  "truncateSync",
  "createWriteStream",
]);

/**
 * `FileSystemDelete`'s name-form methods (the disposition table):
 * `unlink`/`rm`/`rmdir` plus their `Sync` variants.
 */
const FILE_SYSTEM_DELETE_METHODS: ReadonlySet<string> = new Set([
  "unlink",
  "unlinkSync",
  "rm",
  "rmSync",
  "rmdir",
  "rmdirSync",
]);

/**
 * `FileSystemMeta`'s name-form methods (the disposition table):
 * `chmod`/`chown`/`utimes`/`lutimes`/`mkdir` plus their `Sync` variants.
 * `stat`/`lstat` are reads and are deliberately absent.
 */
const FILE_SYSTEM_META_METHODS: ReadonlySet<string> = new Set([
  "chmod",
  "chmodSync",
  "chown",
  "chownSync",
  "utimes",
  "utimesSync",
  "lutimes",
  "lutimesSync",
  "mkdir",
  "mkdirSync",
]);

/**
 * `DatabaseWrite`'s name-form methods (the disposition table): the
 * MongoDB-style write names on any receiver — the documented
 * false-positive surface of the partial tier.
 */
const DATABASE_WRITE_METHODS: ReadonlySet<string> = new Set([
  "insertOne",
  "insertMany",
  "updateOne",
  "updateMany",
  "deleteOne",
  "deleteMany",
  "findOneAndUpdate",
  "bulkWrite",
]);

/** `DatabaseTransaction`'s name-form methods (the disposition table). */
const DATABASE_TRANSACTION_METHODS: ReadonlySet<string> = new Set([
  "beginTransaction",
  "commit",
  "rollback",
  "transact",
]);

/**
 * `LogWrite`'s name-form methods (the disposition table): the logger
 * level names. `console.*` is excluded by the receiver — the stdio
 * family owns it.
 */
const LOG_WRITE_METHODS: ReadonlySet<string> = new Set([
  "info",
  "warn",
  "error",
  "debug",
  "log",
  "trace",
]);

/** `LogWrite`'s name-form receiver spellings (the disposition table). */
const LOG_RECEIVER_NAMES: ReadonlySet<string> = new Set(["log", "logger"]);

/** `LogWrite`'s checker-mode receiver type names. */
const LOG_TYPE_NAMES: ReadonlySet<string> = new Set(["Logger"]);

/**
 * `StdoutWrite`'s console methods (the disposition table):
 * `console.log`/`info`/`debug`/`trace` — detected.
 */
const CONSOLE_STDOUT_METHODS: ReadonlySet<string> = new Set([
  "log",
  "info",
  "debug",
  "trace",
]);

/**
 * `StderrWrite`'s console methods (the disposition table):
 * `console.error`/`warn` — detected.
 */
const CONSOLE_STDERR_METHODS: ReadonlySet<string> = new Set(["error", "warn"]);

/**
 * `ResourceManagement`'s disposal name-forms (the disposition table):
 * `.close()`/`.dispose()` on resource receivers (file handles,
 * connections) — deliberately checked below `ChannelClose`'s receivers
 * (research R6.4's pinned precedence: the MessagePort family's
 * `.close()` is a channel close, never a resource release).
 */
const RESOURCE_DISPOSAL_METHODS: ReadonlySet<string> = new Set(["close", "dispose"]);

/**
 * `FinalizerRegistration`'s checker-mode receiver type names (the
 * disposition table: `.register(...)` on FinalizationRegistry
 * receivers, typed in program mode — the parse-only surface is the
 * construction form alone, a documented best-effort boundary).
 */
const FINALIZER_TYPE_NAMES: ReadonlySet<string> = new Set(["FinalizationRegistry"]);

/**
 * Detects the P0 and P1 side effects of every extraction record
 * (FR-011 through FR-017; research R6).
 *
 * Each record is walked exactly once by a fresh `RecordWalker` (no
 * cross-record state), then `SentinelError` declarations attach per
 * file, then every record's effects are sorted into FR-020's documented
 * `(line, column, canonical type name)` order — dual emissions at one
 * construct and sentinel attachments make emission order alone
 * under-specified, so the total order is applied here where every
 * record's list is complete.
 *
 * @param records The extraction records (any order; the result map
 * preserves the given record order).
 * @param context The analysis context the records came from: its mode
 * decides the typed splits' behavior — program mode consults the live
 * checker, parse-only takes each split's documented type-blind default.
 * @returns Each record's effects, sorted by `(line, column, type)` —
 * empty for a record whose body contains no pinned constructs.
 */
export function detectEffects(
  records: readonly ExtractionRecord[],
  context: ProgramContext,
): ReadonlyMap<ExtractionRecord, readonly Effect[]> {
  const pending = new Map<ExtractionRecord, PendingEffect[]>();
  // The checker is live only in program mode; parse-only walks are
  // purely lexical, and the typed splits take their documented
  // type-blind defaults (FR-015).
  const checker = context.mode === "program" ? context.checker : undefined;
  for (const record of records) {
    const walker = new RecordWalker(record, checker);
    walker.walk();
    pending.set(record, walker.pending);
  }
  attachSentinelEffects(records, pending);
  const effects = new Map<ExtractionRecord, readonly Effect[]>();
  for (const record of records) {
    const list = pending.get(record) ?? [];
    list.sort(comparePendingEffects);
    effects.set(
      record,
      list.map((entry) => entry.effect),
    );
  }
  return effects;
}

/**
 * FR-020's response assembly: turns the detection result into the
 * `(file, line, name)`-sorted `FunctionRecord[]` — the analyze method's
 * record payload (research R8's record-level total order). Extraction
 * already emits in that order; sorting here makes the order structural
 * rather than inherited, so the wire guarantee holds whatever order the
 * records arrive in.
 *
 * Each record's `package` is derived through `derivePackage` and its
 * `side_effects` are the detector's attribution for that record (empty
 * for records the detection walk left clean — never fabricated).
 *
 * @param records The extraction records, any order.
 * @param effects The detection result — `detectEffects`' per-record map.
 * @returns The assembled records, sorted by `(file, line, name)`.
 */
export function assembleFunctionRecords(
  records: readonly ExtractionRecord[],
  effects: ReadonlyMap<ExtractionRecord, readonly Effect[]>,
): readonly FunctionRecord[] {
  const assembled = records.map(
    (record): FunctionRecord => ({
      name: record.name,
      package: derivePackage(record.relPath),
      file: record.relPath,
      line: record.line,
      side_effects: effects.get(record) ?? [],
    }),
  );
  assembled.sort(compareFunctionRecords);
  return assembled;
}

/**
 * The `(file, line, name)` record comparison (research R8): codepoint
 * ordering on the file path and name — the platform-default string
 * comparison the wire contract's golden tests pin — with numeric line
 * ordering between them. Total on the assembled record set.
 *
 * @param a Left record.
 * @param b Right record.
 * @returns The three-key comparison result.
 */
function compareFunctionRecords(a: FunctionRecord, b: FunctionRecord): number {
  if (a.file !== b.file) {
    return a.file < b.file ? -1 : 1;
  }
  if (a.line !== b.line) {
    return a.line - b.line;
  }
  if (a.name !== b.name) {
    return a.name < b.name ? -1 : 1;
  }
  return 0;
}

/**
 * FR-020's within-record effect order: `(line, column, canonical type
 * name)` with codepoint comparison for the type name and `0` on
 * full-key ties so the platform-default stable sort keeps emission
 * order (declaration order for same-position same-type pairs).
 *
 * @param a Left effect.
 * @param b Right effect.
 * @returns The three-key comparison result.
 */
function comparePendingEffects(a: PendingEffect, b: PendingEffect): number {
  if (a.line !== b.line) {
    return a.line - b.line;
  }
  if (a.column !== b.column) {
    return a.column - b.column;
  }
  if (a.effect.type !== b.effect.type) {
    return a.effect.type < b.effect.type ? -1 : 1;
  }
  return 0;
}

/**
 * The one detail payload every FR-017 ambiguity effect carries
 * (`{"confidence": "ambiguous"}`) — shared so the wire shape is
 * structurally uniform across every ambiguity rule (the wire test pins
 * the exact object on every `detail`-bearing effect).
 */
const AMBIGUOUS_DETAIL: Readonly<Record<string, unknown>> = Object.freeze({
  confidence: "ambiguous",
});

/**
 * Constructs one pending effect through the canonical-type resolver
 * (FR-018): `resolveSideEffectType` passes canonical names through, so a
 * miss is a programming error in this module's rules and fails loud
 * (Constitution Principle I) rather than emitting an invalid type.
 * `location` is the construct's root-relative `file:line:col` from the
 * node's no-trivia start (R6.6); `target` and `detail` are included only
 * when the rule pins one (the omit-unset-optionals rule, models.md).
 *
 * @param type The canonical side-effect type name.
 * @param description Deterministic description template.
 * @param relPath Root-relative POSIX path of the declaring file.
 * @param node The construct node — the location's anchor.
 * @param sourceFile The declaring source, for position math.
 * @param target The R6.6 target, when the rule pins one.
 * @param detail The opaque detail payload, when the rule pins one.
 * @returns The pending effect, with its numeric sort keys.
 * @throws Error when `type` resolves to no canonical side-effect type.
 */
function constructEffect(
  type: string,
  description: string,
  relPath: string,
  node: Node,
  sourceFile: SourceFile,
  target?: string,
  detail?: Readonly<Record<string, unknown>>,
): PendingEffect {
  const canonical = resolveSideEffectType(type);
  if (canonical === undefined) {
    throw new Error(`Invalid side effect type: ${type}`);
  }
  const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  const location = `${relPath}:${position.line + 1}:${position.character + 1}`;
  const effect: Effect = {
    type: canonical,
    description,
    location,
    ...(target === undefined ? {} : { target }),
    ...(detail === undefined ? {} : { detail }),
  };
  return {
    effect,
    line: position.line + 1,
    column: position.character + 1,
  };
}

/**
 * The per-file first-record candidate for `SentinelError` attachment
 * (FR-013): the record and its source, plus the `(line, position)` the
 * minimal-scan compares. Position is the record node's no-trivia start,
 * which resolves same-line ties by source order — exactly the "first
 * record in source order" the rule names, independent of the global
 * `(file, line, name)` sort a same-line name tie could reorder.
 */
type FileFirstRecord = {
  readonly record: ExtractionRecord;
  readonly sourceFile: SourceFile;
  readonly line: number;
  readonly position: number;
};

/**
 * Attaches each file's `SentinelError` declarations to its first record
 * (FR-013; research R6 decision 2). The first record is identified by
 * minimal `(line, position)` across the file's records — before any
 * global ordering is assumed — so the attachment is a pure function of
 * the file's source layout. A file whose records list is empty (no
 * functions declared) never appears here and attaches nothing: its
 * sentinels go unreported, exactly the documented no-record case.
 *
 * @param records The extraction records, any order.
 * @param pending The per-record pending-effect lists to append to.
 */
function attachSentinelEffects(
  records: readonly ExtractionRecord[],
  pending: Map<ExtractionRecord, PendingEffect[]>,
): void {
  const firstPerFile = new Map<string, FileFirstRecord>();
  for (const record of records) {
    const sourceFile = record.node.getSourceFile();
    const position = record.node.getStart(sourceFile);
    const known = firstPerFile.get(record.relPath);
    if (
      known === undefined ||
      record.line < known.line ||
      (record.line === known.line && position < known.position)
    ) {
      firstPerFile.set(record.relPath, {
        record,
        sourceFile,
        line: record.line,
        position,
      });
    }
  }
  for (const first of firstPerFile.values()) {
    const list = pending.get(first.record);
    if (list === undefined) {
      continue;
    }
    for (const sentinel of moduleScopeSentinelDeclarations(first.sourceFile)) {
      list.push(
        constructEffect(
          "SentinelError",
          sentinel.description,
          first.record.relPath,
          sentinel.node,
          first.sourceFile,
        ),
      );
    }
  }
}

/**
 * One module-scope sentinel declaration (FR-013): the statement node
 * carrying the declaration (the effect's location anchor) and the
 * deterministic description naming what it declares.
 */
type SentinelDeclaration = {
  readonly node: Node;
  readonly description: string;
};

/**
 * Collects the module-scope Error sentinels of one file (FR-013):
 * Error-subclass class declarations and Error-instance constants,
 * declared directly under the `SourceFile` (module scope — sentinels
 * nested in functions or classes are not module-scope and never match).
 *
 * Resolution is two-pass so project-local subclasses resolve
 * transitively: the first pass maps every module-scope class name to
 * its `extends` clause's identifier spelling; the second classifies
 * declarations against that map — `class A extends Error` directly,
 * `class B extends A` through the chain (with a cycle guard), and
 * `const e = new B(...)` instance constants through the same
 * `isErrorSubclassName` test. Heritage forms other than a single
 * identifier (`extends lib.Base`, `extends (mixins())`) and non-`new`
 * initializers (`const E = Error` — a class reference, not an instance)
 * resolve to no module-scope class and never match — the documented
 * boundary.
 *
 * @param sourceFile The file whose top-level statements are scanned.
 * @returns The sentinel declarations, in statement order.
 */
function moduleScopeSentinelDeclarations(
  sourceFile: SourceFile,
): SentinelDeclaration[] {
  const classParents = new Map<string, string>();
  for (const statement of sourceFile.statements) {
    if (isClassDeclaration(statement) && statement.name !== undefined) {
      const parent = extendsClauseIdentifier(statement);
      if (parent !== null) {
        classParents.set(statement.name.text, parent);
      }
    }
  }
  const sentinels: SentinelDeclaration[] = [];
  for (const statement of sourceFile.statements) {
    if (isClassDeclaration(statement)) {
      if (
        statement.name !== undefined &&
        isErrorSubclassName(statement.name.text, classParents)
      ) {
        sentinels.push({
          node: statement,
          description: `declares module-scope error subclass ${statement.name.text}`,
        });
      }
      continue;
    }
    if (isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        const name = isIdentifier(declaration.name) ? declaration.name.text : null;
        const constructed = newedConstructorName(declaration.initializer);
        if (
          name !== null &&
          constructed !== null &&
          isErrorSubclassName(constructed, classParents)
        ) {
          sentinels.push({
            node: statement,
            description: `declares module-scope error constant ${name}`,
          });
        }
      }
    }
  }
  return sentinels;
}

/**
 * The identifier spelling of a class declaration's `extends` clause, or
 * `null` when it has none (or the clause is not a single identifier).
 * Only the `extends` clause is consulted — `implements` contributes no
 * inheritance.
 *
 * @param node The class declaration.
 * @returns The extended name as written, or `null`.
 */
function extendsClauseIdentifier(node: ClassDeclaration): string | null {
  if (node.heritageClauses === undefined) {
    return null;
  }
  for (const clause of node.heritageClauses) {
    if (clause.token !== SyntaxKind.ExtendsKeyword) {
      continue;
    }
    for (const type of clause.types) {
      if (isIdentifier(type.expression)) {
        return type.expression.text;
      }
    }
  }
  return null;
}

/**
 * The constructor name of a `new X(...)` initializer, when the
 * initializer is a `new` expression over a single identifier — the form
 * whose instances resolve against the module's classes and the built-in
 * error constructors.
 *
 * @param initializer The variable-declaration initializer, if any.
 * @returns The constructed name, or `null` for every other shape.
 */
function newedConstructorName(initializer: Node | undefined): string | null {
  if (initializer === undefined || !isNewExpression(initializer)) {
    return null;
  }
  return isIdentifier(initializer.expression) ? initializer.expression.text : null;
}

/**
 * Whether a name resolves to an error-constructor chain: a built-in
 * error constructor, or a module-scope class whose `extends` chain
 * (followed through `classParents`, with a cycle guard) terminates at
 * one. Unresolvable names — imports, non-class locals, unresolvable
 * heritage — end the walk as non-errors.
 *
 * @param name The candidate class or constructor name.
 * @param classParents Module-scope class name → extended name.
 * @returns Whether the name is an Error subclass.
 */
function isErrorSubclassName(
  name: string,
  classParents: ReadonlyMap<string, string>,
): boolean {
  const seen = new Set<string>();
  let current: string | undefined = name;
  while (current !== undefined && !seen.has(current)) {
    if (BUILTIN_ERROR_CONSTRUCTORS.has(current)) {
      return true;
    }
    seen.add(current);
    current = classParents.get(current);
  }
  return false;
}

/**
 * The module-scope import bindings a detection walk resolves against
 * (research R6.4's receiver rules): default-import names
 * (`import d from "m"`) and namespace-import names
 * (`import * as ns from "m"`), each mapped to its module specifier.
 * Named imports bind individual members, not the module object, and are
 * deliberately absent — no rule keys on them. The scan is purely
 * lexical; a function-scope shadow of an imported name is resolved (and
 * excluded) by the walk's scope stack, never here.
 */
type ImportBindings = {
  readonly defaultSpecifiers: ReadonlyMap<string, string>;
  readonly namespaceSpecifiers: ReadonlyMap<string, string>;
};

/**
 * Collects one file's module-scope import bindings: every top-level
 * import declaration with a string-literal module specifier contributes
 * its default-binding name (if any) and its namespace-binding name (if
 * any). A pure function of the file's top-level statements, so the
 * per-record recomputation in `RecordWalker`'s constructor is
 * deterministic; records of one file share the same bounded statement
 * list, keeping the repeated scan trivial.
 *
 * @param sourceFile The file whose import declarations are scanned.
 * @returns The default- and namespace-binding maps, name → specifier.
 */
function scanImportBindings(sourceFile: SourceFile): ImportBindings {
  const defaultSpecifiers = new Map<string, string>();
  const namespaceSpecifiers = new Map<string, string>();
  for (const statement of sourceFile.statements) {
    if (!isImportDeclaration(statement)) {
      continue;
    }
    const specifier = isStringLiteral(statement.moduleSpecifier)
      ? statement.moduleSpecifier.text
      : null;
    const clause = statement.importClause;
    if (specifier === null || clause === undefined) {
      continue;
    }
    if (clause.name !== undefined) {
      defaultSpecifiers.set(clause.name.text, specifier);
    }
    if (clause.namedBindings !== undefined && isNamespaceImport(clause.namedBindings)) {
      namespaceSpecifiers.set(clause.namedBindings.name.text, specifier);
    }
  }
  return { defaultSpecifiers, namespaceSpecifiers };
}

/**
 * One scope frame of the detection walk: the parameter names declared
 * in it and the binding names visible through it. Two flavors:
 *
 * - **Derived** frames mirror an extractor scope-chain frame — the
 *   chain's name set is hoisting-complete by the time extraction
 *   returns, so the frame is fixed and `declares` is a no-op.
 * - **Entered** frames are created when the walk descends into an
 *   anonymous function-like below the record — parameters seed a live,
 *   growing name set that collects the body's declarations as the walk
 *   proceeds (the later tiers' write classification reads it, so a
 *   local inside a callback never misresolves to an outer scope).
 *
 * Parameter resolution is the walker's: it scans the stack innermost
 * frame outward and asks the first frame that binds the name whether it
 * bound it as a parameter — shadowing resolved by scope order.
 */
class DetectionScope {
  readonly params: ReadonlySet<string>;
  private readonly fixed: ReadonlySet<string>;
  private readonly growing: Set<string> | undefined;

  private constructor(
    params: ReadonlySet<string>,
    fixed: ReadonlySet<string>,
    growing: Set<string> | undefined,
  ) {
    this.params = params;
    this.fixed = fixed;
    this.growing = growing;
  }

  /** A chain-derived frame: `names` is complete; nothing grows. */
  static derived(
    params: ReadonlySet<string>,
    names: ReadonlySet<string>,
  ): DetectionScope {
    return new DetectionScope(params, names, undefined);
  }

  /** A walk-entered frame: parameters seed a live, growing set. */
  static entered(params: ReadonlySet<string>): DetectionScope {
    return new DetectionScope(params, EMPTY_NAMES, new Set(params));
  }

  /** Whether the frame makes `name` visible (as parameter or local). */
  binds(name: string): boolean {
    return this.fixed.has(name) || (this.growing?.has(name) ?? false);
  }

  /** Records a declaration into the frame, when it grows. */
  declares(name: string): void {
    this.growing?.add(name);
  }
}

/**
 * The function-like node union the walk dispatches over: every form the
 * R4 table extracts, plus the anonymous expression forms it traverses
 * into the enclosing record. All members carry `parameters` (and a
 * `body`, possibly expression-typed for arrows).
 */
type FunctionLikeNode =
  | ArrowFunction
  | FunctionDeclaration
  | FunctionExpression
  | MethodDeclaration
  | ConstructorDeclaration
  | GetAccessorDeclaration
  | SetAccessorDeclaration;

/**
 * Type guard for the function-like union.
 *
 * @param node The node to test.
 * @returns Whether the node is one of the seven function-like forms.
 */
function isFunctionLikeNode(node: Node): node is FunctionLikeNode {
  return (
    isFunctionDeclaration(node) ||
    isMethodDeclaration(node) ||
    isConstructorDeclaration(node) ||
    isGetAccessorDeclaration(node) ||
    isSetAccessorDeclaration(node) ||
    isArrowFunction(node) ||
    isFunctionExpression(node)
  );
}

/**
 * The innermost function-like enclosing a node, by parent climb. The
 * detection walk never descends into extracted function-likes, so for
 * any visited node this is the record root or an anonymous function
 * entered during the walk — never a nested record's own scope (the
 * same invariant `ancestorFunctionLikes` relies on, innermost-first
 * here because the yield rule wants the immediately enclosing
 * function only).
 *
 * @param node The node to climb from (exclusive).
 * @returns The innermost enclosing function-like, or `undefined` at
 * module level.
 */
function enclosingFunctionLike(node: Node): FunctionLikeNode | undefined {
  for (
    let current: Node | undefined = node.parent;
    current !== undefined;
    current = current.parent
  ) {
    if (isFunctionLikeNode(current)) {
      return current;
    }
  }
  return undefined;
}

/**
 * Whether a function-like is a synchronous generator (`function*`,
 * method-with-asterisk): carries the asterisk token and no `async`
 * modifier. Async generators yield `AsyncGeneratorYield` (the P2 arm
 * below) and plain functions carry no asterisk.
 *
 * @param node The function-like, when one encloses the yield.
 * @returns Whether the function is a synchronous generator.
 */
function isSyncGenerator(node: FunctionLikeNode | undefined): boolean {
  return (
    node !== undefined &&
    node.asteriskToken !== undefined &&
    (node.modifierFlags & ModifierFlags.Async) === 0
  );
}

/**
 * Whether a function-like is an async generator (`async function*`,
 * async-generator methods): carries the asterisk token and the `async`
 * modifier — the `AsyncGeneratorYield` arm of the yield rule (the
 * disposition table's P2 row; arrows can never qualify, they carry no
 * asterisk).
 *
 * @param node The function-like, when one encloses the yield.
 * @returns Whether the function is an async generator.
 */
function isAsyncGenerator(node: FunctionLikeNode | undefined): boolean {
  return (
    node !== undefined &&
    node.asteriskToken !== undefined &&
    (node.modifierFlags & ModifierFlags.Async) !== 0
  );
}

/**
 * Whether a function-like node is one of the R4 forms that owns its own
 * extraction record — the mirrored half of the attribution contract
 * (FR-009): the detection walk stops at exactly these, while
 * `extract.ts` emits a record for exactly these. Conditions mirror
 * `extract.ts`: body-bearing declarations, methods, accessors, and
 * constructors; expression forms only in a name-giving parent position.
 *
 * @param node The node to test.
 * @returns Whether the node's constructs belong to its own record.
 */
function isExtractedFunctionLike(node: Node): boolean {
  if (isFunctionDeclaration(node)) {
    return node.body !== undefined;
  }
  if (
    isMethodDeclaration(node) ||
    isConstructorDeclaration(node) ||
    isGetAccessorDeclaration(node) ||
    isSetAccessorDeclaration(node)
  ) {
    return node.body !== undefined;
  }
  if (isArrowFunction(node) || isFunctionExpression(node)) {
    return isNamedExpressionPosition(node);
  }
  return false;
}

/**
 * Whether an expression form sits in a parent position that names it —
 * the R4 record condition for arrows and function expressions, mirrored
 * from `extract.ts` (a destructuring pattern cannot initialize from a
 * function, so only an identifier variable name names one).
 *
 * @param node The arrow or function expression.
 * @returns Whether the parent shape gives the function a record name.
 */
function isNamedExpressionPosition(node: ArrowFunction | FunctionExpression): boolean {
  const parent = node.parent;
  if (isVariableDeclaration(parent)) {
    return parent.initializer === node && isIdentifier(parent.name);
  }
  if (isPropertyAssignment(parent) || isPropertyDeclaration(parent)) {
    return parent.initializer === node;
  }
  return isExportAssignment(parent) && parent.expression === node;
}

/**
 * The function-likes lexically enclosing (and including) a node,
 * outermost-first. Each corresponds 1:1 to a function frame of the
 * record's scope chain — the correspondence `buildInitialScopes` zips
 * to recover each frame's parameter names from the ancestor node.
 *
 * @param node The node to climb from (inclusive).
 * @returns The enclosing function-likes, outermost-first.
 */
function ancestorFunctionLikes(node: Node): FunctionLikeNode[] {
  const ancestors: FunctionLikeNode[] = [];
  for (
    let current: Node | undefined = node;
    current !== undefined;
    current = current.parent
  ) {
    if (isFunctionLikeNode(current)) {
      ancestors.push(current);
    }
  }
  ancestors.reverse();
  return ancestors;
}

/**
 * Collects the parameter binding names of a function-like's parameter
 * list, recursing through destructuring patterns so every bound
 * spelling resolves — the same collection `extract.ts` performs for its
 * scope frames, mirrored here for the detection scopes.
 *
 * @param parameters The parameter list.
 * @returns The bound parameter names.
 */
function paramNames(parameters: NodeArray<ParameterDeclaration>): Set<string> {
  const names = new Set<string>();
  for (const parameter of parameters) {
    collectBindingNames(parameter.name, names);
  }
  return names;
}

/**
 * Collects a binding name into a set, recursing through destructuring
 * patterns; pattern holes bind nothing.
 *
 * @param name The binding-name node.
 * @param names The accumulating name set.
 */
function collectBindingNames(name: BindingName, names: Set<string>): void {
  if (isIdentifier(name)) {
    names.add(name.text);
    return;
  }
  for (const element of name.elements) {
    if (isBindingElement(element) && element.name !== undefined) {
      collectBindingNames(element.name, names);
    }
  }
}

/**
 * Whether a call is `Promise.reject(...)` (FR-012's third rejection
 * form): a property access `Promise.reject` as the whole callee.
 *
 * @param node The call expression.
 * @returns Whether the callee is `Promise.reject`.
 */
function isPromiseRejectCall(node: CallExpression): boolean {
  const callee = node.expression;
  return (
    isPropertyAccessExpression(callee) &&
    callee.name.text === "reject" &&
    isIdentifier(callee.expression) &&
    callee.expression.text === "Promise"
  );
}

/**
 * Whether a call is `process.exit(...)` (FR-012's terminal form): a
 * property access `process.exit` as the whole callee. Indirections
 * (`const die = process.exit; die(1)`) and renamed imports are outside
 * the strict tier's name-form — a documented boundary, never a guess.
 *
 * @param node The call expression.
 * @returns Whether the callee is `process.exit`.
 */
function isProcessExitCall(node: CallExpression): boolean {
  const callee = node.expression;
  return (
    isPropertyAccessExpression(callee) &&
    callee.name.text === "exit" &&
    isIdentifier(callee.expression) &&
    callee.expression.text === "process"
  );
}

/**
 * Whether a call is one of the closed scheduling constructs (research
 * R6.5): bare timer globals, promise continuations, DOM-style event
 * registration, and Node's `process.nextTick`. This mirrors
 * `extract.ts`'s scheduling set exactly, so the detector's deferral
 * attribution consumes precisely the callbacks the extractor's
 * `deferred` flag names — never a wider or narrower set (Constitution
 * Principle I: the two walks must agree on what "deferred" means).
 *
 * @param node The call expression.
 * @returns Whether the call schedules a callback.
 */
function isSchedulingCall(node: CallExpression): boolean {
  const callee = node.expression;
  if (isIdentifier(callee)) {
    return TIMER_GLOBAL_NAMES.has(callee.text);
  }
  if (!isPropertyAccessExpression(callee)) {
    return false;
  }
  if (DEFERRED_CALLBACK_METHODS.has(callee.name.text)) {
    return true;
  }
  return (
    callee.name.text === "nextTick" &&
    isIdentifier(callee.expression) &&
    callee.expression.text === "process"
  );
}

/**
 * Whether a function-like node is a scheduling callback (research
 * R6.5): an argument of a closed-set scheduling call. Everything it
 * lexically contains executes after the enclosing function returns —
 * the deferral boundary `DeferredReturnMutation` attributes.
 *
 * @param node The function-like node.
 * @returns Whether the node is an argument of a scheduling call.
 */
function isSchedulingCallbackArgument(node: Node): boolean {
  const parent = node.parent;
  return (
    isCallExpression(parent) &&
    parent.arguments.some((argument) => argument === node) &&
    isSchedulingCall(parent)
  );
}

/**
 * Whether a call is one of FR-016's five spawn forms: the three bare
 * timer globals and Node's `process.nextTick` (with `new Promise(...)`
 * matched at the `NewExpression` dispatch). Promise continuations and
 * event registration schedule callbacks but spawn nothing — they are
 * deliberately absent from the spawn set.
 *
 * @param node The call expression.
 * @returns Whether the call spawns an asynchronous task.
 */
function isSpawnCall(node: CallExpression): boolean {
  const callee = node.expression;
  if (isIdentifier(callee)) {
    return TIMER_GLOBAL_NAMES.has(callee.text);
  }
  return (
    isPropertyAccessExpression(callee) &&
    callee.name.text === "nextTick" &&
    isIdentifier(callee.expression) &&
    callee.expression.text === "process"
  );
}

/**
 * Whether a `new` expression is FR-016's fifth spawn form — `new
 * Promise(...)` over the bare global identifier. Every other
 * construction is inert here (constructor calls as a whole are T018's
 * ambiguity surface, never fabricated by the P1 rules).
 *
 * @param node The new expression.
 * @returns Whether the construction spawns a task.
 */
function isPromiseConstruction(node: NewExpression): boolean {
  return isIdentifier(node.expression) && node.expression.text === "Promise";
}

/**
 * Whether an expression is spelled `process.stdout` or
 * `process.stderr` — `WriterOutput`'s documented exclusion: the stdio
 * streams belong to StdoutWrite/StderrWrite (the stdio families below),
 * never WriterOutput (research R6.4).
 *
 * @param receiver The expression to test.
 * @returns Whether the expression is a process stdio stream.
 */
function isProcessStdioReceiver(receiver: Expression): boolean {
  return (
    isPropertyAccessExpression(receiver) &&
    (receiver.name.text === "stdout" || receiver.name.text === "stderr") &&
    isIdentifier(receiver.expression) &&
    receiver.expression.text === "process"
  );
}

/**
 * Whether a `new` expression is `new WebAssembly.Instance(...)` — one of
 * `CgoCall`'s two WebAssembly forms (the disposition table: the closest
 * foreign-function surface).
 *
 * @param node The new expression.
 * @returns Whether the construction instantiates WebAssembly.
 */
function isWebAssemblyInstanceConstruction(node: NewExpression): boolean {
  return (
    isPropertyAccessExpression(node.expression) &&
    node.expression.name.text === "Instance" &&
    isIdentifier(node.expression.expression) &&
    node.expression.expression.text === "WebAssembly"
  );
}

/**
 * Whether a property-form callee is spelled `WebAssembly.instantiate` —
 * `CgoCall`'s call form (the disposition table).
 *
 * @param callee The property-access callee.
 * @returns Whether the callee instantiates WebAssembly.
 */
function isWebAssemblyInstantiateCallee(callee: PropertyAccessExpression): boolean {
  return (
    callee.name.text === "instantiate" &&
    isIdentifier(callee.expression) &&
    callee.expression.text === "WebAssembly"
  );
}

/**
 * Whether a dot-property write target is spelled `process.env.X` — the
 * `EnvVarMutation` form (the disposition table). Only the dot form is
 * pinned; `process.env[k]` element writes are a documented boundary.
 *
 * @param target The written property-access target.
 * @returns Whether the target path runs through `process.env`.
 */
function isProcessEnvTarget(target: PropertyAccessExpression): boolean {
  const base = target.expression;
  return (
    isPropertyAccessExpression(base) &&
    base.name.text === "env" &&
    isIdentifier(base.expression) &&
    base.expression.text === "process"
  );
}

/**
 * The class-member kinds that can carry decorators (the disposition
 * table's "classes and class members" surface): methods, properties, and
 * accessors. Constructors and static blocks cannot be decorated
 * themselves, and parameter decorators are outside the pinned surface —
 * a documented boundary.
 */
type DecoratableMember =
  | MethodDeclaration
  | PropertyDeclaration
  | GetAccessorDeclaration
  | SetAccessorDeclaration;

/**
 * Type guard for the decoratable member union.
 *
 * @param node The node to test.
 * @returns Whether the node is a method, property, or accessor
 * declaration.
 */
function isDecoratableMember(node: Node): node is DecoratableMember {
  return (
    isMethodDeclaration(node) ||
    isPropertyDeclaration(node) ||
    isGetAccessorDeclaration(node) ||
    isSetAccessorDeclaration(node)
  );
}

/**
 * Whether a checker type is array-like (FR-015's `SliceMutation` arm):
 * tuple types and references to `Array` — plain and `readonly` element
 * types alike, both are Array references — with unions recursing into
 * their constituents. The type authority is the checker (Constitution
 * Principle III): this is a shape test on its answer, never a
 * re-derivation of TypeScript semantics.
 *
 * @param type The checker type, when one is available.
 * @returns Whether the type is array-like.
 */
function isArrayLikeType(type: Type | undefined): boolean {
  if (type === undefined) {
    return false;
  }
  if (type.isTupleType()) {
    return true;
  }
  if (type.isTypeReference()) {
    return type.getTarget().getSymbol()?.name === "Array";
  }
  if (type.isUnionType()) {
    return type.getTypes().some((constituent) => isArrayLikeType(constituent));
  }
  return false;
}

/**
 * The declared name of a checker type's symbol (`Map`, `WeakSet`, a
 * project class), when it has one — the typed half of the receiver
 * rules. `undefined` for intrinsics, literals, and unresolved shapes,
 * which fall back to the name-form rules.
 *
 * @param type The checker type, when one is available.
 * @returns The type symbol's name, or `undefined`.
 */
function typeSymbolName(type: Type | undefined): string | undefined {
  return type?.getSymbol()?.name;
}

/**
 * The R6.6 target of a `throw`: the constructor name for
 * `throw new X(...)` — the identifier or property-access spelling as
 * written — and omitted for every other thrown expression.
 *
 * @param expression The thrown expression, if any.
 * @param sourceFile The declaring source, for the text slice.
 * @returns The constructor spelling, or `undefined`.
 */
function thrownConstructorName(
  expression: Expression | undefined,
  sourceFile: SourceFile,
): string | undefined {
  if (
    expression !== undefined &&
    isNewExpression(expression) &&
    (isIdentifier(expression.expression) ||
      isPropertyAccessExpression(expression.expression))
  ) {
    return expression.expression.getText(sourceFile);
  }
  return undefined;
}

/**
 * Whether an operator-token kind is one of the sixteen assignment
 * operators (simple, compound, and logical-assignment) — the
 * `FirstAssignment`..`LastAssignment` kind range, which excludes every
 * comparison operator.
 *
 * @param kind The operator token's syntax kind.
 * @returns Whether the operator writes.
 */
function isAssignmentOperator(kind: SyntaxKind): boolean {
  return kind >= SyntaxKind.FirstAssignment && kind <= SyntaxKind.LastAssignment;
}

/**
 * One record's P0/P1 detection walk (FR-009 attribution; research R6):
 * a fresh pre-order visitor over the record's own function-like node,
 * with a scope stack seeded from the record's chain and grown as the
 * walk descends into anonymous function-likes. Effects accumulate into
 * {@link pending} — unsorted; `detectEffects` applies FR-020's order.
 */
class RecordWalker {
  readonly pending: PendingEffect[] = [];
  private readonly record: ExtractionRecord;
  private readonly sourceFile: SourceFile;
  private readonly scopes: DetectionScope[];
  /** The live checker in program mode; `undefined` in parse-only. */
  private readonly checker: Checker | undefined;
  /**
   * The declaring file's module-scope import bindings — the fs-receiver
   * and MonkeyPatch namespace rules resolve receiver identifiers against
   * them (research R6.4), with the scope stack settling shadows.
   */
  private readonly imports: ImportBindings;
  /**
   * Scope-stack indices of the deferred-callback frames the walk is
   * inside (research R6.5): a write to a function-scope binding
   * declared outside one of these frames, from inside it, is a
   * `DeferredReturnMutation`. Seeded from a `deferred` record's own
   * ancestors; grown when the walk enters a scheduling callback
   * argument; popped when it leaves.
   */
  private readonly boundaries: number[];

  constructor(record: ExtractionRecord, checker: Checker | undefined) {
    this.record = record;
    this.sourceFile = record.node.getSourceFile();
    this.checker = checker;
    this.imports = scanImportBindings(this.sourceFile);
    this.scopes = buildInitialScopes(record);
    this.boundaries = initialDeferredBoundaries(record);
  }

  /** Walks the record's own function-like node. */
  walk(): void {
    const root = asFunctionLike(this.record.node);
    // The record's own expression-bodied arrow (FR-011): the body IS
    // the returned value, so the implicit return reports at the
    // expression's start.
    if (isArrowFunction(root) && !isBlock(root.body)) {
      this.emit("ReturnValue", "arrow expression body returns a value", root.body);
    }
    this.walkChildren(root);
  }

  /**
   * Emits one effect for this record at `node`'s location, through the
   * canonical-type resolver.
   */
  private emit(type: string, description: string, node: Node, target?: string): void {
    this.pending.push(
      constructEffect(
        type,
        description,
        this.record.relPath,
        node,
        this.sourceFile,
        target,
      ),
    );
  }

  /**
   * Emits one FR-017 ambiguity effect: `CallbackInvocation` carrying
   * `detail: {"confidence": "ambiguous"}`, the carrier the wire contract
   * reserves for detection that cannot resolve the invoked function.
   * The description names the unresolved construct (research R7's
   * decision text); it is a deterministic template like every other.
   */
  private emitAmbiguous(description: string, node: Node): void {
    this.pending.push(
      constructEffect(
        "CallbackInvocation",
        description,
        this.record.relPath,
        node,
        this.sourceFile,
        undefined,
        AMBIGUOUS_DETAIL,
      ),
    );
  }

  /**
   * The dispatch: nested extracted function-likes stop the walk; other
   * function-likes are entered anonymously with their own scope; each
   * pinned construct family emits and continues the descent — constructs
   * nest (`return promise.then(...)`, writes inside callbacks), so no
   * match short-circuits the traversal.
   */
  private visit(node: Node): void {
    if (isFunctionDeclaration(node)) {
      // The declaration binds its name into the enclosing scope (a
      // body-less overload binds too), then a body-bearing declaration
      // stops the walk — its record owns that body.
      if (node.name !== undefined) {
        this.declareName(node.name.text);
      }
      if (node.body === undefined) {
        this.walkChildren(node);
      }
      return;
    }
    if (isFunctionLikeNode(node)) {
      if (isExtractedFunctionLike(node)) {
        return;
      }
      this.visitAnonymousFunctionLike(node);
      return;
    }
    if (isReturnStatement(node)) {
      // FR-011: only a value-carrying return matches; bare `return;`
      // reports nothing.
      if (node.expression !== undefined) {
        this.emit("ReturnValue", "return statement returns a value", node);
      }
      this.walkChildren(node);
      return;
    }
    if (isThrowStatement(node)) {
      this.visitThrow(node);
      return;
    }
    if (isCallExpression(node)) {
      this.visitCall(node);
      return;
    }
    if (isNewExpression(node)) {
      this.visitNew(node);
      return;
    }
    if (isYieldExpression(node)) {
      this.visitYield(node);
      return;
    }
    if (isBinaryExpression(node)) {
      if (isAssignmentOperator(node.operatorToken.kind)) {
        this.emitWrite(node, node.left);
      }
      this.walkChildren(node);
      return;
    }
    if (isPostfixUnaryExpression(node) || isPrefixUnaryExpression(node)) {
      if (
        node.operator === SyntaxKind.PlusPlusToken ||
        node.operator === SyntaxKind.MinusMinusToken
      ) {
        this.emitWrite(node, node.operand);
      }
      this.walkChildren(node);
      return;
    }
    if (isDeleteExpression(node)) {
      this.emitWrite(node, node.expression);
      this.walkChildren(node);
      return;
    }
    if (isVariableStatement(node)) {
      this.visitVariableStatement(node);
      return;
    }
    if (isClassDeclaration(node) || isClassExpression(node)) {
      this.visitClassLike(node);
      return;
    }
    this.declareBinding(node);
    this.walkChildren(node);
  }

  /**
   * FR-012's dual emission for `throw`: `ErrorReturn` + `ErrorSignal`
   * at the throw statement, both targeting the constructor name for
   * `throw new X(...)` (omitted otherwise). Async functions need no
   * case of their own — every throw dual-emits identically, which is
   * the rejection-channel rule.
   */
  private visitThrow(node: ThrowStatement): void {
    const thrown = thrownConstructorName(node.expression, this.sourceFile);
    this.emit("ErrorReturn", "throws an error to the caller", node, thrown);
    this.emit("ErrorSignal", "signals an error", node, thrown);
    this.walkChildren(node);
  }

  /**
   * `ResourceManagement`'s declaration arm (the disposition table): a
   * `using`/`await using` statement — on the native compiler
   * (typescript 7.0.2) both parse as a VariableStatement whose
   * declaration list carries `NodeFlags.Using` (the `await using` form
   * additionally carries `AwaitUsing`; one bit test covers both). The
   * declared names bind normally through the declaration-list descent,
   * exactly as a `const` statement's do.
   */
  private visitVariableStatement(node: VariableStatement): void {
    if ((node.declarationList.flags & NodeFlags.Using) !== 0) {
      this.emit("ResourceManagement", "declares a using-scoped resource", node);
    }
    this.walkChildren(node);
  }

  /**
   * `DescriptorEffect` (the disposition table): every decorator on a
   * class-like inside a walked body — the class's own and its
   * decoratable members' — collected at the class level because the
   * walk stops at extracted method bodies before reaching their
   * decorator nodes, and a decorator executes at class-definition time
   * (inside the enclosing record), never in the decorated method's own
   * frame. A class declaration still binds its name into the enclosing
   * scope (`declareBinding`'s half of this branch); class expressions
   * bind their names only inside themselves. Decorator factory
   * arguments on member decorators are not descended (the member's
   * extracted-body boundary) — a documented boundary.
   */
  private visitClassLike(node: ClassDeclaration | ClassExpression): void {
    for (const modifier of node.modifiers ?? []) {
      if (isDecorator(modifier)) {
        this.emit("DescriptorEffect", "applies a decorator to a class", modifier);
      }
    }
    for (const member of node.members) {
      if (!isDecoratableMember(member)) {
        continue;
      }
      for (const modifier of member.modifiers ?? []) {
        if (isDecorator(modifier)) {
          this.emit(
            "DescriptorEffect",
            "applies a decorator to a class member",
            modifier,
          );
        }
      }
    }
    this.declareBinding(node);
    this.walkChildren(node);
  }

  /**
   * The named-call forms: `Promise.reject(...)` dual-emits
   * `ErrorReturn` + `ErrorSignal` (the rejection channel), and
   * `process.exit(...)` emits `ErrorSignal` + `ProcessExit` — never
   * `ErrorReturn`, the terminal carve-out. Everything else falls to
   * the P1 call families; unmatched calls — including those whose
   * callee or arguments nest detectable constructs — simply descend.
   */
  private visitCall(node: CallExpression): void {
    if (isPromiseRejectCall(node)) {
      this.emit("ErrorReturn", "returns a rejected promise", node);
      this.emit("ErrorSignal", "signals a rejected promise", node);
    } else if (isProcessExitCall(node)) {
      this.emit("ErrorSignal", "signals an error through process exit", node);
      this.emit("ProcessExit", "terminates the process", node);
    } else {
      this.visitP1Call(node);
    }
    this.walkChildren(node);
  }

  /**
   * The bare-callee call families (FR-015/FR-016 plus the P2/P3 rows
   * that key on the callee alone): the spawn forms — emitted as the
   * `AsyncTaskSpawn` alias, which the canonical-type resolver maps to
   * `GoroutineSpawn` before the effect is constructed (FR-018) — the
   * dynamic `import(...)` and `require(...)` module side effects (the
   * callee of the former is the `import` keyword token itself), then
   * the bare-identifier channel/stream globals (`postMessage`, the
   * Worker/window global form; `pipeline`, the node:stream/promises
   * form). The unclaimed callee forms then fall to FR-017's ambiguity
   * remainder: computed-member calls (`obj[key]()`, a syntactic form
   * reported in both modes), `eval(...)`, and — program mode only —
   * bare callees the checker resolves to no declaration (unknown
   * globals). Everything else reports nothing: research R7's carve-out
   * treats lexically-bound bare callees (parameters, locally-defined
   * functions, imported symbols) as resolved, their effects belonging
   * to their own records, and the parse-only mode boundary leaves
   * unresolvable bare callees unreported rather than flooding the mode.
   */
  private visitP1Call(node: CallExpression): void {
    if (isSpawnCall(node)) {
      this.emit("AsyncTaskSpawn", "spawns an asynchronous task", node);
      return;
    }
    if (node.expression.kind === SyntaxKind.ImportKeyword) {
      this.emit("ImportSideEffect", "dynamically imports a module", node);
      return;
    }
    const callee = node.expression;
    if (isPropertyAccessExpression(callee)) {
      this.visitMethodCall(node, callee);
      return;
    }
    if (isElementAccessExpression(callee)) {
      // A syntactic ambiguity form (research R7): no name-form family
      // can match a computed callee — there is no property name to key
      // on — so the dynamic dispatch itself is the reportable fact.
      this.emitAmbiguous("calls through a computed member", node);
      return;
    }
    if (isIdentifier(callee)) {
      if (callee.text === "postMessage") {
        this.emit("ChannelSend", "sends a message to a channel", node);
        return;
      }
      if (callee.text === "pipeline") {
        this.emit("StreamOutput", "pipes a stream", node);
        return;
      }
      if (callee.text === "require") {
        this.emit("ImportSideEffect", "requires a module", node);
        return;
      }
      // `eval` is one of R7's always-forms: it resolves to a lib
      // declaration in program mode, so the syntactic check must
      // precede the symbol-resolution rule.
      if (callee.text === "eval") {
        this.emitAmbiguous("evaluates a string dynamically through eval", node);
        return;
      }
      if (this.isUnresolvedCallee(callee)) {
        this.emitAmbiguous(`calls the unresolved global ${callee.text}`, node);
      }
    }
  }

  /**
   * Whether a bare-identifier callee resolves to no declaration — the
   * program-mode half of FR-017's type-based ambiguity (unknown
   * globals; research R7). Parse-only has no symbol resolution, and R7
   * documents that boundary explicitly: unresolvable bare callees stay
   * unreported there instead of turning every non-lexical helper call
   * into noise. A callee the checker resolves — a parameter, a
   * locally-defined function, an import, a known global — keeps the
   * zero-false-positive carve-out.
   */
  private isUnresolvedCallee(callee: Node): boolean {
    if (this.checker === undefined) {
      return false;
    }
    return this.checker.getSymbolAtLocation(callee) === undefined;
  }

  /**
   * One property-form call through the name-form rule families in
   * research R6.4's precedence order — receiver-specific families
   * first: the stdio streams (console, process.std*), then the P1
   * families (HTTP responses, channels, streams), then the fs family
   * and the metaprogramming/Atomics receivers whose method names the
   * generic rules below would otherwise steal (`Reflect.set` vs the
   * membership `set`, `Atomics.add` vs the membership `add`), then the
   * resource-disposal name-form (below ChannelClose, pinned), logging,
   * generic writers, the FR-015 param-write split, and the membership
   * mutators — then the P2/P4 database, cancellation, clock, and
   * WebAssembly name-forms and the typed finalizer arm. The first match
   * wins; every family matches on closed method-name lists or pinned
   * receiver spellings, so an unmatched call reports nothing until
   * `CallbackInvocation`'s parameter-property remainder.
   */
  private visitMethodCall(
    node: CallExpression,
    callee: PropertyAccessExpression,
  ): void {
    const method = callee.name.text;
    const receiver = callee.expression;
    // The P3 stdio families, pinned above every generic writer family
    // (research R6.4): console.* and process.stdout/stderr.write.
    if (this.visitStdioCall(node, method, callee)) {
      return;
    }
    if (HTTP_RESPONSE_METHODS.has(method) && this.isHttpResponseReceiver(receiver)) {
      this.emit("HTTPResponseWrite", "writes to an HTTP response", node);
      return;
    }
    if (method === "postMessage") {
      this.emit("ChannelSend", "sends a message to a channel", node);
      return;
    }
    if (method === "close" && this.isChannelReceiver(receiver)) {
      this.emit("ChannelClose", "closes a channel", node);
      return;
    }
    // The fs family, pinned above WriterOutput (research R6.4).
    if (this.visitFileSystemCall(node, method, receiver)) {
      return;
    }
    // The metaprogramming forms, pinned above the membership `set`.
    if (this.visitMetaprogrammingCall(node, callee)) {
      return;
    }
    // The Atomics family, pinned above the membership `add`.
    if (this.isAtomicsReceiver(receiver)) {
      this.emit("AtomicOp", "performs an atomic shared-memory operation", node);
      return;
    }
    if (method === "pipe") {
      this.emit("StreamOutput", "pipes a stream", node);
      return;
    }
    // ResourceManagement's disposal name-form — below ChannelClose
    // (research R6.4's pinned precedence).
    if (RESOURCE_DISPOSAL_METHODS.has(method)) {
      this.emit("ResourceManagement", "releases a resource", node);
      return;
    }
    if (LOG_WRITE_METHODS.has(method) && this.isLogReceiver(receiver)) {
      this.emit("LogWrite", "writes a log record", node);
      return;
    }
    if (
      WRITER_OUTPUT_METHODS.has(method) &&
      !isProcessStdioReceiver(receiver) &&
      !this.isHttpResponseReceiver(receiver)
    ) {
      this.emit("WriterOutput", "writes through a writer-like receiver", node);
      return;
    }
    if (ARRAY_MUTATOR_METHODS.has(method) && this.isParamReceiver(receiver)) {
      this.emit("SliceMutation", "calls a mutating array method on a parameter", node);
      return;
    }
    if (this.visitMembershipCall(node, method, receiver)) {
      return;
    }
    if (DATABASE_WRITE_METHODS.has(method)) {
      this.emit("DatabaseWrite", "writes to a database", node);
      return;
    }
    if (DATABASE_TRANSACTION_METHODS.has(method)) {
      this.emit("DatabaseTransaction", "manages a database transaction", node);
      return;
    }
    if (this.visitContextCancellationCall(node, method, callee)) {
      return;
    }
    if (this.visitTimeDependencyCall(node, method, callee)) {
      return;
    }
    if (isWebAssemblyInstantiateCallee(callee)) {
      this.emit("CgoCall", "instantiates WebAssembly", node);
      return;
    }
    if (method === "register" && this.isFinalizerRegistryReceiver(receiver)) {
      this.emit("FinalizerRegistration", "registers a finalizer", node);
      return;
    }
    // FR-017's receiver ambiguity — the final remainder, after every
    // name-form family (a claimed call is never ambiguous; research
    // R7's precedence carve-out).
    this.visitReceiverAmbiguity(node, receiver);
  }

  /**
   * FR-017's receiver-based ambiguity remainder for property-form calls
   * (research R7), replacing the earlier parameter-property callback
   * arm: the pinned tests contract `resolve()` inside a Promise
   * executor and `parts.join("-")` to zero effects, so resolved
   * callback invocations are never re-reported — their effects belong
   * to their own records.
   *
   * Parse-only reports the one syntactic form: a receiver the lexical
   * scope stack cannot resolve. Every lexically-resolvable receiver —
   * parameter, local, import, module binding — is treated as resolved
   * (R7's documented parse-only boundary).
   *
   * Program mode reports the type-based form instead, which subsumes
   * the syntactic one: a receiver whose checker type is `any` or the
   * error type. An undeclared receiver types as error (which carries
   * the Any flag, exactly as in classic ts), while a checker-resolved
   * global receiver (`JSON.parse`, declared globals) keeps the
   * zero-false-positive carve-out.
   */
  private visitReceiverAmbiguity(node: CallExpression, receiver: Expression): void {
    let base = receiver;
    while (isParenthesizedExpression(base)) {
      base = base.expression;
    }
    if (!isIdentifier(base)) {
      // Property chains (`this.items.push`), `this`/`super`, and every
      // non-identifier receiver carry no name-form ambiguity surface.
      return;
    }
    if (this.checker === undefined) {
      if (this.bindingScopeIndex(base.text) < 0) {
        this.emitAmbiguous(
          `calls a method on the unresolvable receiver ${base.text}`,
          node,
        );
      }
      return;
    }
    const type = this.typeAt(base);
    if (type !== undefined && (type.flags & TypeFlags.Any) !== 0) {
      this.emitAmbiguous(`calls a method on the any-typed receiver ${base.text}`, node);
    }
  }

  /**
   * The P3 stdio families (the disposition table): `console.log`/
   * `info`/`debug`/`trace` → `StdoutWrite`, `console.error`/`warn` →
   * `StderrWrite`, and `.write` on the process stdio streams. Matched
   * before WriterOutput so the writer name-form never claims them
   * (research R6.4's pinned precedence).
   *
   * @returns Whether a stdio family claimed the call.
   */
  private visitStdioCall(
    node: CallExpression,
    method: string,
    callee: PropertyAccessExpression,
  ): boolean {
    const receiver = callee.expression;
    if (isIdentifier(receiver) && receiver.text === "console") {
      if (CONSOLE_STDOUT_METHODS.has(method)) {
        this.emit("StdoutWrite", "writes to standard output", node);
        return true;
      }
      if (CONSOLE_STDERR_METHODS.has(method)) {
        this.emit("StderrWrite", "writes to standard error", node);
        return true;
      }
      return false;
    }
    if (
      method === "write" &&
      isPropertyAccessExpression(receiver) &&
      isProcessStdioReceiver(receiver)
    ) {
      const toStdout = receiver.name.text === "stdout";
      this.emit(
        toStdout ? "StdoutWrite" : "StderrWrite",
        toStdout ? "writes to standard output" : "writes to standard error",
        node,
      );
      return true;
    }
    return false;
  }

  /**
   * The fs families (the disposition table's FileSystemWrite/Delete/Meta
   * rows): the write/delete/meta name lists on fs receivers — an
   * identifier spelled `fs` (name-form, receiver-blind), an identifier
   * whose default or namespace import resolves to an fs module
   * specifier (shadow-checked through the scope stack), or a
   * `.promises` chain over either. Reads (`readFile`, `stat`, …) claim
   * nothing and fall through.
   *
   * @returns Whether an fs family claimed the call.
   */
  private visitFileSystemCall(
    node: CallExpression,
    method: string,
    receiver: Expression,
  ): boolean {
    if (!this.isFileSystemReceiver(receiver)) {
      return false;
    }
    if (FILE_SYSTEM_WRITE_METHODS.has(method)) {
      this.emit("FileSystemWrite", "writes a file through the fs API", node);
      return true;
    }
    if (FILE_SYSTEM_DELETE_METHODS.has(method)) {
      this.emit("FileSystemDelete", "deletes a filesystem entry", node);
      return true;
    }
    if (FILE_SYSTEM_META_METHODS.has(method)) {
      this.emit("FileSystemMeta", "changes filesystem metadata", node);
      return true;
    }
    return false;
  }

  /**
   * Whether a method receiver is an fs binding: the `fs` spelling (any
   * shape — the canonical name-form), an import-tracked fs binding
   * (default or namespace import from an fs module specifier, excluded
   * when a function-scope frame shadows the name), or a `.promises`
   * property chain over either form.
   */
  private isFileSystemReceiver(receiver: Expression): boolean {
    let base = receiver;
    while (isParenthesizedExpression(base)) {
      base = base.expression;
    }
    if (isIdentifier(base)) {
      return base.text === "fs" || this.isImportedFsBinding(base.text);
    }
    if (isPropertyAccessExpression(base) && base.name.text === "promises") {
      const root = base.expression;
      return (
        isIdentifier(root) &&
        (root.text === "fs" || this.isImportedFsBinding(root.text))
      );
    }
    return false;
  }

  /**
   * Whether a name is an import-tracked fs binding: bound at module
   * scope by a default or namespace import from an fs module specifier,
   * and not shadowed by any function-scope frame the scope stack sees.
   */
  private isImportedFsBinding(name: string): boolean {
    const specifier =
      this.imports.defaultSpecifiers.get(name) ??
      this.imports.namespaceSpecifiers.get(name);
    return (
      specifier !== undefined &&
      FS_MODULE_SPECIFIERS.has(specifier) &&
      this.bindingScopeIndex(name) <= 0
    );
  }

  /**
   * The metaprogramming forms (the disposition table):
   * `Reflect.set`/`Reflect.deleteProperty`/`Object.defineProperty`,
   * matched before the membership mutators so `Reflect.set` is never a
   * `ContainerMutation` (research R6.4's receiver-specific-first rule).
   *
   * @returns Whether a metaprogramming form claimed the call.
   */
  private visitMetaprogrammingCall(
    node: CallExpression,
    callee: PropertyAccessExpression,
  ): boolean {
    const receiver = callee.expression;
    if (!isIdentifier(receiver)) {
      return false;
    }
    const method = callee.name.text;
    if (
      (receiver.text === "Reflect" &&
        (method === "set" || method === "deleteProperty")) ||
      (receiver.text === "Object" && method === "defineProperty")
    ) {
      this.emit(
        "MetaprogrammingMutation",
        "mutates an object through metaprogramming",
        node,
      );
      return true;
    }
    return false;
  }

  /** Whether a receiver is the `Atomics` global (the `AtomicOp` row). */
  private isAtomicsReceiver(receiver: Expression): boolean {
    return isIdentifier(receiver) && receiver.text === "Atomics";
  }

  /**
   * Whether a receiver is logger-like (the `LogWrite` row): the
   * name-form spellings `log`/`logger` (both modes), or — with the
   * checker — a type declared as a `Logger`.
   */
  private isLogReceiver(receiver: Expression): boolean {
    if (isIdentifier(receiver) && LOG_RECEIVER_NAMES.has(receiver.text)) {
      return true;
    }
    const name = typeSymbolName(this.typeAt(receiver));
    return name !== undefined && LOG_TYPE_NAMES.has(name);
  }

  /**
   * The cancellation forms (the `ContextCancellation` row): `.abort()`
   * — the name-form reading of "AbortController receivers" (the method
   * name is cancellation-specific, and receiver-blind matching keeps
   * parse-only symmetric with program mode) — and the static
   * `AbortSignal.throwIfAborted()`.
   *
   * @returns Whether a cancellation form claimed the call.
   */
  private visitContextCancellationCall(
    node: CallExpression,
    method: string,
    callee: PropertyAccessExpression,
  ): boolean {
    const receiver = callee.expression;
    if (method === "abort") {
      this.emit("ContextCancellation", "aborts an AbortController", node);
      return true;
    }
    if (
      method === "throwIfAborted" &&
      isIdentifier(receiver) &&
      receiver.text === "AbortSignal"
    ) {
      this.emit("ContextCancellation", "throws when the signal is aborted", node);
      return true;
    }
    return false;
  }

  /**
   * The clock forms (the `TimeDependency` row): `Date.now()`,
   * `performance.now()`, `process.hrtime()`, and the
   * `process.hrtime.bigint()` chain.
   *
   * @returns Whether a clock form claimed the call.
   */
  private visitTimeDependencyCall(
    node: CallExpression,
    method: string,
    callee: PropertyAccessExpression,
  ): boolean {
    const receiver = callee.expression;
    if (
      method === "now" &&
      isIdentifier(receiver) &&
      (receiver.text === "Date" || receiver.text === "performance")
    ) {
      this.emit("TimeDependency", "reads the current time", node);
      return true;
    }
    if (method === "hrtime" && isIdentifier(receiver) && receiver.text === "process") {
      this.emit("TimeDependency", "reads the current time", node);
      return true;
    }
    if (
      method === "bigint" &&
      isPropertyAccessExpression(receiver) &&
      receiver.name.text === "hrtime" &&
      isIdentifier(receiver.expression) &&
      receiver.expression.text === "process"
    ) {
      this.emit("TimeDependency", "reads the current time", node);
      return true;
    }
    return false;
  }

  /**
   * Whether a receiver is checker-typed as a FinalizationRegistry (the
   * `.register(...)` arm of the `FinalizerRegistration` row — program
   * mode only; parse-only reports the construction form alone).
   */
  private isFinalizerRegistryReceiver(receiver: Expression): boolean {
    const name = typeSymbolName(this.typeAt(receiver));
    return name !== undefined && FINALIZER_TYPE_NAMES.has(name);
  }

  /**
   * The membership mutators (FR-015): `add`/`delete`/`clear` on any
   * receiver and `set` on non-parameter receivers are
   * `ContainerMutation`; `set` on a parameter follows the Map/WeakMap
   * split — `ContainerMutation` when the checker proves a WeakMap,
   * `MapMutation` otherwise, with parse-only taking the `MapMutation`
   * default (the documented type-blind surface).
   *
   * @returns Whether a membership form claimed the call.
   */
  private visitMembershipCall(
    node: CallExpression,
    method: string,
    receiver: Expression,
  ): boolean {
    if (method === "set") {
      if (this.isParamReceiver(receiver)) {
        if (typeSymbolName(this.typeAt(receiver)) === "WeakMap") {
          this.emit(
            "ContainerMutation",
            "mutates membership of a WeakMap parameter",
            node,
          );
        } else {
          this.emit("MapMutation", "mutates a parameter through Map.set", node);
        }
        return true;
      }
      this.emit("ContainerMutation", "mutates membership of a container", node);
      return true;
    }
    if (MEMBERSHIP_MUTATOR_METHODS.has(method)) {
      this.emit("ContainerMutation", "mutates membership of a container", node);
      return true;
    }
    return false;
  }

  /**
   * The construction families: FR-016's fifth spawn form — `new
   * Promise(...)` emits through the `AsyncTaskSpawn` alias (resolved to
   * `GoroutineSpawn`; the alias never appears on the wire) — plus the
   * P3/P4 construction rows: `new Date()` (`TimeDependency`), `new
   * FinalizationRegistry(...)` (`FinalizerRegistration`), and `new
   * WebAssembly.Instance(...)` (`CgoCall`), then FR-017's `new
   * Function(...)` ambiguity form. Every other construction is inert
   * here; each argument's constructs descend normally.
   */
  private visitNew(node: NewExpression): void {
    if (isPromiseConstruction(node)) {
      this.emit("AsyncTaskSpawn", "spawns an asynchronous task", node);
    } else if (isIdentifier(node.expression) && node.expression.text === "Date") {
      this.emit("TimeDependency", "reads the current time", node);
    } else if (
      isIdentifier(node.expression) &&
      node.expression.text === "FinalizationRegistry"
    ) {
      this.emit("FinalizerRegistration", "creates a finalization registry", node);
    } else if (isWebAssemblyInstanceConstruction(node)) {
      this.emit("CgoCall", "constructs a WebAssembly instance", node);
    } else if (isIdentifier(node.expression) && node.expression.text === "Function") {
      // FR-017's second always-form: `new Function(...)` builds a
      // function from a dynamic string — the executed effects cannot
      // be resolved statically. It resolves to a lib declaration in
      // program mode, so the match is syntactic, the `eval` precedent.
      // No other construction is ambiguous: `new Set<string>()` and
      // kin resolve to declarations and stay clean (the carve-out).
      this.emitAmbiguous(
        "constructs a function dynamically through new Function",
        node,
      );
    }
    this.walkChildren(node);
  }

  /**
   * The yield rule (FR-016 plus the P2 sibling): `yield`/`yield*`
   * whose innermost enclosing function-like — found by the parent
   * climb, the record root or an anonymous function entered during the
   * walk — is a synchronous generator emits `GeneratorYield`; an async
   * generator emits `AsyncGeneratorYield`. The yield's own expression
   * may nest writes, so the descent continues.
   */
  private visitYield(node: YieldExpression): void {
    const enclosing = enclosingFunctionLike(node);
    if (isSyncGenerator(enclosing)) {
      this.emit(
        "GeneratorYield",
        node.asteriskToken === undefined
          ? "yields a value in a generator"
          : "delegates to another iterable in a generator",
        node,
      );
    } else if (isAsyncGenerator(enclosing)) {
      this.emit(
        "AsyncGeneratorYield",
        node.asteriskToken === undefined
          ? "yields a value in an async generator"
          : "delegates to another iterable in an async generator",
        node,
      );
    }
    this.walkChildren(node);
  }

  /**
   * Whether a method receiver is a parameter binding (FR-015's splits
   * are lexically scoped to parameters): a bare identifier the scope
   * stack resolves to a parameter. Property chains (`this.items.push`)
   * and non-identifier receivers never are.
   */
  private isParamReceiver(receiver: Expression): boolean {
    let base = receiver;
    while (isParenthesizedExpression(base)) {
      base = base.expression;
    }
    return isIdentifier(base) && this.isParameter(base.text);
  }

  /**
   * Whether a method receiver is HTTP-response-like: the name-form
   * spellings `res`/`response` (both modes), or — with the checker — a
   * type declared as `ServerResponse` or the fetch/express-style
   * `Response`.
   */
  private isHttpResponseReceiver(receiver: Expression): boolean {
    if (isIdentifier(receiver) && HTTP_RESPONSE_RECEIVER_NAMES.has(receiver.text)) {
      return true;
    }
    const name = typeSymbolName(this.typeAt(receiver));
    return name !== undefined && HTTP_RESPONSE_TYPE_NAMES.has(name);
  }

  /**
   * Whether a method receiver is channel-like: the name-form spellings
   * port/channel/worker (both modes), or — with the checker — a type
   * declared as one of the MessagePort family.
   */
  private isChannelReceiver(receiver: Expression): boolean {
    if (isIdentifier(receiver) && CHANNEL_CLOSE_RECEIVER_NAMES.has(receiver.text)) {
      return true;
    }
    const name = typeSymbolName(this.typeAt(receiver));
    return name !== undefined && CHANNEL_CLOSE_TYPE_NAMES.has(name);
  }

  /** The checker's type at a node, when program mode provides one. */
  private typeAt(node: Node): Type | undefined {
    return this.checker?.getTypeAtLocation(node);
  }

  /**
   * An anonymous (unassigned) function-like inside the record: its
   * constructs attribute to this record (FR-009), so the walk enters it
   * under a fresh scope seeded with its parameters — an arrow's
   * expression body is itself an implicit return (FR-011). A
   * scheduling callback argument additionally opens a deferred-callback
   * boundary (research R6.5): everything it lexically contains executes
   * after the enclosing function returned, so writes it carries to
   * outer function-scope bindings attribute as deferred while the walk
   * is inside it.
   */
  private visitAnonymousFunctionLike(node: FunctionLikeNode): void {
    this.scopes.push(DetectionScope.entered(paramNames(node.parameters)));
    const deferredBoundary = isSchedulingCallbackArgument(node);
    if (deferredBoundary) {
      this.boundaries.push(this.scopes.length - 1);
    }
    if (isArrowFunction(node) && !isBlock(node.body)) {
      this.emit("ReturnValue", "arrow expression body returns a value", node.body);
    }
    this.walkChildren(node);
    this.scopes.pop();
    if (deferredBoundary) {
      this.boundaries.pop();
    }
  }

  /**
   * Classifies one write (FR-014/FR-015 plus the P2/P3 property rows)
   * and emits when it targets `this`, a parameter, `process.env.X`, a
   * MonkeyPatch form, a module-scope binding, or an enclosing
   * function-scope binding. The location anchor is the write construct
   * (assignment, increment/decrement, or `delete` expression); the
   * classified target is the written expression, with parentheses
   * unwrapped. Dot forms take the written path as written (`this.size`,
   * `p.label`, `process.env.DEBUG`, `NS.prop` — R6.6); element forms
   * take the base identifier; bare identifiers take the binding name.
   * Chained member writes other than the MonkeyPatch forms and element
   * writes on non-parameter bases target nothing the tiers pin — the
   * documented method-form boundary.
   */
  private emitWrite(locationNode: Node, written: Node): void {
    let target = written;
    while (isParenthesizedExpression(target)) {
      target = target.expression;
    }
    if (isPropertyAccessExpression(target)) {
      if (isThisExpression(target.expression)) {
        this.emit(
          "ReceiverMutation",
          "mutates a member of this",
          locationNode,
          target.getText(this.sourceFile),
        );
        return;
      }
      if (isIdentifier(target.expression) && this.isParameter(target.expression.text)) {
        this.visitParamDotWrite(locationNode, target);
        return;
      }
      // `EnvVarMutation` (the P3 row): writes to `process.env.X`, in
      // every write form — assignment, compound, increment/decrement,
      // and `delete` all flow through here.
      if (isProcessEnvTarget(target)) {
        this.emit(
          "EnvVarMutation",
          "mutates a process environment variable",
          locationNode,
          target.getText(this.sourceFile),
        );
        return;
      }
      // `MonkeyPatch` (the P2 row; research R6.4 — precedence over
      // GlobalMutation for these forms): `X.prototype.*` writes and
      // property writes on imported namespace objects.
      const patched = this.monkeyPatchTarget(target);
      if (patched !== undefined) {
        this.emit(
          "MonkeyPatch",
          patched.prototype
            ? "patches a prototype property"
            : "patches a property of an imported namespace",
          locationNode,
          patched.text,
        );
        return;
      }
      return;
    }
    if (isElementAccessExpression(target)) {
      this.visitElementWrite(locationNode, target);
      return;
    }
    if (isIdentifier(target)) {
      this.classifyIdentifierWrite(locationNode, target.text);
    }
  }

  /**
   * The MonkeyPatch form of a dot-property write, when it is one: an
   * `X.prototype.*` target (any `X` — the write is a prototype patch
   * regardless of what the constructor binding is), or a property
   * write on an imported namespace object (`import * as NS`; the scope
   * stack excludes function-scope shadows, so a local or parameter of
   * the same name keeps its own classification). Research R6.4: both
   * forms take precedence over GlobalMutation.
   *
   * @param target The written property-access target.
   * @returns The written path and which MonkeyPatch arm matched, or
   * `undefined` when the write is neither form.
   */
  private monkeyPatchTarget(
    target: PropertyAccessExpression,
  ): { readonly text: string; readonly prototype: boolean } | undefined {
    const base = target.expression;
    if (isPropertyAccessExpression(base) && base.name.text === "prototype") {
      return { text: target.getText(this.sourceFile), prototype: true };
    }
    if (
      isIdentifier(base) &&
      this.imports.namespaceSpecifiers.has(base.text) &&
      this.bindingScopeIndex(base.text) <= 0
    ) {
      return { text: target.getText(this.sourceFile), prototype: false };
    }
    return undefined;
  }

  /**
   * The parameter dot-write rules (FR-014/FR-015): `p.length = …` on a
   * checker-proven array-typed parameter is the `SliceMutation`
   * truncation carve-out (never `PointerArgMutation`); every other
   * dot-property write on a parameter is `PointerArgMutation`. The
   * carve-out is typed — in parse-only, or on a non-array checker
   * type, the P0 dot-write rule stands.
   */
  private visitParamDotWrite(
    locationNode: Node,
    target: PropertyAccessExpression,
  ): void {
    if (
      target.name.text === "length" &&
      isArrayLikeType(this.typeAt(target.expression))
    ) {
      this.emit(
        "SliceMutation",
        "truncates an array-typed parameter",
        locationNode,
        target.getText(this.sourceFile),
      );
      return;
    }
    this.emit(
      "PointerArgMutation",
      "mutates a property of a parameter",
      locationNode,
      target.getText(this.sourceFile),
    );
  }

  /**
   * The element-write rules (FR-014/FR-015): `this[k] = v` is
   * `ReceiverMutation`; `p[k] = v` on a parameter follows the split —
   * `SliceMutation` for checker-proven array types, `MapMutation` for
   * everything else (records, objects, `any`, unresolved, and the
   * whole parse-only mode — the documented type-blind default). The
   * target is the base identifier (R6.6). Element writes on other
   * bases report nothing at P1.
   */
  private visitElementWrite(locationNode: Node, target: ElementAccessExpression): void {
    if (isThisExpression(target.expression)) {
      this.emit("ReceiverMutation", "mutates an element of this", locationNode, "this");
      return;
    }
    if (isIdentifier(target.expression) && this.isParameter(target.expression.text)) {
      if (isArrayLikeType(this.typeAt(target.expression))) {
        this.emit(
          "SliceMutation",
          "mutates an element of an array-typed parameter",
          locationNode,
          target.expression.text,
        );
      } else {
        this.emit(
          "MapMutation",
          "mutates a computed key of a parameter",
          locationNode,
          target.expression.text,
        );
      }
    }
  }

  /**
   * The identifier-write classification (FR-014; research R5): a write
   * to a module-scope binding from inside a function is
   * `GlobalMutation`; a write to an enclosing function-scope binding is
   * a closure capture — `DeferredReturnMutation` exactly when a
   * deferred-callback boundary separates the write from the declaring
   * scope (the mutation executes after that function returned), and a
   * synchronous `ClosureCaptureMutation` otherwise (P4, never
   * `GlobalMutation`); a write to the innermost scope's own binding is
   * local state; an unresolved name is the documented tracker boundary
   * (enum, namespace, catch-clause bindings) and reports nothing.
   */
  private classifyIdentifierWrite(locationNode: Node, name: string): void {
    const index = this.bindingScopeIndex(name);
    if (index < 0 || index === this.scopes.length - 1) {
      return;
    }
    if (index === 0) {
      this.emit("GlobalMutation", "writes a module-scope binding", locationNode, name);
      return;
    }
    if (this.boundaries.some((boundary) => index < boundary)) {
      this.emit(
        "DeferredReturnMutation",
        "mutates an enclosing binding from a deferred callback",
        locationNode,
        name,
      );
      return;
    }
    this.emit(
      "ClosureCaptureMutation",
      "mutates an enclosing function-scope binding from a closure",
      locationNode,
      name,
    );
  }

  /**
   * The innermost scope-stack index whose frame binds `name`, or `-1`
   * when no frame does — the write classification's scope address
   * (research R5): index 0 is the module frame, the last index is the
   * innermost function scope, and the frames between are the enclosing
   * closure scopes.
   */
  private bindingScopeIndex(name: string): number {
    for (let index = this.scopes.length - 1; index >= 0; index -= 1) {
      if (this.scopes[index]?.binds(name)) {
        return index;
      }
    }
    return -1;
  }

  /**
   * Whether a name resolves to a parameter: the innermost scope that
   * binds the name decides — its `params` set says parameter, anything
   * else (local, module binding) says not. Unresolved names are never
   * parameters (the documented tracker boundary for enum, namespace,
   * and catch-clause bindings).
   */
  private isParameter(name: string): boolean {
    const index = this.bindingScopeIndex(name);
    return this.scopes[index]?.params.has(name) ?? false;
  }

  /**
   * Records one binding name into the innermost scope — the
   * walk-entered frames' local collection (chain-derived frames are
   * already hoisting-complete, so `declares` is their no-op). Function
   * declarations bind in the visit dispatch; variables and classes
   * here.
   */
  private declareBinding(node: Node): void {
    if (isVariableDeclaration(node)) {
      const names = new Set<string>();
      collectBindingNames(node.name, names);
      for (const name of names) {
        this.declareName(name);
      }
      return;
    }
    if (isClassDeclaration(node) && node.name !== undefined) {
      this.declareName(node.name.text);
    }
  }

  /** One name into the innermost scope, when the walk is inside one. */
  private declareName(name: string): void {
    this.scopes[this.scopes.length - 1]?.declares(name);
  }

  /** The default descent: every child, in source order. */
  private walkChildren(node: Node): void {
    node.forEachChild((child) => {
      this.visit(child);
      return undefined;
    });
  }
}

/**
 * Builds a record's initial scope stack from its chain (research R5):
 * the module frame first, then one frame per chain function scope, its
 * parameter names recovered from the corresponding ancestor
 * function-like node (the 1:1 chain/ancestor correspondence — every
 * chain function frame was pushed by the extractor entering exactly one
 * lexically enclosing function-like). The zip is defensive on length:
 * a short ancestor list degrades that frame's parameter set to empty
 * rather than crashing the walk.
 *
 * @param record The record whose scopes are built.
 * @returns The scope stack, innermost last.
 */
function buildInitialScopes(record: ExtractionRecord): DetectionScope[] {
  const ancestors = ancestorFunctionLikes(record.node);
  const scopes: DetectionScope[] = [];
  let ancestorIndex = 0;
  for (const frame of record.scopeChain) {
    if (scopes.length === 0) {
      // The outermost frame is the module scope: no parameters.
      scopes.push(DetectionScope.derived(EMPTY_NAMES, frame.names));
      continue;
    }
    const ancestor = ancestors[ancestorIndex];
    scopes.push(
      DetectionScope.derived(
        ancestor === undefined ? EMPTY_NAMES : paramNames(ancestor.parameters),
        frame.names,
      ),
    );
    ancestorIndex += 1;
  }
  return scopes;
}

/**
 * The deferred-callback boundaries a record is born inside (research
 * R6.5): for a `deferred` record — one whose declaration sits inside a
 * scheduling callback — every ancestor function-like that is a
 * scheduling-call argument contributes its scope-frame index, using the
 * same chain/ancestor correspondence `buildInitialScopes` zips (the
 * k-th function-like ancestor is the (k+1)-th scope frame). A
 * non-deferred record starts with none: the walk itself grows the
 * boundary set only when it enters a scheduling callback argument.
 *
 * @param record The record whose walk the boundaries seed.
 * @returns The initial boundary scope indices, ascending.
 */
function initialDeferredBoundaries(record: ExtractionRecord): number[] {
  if (!record.deferred) {
    return [];
  }
  const boundaries: number[] = [];
  const ancestors = ancestorFunctionLikes(record.node);
  for (const [index, ancestor] of ancestors.entries()) {
    if (isSchedulingCallbackArgument(ancestor)) {
      boundaries.push(index + 1);
    }
  }
  return boundaries;
}

/**
 * Narrows a record's node to the function-like union — the extraction
 * contract guarantees every record's node is a body-owning function-like,
 * so anything else is an extractor bug and fails loud (Constitution
 * Principle I) rather than walking an ill-shaped tree.
 *
 * @param node The record's node.
 * @returns The node, narrowed.
 * @throws Error when the node is not a function-like.
 */
function asFunctionLike(node: Node): FunctionLikeNode {
  if (!isFunctionLikeNode(node)) {
    throw new Error(
      `extraction record node is not a function-like: ${node.constructor.name}`,
    );
  }
  return node;
}
