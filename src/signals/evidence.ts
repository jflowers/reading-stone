import {
  getJSDocTags,
  getTextOfJSDocComment,
  isBinaryExpression,
  isClassDeclaration,
  isClassLikeDeclaration,
  isExportAssignment,
  isExpressionStatement,
  isFunctionDeclaration,
  isIdentifier,
  isJSDoc,
  isObjectLiteralExpression,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isPropertyDeclaration,
  isReturnStatement,
  isSatisfiesExpression,
  isVariableDeclaration,
  isVariableDeclarationList,
  isVariableStatement,
  type JSDoc,
  ModifierFlags,
  type Node,
  type SourceFile,
  SyntaxKind,
} from "typescript/unstable/ast";
import type { ExtractionRecord } from "../extract.js";
import type { ProgramContext } from "../program.js";

/**
 * The per-record evidence snapshot (FR-002 through FR-006 inputs; research
 * R5, R12; data-model.md Section 5.1) — every classification input the pure
 * extractors read besides the effect type, computed once per function
 * record and never per (record, effect type) pair: evidence is
 * effect-type-independent by construction, so one snapshot serves every
 * signal a record's effects produce (plan.md's performance goal).
 *
 * This module implements the MODE-INDEPENDENT half — `exportedFunction`,
 * `exportedReceiver`, `docText`, `docTags` — from the parsed AST alone,
 * identical in program and parse-only modes (the degradation contract:
 * syntactic fields survive the fallback). The checker-resolved half
 * (`exportedReturnType`, `interfaceMember`, `callerModuleCount`) is declared
 * on the snapshot and carries its degradation values (false/0) until T019
 * wires it through the program-mode context; the underscore-marked
 * parameters of `buildRecordEvidence` are that task's seam.
 *
 * Constitution Principle III throughout: every value comes from the
 * compiler's own surfaces — `getJSDocTags`/`getTextOfJSDocComment` for
 * documentation (never a custom regex doc parser), `modifierFlags` for
 * export modifiers, the AST parent chain for the CJS assignment shapes.
 * Principle II where syntax cannot decide: the CJS binding match is
 * name-based within the file (scope-precise resolution needs the checker),
 * and ambiguity is preferred over omission. Principle V: nothing here
 * executes or imports analyzed code — every read is off the parsed AST.
 *
 * Exportedness contract (research R5; data-model.md Section 5.1):
 *
 * 1. **ESM** — an `export` modifier on the declaration itself, on its root
 *    variable statement, or an export assignment above it. `export default`
 *    qualifies through both of the first two routes: the ExportDefault
 *    modifier flag is a composite that includes the Export bit, and the
 *    anonymous-expression form sits directly under the ExportAssignment.
 *    `export =` fires through the same assignment shape.
 * 2. **CJS** (spec edge case 5) — a `module.exports.<name> = X`,
 *    `module.exports = X`, or `exports.<name> = X` assignment whose
 *    right-hand side is the identifier of the binding the record is rooted
 *    at, in the same file — and only when the walk ended at module scope:
 *    the right-hand side resolves in the module frame, so a function-local
 *    namesake of a targeted binding is a different binding sharing the
 *    spelling, never an export. The targeted names are scanned once per
 *    file and memoized for the build.
 * 3. **The value-position chain** crosses exactly the shapes extract.ts's
 *    name-giving table reads (variable binding, property assignment,
 *    object-literal passthrough, export assignment) because a record only
 *    exists at those shapes — a wrapped initializer (parens, `as`,
 *    `satisfies`) is never extracted, so walk and extraction coincide by
 *    construction. Object literals are crossed so an object-literal member
 *    rooted at an exported binding is itself exported (R5's rooted-object
 *    rule); every other parent — class bodies, blocks, source files — ends
 *    the walk, so a nested function never inherits a module-level export.
 * 4. **The component split** — class-member records (methods, constructors,
 *    accessors, and class-property initializers) never take
 *    `exportedFunction`; they take `exportedReceiver` when the enclosing
 *    class-like satisfies the same closed exported-value rule, class
 *    expressions through their root binding included.
 *
 * Documentation contract (data-model.md Section 5.1): `docTags` is the
 * compiler's own `getJSDocTags` list — bare tag names in document order,
 * parent-node inheritance included (variable-declaration unification); the
 * JSDoc nodes behind `docText` come from mirroring the compiler's hosting
 * walk (see `nextJSDocHost`), which stops at object literals and class
 * bodies exactly as the compiler does — a documented statement does not
 * document its object-literal members, and a documented class does not
 * document its methods.
 */

