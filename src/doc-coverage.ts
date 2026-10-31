/**
 * The `doc_coverage` method (spec 005, FR-001 to FR-004 and FR-011;
 * research R1-R4): the documented-symbol surface walk, its wire record,
 * and the serializer that emits it.
 *
 * The walk enumerates the exported source-level symbols of an analysis
 * scope and reports, per symbol, whether a JSDoc comment is attached
 * (FR-002) and the first summary line of its description (FR-003). This
 * module implements the US1 slice only — exported body-bearing function
 * declarations (FR-001). Routing for the remaining `SymbolKind` members
 * (type, constant, variable, class, method) arrives with T021's
 * phase-5 walk extension; the full closed set is declared now so that
 * extension widens the walk without widening the wire vocabulary.
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
 *   from the declaration's own `jsDoc` array (the surface evidence.ts
 *   reads) and comment text through the compiler's own
 *   `getTextOfJSDocComment` renderer — no custom doc parser. Verified
 *   against typescript 7.0.2: the renderer strips the ` * ` line
 *   decoration and per-line leading whitespace, preserves interior
 *   newlines, and keeps block tags out of the description — so FR-003's
 *   leading-`*` trim is discharged by the compiler surface itself, and
 *   stripping another asterisk here would mangle content asterisks the
 *   renderer deliberately preserves (a `**bold**` summary line survives
 *   verbatim).
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
  type FunctionDeclaration,
  getTextOfJSDocComment,
  isFunctionDeclaration,
  isJSDoc,
  type JSDoc,
  ModifierFlags,
  type SourceFile,
} from "typescript/unstable/ast";

import { type PreparedAnalysis, prepareAnalysis } from "./analysis.js";
import { collectSources } from "./extract.js";
import { compareFileLineName } from "./internal.js";
import { derivePackage } from "./models.js";

/**
 * The kind of a documented-symbol row (FR-001): the closed set the gaze
 * protocol's doc_coverage schema accepts — function, type, constant,
 * variable, class, method. Declared in full now so T021's walk extension
 * routes new declaration shapes into the existing vocabulary; the US1
 * walk emits only "function".
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
  /** The declared name; the literal "default" for an anonymous export-default function. */
  readonly name: string;
  /** Dotted module path derived by `derivePackage` from `file`. */
  readonly package: string;
  /** The symbol's kind; see SymbolKind. */
  readonly kind: SymbolKind;
  /** Root-relative POSIX path of the declaring file. */
  readonly file: string;
  /** 1-based line of the declaration — its first token (`export`), not its JSDoc. */
  readonly line: number;
  /** True if and only if a JSDoc comment is attached to the declaration (FR-002). */
  readonly documented: boolean;
  /** The first summary line of the description (FR-003): omitted when absent, never empty. */
  readonly doc_snippet?: string;
}

/**
 * The `doc_coverage` method entry (FR-001 to FR-004; the analyze-shaped
 * surface T018 established): the serialized SymbolRow array — one row
 * per in-scope exported body-bearing function declaration, assembled in
 * the (file, line, name) total order and mapped through
 * serializeSymbolRow so every element of the returned array is
 * wire-final.
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
 * The US1 slice of the symbol-surface walk: one row per body-bearing
 * exported top-level function declaration of the in-scope sources.
 *
 * Scope narrowing (FR-004): program mode can pull pattern-excluded
 * in-root transitive imports into the program — the behavior
 * analysis.ts documents for its own record narrowing — so the
 * collectSources pairs are filtered by prepared.inScopePaths. The walk
 * reports exactly the files the patterns select, never the imports they
 * drag in: file-set parity with analyze stays structural (research R2;
 * the parity T003's export widening was cut for).
 *
 * The three-clause filter is the US1 surface definition: overload
 * signatures and ambient declarations carry no body and produce no row
 * (the implementation signature is the symbol's documentation site, per
 * the overload edge case), and the Export modifier bit covers export
 * default — the composite flag includes Export. T021's extension adds
 * kind routing here (const/let/var, class, type/interface/enum, class
 * members) without changing the loop's shape.
 */
function collectSymbolRows(prepared: PreparedAnalysis): SymbolRow[] {
  const rows: SymbolRow[] = [];
  const inScope = new Set(prepared.inScopePaths);
  const sources = collectSources(prepared.rootPath, prepared.context);
  for (const [relPath, sourceFile] of sources) {
    if (!inScope.has(relPath)) {
      continue;
    }
    for (const statement of sourceFile.statements) {
      if (
        !isFunctionDeclaration(statement) ||
        statement.body === undefined ||
        (statement.modifierFlags & ModifierFlags.Export) === 0
      ) {
        continue;
      }
      rows.push(functionRowOf(relPath, sourceFile, statement));
    }
  }
  return rows;
}

/**
 * Builds the row for one exported body-bearing function declaration.
 *
 * The name fallback: an anonymous body-bearing function declaration is
 * grammatically only `export default function`, and FR-001 pins the
 * literal "default" as its name. The snippet owner is the LAST attached
 * JSDoc — the compiler's own ownership convention (its
 * filterOwnedJSDocTags resolves multiple comments on one node to the
 * final one) — while `documented` reflects any attachment, so a
 * tags-only final comment still reports documented: true with the
 * snippet omitted (FR-003's tags-only edge).
 *
 * @param relPath Root-relative POSIX path of the declaring file.
 * @param sourceFile The declaring source file (line math).
 * @param declaration The exported body-bearing function declaration.
 * @returns The SymbolRow for the declaration.
 */
function functionRowOf(
  relPath: string,
  sourceFile: SourceFile,
  declaration: FunctionDeclaration,
): SymbolRow {
  const jsDocs = attachedJsDocs(declaration);
  const owner = jsDocs.at(-1);
  const docSnippet = owner !== undefined ? docSnippetOf(owner) : undefined;
  return {
    name: declaration.name?.text ?? "default",
    package: derivePackage(relPath),
    kind: "function",
    file: relPath,
    line:
      sourceFile.getLineAndCharacterOfPosition(declaration.getStart(sourceFile)).line +
      1,
    documented: jsDocs.length > 0,
    ...(docSnippet !== undefined ? { doc_snippet: docSnippet } : {}),
  };
}

/**
 * The JSDoc comments attached to a declaration, read from the node's own
 * jsDoc array — the same compiler surface evidence.ts reads. The array
 * is typed readonly Node[], so isJSDoc filters it down to the JSDoc
 * subset. Attachment to the declaration itself is complete for US1:
 * function declarations are statements, so the compiler's parent-hosting
 * walk (nextJSDocHost) never applies — that walk matters for expression
 * and class-member shapes, which arrive with T021.
 *
 * @param declaration The declaration whose attached comments are read.
 * @returns The attached JSDoc comments, in attachment order.
 */
function attachedJsDocs(declaration: FunctionDeclaration): readonly JSDoc[] {
  return (declaration.jsDoc ?? []).filter(isJSDoc);
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
