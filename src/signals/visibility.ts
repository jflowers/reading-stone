import { derivePackage } from "../models.js";
import type { SideEffectType } from "../taxonomy.js";
import type { RecordEvidence } from "./evidence.js";
import type { Signal } from "./types.js";

/**
 * The API-visibility extractor (FR-003; research R5; data-model.md Section 7)
 * — the pure half of US1's `visibility` signal, and one of the five extractors
 * the adapter fans out per (function record, canonical effect type) pair
 * (FR-008).
 *
 * The rule is pinned weight arithmetic, not tuning: the signal's weight is the
 * sum of the applicable components — exported function +8, exported return
 * type +6, exported receiver +6 — clamped to a maximum of +20. Components are
 * independent (FR-003's "sum of its applicable components"): a module-private
 * function whose annotated return type references an exported type still
 * emits +6. A weight that drifts from data-model.md Section 7 is a bug — the
 * same posture as the caller bucket table (caller.ts) and the interface rule
 * (interface.ts).
 *
 * Evidence seam (research R12): the rule is a pure function of the snapshot
 * and the pair's effect type — no compiler interaction, no I/O, no
 * `ProgramContext`. Every exportedness decision — which ESM and CJS forms
 * count as an exported function (spec edge case 5), which return-type
 * annotations resolve to exported symbols, the class-member/receiver split —
 * lives entirely in evidence.ts's `RecordEvidence` components (T018/T019),
 * pinned over fixture trees by tests/signals/evidence.test.ts (T011); this
 * rule pins the ARITHMETIC over those facts. The one runtime import here is
 * `derivePackage`, the pure string helper that renders the record's dotted
 * module path. The seam is what makes the rule exhaustively table-testable
 * with hand-built snapshots (tests/signals/visibility.test.ts, T013) — no
 * tree, no tsconfig, no checker for the weights, exactly like the sibling
 * pure rules (interface, caller, naming, jsdoc).
 *
 * Positive-only visibility (spec assumption 4): a record with zero applicable
 * components emits NO signal — the issue defines only positive components and
 * the clamp reinforces a positive-only design, so a module-private function
 * emits nothing rather than a negative signal or a 0-weight wire row.
 *
 * Effect-type blindness: visibility evidence agrees with every effect type
 * equally — exportedness obligates the function as a whole, not one effect
 * category — so unlike naming and documentation evidence (FR-005/FR-006)
 * there is no routing gate, and `effectType` rides along as identity only
 * (the interface rule's stance, shared here).
 *
 * Parse-only degradation (research R5; spec assumption 10): the function and
 * receiver components are syntactic facts that survive without a checker;
 * only the return-type component needs one (resolving a type reference to a
 * symbol and its export state is semantics, Principle III). Degradation
 * reduces precision, never availability — the rule itself never branches on
 * mode; the snapshot simply arrives with fewer applicable components.
 *
 * Determinism (Constitution Principle I; research R1): the emitted `reasoning`
 * is a fixed template naming the applicable components in the pinned order
 * function → return type → receiver — a pure function of the snapshot, stable
 * per analyzer version and pinned by the test suite exactly like effect
 * `description` strings.
 */

/**
 * One row of FR-003's component table: the snapshot read that decides
 * applicability, the pinned weight a firing component contributes, and the
 * fixed-template label that names it in the emitted reasoning.
 */
interface VisibilityComponent {
  /** Reads the snapshot field carrying this component's applicability. */
  readonly applies: (evidence: RecordEvidence) => boolean;
  /** The component's pinned contribution to the summed weight (+8/+6/+6). */
  readonly weight: number;
  /** The component's fixed-template name in the emitted reasoning. */
  readonly label: string;
}

/**
 * FR-003's three components, transcribed from data-model.md Section 7. The
 * row order is the pinned reasoning order (function → return type → receiver)
 * and the weights are the pinned contributions — one table is the single
 * source of truth for both, so the arithmetic and the reasoning template
 * cannot drift apart (DRY). Alternatives considered: independent if-chains
 * for the sum and the labels were rejected because a future fourth component
 * (or a re-tuned weight) would need two coordinated edits, where the table
 * makes that extension a one-row change the +20 clamp guards loudly.
 */
const VISIBILITY_COMPONENTS: readonly VisibilityComponent[] = [
  {
    applies: (evidence) => evidence.exportedFunction,
    weight: 8,
    label: "exported function",
  },
  {
    applies: (evidence) => evidence.exportedReturnType,
    weight: 6,
    label: "exported return type",
  },
  {
    applies: (evidence) => evidence.exportedReceiver,
    weight: 6,
    label: "exported receiver",
  },
];

/**
 * FR-003's pinned maximum: the summed component weight is clamped to +20.
 * Arithmetically inert today — 8+6+6 = 20 exactly — and retained anyway as
 * the pinned guard: research R5's rejected alternative is dropping the inert
 * clamp, and removing a pinned guard to simplify code is a gate-weakening
 * move. A future fourth component or re-tuned weight that pushes the raw sum
 * past 20 fails the clamp row loud (tests/signals/visibility.test.ts).
 */
const MAX_VISIBILITY_WEIGHT = 20;

/**
 * Maps one (function record, canonical effect type) pair's evidence snapshot
 * to FR-003's `visibility` signal.
 *
 * The identity fields pass through verbatim — `function` is the record's
 * unqualified name and `package` its `derivePackage` value — and the rule is
 * effect-type-blind (see the module header): the same snapshot yields the
 * same source, weight, and reasoning for any canonical effect type.
 *
 * @param evidence The record's evidence snapshot; the rule reads only the
 * three visibility components and the record's identity fields, never the
 * live compiler views.
 * @param effectType The pair's canonical effect type — the signal's
 * `side_effect_type` identity field.
 * @returns The `visibility` signal carrying the clamped component sum (+8,
 * +6, +6, or their intermediate sums up to +20) when at least one component
 * applies, or `undefined` when zero do — positive-only visibility (spec
 * assumption 4), never a negative signal and never a 0-weight wire row.
 */
export function visibilitySignal(
  evidence: RecordEvidence,
  effectType: SideEffectType,
): Signal | undefined {
  // Applicability is decided per component (they are independent, FR-003);
  // the filtered rows preserve the table's pinned order, which is also the
  // reasoning's fixed component order.
  const applicable = VISIBILITY_COMPONENTS.filter((component) =>
    component.applies(evidence),
  );
  // Positive-only (spec assumption 4): zero applicable components emit no
  // signal at all — the confidence arithmetic simply proceeds without a
  // visibility term.
  if (applicable.length === 0) {
    return undefined;
  }
  // FR-003: the emitted weight is the sum of the applicable components,
  // clamped to the +20 maximum (the pinned guard — MAX_VISIBILITY_WEIGHT).
  const weight = Math.min(
    applicable.reduce((total, component) => total + component.weight, 0),
    MAX_VISIBILITY_WEIGHT,
  );
  const labels = applicable.map((component) => component.label);
  const { record } = evidence;
  return {
    function: record.name,
    package: derivePackage(record.relPath),
    side_effect_type: effectType,
    source: "visibility",
    weight,
    reasoning: `exported API surface: ${labels.join(", ")}`,
  };
}
