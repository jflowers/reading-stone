import { derivePackage } from "../models.js";
import type { SideEffectType } from "../taxonomy.js";
import type { RecordEvidence } from "./evidence.js";
import {
  CONTRACTUAL_PREFIXES,
  INCIDENTAL_PREFIXES,
  ROUTING_TABLE,
  type RoutingBranch,
} from "./routing.js";
import type { Signal } from "./types.js";

/**
 * The naming-convention and sentinel extractor (FR-005; research R3;
 * data-model.md Sections 6–7) — the pure half of US1's
 * `naming_convention` signal, and one of the five extractors the adapter
 * fans out per (function record, canonical effect type) pair (FR-008).
 *
 * The rule is pinned selection-and-weight arithmetic, not tuning: the
 * longest applicable prefix over the union of the 22 closed prefixes
 * (18 contractual, 4 incidental), matched case-insensitively against the
 * record name's leading characters, emits +10 (contractual) or −10
 * (incidental) only when the FR-007 routing table lists the selected
 * prefix as agreeing with the pair's effect type — no applicable prefix,
 * or a match without agreement, emits nothing. A weight that drifts from
 * data-model.md Section 7 is a bug — the same posture as the sibling
 * pure rules (interface, visibility, caller).
 *
 * The `Err` + `SentinelError` sentinel special case takes precedence: a
 * record name beginning with `Err` (case-insensitive) evaluated for a
 * `SentinelError` effect emits +30 IN PLACE of the prefix rules for that
 * effect — research R3's rejected alternative is emitting it alongside a
 * routed prefix, and "in place of" (FR-005) is explicit. Because the
 * return type is a single `Signal | undefined`, the replacement, like
 * the at-most-one-signal-per-pair guarantee, is structural. The special
 * case is a rule of THIS module, never a routing-table row (routing.ts's
 * `SentinelError` naming list is empty; tests/signals/routing.test.ts
 * asserts the placement).
 *
 * Evidence seam (research R12): the rule is a pure function of the
 * snapshot and the pair's effect type — no compiler interaction, no I/O,
 * no `ProgramContext`. Unlike its siblings it reads NO evidence
 * component: the record's name IS the evidence, so the only reads are
 * the record's identity fields (`name` is both the matched string and
 * the signal's `function`; `relPath` feeds `derivePackage` for
 * `package`). That is what lets the adapter compute one snapshot per
 * record for all five extractors while this rule stays
 * evidence-component-blind, and it makes naming the one extractor with
 * no parse-only degradation at all — the name is available in every
 * mode (degradation reduces precision, never availability; here there
 * is nothing to degrade).
 *
 * Effect-type sensitivity — the routing gate (FR-007): unlike the
 * effect-type-blind interface and visibility rules, naming evidence
 * agrees with effect types selectively, so the gate decides per pair —
 * the same `getTotal` name yields +10 on its `ReturnValue` effect and
 * nothing on a `LogWrite` effect (research R3). Contractual agreement
 * is listed in `RoutingBranch.naming`; incidental agreement in
 * `RoutingBranch.docIncidental` — routing.ts's documented shared column
 * for incidental prefixes+verbs (the token sets are disjoint, so one
 * list serves the naming and documentation extractors without
 * ambiguity). An effect type with no agreeing vocabulary — the
 * explicitly-empty rows — emits nothing, never an exception (FR-007
 * totality).
 *
 * Longest-prefix selection is arithmetically inert over today's closed
 * lists — no prefix is a strict prefix of another (research R3), a
 * property tests/signals/naming.test.ts pins as a tripwire exactly like
 * the visibility suite's inert +20 clamp — but the rule is implemented
 * and fixture-tested anyway: it is the rule that governs if the lists
 * ever grow.
 *
 * Stem-boundary imprecision (spec assumption 5): matching is
 * leading-character only, with no word-boundary requirement, so
 * `readyCheckout` matches the `Read` stem and `ErrorMapper` matches
 * `Err` — a documented, fixture-pinned false-positive surface
 * acceptable for a heuristic signal.
 *
 * Determinism (Constitution Principle I; research R1): the emitted
 * `reasoning` is one of three fixed templates naming the matched rule
 * and its token in the CANONICAL closed-list spelling (`'Get'`,
 * `'log'`, `'Err'` — never the record name's own casing, so `getTotal`
 * and `GetTotal` carry identical reasoning), stable per analyzer
 * version and pinned by the test suite exactly like effect
 * `description` strings.
 */

