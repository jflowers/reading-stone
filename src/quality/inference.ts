// Assertion-to-effect inference — the fallback chains and US4's
// provenance passes (T018/T031; FR-009/FR-010/FR-011; research R7;
// data-model.md Sections 5.5 and 7; Constitution Principles I and II).
//
// `inferSideEffectType` answers the mapping row's `side_effect_type`:
// which canonical taxonomy name the assertion observes about its paired
// target. Error rows select by assertion kind alone (US4-5). Value rows
// run US4's four provenance passes in fixed order over the asserted
// expression — direct identity, indirect root resolution, helper
// bridging, inline call matching — and a succeeding pass prefers the
// return family (`ReturnValue` → `GeneratorYield` →
// `AsyncGeneratorYield`) ahead of the US1 fallback chain; with no
// succeeding pass, or no return-family effect to prefer, the fallback
// chain governs unchanged (US4-6/US4-7).
//
// The passes are conservative by pinned boundary (US4-8): they never
// cross nested functions other than the single pass-3 helper bridge,
// never follow alias chains, and never cross control-flow merges —
// unsupported provenance falls back deterministically rather than
// guessing. Every walk is depth-bounded by the shared
// `MAPPING_WALK_DEPTH_BUDGET`; a sentinel past the budget (or a
// materialization `RangeError`) is caught at the provenance boundary
// and treated as no evidence — the row still emits under the fallback
// chain, so nothing is skipped and no diagnostic is written, unlike
// the pairing and assertion walks whose budget skips lose rows.
//
// Inference is TOTAL (US1-7): every (assertion, effect-set) shape maps
// to a canonical name — a target with no detected effects at all maps
// the `ReturnValue` fallback, never an omission. The fallback chains are
// presence-based, not position-based: `ReturnValue` wins over an earlier
// P0 effect in the array, and `ErrorReturn` wins over an earlier
// `ErrorSignal` — only the P0 pass reads the array's order (the first
// P0 effect in effect-array order, the pin `detectEffects`'
// deterministic `(line, column, type)` emission makes stable).

import {
  type ArrowFunction,
  type CallExpression,
  type FunctionDeclaration,
  type FunctionExpression,
  type Identifier,
  isArrowFunction,
  isAwaitExpression,
  isBlock,
  isCallExpression,
  isElementAccessExpression,
  isFunctionDeclaration,
  isFunctionExpression,
  isIdentifier,
  isNewExpression,
  isParenthesizedExpression,
  isPropertyAccessExpression,
  isReturnStatement,
  isVariableDeclaration,
  isVariableStatement,
  type Node,
  NodeFlags,
  type SourceFile,
} from "typescript/unstable/ast";
import { collectBindingNames } from "../extract.js";
import { MAPPING_WALK_DEPTH_BUDGET } from "../internal.js";
import type { Effect } from "../models.js";
import { type ProgramContext, resolveSymbolAliases } from "../program.js";
import { type SideEffectType, TIER_MAP } from "../taxonomy.js";
import type { AssertionSite } from "./assertions.js";
import type { Pairing } from "./pairing.js";

/** The error-row chain's first preference: the error-channel return effect. */
const ERROR_RETURN: SideEffectType = "ErrorReturn";

/** The error-row chain's second preference: the error-channel signal effect. */
const ERROR_SIGNAL: SideEffectType = "ErrorSignal";

/** The value-row chain's first preference and both chains' total fallback. */
const RETURN_VALUE: SideEffectType = "ReturnValue";

/** The value-row chain's generator pass, ahead of the async form. */
const GENERATOR_YIELD: SideEffectType = "GeneratorYield";

/** The value-row chain's final generator pass. */
const ASYNC_GENERATOR_YIELD: SideEffectType = "AsyncGeneratorYield";

/**
 * Whether the effect set carries an effect of the given canonical type.
 *
 * @param effects The target's detected effects, in effect-array order.
 * @param type The canonical type to look for.
 */
function carries(effects: readonly Effect[], type: SideEffectType): boolean {
  return effects.some((effect) => effect.type === type);
}

