import type { Writable } from "node:stream";
import {
  type ArrowFunction,
  type BindingName,
  type Block,
  type CallExpression,
  type ConstructorDeclaration,
  type FunctionDeclaration,
  type FunctionExpression,
  type GetAccessorDeclaration,
  isArrowFunction,
  isBindingElement,
  isCallExpression,
  isClassDeclaration,
  isConstructorDeclaration,
  isExportAssignment,
  isFunctionDeclaration,
  isFunctionExpression,
  isGetAccessorDeclaration,
  isIdentifier,
  isImportDeclaration,
  isMethodDeclaration,
  isNamedImports,
  isNamespaceImport,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isPropertyDeclaration,
  isSetAccessorDeclaration,
  isVariableDeclaration,
  type MethodDeclaration,
  type Node,
  type NodeArray,
  type ParameterDeclaration,
  type PropertyName,
  type SetAccessorDeclaration,
  type SourceFile,
} from "typescript/unstable/ast";
import { compareFileLineName, relativeUnderBase } from "./internal.js";
import type { ProgramContext } from "./program.js";

/**
 * The table-driven function extractor (FR-007 through FR-009; research R4,
 * R5, R15; data-model.md ExtractionRecord; Constitution Principles I, III,
 * IV, and V). `extractFunctions` walks each in-scope source file exactly
 * once and returns the extracted function-likes as deterministically
 * ordered `ExtractionRecord`s — the record set the detector (FR-009
 * attribution) and the complexity engine (FR-022 parity) both consume.
 *
 * The R4 form table, as a dispatch over the node kinds the compiler
 * produces:
 *
 * 1. **Function declarations** with a body, under the declared name; an
 *    anonymous body-bearing declaration is grammatically an
 *    `export default function`, named `"default"`.
 * 2. **Methods** — class members and object-literal members alike, one node
 *    kind — with a body, under the method name; constructors under the
 *    literal name `"constructor"`; getter and setter accessors with a body
 *    under the property name (one record per accessor of a pair).
 * 3. **Assigned function expressions** — arrow functions and function
 *    expressions — under the name of the variable, object-literal property,
 *    or class property whose initializer they are, or `"default"` when they
 *    are the expression of an `export default`.
 * 4. **Nested function-likes** inside another record's body, each its own
 *    record (extraction is not limited to module scope).
 *
 * Never extracted: body-less declarations (overload signatures, ambient
 * `declare function`s, abstract class methods, interface method
 * signatures) and unassigned function expressions (IIFE callees,
 * call-argument callbacks). Per FR-009 those anonymous bodies scan into the
 * innermost enclosing extracted record at detection time; their absence
 * from the record set is this module's pinned half of that contract.
 *
 * Both `ProgramContext` modes extract identically (research R5: the form
 * table and scope tracker are purely lexical): parse-only sources arrive
 * keyed by root-relative path, program-mode source names are absolute and
 * relativized against `realRoot`, and the default libraries the configured
 * program pulls in live outside the analysis root and are filtered by
 * containment.
 *
 * Determinism (FR-008, research R8): records are emitted in source order
 * and finally sorted by `(relPath, line, name)` with the platform-default
 * stable sort, so full-key ties — a getter/setter pair on one line —
 * resolve by AST position. Line is the 1-based line of the record's own
 * node start (`sourceFile.getLineAndCharacterOfPosition(node.getStart(
 * sourceFile))`, R4).
 *
 * Resource bounds (research R15, Constitution V): the walk tracks AST depth
 * against a fixed budget and aborts on exceed; because each traversal level
 * costs several native frames in the compiler client's lazy node
 * materialization, a `RangeError` from the native stack is the same depth
 * condition surfacing through the environment's stack size and is caught
 * the same way. Either abort discards the file's already-emitted records,
 * writes exactly one `reading-stone: skipping <relPath>: ast depth exceeds
 * budget` diagnostic to the injected stderr, and continues with the next
 * file — diagnosed degradation, never a silent truncation and never a
 * crash. stdout is never touched (it is reserved for JSON-RPC responses).
 */

