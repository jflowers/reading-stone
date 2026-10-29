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
// US3's node:assert forms (T028) extend this module with the
// assert-binding table and `expectChain: false` sites; the expect-chain
// surface below is unchanged.

import type { Writable } from "node:stream";
import {
  type CallExpression,
  isAwaitExpression,
  isCallExpression,
  isIdentifier,
  isParenthesizedExpression,
  isPropertyAccessExpression,
  type Node,
  type SourceFile,
} from "typescript/unstable/ast";
import { MAPPING_WALK_DEPTH_BUDGET } from "../internal.js";
import type { TestFunction } from "./collect.js";
import { classifyExpectChain } from "./matchers.js";
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
  // Per-test buffer (F2): one pathological callback discards only its own
  // sites — sibling tests in the same file are unaffected (the assertion
  // stage runs per test, so the skip unit is the test, not the file).
  const sites: AssertionSite[] = [];
  try {
    walkForChains(callback, sourceFile, sites, 0);
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
 * @param node The subtree root (the test's callback).
 * @param sourceFile The callback's source file — the anchor's coordinate
 * base and the asserted nodes' own file.
 * @param sites The collected sites, in walk order.
 * @param depth The current nesting depth (0 at the callback root).
 */
function walkForChains(
  node: Node,
  sourceFile: SourceFile,
  sites: AssertionSite[],
  depth: number,
): void {
  if (depth > MAPPING_WALK_DEPTH_BUDGET) {
    throw new MappingWalkDepthExceeded();
  }
  node.forEachChild((child) => {
    walkForChains(child, sourceFile, sites, depth + 1);
  });
  if (!isCallExpression(node)) {
    return;
  }
  const chain = expectChainOf(node);
  if (chain === null) {
    return;
  }
  const anchor = assertionAnchor(node, sourceFile);
  sites.push({
    kind: classifyExpectChain(chain.matcher, chain.modifiers),
    line: anchor.line,
    character: anchor.character,
    assertedExpression: chain.rootCall.arguments[0] ?? null,
    argumentSubtree: node,
    expectChain: true,
  });
}