/**
 * The error-row chain (FR-009; data-model Section 7): error rows —
 * `assertion_type === "error_check"` — select by assertion type ALONE,
 * never provenance (US4-5). `ErrorReturn` when the target carries it,
 * else `ErrorSignal` when it carries that, else the `ErrorReturn`
 * fallback — total over every effect-set shape including the empty set.
 *
 * @param effects The paired target's detected effects.
 * @returns The mapped canonical side-effect type.
 */
function errorRowType(effects: readonly Effect[]): SideEffectType {
  if (carries(effects, ERROR_RETURN)) {
    return ERROR_RETURN;
  }
  if (carries(effects, ERROR_SIGNAL)) {
    return ERROR_SIGNAL;
  }
  return ERROR_RETURN;
}

/**
 * The value-row fallback chain (FR-010; data-model Section 7): value
 * rows — `equality`, `comparison`, `membership`, and the unclassified
 * `""` kind alike — follow the standard chain:
 *
 * 1. `ReturnValue` when present (presence-based: it shadows a P0 effect
 *    that precedes it in the array);
 * 2. else the target's FIRST P0 effect in effect-array order
 *    (`TIER_MAP` membership — the pin `detectEffects`' deterministic
 *    source-order emission makes stable);
 * 3. else `GeneratorYield` when present;
 * 4. else `AsyncGeneratorYield` when present;
 * 5. else the `ReturnValue` fallback — total for every effect-set shape
 *    including the empty set (US1-7).
 *
 * @param effects The paired target's detected effects.
 * @returns The mapped canonical side-effect type.
 */
function valueRowType(effects: readonly Effect[]): SideEffectType {
  if (carries(effects, RETURN_VALUE)) {
    return RETURN_VALUE;
  }
  const firstP0 = effects.find((effect) => TIER_MAP[effect.type] === "P0");
  if (firstP0 !== undefined) {
    return firstP0.type;
  }
  if (carries(effects, GENERATOR_YIELD)) {
    return GENERATOR_YIELD;
  }
  if (carries(effects, ASYNC_GENERATOR_YIELD)) {
    return ASYNC_GENERATOR_YIELD;
  }
  return RETURN_VALUE;
}

/**
 * The provenance walks' depth sentinel: raised when a pass's AST walk
 * passes the shared `MAPPING_WALK_DEPTH_BUDGET`, caught at the
 * `provenanceEstablished` boundary — never escapes this module (the
 * pairing.ts and assertions.ts sentinel discipline, each module owning
 * its private copy). A `RangeError` from lazy node materialization is
 * caught at the same site and treated identically.
 */
class MappingWalkDepthExceeded extends Error {
  constructor() {
    super("ast depth exceeds budget");
  }
}

/**
 * One file-scope helper of a test file — pass 3's bridge domain
 * (research R7; data-model Section 5.5): a declared function at the
 * file's statement top level, or a const-bound arrow/function
 * expression declarator. `declaration` is the node checker-mode symbol
 * resolution lands on (the `FunctionDeclaration` itself, or the
 * `VariableDeclaration` for expression forms); parse-only matches on
 * `name`. `fn` is the body-owning function-like whose returns are the
 * bridge evidence.
 */
export interface FileLocalHelper {
  /** The helper's declared name (the callee spelling both modes read). */
  readonly name: string;
  /** The declaring node — checker-mode symbol identity; `name` for parse-only. */
  readonly declaration: Node;
  /** The body-owning function-like (pass 3 scans its returns). */
  readonly fn: FunctionDeclaration | FunctionExpression | ArrowFunction;
}

/**
 * The pass evaluation's inputs (data-model Section 5.5): the live
 * `ProgramContext` — call resolution per mode, exactly the pairing
 * `calls` strategy's route — and the test file's file-local helper table
 * (pass 3's bridge domain). Built by the pipeline once per paired test
 * with assertions, the helper table memoized per test file, so passes
 * never recompute shared evidence (research R8's single-walk
 * discipline).
 */
export interface ProvenanceInputs {
  /** The live analysis context; read-only lending, never owned. */
  readonly context: ProgramContext;
  /** The test file's file-scope helpers (pass 3's bridge domain). */
  readonly helpers: readonly FileLocalHelper[];
}