/**
 * One flattened JSDoc tag (data-model.md Section 5.1): the bare tag name
 * (`returns`, never `@returns`) and the tag's comment text as
 * `getTextOfJSDocComment` renders it — the empty string when the tag carries
 * no comment. Document order is preserved by the `docTags` array.
 */
export interface DocTag {
  /** The bare tag name — `param`, `returns` — never spelled with `@`. */
  readonly tag: string;
  /** The tag's comment text; the empty string when the tag has no comment. */
  readonly text: string;
}

/**
 * The per-record evidence snapshot (data-model.md Section 5.1) — the pure
 * extractors' only input besides the effect type (research R12's seam).
 *
 * Immutable value record (convention pack AP-004): `readonly` fields, never
 * mutated after construction. Keyed externally by the record reference this
 * snapshot carries, so lookups and fan-out can use either.
 */
export interface RecordEvidence {
  /** The extracted function-like this snapshot describes — the map key by reference. */
  readonly record: ExtractionRecord;
  /**
   * The record's value is reachable from module scope: an ESM export form
   * (modifier on the declaration, its root variable statement, or its export
   * assignment — `export default` included) or a same-file CJS assignment
   * targeting its binding. Never true for class members — they take
   * `exportedReceiver`.
   */
  readonly exportedFunction: boolean;
  /**
   * The annotated return type contains a type reference resolving to an
   * exported or ambient symbol (research R5). Checker-resolved: false until
   * T019, and always false in parse-only mode.
   */
  readonly exportedReturnType: boolean;
  /**
   * The record is a direct member of a class-like that is itself exported —
   * the same closed rule as `exportedFunction`, applied to the enclosing
   * class (class expressions through their root binding included).
   */
  readonly exportedReceiver: boolean;
  /**
   * The flattened JSDoc text — description and tag comment texts,
   * single-space joined — from the declaration's own JSDoc through the
   * compiler's hosting walk; the empty string when undocumented.
   */
  readonly docText: string;
  /** The JSDoc tags in document order, bare tag names, inheritance included. */
  readonly docTags: readonly DocTag[];
  /**
   * A declared member of an interface in the enclosing class's heritage
   * carries the record's name (research R6). Checker-resolved: false until
   * T019, and always false in parse-only mode.
   */
  readonly interfaceMember: boolean;
  /**
   * The number of distinct in-scope modules with at least one qualifying
   * call site (research R7) — wired from `buildCallerIndex` in T019; 0
   * until then.
   */
  readonly callerModuleCount: number;
}

/**
 * Builds the per-record evidence snapshot over one prepared analysis
 * (research R12's seam).
 *
 * T018 computes the mode-independent components — both exportedness
 * components and both documentation fields — from the parsed AST alone, so
 * the snapshot is identical in program and parse-only modes. The
 * checker-resolved components are declared on the snapshot and carry their
 * degradation values until T019; the underscore-marked parameters are that
 * task's seam — the context its checker queries round-trip through (and
 * therefore must stay live for), and the in-scope path list its
 * caller-index wiring reuses.
 *
 * Every value is computed once per record, and the result is a pure
 * function of the parsed ASTs: repeated calls over the same live inputs
 * produce equal snapshots. An empty record list yields the empty map.
 *
 * @param _context The bootstrapped analysis context — reserved for T019's
 * checker-resolved components; unread in T018.
 * @param records The extracted function-likes, as `prepareAnalysis`
 * returned them — the same instances the caller will look up by.
 * @param _inScopePaths The pattern-filtered, test-excluded source list from
 * `PreparedAnalysis.inScopePaths` — reserved for T019's caller-index
 * wiring; unread in T018.
 * @returns Every record mapped to its evidence snapshot, keyed by the
 * record reference.
 */
