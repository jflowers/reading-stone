/**
 * The `doc_coverage` method (spec 005, FR-001 to FR-004 and FR-011;
 * research R1-R4): the documented-symbol surface walk, its wire record,
 * and the serializer that emits it.
 *
 * The walk enumerates the exported source-level symbols of an analysis
 * scope and reports, per symbol, whether a JSDoc comment is attached
 * (FR-002) and the first summary line of its description (FR-003). The
 * symbol surface (FR-002): exported function declarations (anonymous
 * `export default function` included), exported variable declarations —
 * a const with a function-like initializer routes to "function", any
 * other const to "constant", let and var to "variable" — exported
 * classes with their public method members (constructors, methods,
 * accessors), and exported type, interface, and enum declarations. An
 * `export default` naming an identifier emits the rows of the
 * module-level declaration it names, under that declaration's own name,
 * kind, and documentation.
 *
 * Boundary forms emit no row by design, never by silent omission
 * (Principle II): non-exported declarations; export clauses and
 * re-exports, whose rows belong to the declaration's own export
 * spelling; default exports of expressions (arrows, literals, object
 * literals), which name no declaration; `export =` and `module.exports`,
 * the CommonJS boundaries; destructuring binding patterns, which bind
 * many spellings to no single named symbol; namespaces and their
 * members; body-less overload and ambient signatures, whose
 * implementation signature is the symbol's documentation site; and
 * non-public class members (private, protected, #private).
 *
 * Constitution alignment:
 *
 * - Principle I (Protocol Fidelity): rows serialize to the doc_coverage
 *   wire shape — name, package, kind, file, line, documented, and
 *   doc_snippet only when a summary line exists — in the canonical
 *   sorted-key order the protocol layer's own serializer produces, so
 *   its pass is a structural no-op (the serializeComplexityEntry
 *   discipline).
 * - Principle III (TypeScript-Native Analysis): JSDoc attachment is read
 *   from the compiler's jsDoc arrays and the parent-hosting walk
 *   evidence.ts mirrors from the compiler's own
 *   `getNextJSDocCommentLocation` (nextJSDocHost — one shared hosting
 *   surface, so the doc and signal pipelines cannot drift), and comment
 *   text through the compiler's own `getTextOfJSDocComment` renderer —
 *   no custom doc parser. Verified against typescript 7.0.2: the
 *   renderer strips the ` * ` line decoration and per-line leading
 *   whitespace, preserves interior newlines, and keeps block tags out of
 *   the description — so FR-003's leading-`*` trim is discharged by the
 *   compiler surface itself, and stripping another asterisk here would
 *   mangle content asterisks the renderer deliberately preserves (a
 *   `**bold**` summary line survives verbatim).
 * - Principle IV (Testability): the walk core is a pure
 *   PreparedAnalysis-to-SymbolRow[] function; the entry owns the
 *   program-context lifetime and closes it in a finally, exactly as
 *   computeComplexity does, so no native compiler server outlives one
 *   analysis.
 * - Principle V (Analysis Safety): static analysis only — the walk reads
 *   the compiler's AST and never executes analyzed source.
 */

import type { Writable } from "node:stream";

import {
  type ClassDeclaration,
  type ConstructorDeclaration,
  type GetAccessorDeclaration,
  getTextOfJSDocComment,
  isArrowFunction,
  isClassDeclaration,
  isConstructorDeclaration,
  isEnumDeclaration,
  isExportAssignment,
  isFunctionDeclaration,
  isFunctionExpression,
  isGetAccessorDeclaration,
  isIdentifier,
  isInterfaceDeclaration,
  isJSDoc,
  isMethodDeclaration,
  isPrivateIdentifier,
  isSetAccessorDeclaration,
  isTypeAliasDeclaration,
  isVariableDeclaration,
  isVariableStatement,
  type JSDoc,
  type MethodDeclaration,
  ModifierFlags,
  type Node,
  NodeFlags,
  type SetAccessorDeclaration,
  type SourceFile,
  type VariableDeclaration,
} from "typescript/unstable/ast";

import { type PreparedAnalysis, prepareAnalysis } from "./analysis.js";
import { collectSources, propertyNameText } from "./extract.js";
import { compareFileLineName } from "./internal.js";
import { derivePackage } from "./models.js";
import { nextJSDocHost } from "./signals/evidence.js";