/**
 * Collects a test file's file-local helper table (pass 3's bridge
 * domain): file-scope declared functions and const-bound function
 * expressions — the two declaration forms research R7 pins.
 *
 * Statement top level only, and never entered: the scan reads the
 * source's own statement list (no recursion, so no depth budget), and
 * the const requirement is the conservative-boundary spirit (US4-8) —
 * a `let`/`var` binding is reassignable, so its initializer proves
 * nothing about any later call site. Overload signatures (a declared
 * function with no body) are skipped: the checker's symbol for the
 * callee carries the implementation's declaration, so the body-bearing
 * twin is the bridge evidence. This is not a function-extraction walk —
 * a helper here is evidence for pass 3, never a mapping target itself
 * (test files are outside the target arm by construction, FR-006).
 *
 * @param sourceFile The test file's parsed source.
 * @returns The helpers in statement order; `[]` for a file declaring none.
 */
export function collectFileLocalHelpers(
  sourceFile: SourceFile,
): readonly FileLocalHelper[] {
  const helpers: FileLocalHelper[] = [];
  for (const statement of sourceFile.statements) {
    if (isFunctionDeclaration(statement)) {
      if (statement.name !== undefined && statement.body !== undefined) {
        helpers.push({
          name: statement.name.text,
          declaration: statement,
          fn: statement,
        });
      }
      continue;
    }
    if (!isVariableStatement(statement)) {
      continue;
    }
    if ((statement.declarationList.flags & NodeFlags.Const) === 0) {
      continue;
    }
    for (const declaration of statement.declarationList.declarations) {
      const initializer = declaration.initializer;
      if (
        isIdentifier(declaration.name) &&
        initializer !== undefined &&
        (isArrowFunction(initializer) || isFunctionExpression(initializer))
      ) {
        helpers.push({ name: declaration.name.text, declaration, fn: initializer });
      }
    }
  }
  return helpers;
}

/**
 * Strips `await` and parenthesized wrappers — the transparency the
 * passes pin for direct-call evidence (research R7: `const r = await
 * target()`; the assertions module's anchor unwrapping is the same
 * discipline, upward through parents). Bounded by the walk budget: an
 * adversarial wrapper nest deeper than `MAPPING_WALK_DEPTH_BUDGET`
 * raises the sentinel rather than looping.
 *
 * @param node The expression to unwrap.
 * @returns The innermost expression that is neither wrapper form.
 */
function unwrapAwaitParens(node: Node): Node {
  let current = node;
  for (let steps = 0; steps <= MAPPING_WALK_DEPTH_BUDGET; steps += 1) {
    if (isParenthesizedExpression(current) || isAwaitExpression(current)) {
      current = current.expression;
      continue;
    }
    return current;
  }
  throw new MappingWalkDepthExceeded();
}

/**
 * Whether a call resolves to the pair's target, per mode (research R7):
 * checker mode through the symbol route — `getSymbolAtLocation` at the
 * callee's terminal identifier, aliases followed, any resolved
 * declaration matching `pair.target.node` — and parse-only through
 * terminal-identifier text equality with the target's declared name.
 *
 * This is the pairing `calls` strategy's `collectCallTarget` route in
 * predicate form: the SAME terminal-identifier query node (the callee
 * identifier, or the invoked property's name for a method callee —
 * every other callee form resolves to nothing), the same
 * alias-resolution and declaration matching — so a call that paired the
 * test resolves for provenance and vice versa (Constitution Principle
 * I: the two walks can never disagree on what "a call to the target"
 * means).
 *
 * @param call The call expression to test.
 * @param pair The test-to-target pair the row is being built for.
 * @param context The live analysis context of the same run.
 */
