import type { Writable } from "node:stream";

import {
  isArrowFunction,
  isBinaryExpression,
  isBreakOrContinueStatement,
  isCallExpression,
  isCaseClause,
  isConditionalExpression,
  isDecorator,
  isDoStatement,
  isForInStatement,
  isForOfStatement,
  isForStatement,
  isFunctionExpression,
  isIdentifier,
  isIfStatement,
  isParenthesizedExpression,
  isPropertyAccessExpression,
  isSwitchStatement,
  isThisExpression,
  isTryStatement,
  isWhileStatement,
  type Node,
  SyntaxKind,
} from "typescript/unstable/ast";

import { prepareAnalysis } from "./analysis.js";
import { type ExtractionRecord, isExtractedFunctionLike } from "./extract.js";
import { compareFileLineName } from "./internal.js";
import { derivePackage } from "./models.js";

/**
 * The cognitive complexity engine (spec 005, FR-005 through FR-009;
 * research R1, R7-R10, R12; Constitution Principles I, III, and
 * IV): the SonarSource cognitive complexity score for every function record
 * the shared extraction table produces. `cognitiveComplexity` (T016) closes
 * the shared `prepareAnalysis` pipeline over that score — the SAME
 * extraction set, scope, and ordering `computeComplexity` reports, so US2-2's
 * parity guarantee is structural (a function has a cognitive score if and
 * only if it has a cyclomatic one; no second extraction path to drift) — with
 * the program-mode context's lifetime owned by this handler and closed in a
 * `finally` exactly as `computeComplexity` closes its own.
 *
 * The scoring rules (FR-006's structural, flow-break, and recursion
 * clauses + FR-007 nesting regions + FR-008 sequences + FR-009
 * per-record domain), as the walk applies them:
 *
 * 1. **Increments**: `if`, `for`, `for-of`, `for-in`, `while`, `do`,
 *    `switch`, `catch`, and a conditional (ternary) expression each add 1
 *    plus the current nesting level; `else` and `else if` add 1 flat; `try`
 *    and `finally` add nothing; case clauses never increment (the enclosing
 *    `switch` takes the single increment). An empty body scores 0 — there is
 *    no baseline increment, unlike cyclomatic complexity.
 * 2. **Nesting regions**: the interior of the `if` consequent, the
 *    else-if consequent, the `else` body, loop bodies, `switch` case
 *    clauses, `catch` blocks, and ternary branches is one level deeper,
 *    applying to constructs lexically inside the region — never to the
 *    region's own statement (an `else` is flat though it sits inside the
 *    `if`'s region; a `case` clause is flat though it sits inside the
 *    `switch`'s).
 * 3. **Per-record domain** (FR-009, the same boundary the detector and the
 *    cyclomatic engine walk): the walk starts at the record's body node —
 *    the record's own node is never treated as a boundary — stops at nested
 *    extracted function-likes (each owns its own row), and continues through
 *    anonymous function-likes with the nesting level reset to 0 at the
 *    boundary (the `xs.map((x) => ...)` folding shape).
 * 4. **Flat rules** (T024's phase-6 extension; FR-006's flow-break and
 *    recursion clauses + FR-008; research R7-R10): a logical operator
 *    sequence — `&&`, `||`, `??` — adds 1 per maximal run of the same
 *    operator in the flattened chain, with parenthesized subexpressions
 *    transparent to the flattening and sequences counted anywhere the
 *    walk reaches them, control-structure conditions included; a `break`
 *    or `continue` referencing a label adds 1 (the plain forms add
 *    nothing); and direct recursion — a call to the enclosing record's
 *    own name, bare `f(...)` or `this.m(...)` inside method `m` — adds 1
 *    per call site, matched binding-blind against the record's name
 *    (research R10: no checker dependency, so mode parity holds). All
 *    three increments are FLAT — no nesting term, unlike the structural
 *    constructs of item 1.
 *
 * Scope (T024): the structural clauses and the flat rules above are the
 * full rule set — FR-006's flow-break and recursion clauses and FR-008's
 * sequences have landed with the phase-6 extension;
 * tests/cognitive.test.ts pins the FR-010 golden table these rules
 * compute.
 *
 * The documented divergences from Gaze's Go port (spec 005 Assumption 3 —
 * reading-stone follows SonarSource, the norm the protocol field cites):
 * control-structure conditions are walked (Gaze does not), ternaries are
 * scored (Go has none), labeled breaks are counted (Gaze does not), and
 * nesting resets at anonymous function boundaries (Gaze carries nesting
 * through function literals). The SonarJS lint carve-outs are not adopted
 * (Assumption 4).
 *
 * No second AST depth budget: extraction already discarded any file whose
 * AST could exceed its budget (a record exists only for an in-budget file),
 * and this walk revisits exactly those materialized subtrees — the argument
 * `complexity.ts` records for its own walk (research R12).
 *
 * Constitution alignment:
 *
 * - Principle I (Protocol Fidelity): rows serialize to the
 *   cognitive_complexity wire shape — package, function, file, line,
 *   cognitive_complexity — in the canonical sorted-key order the protocol
 *   layer's own serializer produces, so its pass is a structural no-op; the
 *   identity key is `function` (the coverage method's row shape and the
 *   protocol document's schema, Assumption 6), never `name`.
 * - Principle III (TypeScript-Native Analysis): the score is a metric over
 *   the compiler's AST — exactly as cyclomatic complexity already is — and
 *   the type checker is never consulted, so program and parse-only modes
 *   score identically (mode parity, the optional-program degrade path kept
 *   whole).
 * - Principle IV (Testability): the walk core is a pure
 *   ExtractionRecord-to-number function; the entry takes the injected
 *   (rootPath, patterns, stderr) surface and owns the program-context
 *   lifetime, so each is testable against a fixture tree in isolation.
 * - Principle V (Analysis Safety): static analysis only — the walk reads
 *   the compiler's AST and never executes analyzed source.
 */