/**
 * The kind of a documented-symbol row (FR-001): the closed set the gaze
 * protocol's doc_coverage schema accepts — function, type, constant,
 * variable, class, method. Declared in full so every routed declaration
 * shape lands in the existing vocabulary; the walk's routing widens,
 * the wire set never does.
 */
export type SymbolKind =
  | "function"
  | "type"
  | "constant"
  | "variable"
  | "class"
  | "method";

/**
 * One documented-symbol row (FR-001): the symbol identity, its
 * documentation fact, and — when a summary line exists — the first line
 * of the attached JSDoc description. Field names mirror the wire payload
 * exactly, snake_case included (`doc_snippet`, the MappingRow and
 * FunctionRecord.side_effects precedent), and the entity is an
 * immutable value record (convention pack AP-004).
 */
export interface SymbolRow {
  /**
   * The declared name; the literal "default" for an anonymous
   * export-default function or class declaration.
   */
  readonly name: string;
  /** Dotted module path derived by `derivePackage` from `file`. */
  readonly package: string;
  /** The symbol's kind; see SymbolKind. */
  readonly kind: SymbolKind;
  /** Root-relative POSIX path of the declaring file. */
  readonly file: string;
  /**
   * 1-based line of the declaration's first token — modifiers included
   * (`export` for statements, accessibility keywords for class members)
   * — never its JSDoc.
   */
  readonly line: number;
  /** True if and only if a JSDoc comment is attached to the declaration (FR-002). */
  readonly documented: boolean;
  /** The first summary line of the description (FR-003): omitted when absent, never empty. */
  readonly doc_snippet?: string;
}

/**
 * The `doc_coverage` method entry (FR-001 to FR-004; the analyze-shaped
 * surface T018 established): the serialized SymbolRow array — one row
 * per in-scope symbol of the FR-002 surface — assembled in the (file,
 * line, name) total order and mapped through serializeSymbolRow so
 * every element of the returned array is wire-final.
 *
 * The returned array — not a {symbols: [...]} wrapper — follows the
 * computeComplexity split: the T009 server handler wraps the array into
 * the doc_coverage result shape, exactly as it wraps the complexity
 * entries. Both this entry and its payload are deterministic pure
 * functions of the analyzed tree (Constitution Principle I).
 *
 * The program-mode context's lifetime is this handler's — closed in the
 * finally whatever the walk outcome, exactly as analyze and
 * computeComplexity close theirs; a parse-only context owns nothing to
 * dispose.
 *
 * @param rootPath Absolute or relative project root; validated and
 * realpath-resolved by prepareAnalysis (an invalid root throws
 * InvalidRootPathError, which the server maps to -32602).
 * @param patterns The raw patterns parameter value; shape-validated by
 * the server (-32602) before analysis runs, normalized here.
 * @param stderr Injected diagnostic sink (Testability principle);
 * defaults to process.stderr. Stdout is never touched.
 * @returns The serialized symbol rows, (file, line, name)-sorted.
 * @throws InvalidRootPathError when the root does not exist, is not a
 * directory, or cannot be accessed.
 */
export async function docCoverage(
  rootPath: string,
  patterns: unknown,
  stderr: Writable = process.stderr,
): Promise<readonly Record<string, unknown>[]> {
  const prepared = await prepareAnalysis(rootPath, patterns, stderr);
  try {
    const rows = collectSymbolRows(prepared);
    rows.sort(compareFileLineName);
    return rows.map(serializeSymbolRow);
  } finally {
    if (prepared.context.mode === "program") {
      prepared.context.dispose();
    }
  }
}

/**
 * Serializes a SymbolRow to its wire shape (FR-001, FR-003): exactly the
 * six required fields, plus doc_snippet when set — omit-unset-optionals,
 * the serializeSignal reasoning idiom — never null, never an empty
 * string.
 *
 * Keys are emitted in the canonical sorted order the protocol layer's
 * code-unit key sort produces (doc_snippet first when present — '_'
 * sorts before 'u'), so that pass is a structural no-op: the
 * serializeComplexityEntry discipline.
 *
 * Validation is the deliberate blend of the two house serializer
 * patterns: a pure projection for fields whose validity is structural at
 * this module's single walk construction site (the
 * serializeComplexityEntry argument — no per-field revalidation of
 * names, paths, lines, or booleans), plus the closed-set and
 * never-empty guards the wire contract pins independently of
 * construction (the AssertionKind and omit-unset-optionals patterns):
 * kind membership in SymbolKind's set, and a present-but-empty
 * doc_snippet fails loud rather than reaching the wire.
 *
 * @param row The symbol row to serialize.
 * @returns A JSON-ready object with the wire fields in canonical order.
 * @throws Error when kind is outside the closed set or doc_snippet is
 * present but empty.
 */
