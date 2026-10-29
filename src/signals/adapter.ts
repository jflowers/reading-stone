import type { Writable } from "node:stream";
import { prepareAnalysis } from "../analysis.js";
import { detectEffects } from "../detector.js";
import type { ExtractionRecord } from "../extract.js";
import { type Classification, derivePackage, type Effect } from "../models.js";
import { type SideEffectType, TIER_MAP, type Tier } from "../taxonomy.js";
import { callerSignal } from "./caller.js";
import { buildRecordEvidence, type RecordEvidence } from "./evidence.js";
import { interfaceSignal } from "./interface.js";
import { docstringSignal } from "./jsdoc.js";
import { namingSignal } from "./naming.js";
import { type Signal, serializeSignal } from "./types.js";
import { visibilitySignal } from "./visibility.js";

/**
 * The classification fan-out core (FR-008 through FR-011; research R8, R9,
 * R10; data-model.md Sections 4, 5.4) — the shared engine both consumers of
 * classification ride: the `analyze` method's handler (T025) and the
 * `classify_signals` entry (T029).
 *
 * Three responsibilities, one seam:
 *
 * - **Fan-out (FR-008)**: the five pure extractors (interface, visibility,
 *   caller, naming, docstring) run exactly once per (function record,
 *   canonical effect type) PAIR — never per effect instance. Same-type
 *   instances share one pair run, so they share identical signals and an
 *   identical classification; distinct types on one record run
 *   independently. Extractor results are never deduplicated across
 *   sources. A record absent from the effects map is benign no-pairs (the
 *   `?? []` default `detectEffects` itself uses internally), while a record
 *   without an evidence snapshot fails loud (`buildRecordEvidence` keys
 *   every record, so a miss is an upstream bug).
 * - **Contradiction (FR-011)**: a pair whose extractor signals mix at least
 *   one positive and at least one negative weight carries exactly ONE
 *   synthesized `contradiction` row — weight −20, the pair's identity
 *   fields, a fixed-template reasoning — applied exactly once however many
 *   signals of either polarity fired. The row is the wire realization of
 *   the formula's separate −20 term: a consumer summing ALL emitted signals
 *   for the pair (contradiction included) reproduces the reported
 *   confidence.
 * - **Formula (FR-009/FR-010)**: `clamp(0, 100, 50 + tierBoost +
 *   Σ(extractor weights) − (contradiction ? 20 : 0))` with the tier read
 *   from `TIER_MAP` — the taxonomy is the single tier authority, never a
 *   second tier table — and labels contractual ≥ 80, ambiguous [50, 80),
 *   incidental < 50.
 *
 * The adapter also owns FR-014's emitter-side ordering: every feed it
 * returns is sorted by the four-key `(package, function, side_effect_type,
 * source)` codepoint comparison. Pair keying keeps that key duplicate-free
 * (at most one signal per source per pair), which is what lets the total
 * order carry no tie-break rule and what keeps a Gaze consumer's
 * pair-matching join unambiguous.
 *
 * Composition contract (research R10; research R12's seam): the module has
 * two halves. The CORE — `classifyBundle` and `classifyPairs` below — is a
 * pure function of (records, effects, evidence): no `ProgramContext`, no
 * I/O, no checker (one value import per extractor plus `TIER_MAP` and
 * `derivePackage` are its structural proof, and the exhaustively
 * hand-built snapshots of tests/signals/adapter.test.ts are what that
 * purity buys). The WIRING belongs to the two method entries that consume
 * the core, in one order, while the program-mode context is still live:
 *
 * 1. `detectEffects(records, context)` — the detector's per-record map.
 * 2. `buildRecordEvidence(context, records, inScopePaths)` — the evidence
 *    snapshots, caller index included, taken before any context disposal.
 * 3. `classifyPairs(records, effects, evidence)` — this module's core.
 * 4. `assembleFunctionRecords` + `serializeFunctionRecord` (`analyze`,
 *    src/analysis.ts) / feed serialization (`classifySignals`, this
 *    module) — each entry's own assembly.
 *
 * The classify_signals half: `classifySignals` (T029, below) is the second
 * method entry — the `classify_signals` handler's payload source, running
 * `analyze`'s stages identically and owning the same context-dispose
 * lifetime. Its imports are the wiring's, not the core's. Research R10
 * pins both entries' homes — analyze's handler in src/analysis.ts, this
 * entry beside the core it composes — which makes the two modules mutual
 * importers (`analyze` rides `classifyPairs`; this entry rides
 * `prepareAnalysis`). The cycle is call-time only: both directions are
 * function declarations consumed inside function bodies, never at module
 * evaluation, so ESM's hoisted live bindings keep it safe whichever
 * module loads first.
 *
 * Immutability (convention pack AP-004): classified effects are REBUILT as
 * new values (`{ ...effect, classification }`), every field preserved —
 * the detector's instances are never mutated, and both input maps are
 * consumed read-only. The seam is also what makes the whole engine
 * exhaustively testable with hand-built snapshots (research R13;
 * tests/signals/adapter.test.ts, T016) — no tree, no tsconfig, no checker.
 */