function callResolvesToTarget(
  call: CallExpression,
  pair: Pairing,
  context: ProgramContext,
): boolean {
  const callee = call.expression;
  const terminal = isIdentifier(callee)
    ? callee
    : isPropertyAccessExpression(callee)
      ? callee.name
      : null;
  if (terminal === null) {
    return false;
  }
  if (context.mode === "program") {
    const { checker } = context;
    const symbol = checker.getSymbolAtLocation(terminal);
    const resolved = resolveSymbolAliases(checker, symbol);
    if (resolved === null) {
      return false;
    }
    for (const declaration of resolved.declarations) {
      if (declaration.resolve() === pair.target.node) {
        return true;
      }
    }
    return false;
  }
  return terminal.text === pair.target.name;
}

/**
 * Whether an expression is a direct call to the pair's target with
 * `await`/paren transparency — the one spelling of "direct call" that
 * pass 1's subject, pass 2's declarator initializer, and pass 3's
 * helper returns all read (research R7).
 *
 * @param expression The expression to test.
 * @param pair The test-to-target pair the row is being built for.
 * @param context The live analysis context of the same run.
 */
function isDirectTargetCall(
  expression: Node,
  pair: Pairing,
  context: ProgramContext,
): boolean {
  const unwrapped = unwrapAwaitParens(expression);
  return isCallExpression(unwrapped) && callResolvesToTarget(unwrapped, pair, context);
}

/**
 * The asserted expression's left spine (research R7, passes 2 and 3):
 * the leftmost identifier its expression tree roots at (`result` in
 * `result.items`, `double` in `double(2).items`), and the bottom-most
 * call that identifier heads (`double(2)` — pass 3's root call;
 * `createAdder(1)` for the curried `createAdder(1)(2)`).
 */
interface AssertedSpine {
  /** The leftmost identifier, or null when the spine roots elsewhere. */
  readonly identifier: Identifier | null;
  /** The bottom-most call on the spine, or null when the spine has none. */
  readonly call: CallExpression | null;
}

/**
 * Walks the asserted expression's left spine: `await`/paren wrappers
 * transparent, then down property accesses, element accesses, and
 * call/new callees — the expression's head — until the walk roots at an
 * identifier (returned with the bottom-most call it heads) or at any
 * other node form (both null — a conditional, template, or binary
 * expression root carries no single provenance subject, and the
 * conservative answer is no evidence). Bounded by the walk budget.
 *
 * @param expression The asserted expression.
 * @returns The spine's root identifier and root call.
 */
function spineRootOf(expression: Node): AssertedSpine {
  let call: CallExpression | null = null;
  let current = unwrapAwaitParens(expression);
  for (let steps = 0; steps <= MAPPING_WALK_DEPTH_BUDGET; steps += 1) {
    if (isPropertyAccessExpression(current) || isElementAccessExpression(current)) {
      current = current.expression;
      continue;
    }
    if (isCallExpression(current)) {
      call = current;
      current = current.expression;
      continue;
    }
    if (isNewExpression(current)) {
      current = current.expression;
      continue;
    }
    return { identifier: isIdentifier(current) ? current : null, call };
  }
  throw new MappingWalkDepthExceeded();
}

/**
 * Pass 2 — indirect root resolution (FR-011; research R7): the root
 * identifier is locally bound IN THE TEST FUNCTION by a declarator
 * whose initializer is a direct call to the target — `await` wrappers
 * and destructuring patterns transparent (`const r = await target()`,
 * `const { items } = target()`, `const [first] = target()`).
 *
 * The binding search is the test callback's own declarators only
 * (US4-8): a binding in a describe scope or an inner closure does not
 * qualify — the walk starts at the callback's body and never enters a
 * nested function-like. Alias chains never qualify (an initializer must
 * be a call, never a bare identifier reference), and control-flow
 * merges are structurally unreachable (only declarator initializers are
 * read — a `let` assigned inside `if`/loop branches is never an
 * initializer). Destructuring transparency reuses `collectBindingNames`
 * — the one binding-spelling collector (the extract.ts export) — so
 * every pattern form the scope tracker tracks is a form pass 2 binds.
 *
 * @param pair The test-to-target pair the row is being built for.
 * @param identifier The asserted expression's root identifier text.
 * @param context The live analysis context of the same run.
 */
