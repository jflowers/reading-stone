// Expect-chain assertion detection (T017; FR-007's expect form; research
// R5; data-model.md Section 5.2; Constitution Principles I, III, and V).
//
// `collectAssertions` walks the paired test's callback subtree and
// reconstructs every vitest/jest `expect()` chain invocation as an
// `AssertionSite` — the assertion side of the mapping pipeline. The walk
// is purely lexical (AST inspection through the compiler API): test
// files are untrusted input parsed inside the bounded hermetic host,
// never executed or imported (Constitution V). The walk is depth-bounded
// (F2; plan.md Scale/Scope): a pathological callback subtree discards
// only that test's sites with exactly one diagnostic — the shared
// `MAPPING_WALK_DEPTH_BUDGET`, never a request crash.
//
// Chain reconstruction (data-model Section 5.2): an invocation qualifies
// when its callee is a property access whose base chain — through
// intermediate property accesses and `await` wrappers — roots at a call
// whose callee is the identifier `expect`. The invoked property is the
// matcher name; the intermediate properties are the modifier chain; one
// `AssertionSite` is emitted per matcher invocation, so a chain with two
// matcher invocations (`expect(x).toBe(1).toBeNull()`) yields two sites
// sharing the chain's single anchor. An `expect(...)` chain with NO
// matcher invocation is not an assertion (US3-9): a bare `expect(value)`
// call and a dangling `expect(x).not` property access both collect
// nothing.
//
// Anchoring (US1-1; the landed rule, F5-reconciled): the assertion
// anchor is the OUTERMOST wrapper of the matcher invocation — `await`
// and parenthesized wrappers unwrapped upward through `node.parent`, so
// `await expect(p).resolves.toEqual(2)` anchors at the `await` and
// `(await expect(p)).toBe(2)` at the `(` — the leftmost spelling of the
// full assertion expression, while the invocation's own `getStart`
// descent through its callee covers the plain-chain form (every matcher
// invocation on one chain reports the SAME anchor). Never the matcher's
// own position; the row sort's final tie-break (AST-walk collection
// order) governs the relative order of one chain's sites.
//
// US3's node:assert forms (T028; data-model Sections 4.2 and 5.2) ride
// the SAME walk: the assert-binding table — built per call from the test
// file's import/require declarations over the closed module-specifier
// set — recognizes `assert(value)` bare truthiness calls, `assert.fn(...)`
// member calls on default/namespace/CJS carrier bindings, and bare
// named-binding calls, each emitting an `AssertionSite` with
// `expectChain: false` and classification through the pinned member
// table (src/quality/matchers.ts). The expect-chain surface above is
// unchanged.

import type { Writable } from "node:stream";
import {
  type CallExpression,
  isAwaitExpression,
  isCallExpression,
  isIdentifier,
  isImportDeclaration,
  isNamedImports,
  isNamespaceImport,
  isParenthesizedExpression,
  isPropertyAccessExpression,
  isStringLiteral,
  isVariableStatement,
  type Node,
  type SourceFile,
  SyntaxKind,
} from "typescript/unstable/ast";
import { MAPPING_WALK_DEPTH_BUDGET } from "../internal.js";
import type { TestFunction } from "./collect.js";
import { classifyAssertCall, classifyExpectChain } from "./matchers.js";
import type { AssertionKind } from "./types.js";

/**
 * The assertion walk's depth sentinel (F2): raised when the callback
 * subtree's nesting depth passes the shared `MAPPING_WALK_DEPTH_BUDGET`,
 * caught by `collectAssertions` — never escapes this module (the
 * extract.ts `AstDepthExceeded` discipline). A `RangeError` from lazy
 * node materialization is caught at the same site and treated
 * identically.
 */
class MappingWalkDepthExceeded extends Error {
  constructor() {
    super("ast depth exceeds budget");
  }
}

/**
 * One detected assertion (data-model.md Section 5.2): the classified
 * site of one matcher invocation, anchored at its assertion expression's
 * outermost wrapper.
 *
 * `assertedExpression` and `argumentSubtree` are live compiler views
 * kept for the inference stage (US4's provenance passes, T031): the
 * asserted expression is the provenance subject, and the argument
 * subtree is pass 4's scan domain.
 */