/**
 * One extracted function-like (data-model.md ExtractionRecord; internal —
 * not protocol-visible). The serializable identity fields (`name`,
 * `relPath`, `line`) and `deferred` are computed during extraction — never
 * lazily — so consumers may drop the `ProgramContext` (disposing a
 * program-mode compiler) once `extractFunctions` returns; `node` and
 * `scopeChain` are live compiler views for the detector's same-lifetime
 * walk.
 */
export type ExtractionRecord = {
  /** Identity per the R4 table: declared, variable, or property name, `"constructor"`, or `"default"`. */
  readonly name: string;
  /** Root-relative POSIX path of the declaring file. */
  readonly relPath: string;
  /** 1-based line of the record's declaration. */
  readonly line: number;
  /** The body-owning function-like node; the detector's walk stops at nested extracted function-likes. */
  readonly node: Node;
  /** Lexical scope chain, outermost-first (module frame first, the record's own scope last). */
  readonly scopeChain: readonly ScopeFrame[];
  /** Whether the walk entered this record inside a scheduling callback (research R6). */
  readonly deferred: boolean;
};

/**
 * One frame of the lexical scope tracker (research R5): the declaration
 * kind of the scope and the binding names declared into it. Module frames
 * carry `SourceFile`-level declarations (variables, functions, classes,
 * imports); function frames carry parameters and locals. Write
 * classification resolves a written identifier against the chain from the
 * innermost frame outward — own scope, enclosing function scopes, then
 * module scope.
 */
export type ScopeFrame = {
  readonly kind: "module" | "function";
  readonly names: ReadonlySet<string>;
};

/**
 * The walker-internal frame: a `ScopeFrame` plus the parent link the chain
 * snapshot walks. Frames are shared by reference into every record whose
 * chain passes through them and keep collecting bindings until their
 * function's walk exits — by the time `extractFunctions` returns they are
 * complete and never touched again, which is what makes a creation-time
 * chain snapshot sound for bindings declared after the record lexically
 * (hoisting: a closure may reference a later-declared local).
 */
type MutableScopeFrame = {
  readonly kind: "module" | "function";
  readonly names: Set<string>;
  readonly parent: MutableScopeFrame | undefined;
};

/**
 * The AST visit depth budget (research R15): far beyond real-world nesting,
 * low enough that the recursive walk cannot exhaust the native stack on
 * adversarial input. Fixed, not caller-configurable — the same bound shape
 * as safeio's byte cap.
 */
const AST_DEPTH_BUDGET = 2000;

/**
 * The bare timer globals of the closed scheduling set (research R6):
 * matched as whole callee identifiers, receiver-blind. Exported because
 * `detector.ts`'s FR-016 spawn forms match the same globals — the two
 * modules share the one set and can never disagree on it.
 */
export const TIMER_GLOBAL_NAMES: ReadonlySet<string> = new Set([
  "setTimeout",
  "setInterval",
  "queueMicrotask",
]);
const PROMISE_CALLBACK_METHODS: ReadonlySet<string> = new Set([
  "then",
  "catch",
  "finally",
]);

/** The per-file abort sentinel for the depth budget (never escapes this module). */
class AstDepthExceeded extends Error {
  constructor() {
    super("ast depth exceeds budget");
  }
}

/**
 * Extracts every R4-form function-like from the context's in-scope sources
 * (FR-007, FR-008; research R4, R12).
 *
 * @param realRoot Realpath-resolved absolute analysis root (discovery's
 * `resolveRoot` output); program-mode source names relativize against it.
 * @param context The bootstrapped `ProgramContext` in either mode; the
 * context is only read during the call.
 * @param stderr Injected diagnostic sink for per-file depth-budget skips;
 * stdout is never touched.
 * @returns The extraction records, sorted by `(relPath, line, name)` with
 * full-key ties resolved by source order through sort stability.
 */
export function extractFunctions(
  realRoot: string,
  context: ProgramContext,
  stderr: Writable,
): ExtractionRecord[] {
  const records: ExtractionRecord[] = [];
  for (const [relPath, sourceFile] of collectSources(realRoot, context)) {
    extractFromFile(relPath, sourceFile, stderr, records);
  }
  records.sort(compareRecords);
  return records;
}

