import {
  type ArrowFunction,
  type BindingName,
  type CallExpression,
  type ClassDeclaration,
  type ConstructorDeclaration,
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
  type MethodDeclaration,
  type Node,
  type NodeArray,
  type ParameterDeclaration,
  type SetAccessorDeclaration,
  type SourceFile,
  SyntaxKind,
  type ThrowStatement,
} from "typescript/unstable/ast";
import type { ExtractionRecord } from "./extract.js";
import type { Effect } from "./models.js";
import { resolveSideEffectType } from "./taxonomy.js";

/**
 * The P0 side-effect detection rules (FR-011 through FR-014; the six
 * strict rows of data-model.md's disposition table; research R6;
 * Constitution Principles I, II, and III). `detectEffects` walks each
 * extraction record's own body and reports exactly the constructs the
 * strict tier pins — zero false negatives and zero false positives on
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
 *
 * Every effect is constructed through `resolveSideEffectType` (FR-018 —
 * canonical names only; the resolver passes canonical spellings through
 * and this module fails loud on anything else) and carries no
 * `classification` (FR-019 — the field is omitted entirely). `target`
 * follows research R6.6: the written path as written (`this.x`, `p.x`),
 * the base identifier for element writes (`this` for `this[k] = v`), the
 * constructor name for `throw new X(...)`, and omitted otherwise;
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
 *
 * Extension surface (T016/T017): the walk is a per-record visitor whose
 * `visit` dispatch enumerates construct families; later tiers add rules
 * to the same dispatch and take the `ProgramContext` for the
 * checker-dependent splits then. P0 is purely lexical (research R5) —
 * identical in both context modes. The detector deliberately adds no
 * second AST depth budget: extraction's budget already excluded any
 * file whose AST could exhaust the native stack (records exist only for
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
 * Detects the P0 side effects of every extraction record (FR-011
 * through FR-014; research R6).
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
 * @returns Each record's effects, sorted by `(line, column, type)` —
 * empty for a record whose body contains no P0 constructs.
 */
export function detectEffects(
  records: readonly ExtractionRecord[],
): ReadonlyMap<ExtractionRecord, readonly Effect[]> {
  const pending = new Map<ExtractionRecord, PendingEffect[]>();
  for (const record of records) {
    const walker = new RecordWalker(record);
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
 * One record's P0 detection walk (FR-009 attribution; research R6): a
 * fresh pre-order visitor over the record's own function-like node,
 * with a scope stack seeded from the record's chain and grown as the
 * walk descends into anonymous function-likes. Effects accumulate into
 * {@link pending} — unsorted; `detectEffects` applies FR-020's order.
 */
class RecordWalker {
  readonly pending: PendingEffect[] = [];
  private readonly record: ExtractionRecord;
  private readonly sourceFile: SourceFile;
  private readonly scopes: DetectionScope[];

  constructor(record: ExtractionRecord) {
    this.record = record;
    this.sourceFile = record.node.getSourceFile();
    this.scopes = buildInitialScopes(record);
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
   * P0 construct family emits and continues the descent — constructs
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
   * `ErrorReturn`, the terminal carve-out. Everything else — including
   * calls whose callee or arguments nest detectable constructs —
   * simply descends.
   */
  private visitCall(node: CallExpression): void {
    if (isPromiseRejectCall(node)) {
      this.emit("ErrorReturn", "returns a rejected promise", node);
      this.emit("ErrorSignal", "signals a rejected promise", node);
    } else if (isProcessExitCall(node)) {
      this.emit("ErrorSignal", "signals an error through process exit", node);
      this.emit("ProcessExit", "terminates the process", node);
    }
    this.walkChildren(node);
  }

  /**
   * An anonymous (unassigned) function-like inside the record: its
   * constructs attribute to this record (FR-009), so the walk enters it
   * under a fresh scope seeded with its parameters — an arrow's
   * expression body is itself an implicit return (FR-011).
   */
  private visitAnonymousFunctionLike(node: FunctionLikeNode): void {
    this.scopes.push(DetectionScope.entered(paramNames(node.parameters)));
    if (isArrowFunction(node) && !isBlock(node.body)) {
      this.emit("ReturnValue", "arrow expression body returns a value", node.body);
    }
    this.walkChildren(node);
    this.scopes.pop();
  }

  /**
   * Classifies one write (FR-014/FR-015 dot-form) and emits when it
   * targets `this` or a parameter. The location anchor is the write
   * construct (assignment, increment/decrement, or `delete`
   * expression); the classified target is the written expression, with
   * parentheses unwrapped. Dot forms take the written path as written
   * (`this.size`, `p.label` — R6.6); element forms take the base
   * identifier (`this` for `this[k] = v`). Element writes on parameters
   * are deliberately NOT PointerArgMutation — they follow the P1
   * FR-015 split — and chained member writes (`a.b.c`) target neither
   * `this` nor a parameter directly.
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
        this.emit(
          "PointerArgMutation",
          "mutates a property of a parameter",
          locationNode,
          target.getText(this.sourceFile),
        );
      }
      return;
    }
    if (isElementAccessExpression(target) && isThisExpression(target.expression)) {
      this.emit("ReceiverMutation", "mutates an element of this", locationNode, "this");
    }
  }

  /**
   * Whether a name resolves to a parameter: the innermost scope that
   * binds the name decides — its `params` set says parameter, anything
   * else (local, module binding) says not. Unresolved names are never
   * parameters (the documented tracker boundary for enum, namespace,
   * and catch-clause bindings).
   */
  private isParameter(name: string): boolean {
    for (const scope of [...this.scopes].reverse()) {
      if (scope.binds(name)) {
        return scope.params.has(name);
      }
    }
    return false;
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