export function buildRecordEvidence(
  _context: ProgramContext,
  records: readonly ExtractionRecord[],
  _inScopePaths: readonly string[],
): ReadonlyMap<ExtractionRecord, RecordEvidence> {
  // Per-build memo of each file's CJS exported names — scanned at most once
  // per file, only when the fallback route is actually consulted.
  const cjsNamesByFile = new Map<SourceFile, ReadonlySet<string>>();
  const evidence = new Map<ExtractionRecord, RecordEvidence>();
  for (const record of records) {
    // The component split turns on shape alone: a record with an enclosing
    // class is judged through the class (receiver component), every other
    // record through itself (function component). The two components are
    // disjoint by construction — no record takes both.
    const enclosingClass = enclosingClassOf(record.node);
    evidence.set(record, {
      record,
      exportedFunction:
        enclosingClass === null && isExportedValue(record.node, cjsNamesByFile),
      // T019: the checker-resolved components compute here; until then the
      // declared fields carry their degradation values (false/0), which is
      // also their permanent parse-only answer.
      exportedReturnType: false,
      exportedReceiver:
        enclosingClass !== null && isExportedValue(enclosingClass, cjsNamesByFile),
      docText: docTextOf(record.node),
      docTags: docTagsOf(record.node),
      interfaceMember: false,
      callerModuleCount: 0,
    });
  }
  return evidence;
}

/**
 * The closed exported-value rule (research R5; data-model.md Section 5.1):
 * whether `node`'s value is reachable from module scope. Three routes,
 * checked in order — the own export modifier, the value-position chain, and
 * the same-file CJS fallback, which only a walk that ended at module scope
 * may consult. See the module header for the full contract; the
 * load-bearing details live with the steps below.
 *
 * @param node The declaration or expression to judge.
 * @param cjsNamesByFile The per-build memo of scanned CJS exported names.
 * @returns Whether the node's value is reachable from module scope.
 */
function isExportedValue(
  node: Node,
  cjsNamesByFile: Map<SourceFile, ReadonlySet<string>>,
): boolean {
  if (hasExportModifier(node)) {
    return true;
  }
  // The walk-start spelling for the CJS fallback: a named declaration
  // carries its own binding name (a module-scope `function f` is targeted
  // by `module.exports.f = f`); expressions contribute nothing here — the
  // binding they initialize is captured at the variable step instead.
  let bindingName = declaredName(node);
  let current: Node | undefined = node;
  // The CJS fallback's gate: whether the walk ended with the record rooted
  // at module scope. The assignment's right-hand side resolves in the
  // module frame, so only a module-scope binding — or an object-literal
  // member whose value-position chain roots at one — can be the binding an
  // assignment targets; a function-local namesake shares the spelling but
  // not the binding (Principle II: the name-based match is the
  // approximation, the scope gate is its boundary).
  let rootedAtModuleScope = false;
  while (current !== undefined) {
    // Annotated to break the inference cycle the `current = parent`
    // reassignments would otherwise create (TS7022): the walk's parent is
    // always the compiler-set AST parent, plain Node.
    const parent: Node = current.parent;
    // The export-assignment route fires for both spellings — `export
    // default <expr>` and `export = <expr>` — and only in the expression
    // position: the assignment's clause is not the exported value.
    if (isExportAssignment(parent) && parent.expression === current) {
      return true;
    }
    if (isVariableDeclaration(parent) && parent.initializer === current) {
      // The innermost variable binding on the chain is the name callers
      // invoke (outer bindings of nested object literals are never the
      // invokable name); a destructuring pattern names nothing.
      if (bindingName === null && isIdentifier(parent.name)) {
        bindingName = parent.name.text;
      }
      current = parent;
      continue;
    }
    if (
      isVariableDeclarationList(parent) &&
      parent.declarations.some((declaration) => declaration === current)
    ) {
      current = parent;
      continue;
    }
    if (isVariableStatement(parent)) {
      // The root statement is the last stop of the variable chain: its
      // export modifier is the statement form of ESM exportedness, and no
      // route above a statement can export the initializer. An un-exported
      // statement only ends the ESM walk — the captured binding name still
      // reaches the CJS fallback (the rooted-object rule) when the
      // statement itself sits at module scope.
      if ((parent.modifierFlags & ModifierFlags.Export) !== 0) {
        return true;
      }
      rootedAtModuleScope = parent.parent.kind === SyntaxKind.SourceFile;
      break;
    }
    if (isPropertyAssignment(parent) && parent.initializer === current) {
      current = parent;
      continue;
    }
    if (isObjectLiteralExpression(parent)) {
      // Object-literal passthrough (R5's rooted-object rule): a member of
      // a literal rooted at an exported binding is exported with it.
      current = parent;
      continue;
    }
    // Every other parent — class bodies, blocks, call arguments, source
    // files — ends the walk; nothing above them exports the node. The
    // ending parent also settles the CJS gate: the source file itself
    // roots the record at module scope, anything else (a block, a class
    // body) does not.
    rootedAtModuleScope = parent.kind === SyntaxKind.SourceFile;
    break;
  }
  if (bindingName === null || !rootedAtModuleScope) {
    return false;
  }
  const sourceFile = node.getSourceFile();
  let names = cjsNamesByFile.get(sourceFile);
  if (names === undefined) {
    names = scanCjsExportedNames(sourceFile);
    cjsNamesByFile.set(sourceFile, names);
  }
  return names.has(bindingName);
}