function callbackBindsTargetCall(
  pair: Pairing,
  identifier: string,
  context: ProgramContext,
): boolean {
  const callback = pair.test.callback;
  if (callback === null) {
    return false;
  }
  if (!isFunctionExpression(callback) && !isArrowFunction(callback)) {
    return false;
  }
  return declaratorsBindTargetCall(callback.body, identifier, pair, context, 0);
}

/**
 * The pass-2 declarator walk: a descent over the test callback's body
 * (the node before its children — irrelevant to the boolean result, but
 * deterministic), nested function-likes excluded (their locals are not
 * the test's). Depth-bounded by the shared budget; the sentinel raised
 * past it is caught by `provenanceEstablished`.
 *
 * @param node The subtree root (the callback's body).
 * @param identifier The root identifier text to find a binding for.
 * @param pair The test-to-target pair the row is being built for.
 * @param context The live analysis context of the same run.
 * @param depth The current nesting depth (0 at the body root).
 */
function declaratorsBindTargetCall(
  node: Node,
  identifier: string,
  pair: Pairing,
  context: ProgramContext,
  depth: number,
): boolean {
  if (depth > MAPPING_WALK_DEPTH_BUDGET) {
    throw new MappingWalkDepthExceeded();
  }
  if (
    isFunctionDeclaration(node) ||
    isFunctionExpression(node) ||
    isArrowFunction(node)
  ) {
    return false;
  }
  if (isVariableDeclaration(node) && node.initializer !== undefined) {
    const spellings = new Set<string>();
    collectBindingNames(node.name, spellings);
    if (
      spellings.has(identifier) &&
      isDirectTargetCall(node.initializer, pair, context)
    ) {
      return true;
    }
  }
  let found = false;
  node.forEachChild((child) => {
    if (!found) {
      found = declaratorsBindTargetCall(child, identifier, pair, context, depth + 1);
    }
  });
  return found;
}

/**
 * Pass 3 — helper function bridging (FR-011; research R7): the spine's
 * root call's callee is a file-local helper whose returned value
 * derives from a direct call to the target — a `return [await]
 * target(...)` statement in a block body, or an expression-bodied
 * arrow whose expression IS the direct call.
 *
 * A SINGLE bridge (US4-8): the helper's own returns are read, never a
 * helper-of-a-helper chain, and a returned closure does not bridge
 * (its body runs only when the test invokes it — the returned value
 * derives from the closure, not yet from the target). Checker mode
 * resolves the callee through the symbol route onto the helper's
 * declaring node; parse-only matches the declared name (the documented
 * name-collision surface of lexical matching — degradation reduces
 * precision, never availability).
 *
 * @param call The asserted expression's root call.
 * @param helpers The test file's file-local helper table.
 * @param pair The test-to-target pair the row is being built for.
 * @param context The live analysis context of the same run.
 */
function helperBridgesTarget(
  call: CallExpression,
  helpers: readonly FileLocalHelper[],
  pair: Pairing,
  context: ProgramContext,
): boolean {
  const callee = call.expression;
  if (!isIdentifier(callee)) {
    return false;
  }
  const helper = resolveHelper(callee, helpers, context);
  return helper !== undefined && helperReturnsTargetCall(helper, pair, context);
}

/**
 * Resolves a root-call callee onto the helper table, per mode: checker
 * mode through the symbol route (the callee symbol's resolved
 * declarations matched against each helper's declaring node), parse-only
 * through declared-name equality.
 *
 * @param callee The root call's identifier callee.
 * @param helpers The test file's file-local helper table.
 * @param context The live analysis context of the same run.
 * @returns The helper the callee names, or undefined when none does.
 */
function resolveHelper(
  callee: Identifier,
  helpers: readonly FileLocalHelper[],
  context: ProgramContext,
): FileLocalHelper | undefined {
  if (context.mode === "program") {
    const { checker } = context;
    const symbol = checker.getSymbolAtLocation(callee);
    const resolved = resolveSymbolAliases(checker, symbol);
    if (resolved === null) {
      return undefined;
    }
    return helpers.find((helper) =>
      resolved.declarations.some(
        (declaration) => declaration.resolve() === helper.declaration,
      ),
    );
  }
  return helpers.find((helper) => helper.name === callee.text);
}

