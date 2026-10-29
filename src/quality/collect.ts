// Test-function collection (T015; FR-002/FR-003; research R3; data-model.md
// Section 5.1; Constitution Principles I, III, and V).
//
// `collectTestFunctions` walks the discovery-screened test arm and returns
// every vitest/jest test function as a `TestFunction` — the pairing
// pipeline's test-side input. The walk is purely lexical (statement-level
// AST inspection through the compiler API): test files are untrusted input
// parsed inside the bounded hermetic host, never executed or imported
// (Constitution V, FR-012 — the canary fixture in tests/quality/
// pipeline.test.ts pins it).
//
// Collection rules (FR-002, research R3):
//
// - The callee root — after unwrapping intermediate call-expression
//   wrappers (`it.each(table)(title, fn)` — the callback and title live on
//   the OUTER call) — is an identifier `it`/`test` or a property chain
//   rooted at one. The modifier set is deliberately open: `it.only`,
//   `it.skip`, `it.concurrent`, `it.fails`, `it.skipIf`, `test.each`, and
//   future modifiers all collect (the availability-first reading of
//   FR-002's "and siblings" — an unrecognized modifier is never a reason
//   to drop a test).
// - The callback is the LAST argument that is a function expression or
//   arrow function — robust to trailing timeout arguments. A bare
//   identifier callback still collects with `callback: null` (research
//   R3): title-based and import-graph pairing still apply, and the
//   assertion collector answers `[]` for it — never dropped, never a scan
//   of the referenced function's body.
// - The title is the first argument when a string literal or a
//   no-substitution template literal — the static-text rule — else `""`.
//   The same rule applies per describe level; `qualifiedTitle` joins the
//   enclosing describe titles with " > " outermost-to-innermost, then the
//   title, empty segments joining verbatim (FR-003).
// - `describe` invocations (with their own `.each` unwrapping) are
//   containers: the walk maintains the title stack through their
//   callbacks, including expression-bodied describe callbacks
//   (`describe("a", () => it("b", fn))`). `bench` and the four hooks are
//   excluded by callee root.
// - Output is sorted by `(relPath, collection index)` — a stable,
//   deterministic input to pairing (Constitution I).

import { join } from "node:path";
import {
  type ArrowFunction,
  type Block,
  type FunctionExpression,
  isArrowFunction,
  isBlock,
  isCallExpression,
  isExpressionStatement,
  isFunctionExpression,
  isIdentifier,
  isNoSubstitutionTemplateLiteral,
  isPropertyAccessExpression,
  isStringLiteral,
  type Node,
  type SourceFile,
} from "typescript/unstable/ast";
import type { ProgramContext } from "../program.js";

/** One collected vitest/jest test function (data-model.md Section 5.1). */
export interface TestFunction {
  /**
   * The invocation's first argument when a string literal or
   * no-substitution template literal; `""` otherwise — never dropped
   * (FR-002).
   */
  readonly title: string;
  /**
   * Enclosing describe titles joined `" > "` outermost-to-innermost, then
   * the title; bare title at top level; empty segments join verbatim
   * (FR-003).
   */
  readonly qualifiedTitle: string;
  /** Root-relative POSIX path of the test file. */
  readonly relPath: string;
  /** The enclosing describe titles, outermost first (nearest for pairing). */
  readonly describeTitles: readonly string[];
  /**
   * The callback function-expression node — `null` when the callback
   * argument is a reference, not a function expression (research R3).
   */
  readonly callback: Node | null;
  /** 1-based line of the `it`/`test` invocation (the outer call). */
  readonly line: number;
  /** 0-based source-order index within the file. */
  readonly index: number;
}

/** The callee-root roots that collect as tests (the modifier set is open). */
const TEST_ROOTS: ReadonlySet<string> = new Set(["it", "test"]);

/** The callee-root root that makes an invocation a describe container. */
const DESCRIBE_ROOT = "describe";