export function serializeSymbolRow(row: SymbolRow): Record<string, unknown> {
  if (!SYMBOL_KINDS.has(row.kind)) {
    throw new Error(`Invalid symbol kind: ${row.kind}`);
  }
  const serialized: Record<string, unknown> = {
    documented: row.documented,
    file: row.file,
    kind: row.kind,
    line: row.line,
    name: row.name,
    package: row.package,
  };
  if (row.doc_snippet !== undefined) {
    if (row.doc_snippet.length === 0) {
      throw new Error("Invalid doc_snippet: must be a non-empty string when present");
    }
    return { doc_snippet: row.doc_snippet, ...serialized };
  }
  return serialized;
}

/**
 * The SymbolKind closed set (FR-001), held as a Set for membership so
 * lookups consult own data only, never the prototype chain — the
 * ASSERTION_KINDS and SIGNAL_SOURCES pattern. Constructed with the
 * SymbolKind element type so a misspelled member is a compile error.
 * Module-private: T025's public surface ships docCoverage and the row
 * types, not the set.
 */
const SYMBOL_KINDS: ReadonlySet<string> = new Set<SymbolKind>([
  "function",
  "type",
  "constant",
  "variable",
  "class",
  "method",
]);

/**
 * The symbol-surface walk (FR-002): the rows for every documented-symbol
 * surface member of the in-scope sources.
 *
 * Scope narrowing (FR-004): program mode can pull pattern-excluded
 * in-root transitive imports into the program — the behavior
 * analysis.ts documents for its own record narrowing — so the
 * collectSources pairs are filtered by prepared.inScopePaths. The walk
 * reports exactly the files the patterns select, never the imports they
 * drag in: file-set parity with analyze stays structural (research R2;
 * the parity T003's export widening was cut for).
 *
 * @param prepared The shared analysis preparation (root, context, scope).
 * @returns The symbol rows; docCoverage sorts them into wire order.
 */
function collectSymbolRows(prepared: PreparedAnalysis): SymbolRow[] {
  const rows: SymbolRow[] = [];
  const inScope = new Set(prepared.inScopePaths);
  const sources = collectSources(prepared.rootPath, prepared.context);
  for (const [relPath, sourceFile] of sources) {
    if (!inScope.has(relPath)) {
      continue;
    }
    collectFileRows(relPath, sourceFile, rows);
  }
  return rows;
}

/**
 * One file's rows, in two passes (FR-002's identifier-default rule).
 *
 * Pass one walks the module-level statements: every exported declaration
 * emits its rows. Pass two resolves `export default` naming an
 * identifier — the only default form that names a declaration — against
 * an index of the file's module-level declarations, emitting the
 * referenced declaration's rows under its own name, kind, and
 * documentation (a default export with a declared name uses the name).
 * The emitted set deduplicates: a declaration both exported and named by
 * a default export produces one row set, and a declaration whose
 * routing emits nothing (an overload signature) emits nothing in either
 * pass — the body gate lives in the shared routing, not the export
 * spelling.
 *
 * Determinism: both passes iterate statement order, and the final
 * (file, line, name) sort makes append order immaterial to the wire.
 *
 * @param relPath Root-relative POSIX path of the file.
 * @param sourceFile The parsed source.
 * @param rows The accumulator rows are appended to.
 */
function collectFileRows(
  relPath: string,
  sourceFile: SourceFile,
  rows: SymbolRow[],
): void {
  const emitted = new Set<Node>();
  const declarations = indexModuleDeclarations(sourceFile);
  const defaulted: string[] = [];
  for (const statement of sourceFile.statements) {
    if (isExportedDeclaration(statement)) {
      emitSymbolRows(statement, relPath, sourceFile, rows, emitted);
      continue;
    }
    if (
      isExportAssignment(statement) &&
      !statement.isExportEquals &&
      isIdentifier(statement.expression)
    ) {
      defaulted.push(statement.expression.text);
    }
  }
  for (const name of defaulted) {
    const declaration = declarations.get(name);
    if (declaration !== undefined && !emitted.has(declaration)) {
      emitSymbolRows(declaration, relPath, sourceFile, rows, emitted);
    }
  }
}