/**
 * Whether a helper's returned value derives from a direct call to the
 * target: an expression-bodied arrow whose expression IS the direct
 * call (await/paren transparent), or a block body with at least one
 * return statement whose expression is (research R7's `return [await]
 * target(...)`).
 *
 * @param helper The bridge candidate helper.
 * @param pair The test-to-target pair the row is being built for.
 * @param context The live analysis context of the same run.
 */
function helperReturnsTargetCall(
  helper: FileLocalHelper,
  pair: Pairing,
  context: ProgramContext,
): boolean {
  const body = helper.fn.body;
  if (body === undefined) {
    // A body-less fn (an overload signature) never reaches the table
    // (`collectFileLocalHelpers` skips it); the guard keeps the type
    // total over the function-like union.
    return false;
  }
  if (!isBlock(body)) {
    return isDirectTargetCall(body, pair, context);
  }
  return returnsTargetCall(body, pair, context, 0);
}

/**
 * The pass-3 return walk: a descent over the helper's block body
 * reading its return statements (the node before its children —
 * deterministic), nested function-likes excluded (a return inside a
 * nested function returns from THAT function, not the helper — US4-8's
 * single-bridge boundary). Depth-bounded by the shared budget; the
 * sentinel raised past it is caught by `provenanceEstablished`.
 *
 * @param node The subtree root (the helper's block body).
 * @param pair The test-to-target pair the row is being built for.
 * @param context The live analysis context of the same run.
 * @param depth The current nesting depth (0 at the body root).
 */
function returnsTargetCall(
  node: Node,
  pair: Pairing,
  context: ProgramContext,
  depth: number,
): boolean {
  if (depth > MAPPING_WALK_DEPTH_BUDGET) {
    throw new MappingWalkDepthExceeded();
  }
  if (
    isFunctionDeclaration(node) ||
    isFunctionExpression(node) ||
    isArrowFunction(node)
  ) {
    return false;
  }
  if (
    isReturnStatement(node) &&
    node.expression !== undefined &&
    isDirectTargetCall(node.expression, pair, context)
  ) {
    return true;
  }
  let found = false;
  node.forEachChild((child) => {
    if (!found) {
      found = returnsTargetCall(child, pair, context, depth + 1);
    }
  });
  return found;
}

/**
 * Pass 4 — inline call matching (FR-011; research R7; data-model
 * Section 5.2's `argumentSubtree` pin): a call resolving to the target
 * appears inline anywhere within the assertion's argument subtree — the
 * invoked matcher invocation's full `CallExpression` for expect chains
 * (spanning the `expect(...)` arguments and the matcher's own arguments
 * — `expect(list).toContain(target(item))` scans `list` and
 * `target(item)` alike), the assert call's full argument list for
 * `node:assert` forms. Nested function-likes inside the subtree are
 * included: the subtree sits inside the test callback — the same scan
 * domain the `calls` pairing strategy reads — and US4-8's boundary pins
 * govern the binding searches (passes 2 and 3), never this subtree
 * scan. Depth-bounded by the shared budget.
 *
 * @param node The subtree root (the assertion's `argumentSubtree`).
 * @param pair The test-to-target pair the row is being built for.
 * @param context The live analysis context of the same run.
 * @param depth The current nesting depth (0 at the subtree root).
 */
function subtreeCallsTarget(
  node: Node,
  pair: Pairing,
  context: ProgramContext,
  depth: number,
): boolean {
  if (depth > MAPPING_WALK_DEPTH_BUDGET) {
    throw new MappingWalkDepthExceeded();
  }
  if (isCallExpression(node) && callResolvesToTarget(node, pair, context)) {
    return true;
  }
  let found = false;
  node.forEachChild((child) => {
    if (!found) {
      found = subtreeCallsTarget(child, pair, context, depth + 1);
    }
  });
  return found;
}