/**
 * The tier boosts (data-model.md Section 4; SC-003) — P0 → +25, P1 → +10,
 * P2/P3/P4 → +0. Keyed by the full `Tier` union so the compiler rejects a
 * missing or misspelled entry (compile-time exhaustiveness, the same check
 * `TIER_MAP` gets). The TIER a boost applies to is always read from
 * `TIER_MAP`; this table holds only the arithmetic, and
 * tests/signals/adapter.test.ts carries its own pinned copy as the
 * independent second copy the arithmetic is diffed against.
 */
const TIER_BOOST: Readonly<Record<Tier, number>> = {
  P0: 25,
  P1: 10,
  P2: 0,
  P3: 0,
  P4: 0,
};

/**
 * The mixed-polarity penalty (FR-011; data-model.md Section 4): the weight
 * of the single synthesized `contradiction` row and the formula's one-time
 * term — applied exactly once per contradicting pair, never per signal.
 */
const CONTRADICTION_WEIGHT = -20;

/**
 * The contradiction row's fixed-template reasoning (spec assumption 8;
 * Constitution Principle I): deterministic per analyzer version, pinned
 * verbatim by tests/signals/adapter.test.ts.
 */
const CONTRADICTION_REASONING =
  "mixed-polarity evidence: positive and negative signals";

/**
 * FR-014's total order over signals: the four-key `(package, function,
 * side_effect_type, source)` codepoint comparison — plain string
 * comparison per field, which for these ASCII fields IS codepoint
 * comparison (never `localeCompare`, whose collation is locale-dependent
 * and would break determinism). Pair keying keeps the key duplicate-free
 * (at most one signal per source per pair), so the comparator needs no
 * tie-break rule; the equal case exists only for hand-built duplicates the
 * wire never sees.
 *
 * @param a The left signal.
 * @param b The right signal.
 * @returns Negative when `a` sorts first, positive when `b` does, zero on
 * exact four-key equality.
 */
function compareSignals(a: Signal, b: Signal): number {
  if (a.package !== b.package) {
    return a.package < b.package ? -1 : 1;
  }
  if (a.function !== b.function) {
    return a.function < b.function ? -1 : 1;
  }
  if (a.side_effect_type !== b.side_effect_type) {
    return a.side_effect_type < b.side_effect_type ? -1 : 1;
  }
  if (a.source !== b.source) {
    return a.source < b.source ? -1 : 1;
  }
  return 0;
}

/**
 * FR-010's label bands (data-model.md Section 4): contractual ≥ 80,
 * ambiguous [50, 80), incidental < 50 — inclusive at 80, exclusive at 50.
 *
 * @param confidence The clamped confidence percentage.
 * @returns The label the formula assigns to that confidence.
 */
function labelForConfidence(confidence: number): Classification["label"] {
  if (confidence >= 80) {
    return "contractual";
  }
  return confidence >= 50 ? "ambiguous" : "incidental";
}

/**
 * One pair's classification result (data-model.md Section 5.4): the pair's
 * wire rows — the extractor signals plus the synthesized contradiction row
 * when it fires, in four-key order — and the formula's `Classification`
 * every same-type effect instance of the pair will carry.
 */
export interface SignalBundle {
  /** The pair's signals in `(package, function, type, source)` order. */
  readonly signals: readonly Signal[];
  /** The pair's confidence and label (FR-009/FR-010). */
  readonly classification: Classification;
}

