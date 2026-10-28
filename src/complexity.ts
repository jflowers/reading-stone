import type { Writable } from "node:stream";

import { isBinaryExpression, type Node, SyntaxKind } from "typescript/unstable/ast";

import { prepareAnalysis } from "./analysis.js";
import { type ExtractionRecord, isExtractedFunctionLike } from "./extract.js";
import { compareFileLineName } from "./internal.js";
import { derivePackage } from "./models.js";

/**
 * The cyclomatic complexity engine (FR-021, FR-022; research R9;
 * data-model.md's ComplexityEntry/ComplexityResult; Constitution
 * Principles I and IV). `computeComplexity` (T023) closes the shared
 * `prepareAnalysis` pipeline (T014) over the decision-point count — the
 * SAME extraction set, scope, and ordering `analyze` reports, so FR-022's
 * parity guarantee is structural (no second extraction path to drift) —
 * with the program-mode context's lifetime owned by this handler and
 * closed in a `finally` exactly as `analyze` closes its own.
 *
 * The counting rule (FR-021 / contracts/complexity.md / research R9):
 * complexity = 1 + the count of `if` (each `else if` is a nested `if` and
 * counts naturally), `for`, `for-of`, `for-in`, `while`, `do`, each
 * `case` clause (`default` excluded), `catch`, conditional (ternary)
 * expressions, and the binary logical operators `&&`, `||`, `??` — in the
 * function's OWN body, so the per-record walk starts at the body node (an
 * expression-bodied arrow's expression included). The list is closed:
 * logical-assignment operators (`&&=`, `||=`, `??=`) are never counted
 * (Assumption 10). An empty body scores exactly 1.
 *
 * Attribution (FR-009, the same boundary the detector walks): the
 * per-record walk stops at nested extracted function-likes — the R4 form
 * conditions `extract.ts` exports as `isExtractedFunctionLike`, so the
 * boundary is the extractor's own, never a re-derivation — because each
 * nested form's record owns its body; anonymous (unassigned) function
 * expressions are not in the record set, so the walk continues through
 * them and their constructs count toward the innermost enclosing record.
 *
 * No second AST depth budget: extraction already discarded any file whose
 * AST could exceed its budget (a record exists only for an in-budget
 * file), and this walk revisits exactly those materialized subtrees —
 * the argument `detector.ts` records for its own walk.
 */

/**
 * One complexity entry (data-model.md's ComplexityEntry; FR-022): the
 * extraction identity plus the computed score. Field names mirror the
 * wire payload exactly — no snake_case exception applies to this record —
 * and the entity is an immutable value record (convention pack AP-004).
 */
export interface ComplexityEntry {
  /** The function's declared name (extraction identity, FR-008). */
  readonly name: string;
  /** Dotted module path derived by `derivePackage` from `file`. */
  readonly package: string;
  /** Root-relative POSIX path of the declaring file. */
  readonly file: string;
  /** 1-based line of the function declaration. */
  readonly line: number;
  /** 1 + the counted decision points (an integer ≥ 1). */
  readonly complexity: number;
}

/**
 * The `complexity` method's entry (FR-021, FR-022; the analyze-shaped
 * surface T018 established): the serialized `ComplexityEntry[]` payload —
 * one entry per extraction record, assembled in the `(file, line, name)`
 * total order, and mapped through `serializeComplexityEntry` so every
 * entry on the returned array is already wire-shaped.
 *
 * The returned array — not a `{functions: [...]}` wrapper — is the
 * documented result shape the server wraps into its JSON-RPC success
 * response (T024); both this entry and the payload are deterministic
 * pure functions of the analyzed tree (Constitution Principle I:
 * byte-identical repeat responses).
 *
 * The program-mode context's lifetime is this handler's: the native
 * compiler server behind it is closed in the `finally` whatever the
 * counting outcome, so no subprocess outlives one analysis. A parse-only
 * context owns nothing to dispose.
 *
 * @param rootPath Absolute or relative project root; validated and
 * realpath-resolved by `prepareAnalysis` (an invalid root throws
 * `InvalidRootPathError`, the server maps to `-32602`).
 * @param patterns The raw `patterns` parameter value; shape-validated by
 * the server (`-32602`, T019) before analysis runs, normalized here.
 * @param stderr Injected diagnostic sink (Testability principle); defaults
 * to `process.stderr`. Stdout is never touched.
 * @returns The serialized complexity entries, `(file, line, name)`-sorted.
 */
