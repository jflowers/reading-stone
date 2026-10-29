// Assertion-to-effect inference — the fallback chains (T018; FR-009/
// FR-010; research R7; data-model.md Section 7; Constitution Principles
// I and II).
//
// `inferSideEffectType` answers the mapping row's `side_effect_type`:
// which canonical taxonomy name the assertion observes about its paired
// target. The US1 rules are pure functions over the assertion's kind and
// the target's effect set — no compiler state, no I/O (the
// dependency-injection seam the inference suite pins with hand-built
// effect sets). US4's provenance passes (T031) extend the value-row
// chain in front of the fallback; the seam is the asserted expression
// and the pair, which flow through this signature unchanged.
//
// Inference is TOTAL (US1-7): every (assertion, effect-set) shape maps
// to a canonical name — a target with no detected effects at all maps
// the `ReturnValue` fallback, never an omission. The chains are
// presence-based, not position-based: `ReturnValue` wins over an earlier
// P0 effect in the array, and `ErrorReturn` wins over an earlier
// `ErrorSignal` — only the P0 pass reads the array's order (the first
// P0 effect in effect-array order, the pin `detectEffects`' deterministic
// `(line, column, type)` emission makes stable).

import type { Effect } from "../models.js";
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
 * Infers one mapping row's `side_effect_type` (FR-009/FR-010; research
 * R7; data-model Section 7): which canonical taxonomy name the assertion
 * observes about its paired target.
 *
 * Error rows select by assertion type alone; value rows follow the
 * standard chain. US4's provenance passes (T031) run ahead of the
 * value-row chain — reading the asserted expression and the pair — and
 * only reorder it toward the return family; this signature is the seam
 * they extend, so the assertion site and the pair flow through
 * unchanged.
 *
 * Pure and total (Constitution Principles I and II): a deterministic
 * function of the assertion's kind and the target's effect set, defined
 * for every shape including the empty set.
 *
 * @param assertion The classified assertion site.
 * @param pair The test-to-target pair the row is being built for — the
 * provenance-pass subject (unread by US1's fallback rules).
 * @param effects The paired target's detected effects (`detectEffects`'
 * output for its record), in effect-array order.
 * @returns The canonical side-effect type — one of the 48 taxonomy
 * names, never an alias, never an omission.
 */
export function inferSideEffectType(
  assertion: AssertionSite,
  _pair: Pairing,
  effects: readonly Effect[],
): SideEffectType {
  if (assertion.kind === "error_check") {
    return errorRowType(effects);
  }
  return valueRowType(effects);
}