/**
 * One closed prefix family (FR-005) — the polarity, pinned weight, and
 * routing column shared by every prefix of one closed list. Two families
 * exist: contractual (+10, agreement listed in `RoutingBranch.naming`)
 * and incidental (−10, agreement listed in `RoutingBranch.docIncidental`).
 * Alternatives considered: two independent matched-list walks with the
 * polarity inline at each emit site were rejected because the weight, the
 * reasoning word, and the gate column would then live at a distance from
 * the lists they govern — one table is the single source of truth for
 * all three, the same consolidation as visibility's component table
 * (DRY).
 */
interface PrefixFamily {
  /** The closed list — canonical spellings, one entry per prefix. */
  readonly prefixes: readonly string[];
  /** The family's pinned contribution to the emitted weight (+10/−10). */
  readonly weight: number;
  /** The family's fixed-template word in the emitted reasoning. */
  readonly label: "contractual" | "incidental";
  /** The routing-table column listing the prefixes agreeing with a type. */
  readonly routedIn: (branch: RoutingBranch) => readonly string[];
}

/**
 * FR-005's contractual family — the 18 closed prefixes whose presence
 * AGREES with an effect being contractual (+10 via `naming_convention`
 * when the routing table lists the selected prefix for the pair's effect
 * type). Drawn from routing.ts's exported list so the conformance
 * suite's closed-list pin and this selection table cannot drift apart.
 */
const CONTRACTUAL_FAMILY: PrefixFamily = {
  prefixes: CONTRACTUAL_PREFIXES,
  weight: 10,
  label: "contractual",
  routedIn: (branch) => branch.naming,
};

/**
 * FR-005's incidental family — the 4 closed logging prefixes whose
 * presence DISAGREES with an effect being contractual (−10 when routed;
 * only the output family ever lists them, which is what makes negative
 * naming evidence possible at all — research R2). The routing column is
 * `docIncidental`, routing.ts's shared incidental prefixes+verbs list:
 * the prefix and verb token sets are disjoint, so one column serves the
 * naming and documentation extractors without ambiguity.
 */
const INCIDENTAL_FAMILY: PrefixFamily = {
  prefixes: INCIDENTAL_PREFIXES,
  weight: -10,
  label: "incidental",
  routedIn: (branch) => branch.docIncidental,
};

/**
 * One entry of the flattened 22-prefix closed set — the canonical
 * spelling (what selection returns and the reasoning names), its
 * lowercased form (the case-insensitive matching key, folded once at
 * module load rather than per pair), and the family carrying the
 * polarity, weight, and routing column.
 */
interface ClosedPrefix {
  /** The canonical closed-list spelling — the reasoning's named token. */
  readonly prefix: string;
  /** The prefix lowercased once — the case-insensitive matching key. */
  readonly folded: string;
  /** The family the prefix belongs to. */
  readonly family: PrefixFamily;
}

/**
 * The union of the 22 closed prefixes as one flat selection table (FR-005
 * selects the longest applicable prefix over the UNION, not per family),
 * built once at module load. Contractual entries precede incidental
 * ones; since two prefixes of the same length can both match one name's
 * leading characters only by being the same string — and the two closed
 * lists are disjoint — the order is unobservable beyond determinism.
 */
const CLOSED_PREFIXES: readonly ClosedPrefix[] = [
  CONTRACTUAL_FAMILY,
  INCIDENTAL_FAMILY,
].flatMap((family) =>
  family.prefixes.map((prefix) => ({ prefix, folded: prefix.toLowerCase(), family })),
);

/**
 * The sentinel special case's stem (FR-005; spec assumption 6): a record
 * name beginning with `Err` — the constant holds the folded form, the
 * case-insensitive matching key — evaluated for a `SentinelError`
 * effect emits +30 in place of the prefix rules. The stem is matched
 * with the same leading-character imprecision as every prefix
 * (`ErrorMapper` fires — assumption 5's sentinel-side mirror,
 * fixture-pinned). The carrying record's name governs because signals
 * are computed per pair from the record the effect lives on: sentinel
 * effects attach to the file's first function record (spec 002 FR-013),
 * so that record's name is the one this rule reads (spec edge case 3).
 */
const SENTINEL_STEM = "err";

/**
 * The sentinel special case's pinned weight (data-model.md Section 7):
 * +30, replacing the prefix rules' ±10 for that effect entirely.
 */
