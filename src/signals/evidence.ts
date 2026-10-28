import {
  type ClassLikeDeclaration,
  escapeLeadingUnderscores,
  getJSDocTags,
  getTextOfJSDocComment,
  isBinaryExpression,
  isClassDeclaration,
  isClassLikeDeclaration,
  isExportAssignment,
  isExpressionStatement,
  isFunctionDeclaration,
  isFunctionLikeDeclaration,
  isIdentifier,
  isJSDoc,
  isObjectLiteralExpression,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isPropertyDeclaration,
  isReturnStatement,
  isSatisfiesExpression,
  isTypeReferenceNode,
  isVariableDeclaration,
  isVariableDeclarationList,
  isVariableStatement,
  type JSDoc,
  ModifierFlags,
  type ModifiersBase,
  type Node,
  type SourceFile,
  SyntaxKind,
  type TypeNode,
  type TypeReferenceNode,
} from "typescript/unstable/ast";
import {
  type Checker,
  type Symbol as CompilerSymbol,
  type NodeHandle,
  SymbolFlags,
} from "typescript/unstable/sync";
import type { ExtractionRecord } from "../extract.js";
import type { ProgramContext } from "../program.js";
import { buildCallerIndex } from "./caller-index.js";

/**
 * The per-record evidence snapshot (FR-002 through FR-006 inputs; research
 * R5, R12; data-model.md Section 5.1) — every classification input the pure
 * extractors read besides the effect type, computed once per function
 * record and never per (record, effect type) pair: evidence is
 * effect-type-independent by construction, so one snapshot serves every
 * signal a record's effects produce (plan.md's performance goal).
 *
 * This module computes BOTH halves. The mode-independent half —
 * `exportedFunction`, `exportedReceiver`, `docText`, `docTags` — reads the
 * parsed AST alone, identical in program and parse-only modes. The
 * checker-resolved half — `exportedReturnType`, `interfaceMember`,
 * `callerModuleCount` — rides the program-mode checker while the context is
 * live (`buildRecordEvidence` runs all its checker traffic before
 * returning), and carries the documented degradation values in parse-only
 * mode (research R7's boundary: degradation reduces precision, never
 * availability). The caller index is `buildCallerIndex` (T009) run once
 * per snapshot over the same records and in-scope set.
 *
 * Constitution Principle III throughout: every value comes from the
 * compiler's own surfaces — `getJSDocTags`/`getTextOfJSDocComment` for
 * documentation (never a custom regex doc parser), `modifierFlags` for
 * export modifiers, the AST parent chain for the CJS assignment shapes,
 * `getSymbolAtLocation`/`getAliasedSymbol`/`getMembers` for heritage and
 * return-type resolution, and the compiler's own `escapeLeadingUnderscores`
 * for the member-table key spelling. Principle II where the checker cannot
 * decide: the CJS binding match is name-based within the file, and every
 * unresolved reference — an invalid `extends`-an-interface clause, an
 * unresolvable type name, an unknown alias target — is absence of evidence,
 * never an error. Principle V: nothing here executes or imports analyzed
 * code — every read is off the parsed AST or a checker query.
 *
 * API-safety record (typescript 7.0.2, verified by probe):
 * `checker.getAliasedSymbol` PANICS the native compiler server when handed
 * a non-alias symbol ("Should only get alias here"), and the heritage
 * clause-type node itself resolves nothing — only its `.expression` does.
 * Both facts are load-bearing below: the alias gate in
 * `resolveThroughAliases` is a hard precondition, never a stylistic
 * choice, and the heritage walk queries the clause type's expression.
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
 *
 * Interface-heritage contract (research R6; program mode only): a
 * class-member record's `interfaceMember` is true exactly when a heritage
 * base of the enclosing class-like resolves through the checker to an
 * interface whose DECLARED member table carries the record's escaped name.
 * The route: `checker.getSymbolAtLocation` on each clause type's
 * EXPRESSION (verified — the clause-type node itself resolves nothing),
 * aliases followed to the base symbol, the base counted only when one of
 * its declarations is an `InterfaceDeclaration` — the declaration-kind
 * gate that keeps a resolvable CLASS base from firing, through either
 * heritage token — and membership read from `getMembers()`, the declared
 * table, never apparent-member lookup (which would find `Object`-prototype
 * members and manufacture +30 signals on every `toString`-alike; research
 * R6's pinned hazard). An invalid `extends`-an-interface clause resolves
 * through no checker route and contributes nothing. Structural
 * satisfaction (an object literal contextually typed as an interface) is
 * out: no enclosing class, no declared contract.
 *
 * Return-type contract (research R5; program mode only): `exportedReturnType`
 * is true exactly when the record node's own explicit return-type annotation
 * contains at least one type reference resolving through the checker
 * (aliases followed) to a symbol with at least one exported or ambient
 * declaration — exported is the export modifier on the declaration (the
 * same ESM signal as `exportedFunction`'s modifier route), ambient is a
 * `.d.ts` declaration (the platform libraries, whose members carry no
 * export modifier — verified). Primitives, literal types, and
 * object-literal types are not identifier-based type references; an
 * unresolved name resolves to no symbol or the checker's error symbols,
 * which carry no declarations — none of them fire.
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
   * exported or ambient symbol (research R5). Checker-resolved: false
   * whenever no checker is live — always in parse-only mode.
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
   * carries the record's name (research R6). Checker-resolved: false
   * whenever no checker is live — always in parse-only mode.
   */
  readonly interfaceMember: boolean;
  /**
   * The number of distinct in-scope modules with at least one qualifying
   * call site (research R7) — `buildCallerIndex`'s count for the record,
   * wired here and never recomputed; 0 in parse-only mode (the empty
   * index).
   */
  readonly callerModuleCount: number;
}

