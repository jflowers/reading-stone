import type { SideEffectType } from "../taxonomy.js";
import type { Signal } from "./types.js";

/**
 * The distinct-module bucket extractor (FR-004; research R7; data-model.md
 * Section 7) — the pure half of US3's caller signal, and one of the five
 * extractors the adapter fans out per (function record, canonical effect
 * type) pair (FR-008).
 *
 * `buildCallerIndex` (src/signals/caller-index.ts) answers "how many
 * distinct in-scope modules call this function?" through the checker's own
 * cross-module reference machinery; this rule maps that count to FR-004's
 * pinned buckets:
 *
 * | distinct calling modules | `caller_count` weight |
 * |--------------------------|-----------------------|
 * | 0                        | — (no signal emitted) |
 * | exactly 1                | +5                    |
 * | 2–3                      | +10                   |
 * | 4 or more                | +15                   |
 *
 * The table is pinned arithmetic, not tuning — the same posture as the
 * confidence formula (FR-009): a bucket boundary or weight that drifts from
 * data-model.md Section 7 is a bug.
 *
 * Evidence seam (research R12): the rule is a pure function of the count and
 * the pair's identity fields — no compiler interaction, no I/O, no
 * `ProgramContext` (the imports above are type-only, which is the structural
 * proof). The checker machinery that produces the count lives entirely in
 * caller-index.ts; the adapter passes `RecordEvidence.callerModuleCount`
 * once the evidence snapshot lands (T019). The seam is what makes the rule
 * exhaustively table-testable with hand-built counts
 * (tests/signals/caller.test.ts, T008) — no compiler fixtures for the
 * weights, exactly like the sibling pure rules (interface, visibility,
 * naming, jsdoc).
 *
 * Zero-caller neutrality (FR-004; US3-4; spec assumption 3): a count of 0
 * emits NO signal. Weight 0 carries no evidence — a 0-weight row would add
 * wire noise without shifting the confidence arithmetic — and the reference
 * analyzer's extractor likewise returns nothing for zero-caller counts. The
 * same value carries parse-only degradation (research R7): without a
 * checker the index is empty, so no `caller_count` signal exists at all —
 * degradation reduces precision, never availability.
 *
 * Determinism (Constitution Principle I; research R1/R15): the emitted
 * `reasoning` is a fixed template naming the count — a pure function of the
 * matched rule and its token, stable per analyzer version and pinned by the
 * test suite exactly like effect `description` strings.
 */

/**
 * Maps one (function record, canonical effect type) pair's distinct in-scope
 * calling-module count to FR-004's `caller_count` bucket.
 *
 * The identity fields pass through verbatim — `functionName` is the record's
 * unqualified name, `packageName` its `derivePackage` value — and the rule is
 * effect-type-blind: unlike naming and documentation evidence (FR-005/
 * FR-006), real usage agrees with every effect type equally, so no routing
 * gate applies and `effectType` rides along as identity only.
 *
 * @param callerModuleCount The number of distinct in-scope modules whose
 * call sites resolve to the record — `buildCallerIndex`'s per-record value
 * (0 in parse-only mode), which the adapter passes as
 * `RecordEvidence.callerModuleCount` once the evidence snapshot lands.
 * @param functionName The record's unqualified name — the signal's
 * `function` identity field.
 * @param packageName The record's dotted module path — the signal's
 * `package` identity field.
 * @param effectType The pair's canonical effect type — the signal's
 * `side_effect_type` identity field.
 * @returns The `caller_count` signal for the count's bucket — weight +5 for
 * exactly 1 distinct module, +10 for 2–3, +15 for 4 or more — or
 * `undefined` for 0 callers: neutral evidence, never a 0-weight row.
 * @throws Error when `callerModuleCount` is not a non-negative integer — a
 * value the caller index cannot produce; an upstream bug fails loud rather
 * than silently dropping the signal.
 */
export function callerSignal(
  callerModuleCount: number,
  functionName: string,
  packageName: string,
  effectType: SideEffectType,
): Signal | undefined {
  // The index produces Set.size values — non-negative integers by
  // construction — so an out-of-domain count is an upstream bug, not a
  // runtime condition to absorb. Failing loud (the models.ts serializer
  // posture) beats silently suppressing the caller signal, which would be a
  // Principle II silent false negative.
  if (!Number.isInteger(callerModuleCount) || callerModuleCount < 0) {
    throw new Error(
      `Invalid caller module count: ${callerModuleCount} (must be a non-negative integer)`,
    );
  }
  // US3-4: zero callers is neutral evidence — no signal, never a 0-weight row.
  if (callerModuleCount === 0) {
    return undefined;
  }
  // FR-004's bucket table, transcribed from data-model.md Section 7.
  let weight: number;
  if (callerModuleCount === 1) {
    weight = 5;
  } else if (callerModuleCount <= 3) {
    weight = 10;
  } else {
    weight = 15;
  }
  const plural = callerModuleCount === 1 ? "" : "s";
  return {
    function: functionName,
    package: packageName,
    side_effect_type: effectType,
    source: "caller_count",
    weight,
    reasoning: `called from ${callerModuleCount} distinct in-scope module${plural}`,
  };
}