/**
 * Name-to-declaration index of a file's module-level statements — the
 * lookup surface `export default` naming an identifier resolves against.
 * Names come from the declarations themselves (function, class, type
 * alias, interface, enum, and identifier-bound variable declarations);
 * the last statement of a duplicate name wins, matching the overload-set
 * convention that the implementation signature follows its overloads —
 * and the body gate in emitSymbolRows, not the index, decides what a
 * looked-up overload set emits.
 *
 * @param sourceFile The parsed source.
 * @returns The declarations keyed by declared name.
 */
function indexModuleDeclarations(sourceFile: SourceFile): Map<string, Node> {
  const declarations = new Map<string, Node>();
  for (const statement of sourceFile.statements) {
    if (isFunctionDeclaration(statement) && statement.name !== undefined) {
      declarations.set(statement.name.text, statement);
      continue;
    }
    if (isClassDeclaration(statement) && statement.name !== undefined) {
      declarations.set(statement.name.text, statement);
      continue;
    }
    if (
      isTypeAliasDeclaration(statement) ||
      isInterfaceDeclaration(statement) ||
      isEnumDeclaration(statement)
    ) {
      declarations.set(statement.name.text, statement);
      continue;
    }
    if (isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (isIdentifier(declaration.name)) {
          declarations.set(declaration.name.text, declaration);
        }
      }
    }
  }
  return declarations;
}

/**
 * Whether a statement is one of the declaration forms the FR-002 surface
 * routes, carrying the Export modifier — the composite flag whose bits
 * cover both `export` and `export default` (verified against
 * typescript 7.0.2: ExportDefault is Export | Default), so one test
 * admits both spellings. The export-modifier shape extends
 * evidence.ts's hasExportModifier with the type, interface, and enum
 * declaration forms the signal pipeline never reads.
 *
 * @param statement The module-level statement to test.
 * @returns True when the statement is an exported routed declaration.
 */
function isExportedDeclaration(statement: Node): boolean {
  return (
    (isFunctionDeclaration(statement) ||
      isClassDeclaration(statement) ||
      isVariableStatement(statement) ||
      isTypeAliasDeclaration(statement) ||
      isInterfaceDeclaration(statement) ||
      isEnumDeclaration(statement)) &&
    (statement.modifierFlags & ModifierFlags.Export) !== 0
  );
}

/**
 * FR-002's routing table: the rows one module-level declaration emits.
 * Both file passes converge here — an exported statement and the
 * declaration an `export default` names route identically, so a symbol's
 * row never depends on which spelling exported it.
 *
 * Routing: a VariableStatement fans out to its declarations (a
 * multi-declarator statement exports each); a function declaration with
 * a body emits a "function" row — an anonymous one is grammatically only
 * `export default function`, so FR-001's literal "default" names it —
 * while a body-less overload or ambient signature emits none, the
 * implementation signature being the symbol's documentation site; a
 * variable declaration with an identifier name emits a row whose kind
 * the declaration keyword and initializer shape decide (variableRowKind)
 * — a destructuring pattern binds many spellings to no single symbol
 * and emits none; a class declaration emits a "class" row plus its
 * public method members' rows; a type alias, interface, or enum emits a
 * single "type" row — interface and enum members are not symbols of the
 * documentation surface. Any other node emits nothing.
 *
 * @param node The statement or declaration to route.
 * @param relPath Root-relative POSIX path of the declaring file.
 * @param sourceFile The declaring source (line math, member names).
 * @param rows The accumulator rows are appended to.
 * @param emitted The declarations that have emitted; the dedup surface
 * for the identifier-default pass.
 */