/**
 * Builds the per-record evidence snapshot over one prepared analysis
 * (research R12's seam).
 *
 * Both halves compute here, each once per record: the mode-independent
 * components (both exportedness components and both documentation fields)
 * from the parsed AST, and the checker-resolved components
 * (`exportedReturnType`, `interfaceMember`) through the live program-mode
 * checker. The caller index is `buildCallerIndex` (T009) run once per
 * build, over the same records and in-scope set — its count lands on the
 * snapshot verbatim, never recomputed per record. In parse-only mode there
 * is no checker: the checker-resolved components carry their degradation
 * values (false/0) and the caller index is empty, so degradation reduces
 * precision, never availability.
 *
 * Every value is computed once per record, and the result is a pure
 * function of the live inputs: repeated calls over the same context,
 * records, and in-scope set produce equal snapshots. An empty record list
 * yields the empty map.
 *
 * @param context The bootstrapped analysis context — the program-mode arm
 * must still be live (every checker query and the caller index's
 * `getSignatureUsage` traffic round-trip to the native compiler server);
 * the parse-only arm owns nothing to keep alive.
 * @param records The extracted function-likes, as `prepareAnalysis`
 * returned them — the same instances the caller will look up by.
 * @param inScopePaths The pattern-filtered, test-excluded source list from
 * `PreparedAnalysis.inScopePaths` — the identical file set the caller index
 * filters call sites by (US3-7's parity).
 * @returns Every record mapped to its evidence snapshot, keyed by the
 * record reference.
 */