export interface AssertionSite {
  /** The classified kind — a kind or `""` (Section 4's normative table). */
  readonly kind: AssertionKind;
  /**
   * 1-based line of the assertion's anchor — the outermost wrapper of
   * the matcher invocation (`await` and parenthesized wrappers unwrapped
   * upward), the same anchor for every matcher invocation on one shared
   * chain (the row's `assertion_location` line; no column on the wire).
   */
  readonly line: number;
  /**
   * 0-based character of the assertion's anchor — the row-order
   * tie-break; every matcher invocation on one shared chain reports the
   * same anchor.
   */
  readonly character: number;
  /**
   * The asserted expression — expect's FIRST argument, the provenance
   * subject — or `null` when the expect call carried no arguments.
   */
  readonly assertedExpression: Node | null;
  /**
   * Pass 4's scan domain: the invoked matcher invocation's full
   * `CallExpression`, spanning BOTH the `expect(...)` arguments and the
   * matcher's own arguments.
   */
  readonly argumentSubtree: Node;
  /** `true` for expect-rooted forms; `false` for node:assert forms (T028). */
  readonly expectChain: boolean;
}

/**
 * The reconstructed expect chain of one qualifying invocation: the root
 * `expect(...)` call, the invoked matcher's name, and the intermediate
 * property names between them (the modifier chain, matcher-side first).
 */
interface ExpectChain {
  readonly rootCall: CallExpression;
  readonly matcher: string;
  readonly modifiers: readonly string[];
}

/**
 * The closed `node:assert` module-specifier set (data-model Section 4.2;
// research R5): a binding is an assert binding exactly when its import or
 * require names one of these specifiers. Matched SYNTACTICALLY in both
 * bootstrap modes — `node:assert` admits no in-root re-export, so the
 * specifier text is the complete resolution (never a checker query, never
 * a filesystem probe). `node:assert/strict` is in the set because it
 * changes call SEMANTICS, not routing: the member name routes through the
 * same table either way.
 */
const ASSERT_MODULE_SPECIFIERS: ReadonlySet<string> = new Set([
  "node:assert",
  "node:assert/strict",
  "assert",
]);

/**
 * The test file's assert bindings (T028; data-model Section 4.2): the
 * local names a `node:assert` import or require introduced, split by
 * recognition form.
 *
 * - `carriers` — default-import, namespace-import, and CJS-require
 *   bindings (`import assert from …`, `import * as assert from …`,
 *   `const assert = require(…)`): both `X(value)` bare truthiness calls
 *   and `X.fn(...)` member calls recognize.
 * - `named` — named-import bindings (`import { equal, notEqual as ne }`),
 *   local name → the module-side assert function: only the bare call
 *   `ne(a, b)` recognizes, and classification routes on the IMPORTED
 *   name (`notEqual`), never the local rename.
 *
 * Type-only imports are excluded (the whole-clause `import type` form and
 * the inline `{ type X }` element form alike): the erased binding names a
 * type, never a runtime assertion.
 */
interface AssertBindingTable {
  readonly carriers: ReadonlySet<string>;
  readonly named: ReadonlyMap<string, string>;
}

/**
 * Builds the assert-binding table from one test file's top-level import
 * and require declarations (T028; data-model Section 4.2).
 *
 * A statement-level scan — import declarations are top-level only, the
 * import clause's shapes are fixed grammar, and the CJS form is the
 * exact `const <identifier> = require(<specifier>)` declarator — so the
 * build performs NO recursion at all and the shared
 * `MAPPING_WALK_DEPTH_BUDGET` is satisfied vacuously (the
 * `namedImportBindings` precedent in src/quality/pairing.ts: a walk with
 * no descent has no depth to bound). A `require` nested inside a
 * function body is deliberately NOT a file binding — it names a local of
 * that scope, never the file's assertion vocabulary.
 *
 * @param sourceFile The test file's parsed source.
 * @returns The file's assert bindings — empty sets when the file has no
 * `node:assert` import or require.
 */