/**
 * The walk set: parse-only sources arrive keyed by root-relative path;
 * program-mode names are the compiler's absolute file names, filtered to
 * the in-scope files that relativize strictly beneath `realRoot`. The
 * configured program's default libraries live outside the analysis root
 * and cannot pass the containment test, so exactly the analyzed tree's
 * sources are walked.
 *
 * @param realRoot Realpath-resolved absolute analysis root.
 * @param context The bootstrapped context in either mode.
 * @returns `(relPath, SourceFile)` pairs in context order.
 */
function collectSources(
  realRoot: string,
  context: ProgramContext,
): Array<[string, SourceFile]> {
  if (context.mode === "parse-only") {
    return [...context.sources];
  }
  const pairs: Array<[string, SourceFile]> = [];
  for (const fileName of context.program.getSourceFileNames()) {
    const relPath = relativeUnderBase(realRoot, fileName);
    if (relPath === null) {
      continue;
    }
    const sourceFile = context.program.getSourceFile(fileName);
    if (sourceFile === undefined) {
      continue;
    }
    pairs.push([relPath, sourceFile]);
  }
  return pairs;
}

/**
 * Walks one source file into `records`, or nothing on a depth abort (the
 * counter tripping or the native stack exhausting first): the file's
 * records are buffered so a pathological file can be excluded whole (R15 —
 * "the file contributes no records"), with exactly one diagnostic written
 * before the walk continues with the next file.
 *
 * @param relPath Root-relative POSIX path, echoed in the skip diagnostic.
 * @param sourceFile The parsed source to walk.
 * @param stderr Injected diagnostic sink for the depth-budget skip.
 * @param records The accumulating cross-file record list.
 */
function extractFromFile(
  relPath: string,
  sourceFile: SourceFile,
  stderr: Writable,
  records: ExtractionRecord[],
): void {
  const fileRecords: ExtractionRecord[] = [];
  const walker = new FileWalker(relPath, sourceFile, fileRecords);
  try {
    walker.walk();
  } catch (error) {
    // Both abort modes are the same per-file degradation (R15): the depth
    // counter tripping, or the native stack exhausting first inside the
    // lazy node materialization — the same depth condition manifesting
    // through the environment's stack size instead of the counter, so it
    // shares the one diagnostic line and the whole-file discard.
    if (!(error instanceof AstDepthExceeded || error instanceof RangeError)) {
      throw error;
    }
    stderr.write(`reading-stone: skipping ${relPath}: ast depth exceeds budget\n`);
    return;
  }
  for (const record of fileRecords) {
    records.push(record);
  }
}

/**
 * The FR-008 order, via the shared `(file, line, name)` comparator
 * (src/internal.ts): codepoint comparison for the string keys and `0` on
 * full-key ties so the platform-default stable sort resolves them by
 * emission (source) order — the getter-before-setter resolution for a
 * one-line accessor pair. The record's file key is `relPath`, the same
 * root-relative POSIX spelling the wire payloads carry as `file`.
 *
 * @param a Left record.
 * @param b Right record.
 * @returns The three-key comparison result.
 */
function compareRecords(a: ExtractionRecord, b: ExtractionRecord): number {
  return compareFileLineName(
    { file: a.relPath, line: a.line, name: a.name },
    { file: b.relPath, line: b.line, name: b.name },
  );
}

/**
 * One file's extraction walk: a single pre-order descent that maintains the
 * R5 scope-tracker state, the R6 deferral flag, and the per-file record
 * buffer. Records are created at the function-like node itself — the R4
 * expression forms (variable-, property-, and default-assigned arrows and
 * function expressions) resolve their names from the node's parent shape,
 * so every form's record lands in source order without a second pass.
 */
class FileWalker {
  private readonly relPath: string;
  private readonly sourceFile: SourceFile;
  private readonly records: ExtractionRecord[];
  private current: MutableScopeFrame;
  private deferred = false;