function emitSymbolRows(
  node: Node,
  relPath: string,
  sourceFile: SourceFile,
  rows: SymbolRow[],
  emitted: Set<Node>,
): void {
  if (isVariableStatement(node)) {
    for (const declaration of node.declarationList.declarations) {
      emitSymbolRows(declaration, relPath, sourceFile, rows, emitted);
    }
    return;
  }
  if (isFunctionDeclaration(node)) {
    if (node.body !== undefined) {
      emitted.add(node);
      rows.push(
        symbolRow(relPath, sourceFile, node, node.name?.text ?? "default", "function"),
      );
    }
    return;
  }
  if (isVariableDeclaration(node)) {
    if (isIdentifier(node.name)) {
      emitted.add(node);
      rows.push(
        symbolRow(relPath, sourceFile, node, node.name.text, variableRowKind(node)),
      );
    }
    return;
  }
  if (isClassDeclaration(node)) {
    emitted.add(node);
    rows.push(
      symbolRow(relPath, sourceFile, node, node.name?.text ?? "default", "class"),
    );
    emitClassMemberRows(node, relPath, sourceFile, rows);
    return;
  }
  if (
    isTypeAliasDeclaration(node) ||
    isInterfaceDeclaration(node) ||
    isEnumDeclaration(node)
  ) {
    emitted.add(node);
    rows.push(symbolRow(relPath, sourceFile, node, node.name.text, "type"));
  }
}

/**
 * The class elements that carry executable declarations: methods,
 * constructors, and property accessors — the FR-002 method surface.
 * Property declarations, index signatures, and static blocks are not
 * members of it.
 */
type ClassMethodLike =
  | MethodDeclaration
  | ConstructorDeclaration
  | GetAccessorDeclaration
  | SetAccessorDeclaration;

/**
 * Whether a class element is one of the method-like declarations.
 *
 * @param member The class element to test.
 * @returns True when the element declares a method-like member.
 */
function isClassMethodLike(member: Node): member is ClassMethodLike {
  return (
    isMethodDeclaration(member) ||
    isConstructorDeclaration(member) ||
    isGetAccessorDeclaration(member) ||
    isSetAccessorDeclaration(member)
  );
}

/**
 * The public method surface of one exported class (FR-002): methods,
 * constructors, and accessors emit "method" rows; every other class
 * element — property declarations, index signatures, static blocks —
 * emits none.
 *
 * Exclusion is the accessibility contract, not a heuristic: the
 * private/protected modifier bits and #private names (PrivateIdentifier
 * — which carries no modifier bit at all, verified against typescript
 * 7.0.2, so the name's node kind is the only reliable test) mark
 * members no consumer of the exported surface can see. Body-less
 * members emit only when abstract: an overload signature has no
 * documentation site of its own (its implementation is the symbol), but
 * an abstract method is the declaration of the symbol itself. Static
 * public methods are part of the exported surface and included. A
 * getter/setter pair is two declarations and emits two rows, one per
 * accessor line. Constructors have no name node — the literal
 * "constructor" is the row name; other members take their source
 * spelling through propertyNameText, the same identity surface
 * ExtractionRecord uses, so doc rows and extraction records agree.
 *
 * @param cls The exported class declaration.
 * @param relPath Root-relative POSIX path of the declaring file.
 * @param sourceFile The declaring source (line math, member names).
 * @param rows The accumulator rows are appended to.
 */
function emitClassMemberRows(
  cls: ClassDeclaration,
  relPath: string,
  sourceFile: SourceFile,
  rows: SymbolRow[],
): void {
  for (const member of cls.members) {
    if (!isClassMethodLike(member)) {
      continue;
    }
    if ((member.modifierFlags & ModifierFlags.NonPublicAccessibilityModifier) !== 0) {
      continue;
    }
    if (!isConstructorDeclaration(member) && isPrivateIdentifier(member.name)) {
      continue;
    }
    if (
      member.body === undefined &&
      (member.modifierFlags & ModifierFlags.Abstract) === 0
    ) {
      continue;
    }
    const name = isConstructorDeclaration(member)
      ? "constructor"
      : propertyNameText(member.name, sourceFile);
    rows.push(symbolRow(relPath, sourceFile, member, name, "method"));
  }
}

/**
 * FR-002's kind routing for one variable declaration, decided by the
 * declaration keyword and the initializer's shape: let and var are
 * reassignable bindings — "variable" — regardless of initializer (the
 * table routes by keyword); a const with a function-like initializer
 * (arrow or function expression, generator expressions included — one
 * node kind) names a function — "function"; any other const is a value
 * — "constant". The keyword comes from the declaration list's NodeFlags
 * (Const = 2, verified against typescript 7.0.2), the same flag surface
 * the compiler's own binder reads.
 *
 * @param declaration The variable declaration to classify.
 * @returns The row kind: function, constant, or variable.
 */