function buildAssertBindingTable(sourceFile: SourceFile): AssertBindingTable {
  const carriers = new Set<string>();
  const named = new Map<string, string>();
  for (const statement of sourceFile.statements) {
    if (isImportDeclaration(statement)) {
      const clause = statement.importClause;
      // The whole-clause `import type` form: TS 7's native AST spells the
      // erased marker as the clause's phase modifier, not a boolean (the
      // namedImportBindings precedent in src/quality/pairing.ts).
      if (clause === undefined || clause.phaseModifier === SyntaxKind.TypeKeyword) {
        continue;
      }
      const specifier = isStringLiteral(statement.moduleSpecifier)
        ? statement.moduleSpecifier.text
        : null;
      if (specifier === null || !ASSERT_MODULE_SPECIFIERS.has(specifier)) {
        continue;
      }
      if (clause.name !== undefined) {
        carriers.add(clause.name.text);
      }
      const bindings = clause.namedBindings;
      if (bindings === undefined) {
        continue;
      }
      if (isNamespaceImport(bindings)) {
        carriers.add(bindings.name.text);
      } else if (isNamedImports(bindings)) {
        for (const element of bindings.elements) {
          if (element.isTypeOnly) {
            continue;
          }
          named.set(element.name.text, element.propertyName?.text ?? element.name.text);
        }
      }
      continue;
    }
    if (isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        // The CJS form is the exact declarator shape — an identifier name
        // whose initializer is a require call naming the closed set. A
        // destructuring pattern (`const { equal } = require(...)`) is not
        // one of the four recognized binding forms.
        if (!isIdentifier(declaration.name)) {
          continue;
        }
        const initializer = declaration.initializer;
        if (initializer === undefined || !isCallExpression(initializer)) {
          continue;
        }
        const callee = initializer.expression;
        if (!isIdentifier(callee) || callee.text !== "require") {
          continue;
        }
        const argument = initializer.arguments[0];
        if (argument === undefined || !isStringLiteral(argument)) {
          continue;
        }
        if (ASSERT_MODULE_SPECIFIERS.has(argument.text)) {
          carriers.add(declaration.name.text);
        }
      }
    }
  }
  return { carriers, named };
}

/**
 * The assert form one call expression takes under a binding table, or
 * `null` when the call is not assert-rooted (T028; data-model Section
 * 4.2).
 *
 * Recognition is import-gated and lexical — the local-name lookups never
 * consult the checker, so a file-local function named `equal` (never
 * imported) is not an assert call, while a same-named named import is
 * (the documented conservative trade: a shadowed local import binding
 * still recognizes, availability over precision at the site level).
 * Nested property chains (`assert.strict.equal(...)`) do not recognize:
 * the member-call form is exactly one property access whose base is a
 * carrier identifier.
 *
 * @param call The candidate call expression.
 * @param table The test file's assert bindings.
 * @returns The classification member — `undefined` for the bare
 * truthiness call, the member/property text otherwise — or `null` when
 * the call is not assert-rooted.
 */
function assertFormOf(
  call: CallExpression,
  table: AssertBindingTable,
): { member: string | undefined } | null {
  const callee = call.expression;
  if (isIdentifier(callee)) {
    if (table.carriers.has(callee.text)) {
      // The bare truthiness call `assert(value)` — the undefined member.
      return { member: undefined };
    }
    const imported = table.named.get(callee.text);
    if (imported !== undefined) {
      return { member: imported };
    }
    return null;
  }
  if (
    isPropertyAccessExpression(callee) &&
    isIdentifier(callee.expression) &&
    table.carriers.has(callee.expression.text)
  ) {
    return { member: callee.name.text };
  }
  return null;
}

/**
 * Reconstructs the expect chain a matcher invocation hangs from
 * (data-model Section 5.2), or answers `null` when the invocation is not
 * expect-rooted.
 *
 * The walk descends from the invocation's callee toward the chain root,
 * unwrapping every wrapper form the chain grammar admits:
 *
 * - an intermediate property access contributes its name to the modifier
 *   chain (`.not.`, `.resolves.`, `.rejects.`, and any other — the
 *   classification table decides which are meaningful; inert names are
 *   kept harmlessly);
 * - parentheses and `await` wrappers are transparent — `(await
 * expect(p)).toBe(2)` still roots at the `expect(p)` call, and the
 * modifiers list reaching `classifyExpectChain` never sees an await
 *   (US3-10's awaited-chain parity, by construction);
 * - a call rooted at the identifier `expect` is THE root;
 * - a call rooted at another identifier (`something().it(...)`) is not
 *   an expect chain — the walk stops without a root;
 * - a call rooted at a property access is an intermediate matcher
 *   invocation (`expect(v).toBe(1).toBeNull()`'s inner link): its
 *   callee property is inert context for THIS invocation (the inner
 *   invocation is itself a site the caller's walk collects), and the
 *   descent continues through that property's base;
 * - anything else (an element access, an identifier, a literal) is not
 *   an expect chain.
 *
 * @param invocation The candidate matcher-invocation call expression.
 * @returns The reconstructed chain, or `null` when not expect-rooted.
 */