export async function computeComplexity(
  rootPath: string,
  patterns: unknown,
  stderr: Writable = process.stderr,
): Promise<readonly Record<string, unknown>[]> {
  const prepared = await prepareAnalysis(rootPath, patterns, stderr);
  try {
    const entries = prepared.records.map(
      (record): ComplexityEntry => ({
        name: record.name,
        package: derivePackage(record.relPath),
        file: record.relPath,
        line: record.line,
        complexity: 1 + countDecisionPoints(record),
      }),
    );
    entries.sort(compareFileLineName);
    return entries.map(serializeComplexityEntry);
  } finally {
    if (prepared.context.mode === "program") {
      prepared.context.dispose();
    }
  }
}

/**
 * Serializes a `ComplexityEntry` to its wire shape (FR-022): exactly the
 * five fields, emitted in the canonical sorted-key order the protocol
 * layer's sorted-key serializer produces — so the server's `serialize`
 * pass re-orders these keys as a structural no-op and each entry is
 * wire-final in the form that serializer defines.
 *
 * A pure projection, deliberately without the fail-loud field validation
 * `models.ts`'s record serializers apply: those guard records assembled
 * from many detector construction sites (and `tests/models.test.ts`
 * covers the guards), while every `ComplexityEntry` is constructed at
 * this module's single site from fields whose validity is structural —
 * `ExtractionRecord`'s string `name`/`relPath`, a 1-based `line`, and
 * `complexity` as `1 + countDecisionPoints` (≥ 1 by construction). The
 * wire shape itself — exactly these five keys, integer `complexity` ≥ 1 —
 * is pinned by `tests/complexity.test.ts`'s wire-invariant assertions.
 *
 * @param entry The complexity entry to serialize.
 * @returns A JSON-ready object with `complexity`, `file`, `line`, `name`,
 * and `package`.
 */
export function serializeComplexityEntry(
  entry: ComplexityEntry,
): Record<string, unknown> {
  return {
    complexity: entry.complexity,
    file: entry.file,
    line: entry.line,
    name: entry.name,
    package: entry.package,
  };
}

/**
 * Counts the closed decision-point list (FR-021; research R9) inside one
 * record's own body.
 *
 * The walk starts at the record's body node — a block body's statements,
 * an expression-bodied arrow's expression — because FR-021 counts what is
 * in the function's own body. It stops at nested extracted
 * function-likes (each owns its own record, so its decision points belong
 * to its own entry) and continues through anonymous function-likes, whose
 * constructs attribute to this record per FR-009. Each occurrence counts
 * exactly once: an `else if` is a nested `if` statement and counts
 * naturally, and a `default` clause never matches the case-clause kind.
 *
 * @param record The extraction record whose body is counted.
 * @returns The decision-point count (an integer ≥ 0).
 */
function countDecisionPoints(record: ExtractionRecord): number {
  if (!isExtractedFunctionLike(record.node)) {
    throw new Error(
      "extraction record node is not an extracted function-like: " +
        `${record.node.constructor.name}`,
    );
  }
  let count = 0;
  const visit = (node: Node): void => {
    if (isExtractedFunctionLike(node)) {
      return;
    }
    if (isDecisionPoint(node)) {
      count += 1;
    }
    node.forEachChild((child) => {
      visit(child);
      return undefined;
    });
  };
  visit(record.node.body);
  return count;
}

/**
 * The closed decision-point kind set (FR-021; research R9): the statement,
 * clause, and conditional-expression kinds that each count once.
 * `DefaultClause` is a distinct kind and is deliberately absent — `default`
 * never counts.
 */
const DECISION_POINT_KINDS: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.IfStatement,
  SyntaxKind.ForStatement,
  SyntaxKind.ForOfStatement,
  SyntaxKind.ForInStatement,
  SyntaxKind.WhileStatement,
  SyntaxKind.DoStatement,
  SyntaxKind.CaseClause,
  SyntaxKind.CatchClause,
  SyntaxKind.ConditionalExpression,
]);

/**
 * The counted binary logical operator tokens (FR-021; research R9): `&&`,
 * `||`, and `??` only. The logical-assignment operators (`&&=`, `||=`,
 * `??=`) are distinct token kinds and are deliberately absent — the
 * documented exclusion (Assumption 10).
 */
const LOGICAL_OPERATOR_KINDS: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.AmpersandAmpersandToken,
  SyntaxKind.BarBarToken,
  SyntaxKind.QuestionQuestionToken,
]);

/**
 * Whether a node is one counted decision point: a member of the closed
 * kind set, or a binary expression whose operator token is one of the
 * three counted logical operators. The operator is read from
 * `operatorToken.kind` — the binary property; every other binary
 * operator, comparison and assignment alike, counts nothing.
 *
 * @param node The node to test.
 * @returns Whether the node counts one decision point.
 */
function isDecisionPoint(node: Node): boolean {
  if (DECISION_POINT_KINDS.has(node.kind)) {
    return true;
  }
  return (
    isBinaryExpression(node) && LOGICAL_OPERATOR_KINDS.has(node.operatorToken.kind)
  );
}