/**
 * Whether `node` is a declaration carrying the export modifier itself — the
 * direct ESM form. `export default` declarations qualify through their
 * modifier flags: ExportDefault is a composite that includes the Export
 * bit, so one mask covers both spellings. Only declarations that can carry
 * the modifier are tested (functions, classes, variable statements);
 * expressions cannot, and class expressions are reached through their root
 * binding instead.
 *
 * @param node The node to test.
 * @returns Whether the node's own modifier flags include Export.
 */
function hasExportModifier(node: Node): boolean {
  return (
    (isFunctionDeclaration(node) ||
      isClassDeclaration(node) ||
      isVariableStatement(node)) &&
    (node.modifierFlags & ModifierFlags.Export) !== 0
  );
}

/**
 * The declared name of a named function or class declaration — the
 * walk-start spelling of the CJS binding match. Only declarations count: a
 * function EXPRESSION's internal name is invisible to callers (the binding
 * it initializes is the invokable name, captured at the variable step), so
 * expressions contribute nothing.
 *
 * @param node The node to read a declared name from.
 * @returns The declaration's name, or null when the node is not a named
 * declaration.
 */
function declaredName(node: Node): string | null {
  if (isFunctionDeclaration(node) || isClassDeclaration(node)) {
    return node.name !== undefined ? node.name.text : null;
  }
  return null;
}

/**
 * The class-like a record is a direct member of, when it is one: any
 * function-like whose parent is a class-like (methods, constructors,
 * accessors — extraction's member forms), or the initializer of a class
 * property under a class-like (the arrow/function-expression member form).
 * Object-literal members and every module-scope form return null — the
 * receiver/function component split turns on exactly this shape.
 *
 * @param node The record's node.
 * @returns The enclosing class-like, or null when the record is not a
 * direct class member.
 */
function enclosingClassOf(node: Node): Node | null {
  const parent = node.parent;
  if (isClassLikeDeclaration(parent)) {
    return parent;
  }
  if (
    isPropertyDeclaration(parent) &&
    parent.initializer === node &&
    isClassLikeDeclaration(parent.parent)
  ) {
    return parent.parent;
  }
  return null;
}

/**
 * Scans one source file's top-level statements for CommonJS export
 * assignments (spec edge case 5): `module.exports.<p> = X`,
 * `module.exports = X`, and `exports.<p> = X`, each with a plain `=`
 * operator and an identifier right-hand side. The right-hand identifier is
 * the targeted binding's NAME — the value the assignment exports —
 * collected into the per-file set the exported-value rule matches against.
 *
 * Deliberate approximations, both Principle II (ambiguity over omission):
 * the match is name-based within the file (scope-precise resolution needs
 * the checker), and only top-level statements are scanned (a CJS export
 * inside a function body is not a module export). Compound operators
 * (`+=`), non-identifier targets (`module.exports.f = obj.g`), and deeper
 * member forms (`module.exports.f.g = X`) contribute nothing.
 *
 * @param sourceFile The file to scan.
 * @returns The names targeted by the file's CJS export assignments.
 */
function scanCjsExportedNames(sourceFile: SourceFile): ReadonlySet<string> {
  const names = new Set<string>();
  for (const statement of sourceFile.statements) {
    if (!isExpressionStatement(statement)) {
      continue;
    }
    const assignment = statement.expression;
    if (
      !isBinaryExpression(assignment) ||
      assignment.operatorToken.kind !== SyntaxKind.EqualsToken ||
      !isPropertyAccessExpression(assignment.left) ||
      !isIdentifier(assignment.right)
    ) {
      continue;
    }
    const receiver = assignment.left;
    // The three receiver shapes: `module.exports` itself, a property on it,
    // and a property on the `exports` alias.
    if (
      isModuleExportsAccess(receiver) ||
      isExportsAliasAccess(receiver) ||
      (isPropertyAccessExpression(receiver.expression) &&
        isModuleExportsAccess(receiver.expression))
    ) {
      names.add(assignment.right.text);
    }
  }
  return names;
}