/**
 * The fan-out result (FR-008; data-model.md Section 5.4): the full
 * `(package, function, side_effect_type, source)`-ordered signal feed and
 * every record's effects rebuilt as new immutable values with
 * `classification` set — `analyze`'s assembly input and
 * `classify_signals`' feed source, one shape for both consumers.
 */
export interface ClassifiedEffects {
  /** Every emitted signal, in FR-014's four-key order. */
  readonly signals: readonly Signal[];
  /** Each record's effects, rebuilt with classification attached. */
  readonly effects: ReadonlyMap<ExtractionRecord, readonly Effect[]>;
}

/**
 * Classifies one (function record, canonical effect type) pair (FR-011;
 * data-model.md Sections 4, 5.4) — the per-pair core `classifyPairs` fans
 * out to, and the seam tests/signals/adapter.test.ts pins directly with
 * hand-built signals (deliberately out-of-set weights included, for the
 * clamp rows real extractor arithmetic cannot reach).
 *
 * The contradiction rule is a property of the PAIR, not a per-signal
 * penalty: when the extractor signals mix at least one positive and at
 * least one negative weight, exactly ONE synthesized row joins the bundle
 * — source `contradiction`, weight −20, the first signal's identity
 * fields, the pair's canonical type, the fixed-template reasoning — and
 * the formula applies the −20 exactly once however many signals of either
 * polarity fired. All-positive and all-negative evidence is agreement,
 * never a contradiction; a weight of 0 is polarity-neutral.
 *
 * The formula (FR-009/FR-010): `clamp(0, 100, 50 + tierBoost +
 * Σ(extractor weights) − (contradiction ? 20 : 0))` — the tier from
 * `TIER_MAP` (the taxonomy is the single tier authority), the sum over the
 * EXTRACTOR signals only (the synthesized row's −20 is the separate
 * one-time term, which is what keeps the emitted feed sum-invariant). The
 * clamp applies to the confidence only — emitted rows keep their real
 * weights, so the evidence a consumer reads is never distorted by the
 * bound.
 *
 * @param extractorSignals The pair's already-extracted signals — the five
 * extractors' defined results, any order; never mutated.
 * @param effectType The pair's canonical effect type — the `TIER_MAP` key
 * and the synthesized row's `side_effect_type`; structural for the empty
 * bundle, where no signal exists to read it from.
 * @returns The pair's `SignalBundle`: its wire rows in four-key order
 * (contradiction row included when it fires) and its `Classification`.
 * @throws Error never in real flow — the identity guard below is
 * structurally unreachable (mixed polarity implies a non-empty bundle) and
 * exists to keep that claim loud rather than asserted.
 */
export function classifyBundle(
  extractorSignals: readonly Signal[],
  effectType: SideEffectType,
): SignalBundle {
  // The polarity scan decides the synthesis (FR-011): mixed polarity — at
  // least one positive AND at least one negative weight — is the one and
  // only trigger. A 0 weight (never emitted by real extractors) is
  // polarity-neutral: it cannot fire the synthesis.
  let hasPositive = false;
  let hasNegative = false;
  for (const signal of extractorSignals) {
    if (signal.weight > 0) {
      hasPositive = true;
    } else if (signal.weight < 0) {
      hasNegative = true;
    }
  }
  // The bundle copies the input array (never mutates it); the signal
  // objects themselves are shared immutable values, the house pattern.
  const signals: Signal[] = [...extractorSignals];
  // The one-time −20 term; 0 when no synthesis fired. Kept separate from
  // the extractor sum so the emitted rows and the arithmetic stay in step
  // — the sum-invariant a consumer checks by summing ALL rows.
  let contradictionTerm = 0;
  if (hasPositive && hasNegative) {
    // Mixed polarity implies a non-empty bundle, so the first signal
    // always exists; the guard keeps the structural claim loud rather
    // than asserted (the noUncheckedIndexedAccess posture).
    const identity = extractorSignals[0];
    if (identity === undefined) {
      throw new Error(
        "mixed-polarity evidence implies a non-empty signal bundle — an empty bundle cannot fire the contradiction",
      );
    }
    signals.push({
      function: identity.function,
      package: identity.package,
      side_effect_type: effectType,
      source: "contradiction",
      weight: CONTRADICTION_WEIGHT,
      reasoning: CONTRADICTION_REASONING,
    });
    contradictionTerm = CONTRADICTION_WEIGHT;
  }
  signals.sort(compareSignals);
  const weightSum = extractorSignals.reduce(
    (total, signal) => total + signal.weight,
    0,
  );
  // FR-009: the clamped score, then FR-010: the label bands.
  const raw = 50 + TIER_BOOST[TIER_MAP[effectType]] + weightSum + contradictionTerm;
  const confidence = Math.max(0, Math.min(100, raw));
  return {
    signals,
    classification: { label: labelForConfidence(confidence), confidence },
  };
}

