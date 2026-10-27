import {
  type ArrowFunction,
  type BindingName,
  type CallExpression,
  type ClassDeclaration,
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
  isConstructorDeclaration,
  isDeleteExpression,
  isElementAccessExpression,
  isExportAssignment,
  isFunctionDeclaration,
  isFunctionExpression,
  isGetAccessorDeclaration,
  isIdentifier,
  isMethodDeclaration,
  isNewExpression,
  isParenthesizedExpression,
  isPostfixUnaryExpression,
  isPrefixUnaryExpression,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isPropertyDeclaration,
  isReturnStatement,
  isSetAccessorDeclaration,
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
  type ParameterDeclaration,
  type PropertyAccessExpression,
  type SetAccessorDeclaration,
  type SourceFile,
  SyntaxKind,
  type ThrowStatement,
  type YieldExpression,
} from "typescript/unstable/ast";
import type { Checker, Type } from "typescript/unstable/sync";
import type { ExtractionRecord } from "./extract.js";
import type { Effect } from "./models.js";
import type { ProgramContext } from "./program.js";
import { resolveSideEffectType } from "./taxonomy.js";

/**
 * The P0 and P1 side-effect detection rules (FR-011 through FR-017; the
 * six strict rows plus the eleven must rows of data-model.md's
 * disposition table; research R6; Constitution Principles I, II, and
 * III). `detectEffects` walks each extraction record's own body and
 * reports exactly the constructs the pinned tiers cover — zero false
 * negatives and zero false positives on the conformance fixtures:
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
 * Extension surface (T017): the walk is a per-record visitor whose
 * `visit` dispatch enumerates construct families; the P2/P3/P4 tiers
 * add rules to the same dispatch. P0 is purely lexical (research R5);
 * P1's typed splits take the `ProgramContext` — the checker is live
 * only in program mode, and parse-only takes each split's documented
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
 * Constructs one pending effect through the canonical-type resolver
 * (FR-018): `resolveSideEffectType` passes canonical names through, so a
 * miss is a programming error in this module's rules and fails loud
 * (Constitution Principle I) rather than emitting an invalid type.
 * `location` is the construct's root-relative `file:line:col` from the
 * node's no-trivia start (R6.6); `target` is included only when the
 * rule pins one.
 *
 * @param type The canonical side-effect type name.
 * @param description Deterministic description template.
 * @param relPath Root-relative POSIX path of the declaring file.
 * @param node The construct node — the location's anchor.
 * @param sourceFile The declaring source, for position math.
 * @param target The R6.6 target, when the rule pins one.
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
): PendingEffect {
  const canonical = resolveSideEffectType(type);
  if (canonical === undefined) {
    throw new Error(`Invalid side effect type: ${type}`);
  }
  const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  const effect: Effect =
    target === undefined
      ? {
          type: canonical,
          description,
          location: `${relPath}:${position.line + 1}:${position.character + 1}`,
        }
      : {
          type: canonical,
          description,
          location: `${relPath}:${position.line + 1}:${position.character + 1}`,
          target,
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
 * modifier. Async generators yield `AsyncGeneratorYield` (P2, T017) —
 * never fabricated here — and plain functions carry no asterisk.
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
 * streams belong to StdoutWrite/StderrWrite (P2), never WriterOutput
 * (research R6.4).
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
   * The P1 call families (FR-015/FR-016): the spawn forms — emitted as
   * the `AsyncTaskSpawn` alias, which the canonical-type resolver maps
   * to `GoroutineSpawn` before the effect is constructed (FR-018) —
   * then the bare-identifier channel/stream globals (`postMessage`,
   * the Worker/window global form; `pipeline`, the node:stream/promises
   * form), then, for property-form callees, the receiver/method
   * name-form families. Any other bare callee reports nothing at P1.
   */
  private visitP1Call(node: CallExpression): void {
    if (isSpawnCall(node)) {
      this.emit("AsyncTaskSpawn", "spawns an asynchronous task", node);
      return;
    }
    const callee = node.expression;
    if (isPropertyAccessExpression(callee)) {
      this.visitMethodCall(node, callee);
      return;
    }
    if (isIdentifier(callee)) {
      if (callee.text === "postMessage") {
        this.emit("ChannelSend", "sends a message to a channel", node);
      } else if (callee.text === "pipeline") {
        this.emit("StreamOutput", "pipes a stream", node);
      }
    }
  }

  /**
   * One property-form call through the name-form rule families in
   * research R6.4's precedence order — receiver-specific families
   * (HTTP responses, channels, streams) before generic writers, then
   * the FR-015 param-write split and the membership mutators. The
   * first match wins; every family matches on closed method-name
   * lists, so an unmatched call reports nothing at P1.
   */
  private visitMethodCall(
    node: CallExpression,
    callee: PropertyAccessExpression,
  ): void {
    const method = callee.name.text;
    const receiver = callee.expression;
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
    if (method === "pipe") {
      this.emit("StreamOutput", "pipes a stream", node);
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
    this.visitMembershipCall(node, method, receiver);
  }

  /**
   * The membership mutators (FR-015): `add`/`delete`/`clear` on any
   * receiver and `set` on non-parameter receivers are
   * `ContainerMutation`; `set` on a parameter follows the Map/WeakMap
   * split — `ContainerMutation` when the checker proves a WeakMap,
   * `MapMutation` otherwise, with parse-only taking the `MapMutation`
   * default (the documented type-blind surface).
   */
  private visitMembershipCall(
    node: CallExpression,
    method: string,
    receiver: Expression,
  ): void {
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
        return;
      }
      this.emit("ContainerMutation", "mutates membership of a container", node);
      return;
    }
    if (MEMBERSHIP_MUTATOR_METHODS.has(method)) {
      this.emit("ContainerMutation", "mutates membership of a container", node);
    }
  }

  /**
   * FR-016's fifth spawn form: `new Promise(...)` emits through the
   * `AsyncTaskSpawn` alias (resolved to `GoroutineSpawn` — the alias
   * never appears on the wire). Every other construction is inert
   * here; the executor argument's constructs descend normally.
   */
  private visitNew(node: NewExpression): void {
    if (isPromiseConstruction(node)) {
      this.emit("AsyncTaskSpawn", "spawns an asynchronous task", node);
    }
    this.walkChildren(node);
  }

  /**
   * `GeneratorYield` (FR-016): `yield` and `yield*` whose innermost
   * enclosing function-like — found by the parent climb, the record
   * root or an anonymous function entered during the walk — is a
   * synchronous generator. Async generators are `AsyncGeneratorYield`
   * (P2, T017), never fabricated here. The yield's own expression may
   * nest writes, so the descent continues.
   */
  private visitYield(node: YieldExpression): void {
    if (isSyncGenerator(enclosingFunctionLike(node))) {
      this.emit(
        "GeneratorYield",
        node.asteriskToken === undefined
          ? "yields a value in a generator"
          : "delegates to another iterable in a generator",
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
   * Classifies one write (FR-014/FR-015) and emits when it targets
   * `this`, a parameter, a module-scope binding, or an enclosing
   * function-scope binding. The location anchor is the write construct
   * (assignment, increment/decrement, or `delete` expression); the
   * classified target is the written expression, with parentheses
   * unwrapped. Dot forms take the written path as written (`this.size`,
   * `p.label` — R6.6); element forms take the base identifier; bare
   * identifiers take the binding name. Chained member writes (`a.b.c`)
   * and element writes on non-parameter bases target nothing P1 pins —
   * the documented method-form boundary.
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
   * scope (the mutation executes after that function returned), and
   * unreported at P1 otherwise (`ClosureCaptureMutation` is P4); a
   * write to the innermost scope's own binding is local state; an
   * unresolved name is the documented tracker boundary (enum,
   * namespace, catch-clause bindings) and reports nothing.
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
    }
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