function expectChainOf(invocation: CallExpression): ExpectChain | null {
  const callee = invocation.expression;
  if (!isPropertyAccessExpression(callee)) {
    return null;
  }
  const matcher = callee.name.text;
  const modifiers: string[] = [];
  let node: Node = callee.expression;
  while (true) {
    if (isPropertyAccessExpression(node)) {
      modifiers.push(node.name.text);
      node = node.expression;
      continue;
    }
    if (isParenthesizedExpression(node) || isAwaitExpression(node)) {
      node = node.expression;
      continue;
    }
    if (isCallExpression(node)) {
      const innerCallee = node.expression;
      if (isIdentifier(innerCallee)) {
        if (innerCallee.text === "expect") {
          return { rootCall: node, matcher, modifiers };
        }
        return null;
      }
      if (isPropertyAccessExpression(innerCallee)) {
        // An intermediate matcher invocation's link property — inert
        // chain context for this invocation; the inner invocation is
        // collected as its own site by the subtree walk.
        modifiers.push(innerCallee.name.text);
        node = innerCallee.expression;
        continue;
      }
      return null;
    }
    return null;
  }
}

/**
 * The assertion anchor of one matcher invocation (US1-1): the invocation's
 * own position, unwrapped upward through enclosing `await` and
 * parenthesized wrappers — so `await expect(p).resolves.toEqual(2)`
 * anchors at the `await` and `(await expect(p)).toBe(2)` at the `(`,
 * the leftmost character of the full assertion expression, while the
 * invocation's own `getStart` descent through its callee covers the
 * parenthesized receiver form. Every matcher invocation on one shared
 * chain reports the SAME anchor (their common leftmost spelling), the
 * position the row's `assertion_location` line and the row-order
 * character tie-break read.
 *
 * @param invocation The collected matcher-invocation call expression.
 * @param sourceFile The invocation's source file — the coordinate base.
 * @returns The anchor's 1-based line and 0-based character.
 */
function assertionAnchor(
  invocation: CallExpression,
  sourceFile: SourceFile,
): { line: number; character: number } {
  let outermost: Node = invocation;
  while (
    isAwaitExpression(outermost.parent) ||
    isParenthesizedExpression(outermost.parent)
  ) {
    outermost = outermost.parent;
  }
  const position = sourceFile.getLineAndCharacterOfPosition(
    outermost.getStart(sourceFile),
  );
  return { line: position.line + 1, character: position.character };
}

/**
 * Collects every assertion inside one paired test function (FR-007's
 * expect form; research R5).
 *
 * The scan domain is the paired test's callback subtree INCLUDING nested
 * function expressions within it — a `Promise.resolve().then(() =>
 * expect(x).toBe(1))` callback body is inside the test, so its chain
 * collects; hooks and describe-scope statements are structurally outside
 * (the walk starts at this test's own callback node, assumption 13). A
 * test whose callback argument is a bare identifier reference (no
 * subtree) collects nothing — the truthful outcome, never a crash and
 * never a scan of the referenced function's body (US3-8).
 *
 * The walk is depth-bounded (F2; plan.md Scale/Scope): a callback
 * subtree whose nesting passes the shared `MAPPING_WALK_DEPTH_BUDGET`
 * discards only THIS test's sites — sibling tests keep theirs, the
 * assertion stage being per test — with exactly one diagnostic written
 * to `stderr` (a `RangeError` from lazy node materialization is treated
 * identically). Pathological input degrades to a skip, never a crash
 * (Constitution V).
 *
 * Sites emit in the deterministic AST-walk collection order: a post-order
 * descent (children before the node itself), so the statements of a
 * callback body arrive in source order and the matcher invocations of
 * one shared chain arrive inner-first — the row sort's pinned final
 * tie-break. Classification runs through the normative table
 * (src/quality/matchers.ts): the matcher's kind under the modifier rule
 * (`.rejects.` → `error_check`, else the matcher's row), and an unknown
 * or custom matcher routes to `""` — never an exception, never a drop.
 *
 * @param test The paired test function.
 * @param stderr The diagnostic sink for depth-budget skips (the server's
 * stderr; never stdout — protocol fidelity).
 * @returns The assertion sites in AST-walk collection order — `[]` for
 * a null callback, an assertion-free subtree, or a depth-skipped one.
 */