/**
 * One cognitive complexity row (FR-005): the extraction identity plus the
 * computed SonarSource score. Field names mirror the wire payload exactly —
 * the identity key is `function` (the coverage method's row shape and the
 * protocol document's schema, Assumption 6), not `name` (the cyclomatic
 * complexity method's) — snake_case included (`cognitive_complexity`, the
 * MappingRow and FunctionRecord.side_effects precedent), and the entity is
 * an immutable value record (convention pack AP-004).
 */
export interface CognitiveRow {
  /** Dotted module path derived by `derivePackage` from `file`. */
  readonly package: string;
  /**
   * The function's declared name, carried as the wire `function` key — the
   * identity-key spelling FR-005 pins (Assumption 6), never `name`.
   */
  readonly function: string;
  /** Root-relative POSIX path of the declaring file. */
  readonly file: string;
  /** 1-based line of the function declaration. */
  readonly line: number;
  /** The SonarSource cognitive complexity score (an integer ≥ 0). */
  readonly cognitive_complexity: number;
}

/**
 * The `cognitive_complexity` method's entry (FR-005, FR-009; the
 * analyze-shaped surface T018 established): the serialized `CognitiveRow[]`
 * payload — one row per extraction record, assembled in the `(file, line,
 * name)` total order, and mapped through `serializeCognitiveRow` so every
 * row on the returned array is already wire-shaped.
 *
 * The returned array — not a `{functions: [...]}` wrapper — follows the
 * computeComplexity split: the T017 server handler wraps the array into the
 * cognitive_complexity result shape, exactly as it wraps the complexity
 * entries. Both this entry and its payload are deterministic pure functions
 * of the analyzed tree (Constitution Principle I: byte-identical repeat
 * responses).
 *
 * The program-mode context's lifetime is this handler's: the native
 * compiler server behind it is closed in the `finally` whatever the scoring
 * outcome, so no subprocess outlives one analysis. A parse-only context
 * owns nothing to dispose.
 *
 * @param rootPath Absolute or relative project root; validated and
 * realpath-resolved by `prepareAnalysis` (an invalid root throws
 * `InvalidRootPathError`, the server maps to `-32602`).
 * @param patterns The raw `patterns` parameter value; shape-validated by
 * the server (`-32602`) before analysis runs, normalized here.
 * @param stderr Injected diagnostic sink (Testability principle); defaults
 * to `process.stderr`. Stdout is never touched.
 * @returns The serialized cognitive rows, `(file, line, name)`-sorted.
 */
export async function cognitiveComplexity(
  rootPath: string,
  patterns: unknown,
  stderr: Writable = process.stderr,
): Promise<readonly Record<string, unknown>[]> {
  const prepared = await prepareAnalysis(rootPath, patterns, stderr);
  try {
    const rows = prepared.records.map(
      (record): CognitiveRow => ({
        package: derivePackage(record.relPath),
        function: record.name,
        file: record.relPath,
        line: record.line,
        cognitive_complexity: cognitiveScoreOf(record),
      }),
    );
    rows.sort(compareCognitiveRows);
    return rows.map(serializeCognitiveRow);
  } finally {
    if (prepared.context.mode === "program") {
      prepared.context.dispose();
    }
  }
}