function variableRowKind(declaration: VariableDeclaration): SymbolKind {
  if ((declaration.parent.flags & NodeFlags.Const) === 0) {
    return "variable";
  }
  const initializer = declaration.initializer;
  if (
    initializer !== undefined &&
    (isArrowFunction(initializer) || isFunctionExpression(initializer))
  ) {
    return "function";
  }
  return "constant";
}

/**
 * Builds one symbol row: identity from the arguments, position from the
 * node's first token, and the documentation fact from the JSDoc
 * attached to the node (attachedJsDocs).
 *
 * The snippet owner is the LAST attached JSDoc — the compiler's own
 * ownership convention (its filterOwnedJSDocTags resolves multiple
 * comments on one node to the final one) — while `documented` reflects
 * any attachment, so a tags-only final comment still reports
 * documented: true with the snippet omitted (FR-003's tags-only edge).
 *
 * @param relPath Root-relative POSIX path of the declaring file.
 * @param sourceFile The declaring source (line math).
 * @param node The declaration the row describes.
 * @param name The symbol's row name.
 * @param kind The symbol's row kind.
 * @returns The SymbolRow for the declaration.
 */
function symbolRow(
  relPath: string,
  sourceFile: SourceFile,
  node: Node,
  name: string,
  kind: SymbolKind,
): SymbolRow {
  const jsDocs = attachedJsDocs(node);
  const owner = jsDocs.at(-1);
  const docSnippet = owner !== undefined ? docSnippetOf(owner) : undefined;
  return {
    name,
    package: derivePackage(relPath),
    kind,
    file: relPath,
    line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
    documented: jsDocs.length > 0,
    ...(docSnippet !== undefined ? { doc_snippet: docSnippet } : {}),
  };
}

/**
 * The JSDoc comments attached to a declaration, read from the node's own
 * jsDoc array — the same compiler surface evidence.ts reads — and then
 * from each hosting parent up the compiler's parent-hosting chain
 * (nextJSDocHost), innermost first. The hosting chain is what makes a
 * variable declaration's statement comment its documentation: the
 * compiler attaches a statement-leading comment to the statement and
 * considers it hosted by the declaration. For every other routed shape
 * — statements, class members, type declarations — the walk ends at the
 * enclosing source file or class body (evidence.ts documents the same
 * stop), so their rows read their own comments alone.
 *
 * @param node The declaration whose attached comments are read.
 * @returns The attached JSDoc comments, in attachment order.
 */
function attachedJsDocs(node: Node): readonly JSDoc[] {
  const docs: JSDoc[] = [];
  let current: Node | undefined = node;
  while (current !== undefined) {
    for (const attached of current.jsDoc ?? []) {
      if (isJSDoc(attached)) {
        docs.push(attached);
      }
    }
    current = nextJSDocHost(current);
  }
  return docs;
}

/**
 * The FR-003 snippet rule over one rendered JSDoc description: the first
 * non-empty line that is not a block-tag line (a line whose first token
 * begins with @), trimmed of surrounding whitespace; undefined when no
 * line qualifies, so the row omits the key (never an empty string).
 *
 * The leading-`*` trim FR-003 names is discharged by the compiler's own
 * renderer — getTextOfJSDocComment (typescript 7.0.2, verified) strips
 * the ` * ` decoration and per-line leading whitespace and keeps block
 * tags out of the description — so rendered lines carry no decoration
 * left to strip, and stripping another asterisk here would mangle
 * content asterisks the renderer preserves (a `**bold**` summary line
 * must survive verbatim). The @ check is defensive for the same reason:
 * the compiler parses tags — unknown tag names included — out of the
 * description, so a rendered @-leading line is not expected on real
 * output.
 *
 * @param doc The JSDoc comment whose description is scanned.
 * @returns The first summary line, or undefined when none qualifies.
 */
function docSnippetOf(doc: JSDoc): string | undefined {
  const text = getTextOfJSDocComment(doc.comment);
  if (text === undefined) {
    return undefined;
  }
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (line.length === 0) {
      continue;
    }
    if (line.startsWith("@")) {
      continue;
    }
    return line;
  }
  return undefined;
}