/**
 * Runs the four passes in fixed order (FR-011; research R7): direct
 * identity, indirect root resolution, helper bridging, inline call
 * matching — the first succeeding pass establishes provenance. Passes
 * 1-3 read the asserted expression (an absent asserted expression —
 * `expect()` with no arguments — leaves pass 4, whose scan domain is
 * the argument subtree); pass 4 always runs.
 *
 * The depth sentinel (and a materialization `RangeError`) is caught
 * HERE as no evidence: nothing is skipped — the row still emits under
 * the fallback chain — so no diagnostic is written, unlike the pairing
 * and assertion walks whose budget skips lose rows. Anything else
 * escapes (a crash is never a silent skip — the `collectAssertions`
 * rethrow discipline).
 *
 * @param assertion The classified assertion site.
 * @param pair The test-to-target pair the row is being built for.
 * @param inputs The pass inputs — live context and helper table.
 * @returns Whether any pass established provenance.
 */
function provenanceEstablished(
  assertion: AssertionSite,
  pair: Pairing,
  inputs: ProvenanceInputs,
): boolean {
  try {
    const asserted = assertion.assertedExpression;
    if (asserted !== null) {
      // Pass 1 — direct identity: the asserted expression IS a direct
      // target call (await/paren transparent).
      if (isDirectTargetCall(asserted, pair, inputs.context)) {
        return true;
      }
      const spine = spineRootOf(asserted);
      // Pass 2 — indirect root resolution: the root identifier is bound
      // in the test callback to the target's call result.
      if (
        spine.identifier !== null &&
        callbackBindsTargetCall(pair, spine.identifier.text, inputs.context)
      ) {
        return true;
      }
      // Pass 3 — helper bridging: the root call's helper returns the
      // target's call result.
      if (
        spine.call !== null &&
        helperBridgesTarget(spine.call, inputs.helpers, pair, inputs.context)
      ) {
        return true;
      }
    }
    // Pass 4 — inline call matching: a target call inside the
    // assertion's argument subtree.
    return subtreeCallsTarget(assertion.argumentSubtree, pair, inputs.context, 0);
  } catch (error) {
    if (!(error instanceof MappingWalkDepthExceeded || error instanceof RangeError)) {
      throw error;
    }
    return false;
  }
}

/**
 * Infers one mapping row's `side_effect_type` (FR-009/FR-010/FR-011;
 * research R7; data-model Section 7): which canonical taxonomy name the
 * assertion observes about its paired target.
 *
 * Error rows select by assertion type alone; value rows run US4's
 * provenance passes ahead of the standard chain — a succeeding pass
 * prefers the return family (`ReturnValue` → `GeneratorYield` →
 * `AsyncGeneratorYield`), and with no return-family effect present, or
 * no succeeding pass, the standard chain governs unchanged.
 *
 * Pure and total (Constitution Principles I and II): a deterministic
 * function of the assertion's kind, the pair's AST evidence, and the
 * target's effect set, defined for every shape including the empty set.
 *
 * @param assertion The classified assertion site.
 * @param pair The test-to-target pair the row is being built for — the
 * provenance-pass subject (unread by the fallback chains).
 * @param effects The paired target's detected effects (`detectEffects`'
 * output for its record), in effect-array order.
 * @param provenance The pass inputs — live context and the test file's
 * helper table. Optional so fallback-chain fixtures exercise FR-010 in
 * isolation; the pipeline always supplies it.
 * @returns The canonical side-effect type — one of the 48 taxonomy
 * names, never an alias, never an omission.
 */
export function inferSideEffectType(
  assertion: AssertionSite,
  pair: Pairing,
  effects: readonly Effect[],
  provenance?: ProvenanceInputs,
): SideEffectType {
  if (assertion.kind === "error_check") {
    return errorRowType(effects);
  }
  if (provenance !== undefined && provenanceEstablished(assertion, pair, provenance)) {
    if (carries(effects, RETURN_VALUE)) {
      return RETURN_VALUE;
    }
    if (carries(effects, GENERATOR_YIELD)) {
      return GENERATOR_YIELD;
    }
    if (carries(effects, ASYNC_GENERATOR_YIELD)) {
      return ASYNC_GENERATOR_YIELD;
    }
    // No return-family effect to prefer: the standard chain governs
    // (US4-7 — provenance only reorders the return family ahead of it).
  }
  return valueRowType(effects);
}