  constructor(relPath: string, sourceFile: SourceFile, records: ExtractionRecord[]) {
    this.relPath = relPath;
    this.sourceFile = sourceFile;
    this.records = records;
    this.current = { kind: "module", names: new Set(), parent: undefined };
  }

  /** Runs the walk from the source file root (depth 0). */
  walk(): void {
    this.visit(this.sourceFile, 0);
  }

  private visit(node: Node, depth: number): void {
    if (depth > AST_DEPTH_BUDGET) {
      throw new AstDepthExceeded();
    }
    if (isFunctionDeclaration(node)) {
      this.visitFunctionDeclaration(node, depth);
      return;
    }
    if (
      isMethodDeclaration(node) ||
      isConstructorDeclaration(node) ||
      isGetAccessorDeclaration(node) ||
      isSetAccessorDeclaration(node)
    ) {
      this.visitMethodLike(node, depth);
      return;
    }
    if (isArrowFunction(node) || isFunctionExpression(node)) {
      this.visitFunctionExpressionLike(node, depth);
      return;
    }
    if (isCallExpression(node)) {
      this.visitCallExpression(node, depth);
      return;
    }
    this.declareInCurrentScope(node);
    this.walkChildren(node, depth);
  }

  /**
   * Form 1: a function declaration declares its name into the enclosing
   * scope (overload signatures and ambient declarations bind too), but only
   * a body-bearing declaration is a record — an anonymous one is
   * grammatically `export default function`, so it names `"default"`.
   */
  private visitFunctionDeclaration(node: FunctionDeclaration, depth: number): void {
    if (node.name !== undefined) {
      this.current.names.add(node.name.text);
    }
    if (node.body === undefined) {
      this.walkChildren(node, depth);
      return;
    }
    const name = node.name !== undefined ? node.name.text : "default";
    const enclosing = this.current;
    this.enterFunctionScope(node.parameters);
    this.emitRecord(name, node);
    this.walkChildren(node, depth);
    this.current = enclosing;
  }

  /**
   * Forms 2, 3, and 9: methods, accessors, and constructors — class members
   * and object-literal members share one node kind. Body-less members
   * (abstract methods) walk without a record; a body-bearing member is a
   * record under the member name (`"constructor"` for constructors).
   */
  private visitMethodLike(
    node:
      | MethodDeclaration
      | ConstructorDeclaration
      | GetAccessorDeclaration
      | SetAccessorDeclaration,
    depth: number,
  ): void {
    if (node.body === undefined) {
      this.walkChildren(node, depth);
      return;
    }
    const name = isConstructorDeclaration(node)
      ? "constructor"
      : propertyNameText(node.name, this.sourceFile);
    const enclosing = this.current;
    this.enterFunctionScope(node.parameters);
    this.emitRecord(name, node);
    this.walkChildren(node, depth);
    this.current = enclosing;
  }

  /**
   * Forms 4, 6, 7, and 10: arrow functions and function expressions always
   * scope their parameters (an anonymous callback still introduces a frame
   * the chain must show), and become records exactly when their parent
   * shape names them — a variable initializer, an object-literal or class
   * property initializer, or an `export default` expression. Every other
   * position (call arguments, IIFE callees, returns, array elements) is an
   * unassigned function expression: walked, scoped, never recorded.
   */
  private visitFunctionExpressionLike(
    node: ArrowFunction | FunctionExpression,
    depth: number,
  ): void {
    const name = this.recordNameForExpression(node);
    const enclosing = this.current;
    this.enterFunctionScope(node.parameters);
    if (name !== null) {
      this.emitRecord(name, node);
    }
    this.walkChildren(node, depth);
    this.current = enclosing;
  }

  /**
   * The R4 name for an expression form, from the parent shape: the variable
   * name (an identifier — a destructuring pattern cannot initialize from a
   * function), the object-literal or class property name, or `"default"`
   * for the `export default` expression. `null` when the parent does not
   * name the function (including the parenthesized-initializer boundary:
   * R4's table reads the initializer node itself).
   */
  private recordNameForExpression(
    node: ArrowFunction | FunctionExpression,
  ): string | null {
    const parent = node.parent;
    if (isVariableDeclaration(parent) && parent.initializer === node) {
      return isIdentifier(parent.name) ? parent.name.text : null;
    }
    if (isPropertyAssignment(parent) && parent.initializer === node) {
      return propertyNameText(parent.name, this.sourceFile);
    }
    if (isPropertyDeclaration(parent) && parent.initializer === node) {
      return propertyNameText(parent.name, this.sourceFile);
    }
    if (isExportAssignment(parent) && parent.expression === node) {
      return "default";
    }
    return null;
  }