/**
 * Serializes a `CognitiveRow` to its wire shape (FR-005): exactly the five
 * fields, emitted in the canonical sorted-key order the protocol layer's
 * sorted-key serializer produces — so the server's `serialize` pass
 * re-orders these keys as a structural no-op and each row is wire-final in
 * the form that serializer defines.
 *
 * A pure projection, deliberately without the fail-loud field validation
 * `models.ts`'s record serializers apply (the serializeComplexityEntry
 * argument): every `CognitiveRow` is constructed at this module's single
 * site from fields whose validity is structural — `ExtractionRecord`'s
 * string `name`/`relPath`, a 1-based `line`, and `cognitive_complexity` as
 * the walk's non-negative sum. The wire shape itself — exactly these five
 * keys, integer `cognitive_complexity` ≥ 0 — is pinned by
 * `tests/cognitive.test.ts`'s wire-invariant assertions.
 *
 * @param row The cognitive row to serialize.
 * @returns A JSON-ready object with `cognitive_complexity`, `file`,
 * `function`, `line`, and `package`.
 */
export function serializeCognitiveRow(row: CognitiveRow): Record<string, unknown> {
  return {
    cognitive_complexity: row.cognitive_complexity,
    file: row.file,
    function: row.function,
    line: row.line,
    package: row.package,
  };
}

/**
 * The FR-005 total order over cognitive rows: `(file, line, name)` via the
 * shared record comparator (src/internal.ts), with the row's `function` key
 * adapted to the comparator's `name` — the identity key and the ORDER key
 * are spelled differently (Assumption 6), the same shape adaptation
 * `extract.ts`'s comparator makes for `ExtractionRecord.relPath`. Codepoint
 * comparison for the string keys, numeric line ordering between them.
 *
 * @param a Left row.
 * @param b Right row.
 * @returns The three-key comparison result.
 */
function compareCognitiveRows(a: CognitiveRow, b: CognitiveRow): number {
  return compareFileLineName(
    { file: a.file, line: a.line, name: a.function },
    { file: b.file, line: b.line, name: b.function },
  );
}

/**
 * Whether a binary operator token kind is one of FR-008's sequence
 * operators — the logical `&&`, `||`, and `??` tokens whose chains score
 * per maximal same-operator run (research R7).
 *
 * @param kind The binary operator token kind to test.
 * @returns True for `&&`, `||`, or `??`; false for every other operator
 *   (`+`, `<=`, `instanceof`, …), which never forms a sequence.
 */
function isLogicalSequenceOperator(kind: SyntaxKind): boolean {
  return (
    kind === SyntaxKind.AmpersandAmpersandToken ||
    kind === SyntaxKind.BarBarToken ||
    kind === SyntaxKind.QuestionQuestionToken
  );
}

/**
 * Flattens a logical operator sequence (FR-008, research R7): collects
 * the chain's operators and operand leaves in source order, descending
 * through nested sequence-operator binaries and unwrapping parenthesized
 * subexpressions — parens are transparent to the flattening, never scored
 * as leaves. A child that unwraps to anything other than a
 * sequence-operator binary is an operand leaf.
 *
 * A pure recursive projection over the compiler's AST; its depth is
 * bounded by the subtree the walk already entered — extraction discarded
 * any out-of-budget file before a record existed (the research R12
 * argument `complexity.ts` records for its own walk).
 *
 * @param node The chain's root node (a sequence-operator binary, per the
 *   visit dispatch that calls this).
 * @returns The flattened operator sequence and operand leaves, in source
 *   order — `operators.length === operands.length - 1` for the chain.
 */
function flattenLogicalSequence(node: Node): {
  readonly operators: SyntaxKind[];
  readonly operands: Node[];
} {
  const operators: SyntaxKind[] = [];
  const operands: Node[] = [];
  const descend = (current: Node): void => {
    let unwrapped = current;
    while (isParenthesizedExpression(unwrapped)) {
      unwrapped = unwrapped.expression;
    }
    if (
      isBinaryExpression(unwrapped) &&
      isLogicalSequenceOperator(unwrapped.operatorToken.kind)
    ) {
      descend(unwrapped.left);
      operators.push(unwrapped.operatorToken.kind);
      descend(unwrapped.right);
      return;
    }
    operands.push(unwrapped);
  };
  descend(node);
  return { operators, operands };
}