const SENTINEL_WEIGHT = 30;

/**
 * Selects FR-005's longest applicable prefix for a record name: the one
 * closed-list entry whose folded form matches the name's leading
 * characters, case-insensitively, longest first. Over today's closed
 * lists at most one prefix can apply at all (the no-overlap tripwire in
 * tests/signals/naming.test.ts); the length comparison is the pinned
 * longest-wins rule that governs if the lists ever grow (research R3) —
 * never removed to simplify the code, the same pinned-guard discipline
 * as visibility's inert +20 clamp.
 *
 * @param name The record's unqualified name.
 * @returns The longest applicable closed prefix, or `undefined` when
 * the name begins with none of the 22.
 */
function selectLongestPrefix(name: string): ClosedPrefix | undefined {
  const folded = name.toLowerCase();
  let selected: ClosedPrefix | undefined;
  for (const candidate of CLOSED_PREFIXES) {
    if (
      folded.startsWith(candidate.folded) &&
      (selected === undefined || candidate.prefix.length > selected.prefix.length)
    ) {
      selected = candidate;
    }
  }
  return selected;
}

/**
 * Maps one (function record, canonical effect type) pair's evidence
 * snapshot to FR-005's `naming_convention` signal.
 *
 * The identity fields pass through verbatim — `function` is the record's
 * unqualified name (which is also the matched evidence) and `package`
 * its `derivePackage` value — and the rule reads no other snapshot field
 * (see the module header): the same name yields the same signal for a
 * given effect type regardless of every other evidence component.
 *
 * @param evidence The record's evidence snapshot; the rule reads only
 * the record's identity fields, never the compiler views or the other
 * components.
 * @param effectType The pair's canonical effect type — the signal's
 * `side_effect_type` identity field and the routing gate's key.
 * @returns The +30 sentinel signal for an `Err`-prefixed name on a
 * `SentinelError` effect; otherwise the routed prefix's +10/−10 signal
 * when the longest applicable closed prefix agrees with the effect type
 * through the routing table; `undefined` when no prefix applies or the
 * selected prefix has no agreement — at most one signal per
 * (function, effect-type) pair, structurally.
 */
export function namingSignal(
  evidence: RecordEvidence,
  effectType: SideEffectType,
): Signal | undefined {
  const { record } = evidence;
  // The sentinel special case first (FR-005 precedence): a SentinelError
  // effect carried by an Err-prefixed name emits +30 IN PLACE of the
  // prefix rules — returning here is what makes "in place of"
  // structural, and the single return value is what makes
  // at-most-one-signal-per-pair structural. Every other combination
  // falls through to the prefix rules: an Err-prefixed name on any other
  // effect (Err is in neither closed list — no closed prefix even begins
  // with 'e' — so the fallback is structurally silent), and a
  // SentinelError effect on a non-Err name (the row's naming list is
  // empty, so the gate below stays silent).
  if (
    effectType === "SentinelError" &&
    record.name.toLowerCase().startsWith(SENTINEL_STEM)
  ) {
    return {
      function: record.name,
      package: derivePackage(record.relPath),
      side_effect_type: effectType,
      source: "naming_convention",
      weight: SENTINEL_WEIGHT,
      reasoning: "name starts with 'Err', the SentinelError special case",
    };
  }
  // Longest-prefix selection over the union of the 22 closed prefixes,
  // case-insensitive on the name's leading characters. No applicable
  // prefix is neutral absence, never an error (Constitution Principle
  // II) — the confidence arithmetic simply proceeds without a naming
  // term.
  const selected = selectLongestPrefix(record.name);
  if (selected === undefined) {
    return undefined;
  }
  const { family, prefix } = selected;
  // The routing gate (FR-007): the matched prefix is evidence only for
  // the effect types whose routing row lists it — a match without
  // agreement emits nothing. The family picks the column (contractual
  // agreement in `naming`, incidental in `docIncidental`), and the
  // lookup is total by construction — routing.ts's compile-time
  // exhaustiveness — so there is no fallback path and never an
  // exception.
  if (!family.routedIn(ROUTING_TABLE[effectType]).includes(prefix)) {
    return undefined;
  }
  return {
    function: record.name,
    package: derivePackage(record.relPath),
    side_effect_type: effectType,
    source: "naming_convention",
    weight: family.weight,
    reasoning: `name starts with the ${family.label} prefix '${prefix}'`,
  };
}