/**
 * Resolves each test path's parsed source in either bootstrap mode.
 *
 * Parse-only sources are keyed by root-relative path already; program-mode
 * source names are the compiler's absolute file names, spelled exactly as
 * the extender config's `files` root set spelled them —
 * `join(realRoot, relPath)` (src/program.ts) — so the same join resolves
 * them back. A path absent from the bootstrap (a pre-read skip whose
 * diagnostic readBounded already wrote) resolves to nothing and is skipped
 * silently — never a second diagnostic, never a crash.
 *
 * @param testPaths Root-relative POSIX paths of the test arm.
 * @param context The bootstrapped `ProgramContext` in either mode.
 * @param rootPath Realpath-resolved absolute analysis root — the
 * program-mode relativization base.
 * @returns `(relPath, SourceFile)` pairs in testPaths order, missing paths
 * excluded.
 */
function resolveTestSources(
  testPaths: readonly string[],
  context: ProgramContext,
  rootPath: string,
): Array<[string, SourceFile]> {
  if (context.mode === "parse-only") {
    const pairs: Array<[string, SourceFile]> = [];
    for (const relPath of testPaths) {
      const sourceFile = context.sources.get(relPath);
      if (sourceFile !== undefined) {
        pairs.push([relPath, sourceFile]);
      }
    }
    return pairs;
  }
  const pairs: Array<[string, SourceFile]> = [];
  for (const relPath of testPaths) {
    // The extender config's own spelling: both sides go through node:path's
    // join against the same resolved root, so the compiler's absolute name
    // matches exactly (case and separators alike — no re-derivation).
    const sourceFile = context.program.getSourceFile(join(rootPath, relPath));
    if (sourceFile !== undefined) {
      pairs.push([relPath, sourceFile]);
    }
  }
  return pairs;
}

/**
 * Unwraps intermediate call-expression wrappers and reads the callee root:
 * the leftmost identifier the callee chain roots at, or `null` when the
 * chain roots at anything else (a call, a literal, an element access).
 * `it.each(table)` and `it.skip.each(table)` both root at `it`;
 * `something().it(...)` roots at a call and does not qualify.
 *
 * @param callee The outer invocation's callee expression.
 * @returns The root identifier's text, or `null` when the chain does not
 * root at an identifier.
 */
function calleeRoot(callee: Node): string | null {
  let node: Node = callee;
  // The `.each(table)` wrapper: the callback and title live on the OUTER
  // call, so classification unwraps through the inner call expressions to
  // the property chain (or identifier) beneath.
  while (isCallExpression(node)) {
    node = node.expression;
  }
  if (isIdentifier(node)) {
    return node.text;
  }
  if (isPropertyAccessExpression(node)) {
    let base: Node = node;
    while (isPropertyAccessExpression(base)) {
      base = base.expression;
    }
    return isIdentifier(base) ? base.text : null;
  }
  return null;
}

/**
 * The static title of an invocation's first argument (the static-text
 * rule): a string literal or a NO-substitution template literal reads its
 * text verbatim — `$a` placeholders included; anything else (a substituted
 * template, a call, a number, an absent argument) is `""`.
 *
 * @param argument The invocation's first argument, when present.
 * @returns The static title text, or `""`.
 */
function staticTitle(argument: Node | undefined): string {
  if (argument === undefined) {
    return "";
  }
  if (isStringLiteral(argument) || isNoSubstitutionTemplateLiteral(argument)) {
    return argument.text;
  }
  return "";
}

/**
 * The callback of an invocation: the LAST argument that is a function
 * expression or arrow function — robust to trailing timeout arguments
 * (`it("slow", fn, 5000)`). A callback passed as a bare identifier
 * reference yields `null` (research R3) — the test still collects.
 *
 * @param arguments_ The invocation's argument nodes.
 * @returns The callback function-expression node, or `null`.
 */
function callbackOf(arguments_: readonly Node[]): Node | null {
  for (let i = arguments_.length - 1; i >= 0; i--) {
    // noUncheckedIndexedAccess: an in-bounds index still reads as
    // possibly undefined; the loop walks real positions only, so an
    // undefined element (impossible for a materialized argument list)
    // simply fails the callback-form test below.
    const argument = arguments_[i];
    if (argument !== undefined && isCallbackForm(argument)) {
      return argument;
    }
  }
  return null;
}

/**
 * Is the node a function expression or arrow function (the callback
 * forms)?
 */
function isCallbackForm(node: Node): node is FunctionExpression | ArrowFunction {
  return isFunctionExpression(node) || isArrowFunction(node);
}