/**
 * Runs the classification fan-out over one prepared analysis's records
 * (FR-008; research R8) — the shared engine both consumers call after
 * `detectEffects` and `buildRecordEvidence`, per the composition contract
 * in this module's header.
 *
 * Pair keying: the extractors run once per (record, DISTINCT canonical
 * effect type) pair — the fan-out counts types, never effect instances —
 * so same-type instances share one bundle's signals and one classification,
 * and distinct types on one record run independently (the routing gate
 * decides per pair; neither pair's evidence leaks to the other). Extractor
 * results are never deduplicated across sources: a naming and a
 * documentation match on one pair yield two signals, never one merged row.
 *
 * Evidence totality is the hard dependency: a record in `records` without
 * an evidence snapshot is an upstream bug and fails loud (the
 * `callerSignal` posture — never a silent skip, which would be a
 * Constitution Principle II silent false negative). A record ABSENT from
 * the effects map is benign no-pairs and still keys the output map (output
 * totality mirrors `detectEffects`' own over `records`).
 *
 * @param records The extraction records, any order; the output map keys
 * every record.
 * @param effects `detectEffects`' per-record effect map, consumed
 * read-only.
 * @param evidence `buildRecordEvidence`'s per-record snapshot map, keyed by
 * the same record references.
 * @returns The `ClassifiedEffects`: the four-key-ordered signal feed and
 * every record's effects rebuilt as new immutable values with
 * `classification` set (AP-004 — the detector's instances are never
 * mutated, every field preserved, input order preserved).
 * @throws Error when a record in `records` has no evidence snapshot, or
 * when an effect's type carries no pair classification (structurally
 * impossible — the pair loop keys every detected type).
 */
export function classifyPairs(
  records: readonly ExtractionRecord[],
  effects: ReadonlyMap<ExtractionRecord, readonly Effect[]>,
  evidence: ReadonlyMap<ExtractionRecord, RecordEvidence>,
): ClassifiedEffects {
  const feed: Signal[] = [];
  const classified = new Map<ExtractionRecord, readonly Effect[]>();
  for (const record of records) {
    const snapshot = evidence.get(record);
    if (snapshot === undefined) {
      throw new Error(
        `record "${record.name}" (${record.relPath}) has no evidence snapshot — buildRecordEvidence keys every record, so this is an upstream bug`,
      );
    }
    // The keyed-empty and absent spellings collapse here: a record the
    // detector left clean arrives as [], a record missing from the map as
    // undefined — both are no-pairs, never an error.
    const recordEffects = effects.get(record) ?? [];
    // Distinct canonical types in first-occurrence order (Set insertion
    // order) — the pair unit FR-008 names. Instance count is invisible to
    // the fan-out by construction.
    const pairTypes = new Set(recordEffects.map((effect) => effect.type));
    const pairClassifications = new Map<SideEffectType, Classification>();
    for (const effectType of pairTypes) {
      // FR-001's source order: interface, visibility, caller_count,
      // naming_convention, docstring. The feed is sorted before return, so
      // this order never reaches the output — it exists only to give the
      // pre-sort array one fixed shape.
      const extractorSignals = [
        interfaceSignal(snapshot, effectType),
        visibilitySignal(snapshot, effectType),
        callerSignal(
          snapshot.callerModuleCount,
          record.name,
          derivePackage(record.relPath),
          effectType,
        ),
        namingSignal(snapshot, effectType),
        docstringSignal(snapshot, effectType),
      ].filter((signal): signal is Signal => signal !== undefined);
      const bundle = classifyBundle(extractorSignals, effectType);
      feed.push(...bundle.signals);
      pairClassifications.set(effectType, bundle.classification);
    }
    // AP-004: rebuild, never mutate — new values, every field preserved,
    // input order preserved, the pair's classification attached to every
    // same-type instance identically.
    classified.set(
      record,
      recordEffects.map((effect) => {
        const classification = pairClassifications.get(effect.type);
        if (classification === undefined) {
          throw new Error(
            `effect type "${effect.type}" on record "${record.name}" has no pair classification — the pair loop keys every detected type, so this is an upstream bug`,
          );
        }
        return { ...effect, classification };
      }),
    );
  }
  // FR-014: the emitter owns the total order. Pair keying keeps the
  // four-key duplicate-free (one signal per source per pair), so this is a
  // strict total order with no tie-break rule.
  feed.sort(compareSignals);
  return { signals: feed, effects: classified };
}