/**
 * Whether `node` spells the whole-module CJS receiver `module.exports`.
 *
 * @param node The node to test.
 * @returns Whether the node is a property access reading `module.exports`.
 */
function isModuleExportsAccess(node: Node): boolean {
  return (
    isPropertyAccessExpression(node) &&
    isIdentifier(node.expression) &&
    node.expression.text === "module" &&
    node.name.text === "exports"
  );
}

/**
 * Whether `node` is a property access on the `exports` alias — the
 * per-property CJS receiver (`exports.<name>`).
 *
 * @param node The node to test.
 * @returns Whether the node reads a property of `exports`.
 */
function isExportsAliasAccess(node: Node): boolean {
  return (
    isPropertyAccessExpression(node) &&
    isIdentifier(node.expression) &&
    node.expression.text === "exports"
  );
}

/**
 * The record's JSDoc tags (data-model.md Section 5.1): the compiler's own
 * `getJSDocTags` list — bare tag names in document order, with the
 * compiler's parent-node inheritance included (variable-declaration
 * unification: a statement's tags document the function its initializer
 * names). Constitution Principle III: never a custom doc parser.
 *
 * @param node The record's node.
 * @returns The tag list — tag name and comment text — in document order.
 */
function docTagsOf(node: Node): readonly DocTag[] {
  return getJSDocTags(node).map((tag) => ({
    tag: tag.tagName.text,
    text: getTextOfJSDocComment(tag.comment) ?? "",
  }));
}

/**
 * The record's flattened JSDoc text: the description and each tag's comment
 * text, single-space joined, non-empty parts only — each part rendered by
 * the compiler's own `getTextOfJSDocComment` (Constitution Principle III).
 *
 * The JSDoc nodes come from mirroring the compiler's hosting walk
 * (`nextJSDocHost`): the record's own JSDoc first, then the comments
 * attached to the hosting parents above it — innermost first, so a node's
 * own comment precedes a hosting statement's. The walk stops where the
 * compiler's does: object literals and class bodies are not hosting
 * parents, so a documented statement does not document its object-literal
 * members, and a documented class does not document its methods.
 *
 * @param node The record's node.
 * @returns The joined doc text — the empty string when undocumented.
 */
function docTextOf(node: Node): string {
  const parts: string[] = [];
  let current: Node | undefined = node;
  while (current !== undefined) {
    for (const attached of current.jsDoc ?? []) {
      if (isJSDoc(attached)) {
        appendDocParts(attached, parts);
      }
    }
    current = nextJSDocHost(current);
  }
  return parts.join(" ");
}

/**
 * Flattens one JSDoc node into `parts`: its description, then each tag's
 * comment in document order — empty renderings skipped, the rest joined by
 * the caller.
 *
 * @param doc The JSDoc node to flatten.
 * @param parts The accumulator of non-empty rendered parts.
 */
function appendDocParts(doc: JSDoc, parts: string[]): void {
  const description = getTextOfJSDocComment(doc.comment);
  if (description !== undefined && description.length > 0) {
    parts.push(description);
  }
  for (const tag of doc.tags ?? []) {
    const text = getTextOfJSDocComment(tag.comment);
    if (text !== undefined && text.length > 0) {
      parts.push(text);
    }
  }
}

/**
 * The next node up whose attached JSDoc the compiler considers hosted by
 * `node` — a faithful mirror of the compiler's own
 * `getNextJSDocCommentLocation` (typescript/dist/ast/jsdoc.js): the
 * comment-bearing owners are property assignments, export assignments,
 * property declarations, variable declarations, satisfies expressions,
 * return statements, variable statements, and expression statements, plus a
 * variable declaration list only when `node` is its first declaration.
 * Every other parent — object literals, class bodies, source files — ends
 * the walk.
 *
 * @param node The node whose hosting parent to find.
 * @returns The parent that hosts JSDoc for `node`, or undefined when the
 * walk ends.
 */
function nextJSDocHost(node: Node): Node | undefined {
  const parent = node.parent;
  if (
    isPropertyAssignment(parent) ||
    isExportAssignment(parent) ||
    isPropertyDeclaration(parent) ||
    isVariableDeclaration(parent) ||
    isSatisfiesExpression(parent) ||
    isReturnStatement(parent) ||
    isVariableStatement(parent) ||
    isExpressionStatement(parent)
  ) {
    return parent;
  }
  if (isVariableDeclarationList(parent) && parent.declarations[0] === node) {
    return parent;
  }
  return undefined;
}