export function collectAssertions(
  test: TestFunction,
  stderr: Writable = process.stderr,
): readonly AssertionSite[] {
  const callback = test.callback;
  if (callback === null) {
    return [];
  }
  const sourceFile = callback.getSourceFile();
  // The file's assert bindings, built once per call (a statement-level
  // scan, recursion-free): the pipeline memoizes this function per test
  // function, so the table is never rebuilt per pair or per assertion.
  const assertBindings = buildAssertBindingTable(sourceFile);
  // Per-test buffer (F2): one pathological callback discards only its own
  // sites — sibling tests in the same file are unaffected (the assertion
  // stage runs per test, so the skip unit is the test, not the file).
  const sites: AssertionSite[] = [];
  try {
    walkForChains(callback, sourceFile, assertBindings, sites, 0);
  } catch (error) {
    // Only the depth sentinel and a materialization RangeError are
    // diagnosed skips; anything else escapes (a crash is never a silent
    // skip — the buildProgramContext rethrow discipline).
    if (!(error instanceof MappingWalkDepthExceeded || error instanceof RangeError)) {
      throw error;
    }
    stderr.write(
      `reading-stone: skipping assertions in ${test.relPath}:${test.line}: ast depth exceeds budget\n`,
    );
    return [];
  }
  return sites;
}

/**
 * The post-order subtree walk: descends into every child first, then
 * processes the node — so nested function bodies collect before their
 * enclosing statements complete, statements arrive in source order, and
 * a shared chain's inner matcher invocation precedes its outer one (the
 * deterministic collection order the row sort's final tie-break pins).
 * Depth-bounded by the shared `MAPPING_WALK_DEPTH_BUDGET` (F2): the
 * sentinel raised past the budget is caught by `collectAssertions`'s
 * per-test skip.
 *
 * Both assertion families ride this one walk: a `CallExpression` is
 * first probed for expect-chain rootedness, then — when not
 * expect-rooted — for a node:assert form under the file's binding table
 * (T028). A call can be at most one of the two (an expect chain roots at
 * the identifier `expect`; an assert form roots at a table binding), so
 * the order is a deterministic tie-break, never a conflict.
 *
 * @param node The subtree root (the test's callback).
 * @param sourceFile The callback's source file — the anchor's coordinate
 * base and the asserted nodes' own file.
 * @param assertBindings The test file's assert bindings (T028).
 * @param sites The collected sites, in walk order.
 * @param depth The current nesting depth (0 at the callback root).
 */
function walkForChains(
  node: Node,
  sourceFile: SourceFile,
  assertBindings: AssertBindingTable,
  sites: AssertionSite[],
  depth: number,
): void {
  if (depth > MAPPING_WALK_DEPTH_BUDGET) {
    throw new MappingWalkDepthExceeded();
  }
  node.forEachChild((child) => {
    walkForChains(child, sourceFile, assertBindings, sites, depth + 1);
  });
  if (!isCallExpression(node)) {
    return;
  }
  const chain = expectChainOf(node);
  if (chain !== null) {
    const anchor = assertionAnchor(node, sourceFile);
    sites.push({
      kind: classifyExpectChain(chain.matcher, chain.modifiers),
      line: anchor.line,
      character: anchor.character,
      assertedExpression: chain.rootCall.arguments[0] ?? null,
      argumentSubtree: node,
      expectChain: true,
    });
    return;
  }
  const assertForm = assertFormOf(node, assertBindings);
  if (assertForm !== null) {
    // The node:assert site (data-model Section 5.2): the same anchor
    // rule (the outermost wrapper, `await` unwrapped upward), the first
    // argument as the provenance subject, the assert call's own
    // argument list as the pass-4 scan domain, and `expectChain: false`.
    const anchor = assertionAnchor(node, sourceFile);
    sites.push({
      kind: classifyAssertCall(assertForm.member),
      line: anchor.line,
      character: anchor.character,
      assertedExpression: node.arguments[0] ?? null,
      argumentSubtree: node,
      expectChain: false,
    });
  }
}