  /**
   * A call expression is walked manually — callee first, then arguments —
   * so a function-like argument of a scheduling construct is entered with
   * the deferral flag set for its whole subtree (R6: everything the
   * callback lexically contains is deferred, because it executes after the
   * enclosing function returns). Type arguments are type-only and skipped.
   */
  private visitCallExpression(node: CallExpression, depth: number): void {
    this.visit(node.expression, depth + 1);
    const scheduling = isSchedulingCall(node);
    for (const argument of node.arguments) {
      const isCallback = isArrowFunction(argument) || isFunctionExpression(argument);
      if (!scheduling || !isCallback) {
        this.visit(argument, depth + 1);
        continue;
      }
      const enclosing = this.deferred;
      this.deferred = true;
      this.visit(argument, depth + 1);
      this.deferred = enclosing;
    }
  }

  /** The default descent: every child, in source order, one depth deeper. */
  private walkChildren(node: Node, depth: number): void {
    node.forEachChild((child) => {
      this.visit(child, depth + 1);
      return undefined;
    });
  }

  /**
   * Collects the binding names a declaration introduces into the current
   * scope — R5's explicit enumeration: variable declarations (including
   * destructured names), classes, and imports (function declarations are
   * handled where their records are emitted). Enum, namespace, and
   * catch-clause bindings fall outside that enumeration and are a
   * documented tracker boundary: writes to them resolve the same way
   * writes to any untracked name do, under the detector's
   * unresolved-name policy.
   */
  private declareInCurrentScope(node: Node): void {
    const names = this.current.names;
    if (isVariableDeclaration(node)) {
      collectBindingNames(node.name, names);
      return;
    }
    if (isClassDeclaration(node)) {
      if (node.name !== undefined) {
        names.add(node.name.text);
      }
      return;
    }
    if (isImportDeclaration(node)) {
      const clause = node.importClause;
      if (clause?.name !== undefined) {
        names.add(clause.name.text);
      }
      const bindings = clause?.namedBindings;
      if (bindings !== undefined) {
        if (isNamespaceImport(bindings)) {
          names.add(bindings.name.text);
        } else if (isNamedImports(bindings)) {
          for (const element of bindings.elements) {
            names.add(element.name.text);
          }
        }
      }
    }
  }

  /**
   * Pushes the function scope for a function-like's parameters; the frame
   * keeps collecting the body's locals until the walk restores the
   * enclosing scope.
   */
  private enterFunctionScope(parameters: NodeArray<ParameterDeclaration>): void {
    const frame: MutableScopeFrame = {
      kind: "function",
      names: new Set(),
      parent: this.current,
    };
    for (const parameter of parameters) {
      collectBindingNames(parameter.name, frame.names);
    }
    this.current = frame;
  }

  /**
   * Emits one record in source order: identity and line computed now (the
   * consumer may dispose the context immediately after extraction), the
   * scope chain a reference snapshot of the live frames (complete by
   * return), and the deferral flag the walk's current state.
   */
  private emitRecord(name: string, node: Node): void {
    const position = this.sourceFile.getLineAndCharacterOfPosition(
      node.getStart(this.sourceFile),
    );
    this.records.push({
      name,
      relPath: this.relPath,
      line: position.line + 1,
      node,
      scopeChain: this.chainOf(this.current),
      deferred: this.deferred,
    });
  }

  /** The live-frame chain, outermost-first, ending at the record's own scope. */
  private chainOf(innermost: MutableScopeFrame): ScopeFrame[] {
    const chain: ScopeFrame[] = [];
    for (
      let frame: MutableScopeFrame | undefined = innermost;
      frame !== undefined;
      frame = frame.parent
    ) {
      chain.push(frame);
    }
    chain.reverse();
    return chain;
  }
}