/**
 * Counts the maximal same-operator runs in a flattened operator sequence
 * (FR-008): a single operator is a run of one, and each operator change
 * starts a new run — `a && b` is 1, `a && b || c` is 2, and
 * `a && b || c && d` is 3.
 *
 * @param operators The flattened operator sequence, in source order.
 * @returns The run count (0 for an empty sequence).
 */
function countOperatorRuns(operators: readonly SyntaxKind[]): number {
  let runs = 0;
  let previous: SyntaxKind | undefined;
  for (const operator of operators) {
    if (operator !== previous) {
      runs += 1;
      previous = operator;
    }
  }
  return runs;
}

/**
 * Scores one extraction record's body with the cognitive complexity
 * rules (FR-006 structural, flow-break, and recursion clauses; FR-007;
 * FR-008; FR-009; research R7-R10).
 *
 * The walk starts at the record's body node — a block body's statements, an
 * expression-bodied arrow's expression — the countDecisionPoints
 * start-at-body discipline: the record's own node is never treated as a
 * boundary, so its decorators and parameter lists are structurally outside
 * the walk (decorator transparency for the record's own spelling). It stops
 * at nested extracted function-likes (each owns its own record, so its
 * constructs belong to its own row — the `isExtractedFunctionLike`
 * boundary, never a re-derivation) and continues through anonymous
 * function-likes with the nesting level reset to 0 at the boundary, whose
 * constructs attribute to this record per FR-009. Conditions and clause
 * labels are walked at their construct's own nesting level — only the
 * FR-007 region interiors deepen — and decorators are transparent wherever
 * they appear (class, member, and parameter positions alike).
 *
 * @param record The extraction record whose body is scored.
 * @returns The SonarSource cognitive complexity score (an integer ≥ 0).
 */