export function buildRecordEvidence(
  context: ProgramContext,
  records: readonly ExtractionRecord[],
  inScopePaths: readonly string[],
): ReadonlyMap<ExtractionRecord, RecordEvidence> {
  // The caller index is built once per snapshot while the context is live
  // (research R7's lifetime rule) — before any record loop that might
  // hand its results to a consumer that disposes. Parse-only yields the
  // empty index inside.
  const callerIndex = buildCallerIndex(context, records, inScopePaths);
  // The checker-resolved components' gate: null in parse-only mode, where
  // each carries its degradation value (false/0) below.
  const checker = context.mode === "program" ? context.checker : null;
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
      exportedReturnType:
        checker !== null && hasExportedReturnType(checker, record.node),
      exportedReceiver:
        enclosingClass !== null && isExportedValue(enclosingClass, cjsNamesByFile),
      docText: docTextOf(record.node),
      docTags: docTagsOf(record.node),
      interfaceMember:
        checker !== null &&
        enclosingClass !== null &&
        isDeclaredInterfaceMember(checker, enclosingClass, record.name),
      // Total in program mode (one entry per record, 0 for the uncalled);
      // the empty parse-only index leaves every record at the degraded 0.
      callerModuleCount: callerIndex.get(record) ?? 0,
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
 * receiver/function component split turns on exactly this shape, and the
 * interface-heritage component reads the returned class's heritage
 * clauses.
 *
 * @param node The record's node.
 * @returns The enclosing class-like, or null when the record is not a
 * direct class member.
 */
function enclosingClassOf(node: Node): ClassLikeDeclaration | null {
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
 * Resolves a checker-returned symbol to the symbol its references name:
 * an import alias is followed to its target, every other symbol passes
 * through unchanged. Constitution Principle III's price on the unstable
 * surface — `getAliasedSymbol` is the checker's own alias machinery —
 * comes with a hard precondition the module header records: the native
 * server PANICS on a non-alias argument ("Should only get alias here",
 * verified against 7.0.2), so the Alias-flag gate below is a safety
 * requirement, not a stylistic choice.
 *
 * Principle II at the unresolved boundary: an alias whose target cannot
 * be resolved (a name imported from a missing module) yields the
 * checker's unknown symbol, which identifies nothing — absence of
 * evidence, returned as null, never an error and never a phantom target.
 *
 * @param checker The live program-mode type checker.
 * @param symbol The symbol a reference resolved to, or undefined when the
 * reference resolved nowhere.
 * @returns The referenced symbol with aliases followed, or null when
 * nothing resolvable backs the reference.
 */
function resolveThroughAliases(
  checker: Checker,
  symbol: CompilerSymbol | undefined,
): CompilerSymbol | null {
  if (symbol === undefined) {
    return null;
  }
  if ((symbol.flags & SymbolFlags.Alias) === 0) {
    return symbol;
  }
  const target = checker.getAliasedSymbol(symbol);
  return checker.isUnknownSymbol(target) ? null : target;
}

/**
 * The interface-heritage component (research R6; data-model.md Section
 * 5.1): whether an interface in the enclosing class's heritage DECLARES a
 * member carrying the record's name.
 *
 * The route, each step verified against 7.0.2: `checker.getSymbolAtLocation`
 * on each heritage clause type's EXPRESSION (the clause-type node itself
 * resolves nothing), aliases followed to the base symbol, the base counted
 * only when one of its declarations is an `InterfaceDeclaration` — the
 * declaration-kind gate that keeps a resolvable CLASS base from firing
 * through either heritage token, `extends Base` and `implements Base`
 * alike — and membership read from the base symbol's `getMembers()`
 * DECLARED-member table, keyed by the record's escaped name.
 *
 * The declared table is load-bearing (research R6's pinned hazard): an
 * apparent-member lookup would find `Object`-prototype members on every
 * interface and manufacture +30 signals on every `toString`-alike method.
 * The escaped-name key is the compiler's own `escapeLeadingUnderscores`
 * spelling — names beginning with `__` carry one extra underscore in the
 * table (Principle III: the compiler's util, never a reimplementation).
 * An invalid `extends`-an-interface clause resolves through no checker
 * route (the symbol is undefined) and contributes nothing — Principle II,
 * undeterminable is absence of evidence, never an error.
 *
 * @param checker The live program-mode type checker.
 * @param enclosingClass The class-like the record is a direct member of.
 * @param name The record's member name.
 * @returns Whether a heritage interface declares a member with that name.
 */
function isDeclaredInterfaceMember(
  checker: Checker,
  enclosingClass: ClassLikeDeclaration,
  name: string,
): boolean {
  const escapedName = escapeLeadingUnderscores(name);
  for (const clause of enclosingClass.heritageClauses ?? []) {
    for (const base of clause.types) {
      const baseSymbol = resolveThroughAliases(
        checker,
        checker.getSymbolAtLocation(base.expression),
      );
      if (baseSymbol === null) {
        continue;
      }
      // The declaration-kind gate: only an interface base counts. A class
      // base resolves to the same member-bearing symbol shape — the kind
      // is the only discriminator (research R6's cheap-check-first shape).
      if (
        !baseSymbol.declarations.some(
          (declaration) => declaration.kind === SyntaxKind.InterfaceDeclaration,
        )
      ) {
        continue;
      }
      if (baseSymbol.getMembers().has(escapedName)) {
        return true;
      }
    }
  }
  return false;
}

/**
 * The exported-return-type component (research R5; data-model.md Section
 * 5.1): whether the record's own explicit return-type annotation contains
 * at least one type reference resolving through the checker to an exported
 * or ambient symbol. See the module header's return-type contract for the
 * full rule.
 *
 * @param checker The live program-mode type checker.
 * @param node The record's function-like node.
 * @returns Whether an exported or ambient type reference appears in the
 * annotation.
 */
function hasExportedReturnType(checker: Checker, node: Node): boolean {
  const annotation = returnTypeAnnotationOf(node);
  if (annotation === null) {
    return false;
  }
  for (const reference of typeReferencesIn(annotation)) {
    const symbol = resolveThroughAliases(
      checker,
      checker.getSymbolAtLocation(reference.typeName),
    );
    if (symbol === null) {
      continue;
    }
    if (symbol.declarations.some(isExportedOrAmbientDeclaration)) {
      return true;
    }
  }
  return false;
}

/**
 * The record node's explicit return-type annotation — the `type` field of
 * the function-like itself, present for every record form that annotates a
 * return (the declaration forms and the assigned expression forms alike
 * carry it on the function-like node the record wraps). Constructors and
 * setters cannot annotate a return; unannotated functions do not.
 *
 * @param node The record's node.
 * @returns The annotation's type-node subtree, or null when absent.
 */
function returnTypeAnnotationOf(node: Node): TypeNode | null {
  return isFunctionLikeDeclaration(node) && node.type !== undefined ? node.type : null;
}

/**
 * Collects every identifier-based type reference in an annotation subtree,
 * outer references and nested type arguments alike (`Result | null`,
 * `Array<Result>`): a keyword (`string`), a literal type (`"ok"`), and an
 * object-literal type (`{ n: number }`) are not type references and never
 * appear. The walk revisits only nodes of a file extraction already
 * admitted under its depth budget — the detector's per-record walk
 * discipline, no second budget.
 *
 * @param annotation The annotation's root type node.
 * @returns The type-reference nodes within, in source order.
 */
function typeReferencesIn(annotation: TypeNode): readonly TypeReferenceNode[] {
  const references: TypeReferenceNode[] = [];
  const collect = (node: Node): void => {
    if (isTypeReferenceNode(node)) {
      references.push(node);
    }
    node.forEachChild((child) => {
      collect(child);
      return undefined;
    });
  };
  collect(annotation);
  return references;
}

/**
 * Whether one declaration of a resolved type symbol is exported or ambient
 * (research R5): exported is the export modifier on the declaration itself
 * — the same ESM signal as the exported-value rule's modifier route — and
 * ambient is a `.d.ts` source file (the platform libraries; their members
 * carry no export modifier, verified). A handle the producing project
 * cannot resolve identifies nothing.
 *
 * The cast is scoped to the modifier read: every declaration shape a
 * resolved type reference reaches (interface, class, alias, enum, module)
 * is modifier-bearing, and the `?? None` fallback covers the shapes the
 * cast cannot promise (a type parameter declaration), where no export
 * modifier exists — the bit test reads as no-export, never crashes.
 *
 * @param declaration The declaration handle to judge.
 * @returns Whether the declaration is exported or ambient.
 */
function isExportedOrAmbientDeclaration(declaration: NodeHandle): boolean {
  const node = declaration.resolve();
  if (node === undefined) {
    return false;
  }
  const modifierFlags = (node as ModifiersBase).modifierFlags ?? ModifierFlags.None;
  if ((modifierFlags & ModifierFlags.Export) !== 0) {
    return true;
  }
  return node.getSourceFile().fileName.endsWith(".d.ts");
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