/**
 * The record name for a property-name position (methods, accessors,
 * object-literal and class properties): the node's source spelling —
 * getStart through getEnd, no trivia — which is the identifier's text for
 * identifier names and the literal's source text for string and numeric
 * literal names, computed names, and private names. Deterministic for the
 * same tree, never fabricated.
 *
 * @param name The property-name node.
 * @param sourceFile The declaring source, for the text slice.
 * @returns The name's text.
 */
function propertyNameText(name: PropertyName, sourceFile: SourceFile): string {
  return name.getText(sourceFile);
}

/**
 * Collects a binding name into a scope frame, recursing through
 * destructuring patterns (`const { a, b: c } = ...`, `const [x, y] = ...`)
 * so every bound spelling is tracked; pattern holes bind nothing. Exported
 * because the detector's scope machinery resolves the same parameter and
 * variable spellings — the one collector, never a mirrored copy.
 *
 * @param name The binding-name node.
 * @param names The frame's accumulating name set.
 */
export function collectBindingNames(name: BindingName, names: Set<string>): void {
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
 * Whether a call is one of the closed scheduling constructs (R6): a bare
 * `setTimeout`/`setInterval`/`queueMicrotask` reference, Node's
 * `process.nextTick`, a promise `.then`/`.catch`/`.finally` continuation,
 * or an `addEventListener` registration. Exported so the detector's
 * deferral attribution consumes precisely the callbacks this module's
 * `deferred` flag names — never a wider or narrower set (Constitution
 * Principle I: the two walks agree on what "deferred" means).
 *
 * @param node The call expression.
 * @returns Whether the callee matches the scheduling set.
 */
export function isSchedulingCall(node: CallExpression): boolean {
  const callee = node.expression;
  if (isIdentifier(callee)) {
    return TIMER_GLOBAL_NAMES.has(callee.text);
  }
  if (!isPropertyAccessExpression(callee)) {
    return false;
  }
  const method = callee.name.text;
  if (PROMISE_CALLBACK_METHODS.has(method) || method === "addEventListener") {
    return true;
  }
  return (
    method === "nextTick" &&
    isIdentifier(callee.expression) &&
    callee.expression.text === "process"
  );
}

/**
 * A function-like that owns its own extraction record (the R4 table's
 * forms): a body-bearing function declaration, method, accessor, or
 * constructor — the `body` presence the runtime predicate checks, with
 * each declaration or member form's optional `FunctionBody` narrowed to a
 * required `Block` — or an arrow or function expression, whose body is
 * grammatically always present (`ConciseBody` and `FunctionBody`).
 */
export type ExtractedFunctionLike =
  | ArrowFunction
  | FunctionExpression
  | (FunctionDeclaration & { readonly body: Block })
  | (MethodDeclaration & { readonly body: Block })
  | (ConstructorDeclaration & { readonly body: Block })
  | (GetAccessorDeclaration & { readonly body: Block })
  | (SetAccessorDeclaration & { readonly body: Block });

/**
 * Whether a function-like node is one of the R4 forms that owns its own
 * extraction record — the shared half of the FR-009 attribution boundary:
 * `extractFunctions` emits a record for exactly these, so a per-record
 * consumer walk stops at exactly these (a nested form's constructs belong
 * to its own record) and traverses unassigned function expressions into
 * the enclosing record instead. The conditions mirror the walker dispatch
 * above (body presence for the declaration and member forms, a
 * name-giving parent position for the expression forms); exported so
 * both per-record consumer walks — the complexity engine's attribution
 * walk (FR-022) and the detector's FR-009 walk — consume the one form
 * table with no duplicated dispatch to drift.
 *
 * @param node The node to test.
 * @returns Whether the node's body belongs to its own extraction record.
 */
export function isExtractedFunctionLike(node: Node): node is ExtractedFunctionLike {
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
 * the R4 record condition for arrows and function expressions (a
 * destructuring pattern cannot initialize from a function, so only an
 * identifier variable name names one).
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