function cognitiveScoreOf(record: ExtractionRecord): number {
  if (!isExtractedFunctionLike(record.node)) {
    throw new Error(
      "extraction record node is not an extracted function-like: " +
        `${record.node.constructor.name}`,
    );
  }
  let score = 0;
  // One node, one dispatch: each structural construct takes its FR-006
  // increment and walks its FR-007 region interiors one level deeper; the
  // flat rules (FR-006 flow-break and recursion clauses, FR-008
  // sequences) add theirs with no nesting term; everything else
  // descends unchanged.
  const visit = (node: Node, nesting: number): void => {
    // FR-009: a nested extracted function-like stops the walk — its own
    // record owns its constructs.
    if (isExtractedFunctionLike(node)) {
      return;
    }
    // FR-009: an anonymous function-like owns no record; the walk continues
    // through it with the nesting level reset to 0 at the boundary.
    if (isArrowFunction(node) || isFunctionExpression(node)) {
      visitChildren(node, 0);
      return;
    }
    if (isIfStatement(node)) {
      score += 1 + nesting;
      visit(node.expression, nesting);
      visit(node.thenStatement, nesting + 1);
      visitElseChain(node.elseStatement, nesting);
      return;
    }
    if (isForStatement(node)) {
      score += 1 + nesting;
      if (node.initializer !== undefined) {
        visit(node.initializer, nesting);
      }
      if (node.condition !== undefined) {
        visit(node.condition, nesting);
      }
      if (node.incrementor !== undefined) {
        visit(node.incrementor, nesting);
      }
      visit(node.statement, nesting + 1);
      return;
    }
    if (isForOfStatement(node) || isForInStatement(node)) {
      score += 1 + nesting;
      visit(node.initializer, nesting);
      visit(node.expression, nesting);
      visit(node.statement, nesting + 1);
      return;
    }
    if (isWhileStatement(node)) {
      score += 1 + nesting;
      visit(node.expression, nesting);
      visit(node.statement, nesting + 1);
      return;
    }
    if (isDoStatement(node)) {
      score += 1 + nesting;
      visit(node.statement, nesting + 1);
      visit(node.expression, nesting);
      return;
    }
    if (isSwitchStatement(node)) {
      score += 1 + nesting;
      visit(node.expression, nesting);
      // Case clauses never increment (the switch above took the single
      // increment) and each clause's statement list is a region one level
      // deeper; the clause's own label expression is walked at the
      // switch's level — the region's own spelling, the same flat
      // treatment an `else` gets inside the `if`'s region.
      for (const clause of node.caseBlock.clauses) {
        if (isCaseClause(clause)) {
          visit(clause.expression, nesting);
        }
        for (const statement of clause.statements) {
          visit(statement, nesting + 1);
        }
      }
      return;
    }
    if (isTryStatement(node)) {
      // `try` and `finally` add nothing and are not nesting regions
      // (FR-006/FR-007); only `catch` increments, and its block is a
      // region one level deeper.
      visit(node.tryBlock, nesting);
      if (node.catchClause !== undefined) {
        score += 1 + nesting;
        visit(node.catchClause.block, nesting + 1);
      }
      if (node.finallyBlock !== undefined) {
        visit(node.finallyBlock, nesting);
      }
      return;
    }
    if (isConditionalExpression(node)) {
      score += 1 + nesting;
      visit(node.condition, nesting);
      visit(node.whenTrue, nesting + 1);
      visit(node.whenFalse, nesting + 1);
      return;
    }
    // FR-008 (research R7): a logical operator sequence — `&&`, `||`,
    // `??` — adds 1 per maximal run of the same operator in the
    // flattened chain: a single operator is a run of one, and each
    // operator change starts a new run. The increment is FLAT — no
    // nesting term, unlike the structural constructs above — and a
    // sequence counts anywhere the walk reaches it,
    // control-structure conditions included (they are walked at their
    // construct's own level, so nothing extra is wired here). Each
    // operand leaf is re-visited below so nested ternaries, calls, and
    // separate chains inside operands still score; a sequence nested
    // inside a non-logical binary (e.g. `a + (b && c)`) reaches this
    // case by the default descent and scores as its own chain.
    if (
      isBinaryExpression(node) &&
      isLogicalSequenceOperator(node.operatorToken.kind)
    ) {
      const { operators, operands } = flattenLogicalSequence(node);
      score += countOperatorRuns(operators);
      for (const operand of operands) {
        visit(operand, nesting);
      }
      return;
    }
    // FR-006 flow-break clause (research R8): only a `break` or
    // `continue` that REFERENCES A LABEL increments — flat, +1, no
    // nesting term — while the plain forms add nothing. The increment
    // falls through to the default descent below, which walks the
    // statement's children: the label identifier itself scores nothing.
    // A labeled statement's own label needs no case here — the default
    // descent enters its statement unchanged.
    if (isBreakOrContinueStatement(node) && node.label !== undefined) {
      score += 1;
    }
    // FR-006 recursion clause (research R10): direct recursion — a call
    // to the enclosing record's own name — adds 1 per call site, flat,
    // bare (`f(...)`) or via `this` (`this.m(...)` inside method `m`).
    // The match is binding-blind text comparison against the record's
    // declared name: no type-checker dependency, so program and
    // parse-only modes score identically (mode parity). Mutual
    // recursion — calls to any other name — adds nothing. The fall
    // through to the default descent below still walks the call's
    // arguments, where nested constructs and further calls score.
    if (isCallExpression(node)) {
      const callee = node.expression;
      if (
        (isIdentifier(callee) && callee.text === record.name) ||
        (isPropertyAccessExpression(callee) &&
          callee.name.text === record.name &&
          isThisExpression(callee.expression))
      ) {
        score += 1;
      }
    }
    visitChildren(node, nesting);
  };
  // The flat else family (FR-006): an `else` and each `else if` add 1 with
  // no nesting penalty, while their interiors are regions one level deeper
  // than the chain's `if` (FR-007) — the else-if consequent and the else
  // body both deepen relative to the original if's level, never
  // cumulatively down the chain.
  const visitElseChain = (elseBranch: Node | undefined, chainNesting: number): void => {
    let current = elseBranch;
    while (current !== undefined) {
      if (!isIfStatement(current)) {
        score += 1;
        visit(current, chainNesting + 1);
        return;
      }
      score += 1;
      visit(current.expression, chainNesting);
      visit(current.thenStatement, chainNesting + 1);
      current = current.elseStatement;
    }
  };
  // The default descent: every child in source order at the same nesting,
  // with decorators skipped wherever they appear — a decorator's argument
  // subtree is never entered, so decorator transparency holds for nested
  // classes, members, and parameters alike, not just the record's own
  // spelling.
  const visitChildren = (node: Node, nesting: number): void => {
    node.forEachChild((child) => {
      if (isDecorator(child)) {
        return undefined;
      }
      visit(child, nesting);
      return undefined;
    });
  };
  visit(record.node.body, 0);
  return score;
}