/**
 * Walks one container callback's body: a block body statement by
 * statement, an expression-bodied arrow as the single contained invocation
 * (`describe("a", () => it("b", fn))` — the tight-suite form). Tests are
 * never containers; only describe callbacks flow through here.
 */
function walkContainerBody(
  callback: FunctionExpression | ArrowFunction,
  describeTitles: readonly string[],
  walk: (expression: Node, describeTitles: readonly string[]) => void,
): void {
  const body = callback.body;
  if (isBlock(body)) {
    for (const statement of (body as Block).statements) {
      if (isExpressionStatement(statement)) {
        walk(statement.expression, describeTitles);
      }
    }
    return;
  }
  walk(body, describeTitles);
}

/**
 * Collects every test function from the discovery-screened test arm
 * (FR-002/FR-003; research R3).
 *
 * Both `ProgramContext` modes collect identically — the walk is purely
 * lexical over the parsed sources, exactly as extraction is (research R5's
 * both-modes parity). The statement-level walk domain is the data model's:
 * `it`/`test`/`describe` invocations are statements, and describe callbacks
 * are the only containers (hooks, benches, and non-invocation statements
 * contribute nothing by construction).
 *
 * @param testPaths The discovered, exclusion-screened test arm —
 * root-relative POSIX paths in classifyFiles' sorted order (pattern
 * scoping never narrows this arm; FR-006).
 * @param context The bootstrapped `ProgramContext` in either mode; read
 * only during the call.
 * @param rootPath Realpath-resolved absolute analysis root — the
 * program-mode source-name base (the buildCallerIndex threading
 * precedent: the root is passed explicitly, never re-derived).
 * @returns The collected test functions, sorted by `(relPath, collection
 * index)` — a stable, deterministic input to pairing.
 */
export function collectTestFunctions(
  testPaths: readonly string[],
  context: ProgramContext,
  rootPath: string,
): TestFunction[] {
  const collected: TestFunction[] = [];

  // The per-file collection walk: `processInvocation` classifies one
  // statement-level call by its callee root and either collects a test,
  // recurses through a describe container, or stops (hooks, benches, and
  // unrecognized roots are excluded by root). Defined inside the entry so
  // the per-file counter closes over nothing but the output list.
  function processInvocation(
    expression: Node,
    relPath: string,
    sourceFile: SourceFile,
    describeTitles: readonly string[],
    index: { count: number },
  ): void {
    if (!isCallExpression(expression)) {
      return;
    }
    const root = calleeRoot(expression.expression);
    if (root === null) {
      return;
    }
    if (TEST_ROOTS.has(root)) {
      const title = staticTitle(expression.arguments[0]);
      collected.push({
        title,
        qualifiedTitle: [...describeTitles, title].join(" > "),
        relPath,
        describeTitles,
        callback: callbackOf(expression.arguments),
        line:
          sourceFile.getLineAndCharacterOfPosition(expression.getStart(sourceFile))
            .line + 1,
        index: index.count,
      });
      index.count += 1;
      return;
    }
    if (root === DESCRIBE_ROOT) {
      const callback = callbackOf(expression.arguments);
      if (callback !== null && isCallbackForm(callback)) {
        const title = staticTitle(expression.arguments[0]);
        walkContainerBody(callback, [...describeTitles, title], (inner) =>
          processInvocation(
            inner,
            relPath,
            sourceFile,
            describeTitles.length === 0 ? [title] : [...describeTitles, title],
            index,
          ),
        );
      }
      return;
    }
    // Every other root — bench, the four hooks, and unrelated calls
    // rooted at other identifiers — contributes nothing: the walk
    // simply does not descend (exclusion by callee root, FR-002).
  }

  for (const [relPath, sourceFile] of resolveTestSources(
    testPaths,
    context,
    rootPath,
  )) {
    const index = { count: 0 };
    for (const statement of sourceFile.statements) {
      if (isExpressionStatement(statement)) {
        processInvocation(statement.expression, relPath, sourceFile, [], index);
      }
    }
  }

  // The structural output sort: (relPath, collection index), UTF-16
  // code-unit comparison for the path — the deterministic order the
  // pairing strategies consume, independent of the input path order
  // (Constitution I).
  collected.sort((a, b) => {
    if (a.relPath !== b.relPath) {
      return a.relPath < b.relPath ? -1 : 1;
    }
    return a.index - b.index;
  });
  return collected;
}