/**
 * The `classify_signals` method's entry (FR-014; research R10, R11): the
 * serialized `Signal[]` payload — the raw evidence behind `analyze`'s
 * classifications, one row per rule that matched per (function record,
 * canonical effect type) pair — in FR-014's `(package, function,
 * side_effect_type, source)` total order, each row already wire-shaped
 * through `serializeSignal` (validated fields, omit-unset-optionals
 * `reasoning`). The returned array — not a `{"signals": [...]}` wrapper —
 * is the payload the server handler wraps into its JSON-RPC success
 * response, exactly as it wraps `analyze`'s array.
 *
 * The stages are `analyze`'s, identically and in the identical order
 * (FR-013's one-shared-pipeline guarantee is structural, never a second
 * walk): `prepareAnalysis` — the one discovery/bootstrap/extraction
 * pipeline, so the identical discovered, pattern-filtered,
 * exclusion-filtered file set and record set — then `detectEffects`, then
 * the T024 core with the program-mode context still live: the evidence
 * snapshots (`buildRecordEvidence`, caller index included) taken while the
 * checker can still answer, then `classifyPairs` — the pair-keyed fan-out
 * whose four-key-ordered `signals` feed is this entry's payload. The two
 * entries differ by the last stage only: assembly and
 * `serializeFunctionRecord` there, feed serialization here.
 *
 * The program-mode context's dispose lifetime is owned here exactly as
 * `analyze` owns its own (the same `finally` discipline): the native
 * compiler server behind the context is closed whatever the detection and
 * classification outcome, so no subprocess outlives one request. A
 * parse-only context owns nothing to dispose. `prepareAnalysis` itself
 * releases the context when extraction throws, and an invalid root throws
 * `InvalidRootPathError` before any context exists — it propagates
 * untouched for the server to map to the shared `-32602` root message.
 *
 * Deterministic (Constitution Principle I): the feed is a pure function of
 * the analyzed tree and analyzer version — fixed row order, fixed
 * reasoning templates, no timestamps or environment-dependent data — so
 * repeated requests over the same tree serialize byte-identically.
 *
 * @param rootPath Absolute or relative project root; validated and
 * realpath-resolved by `prepareAnalysis` (an invalid root throws
 * `InvalidRootPathError`, the server maps to `-32602`).
 * @param patterns The raw `patterns` parameter value; shape-validated by
 * the server (`-32602`) before analysis runs, normalized by
 * `prepareAnalysis`. A set matching nothing yields `[]`, never an error.
 * @param stderr Injected diagnostic sink (Testability principle); defaults
 * to `process.stderr`. Stdout is never touched.
 * @returns The serialized signals, `(package, function, side_effect_type,
 * source)`-sorted.
 * @throws InvalidRootPathError when the root does not exist, is not a
 * directory, or cannot be accessed; the server handler maps it to the
 * contract's `-32602` response.
 */
export async function classifySignals(
  rootPath: string,
  patterns: unknown,
  stderr: Writable = process.stderr,
): Promise<readonly Record<string, unknown>[]> {
  const prepared = await prepareAnalysis(rootPath, patterns, stderr);
  try {
    const effects = detectEffects(prepared.records, prepared.context);
    // The core's composition order (this module's header): evidence while
    // the program-mode context is live — the caller index's
    // `getSignatureUsage` traffic and every checker query ride it — then
    // the pair-keyed fan-out whose four-key-ordered feed is the payload.
    const evidence = buildRecordEvidence(
      prepared.context,
      prepared.records,
      prepared.inScopePaths,
    );
    const classified = classifyPairs(prepared.records, effects, evidence);
    return classified.signals.map(serializeSignal);
  } finally {
    if (prepared.context.mode === "program") {
      prepared.context.dispose();
    }
  }
}
