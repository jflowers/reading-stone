/**
 * Adapter fan-out, contradiction, and formula conformance suite (T016,
 * FR-008 through FR-011; research R8, R9, R13; data-model.md Sections 4,
 * 5.4, 7, 8).
 *
 * src/signals/adapter.ts (T024) is the shared core both `analyze` (T025) and
 * the `classify_signals` entry (T029) consume. This suite pins its three
 * responsibilities over the evidence seam (research R12) — the same seam
 * every sibling extractor suite tests through, so the whole suite runs on
 * hand-built snapshots with no tree, no tsconfig, and no checker:
 *
 * - **Fan-out (FR-008)**: the five extractors run once per (function
 *   record, canonical effect type) PAIR, never per effect instance.
 *   Same-type instances share identical signals and identical
 *   classifications; distinct types on one record run per type; zero
 *   effects yield zero signals; extractor results are never deduplicated
 *   across sources.
 * - **Contradiction (FR-011)**: a pair whose extractor signals mix at
 *   least one positive and at least one negative weight gets exactly ONE
 *   synthesized row — source `contradiction`, weight −20, the standard
 *   identity fields, fixed-template reasoning — applied exactly once.
 * - **Formula (FR-009/FR-010)**: `clamp(0, 100, 50 + tierBoost +
 *   Σ(extractor weights) − (contradiction ? 20 : 0))` with `tierBoost`
 *   read from `TIER_MAP` (P0 → +25, P1 → +10, P2/P3/P4 → +0 — the
 *   taxonomy is the single tier authority, never a second tier table);
 *   labels contractual ≥ 80, ambiguous [50, 80), incidental < 50.
 *
 * RED-FIRST: this suite was written and observed failing before
 * src/signals/adapter.ts existed (the module-resolution failure is the red
 * observation), per the task-pairing discipline in tasks.md. Because T016
 * lands before T024, the suite also DEFINES the module's export surface:
 *
 * - `classifyBundle(extractorSignals, effectType)` — the per-pair core.
 *   Takes the pair's already-extracted signals plus the pair's canonical
 *   effect type (the `TIER_MAP` key; the empty-signals floor makes the
 *   type parameter structural — there is no signal to read it from) and
 *   returns the `SignalBundle`: the pair's wire rows in source-codepoint
 *   order (contradiction row included when it fires) plus the formula's
 *   `Classification`.
 * - `classifyPairs(records, effects, evidence)` — the fan-out. Takes the
 *   extraction records, `detectEffects`' per-record effect map, and the
 *   per-record evidence snapshots; returns the `ClassifiedEffects`: the
 *   full `(package, function, side_effect_type, source)`-ordered signal
 *   feed and every record's effects rebuilt as new immutable values with
 *   `classification` set (rebuild, never mutation — convention pack
 *   AP-004). The evidence map is the adapter's hard dependency: a record
 *   without a snapshot fails loud (`buildRecordEvidence` keys every
 *   record, so a miss is an upstream bug), while a record absent from
 *   the effects map is benign no-pairs (the `?? []` default
 *   `detectEffects` itself uses internally).
 *
 * Scenario coverage (spec.md FR-008–FR-011; SC-001, SC-003; quickstart.md
 * Sections 4–5):
 *
 * - The quickstart profile arithmetic through real extractor composition:
 *   getTotal 85 contractual, logMessage 25 incidental (all-negative, no
 *   contradiction), writeBanner 25 incidental (contradiction fires once,
 *   three-row wire set), tweak 75 ambiguous (the P0 floor).
 * - The SC-001 label boundaries as exact fixtures: 80 → contractual,
 *   79 → ambiguous, 50 → ambiguous, 49 → incidental.
 * - The SC-003 tier arithmetic: the ambiguous floor 75/60/50/50/50 across
 *   P0–P4, and identical profiles offset exactly +25/+10/+0 across tiers.
 * - Clamping at both bounds: 129 raw → 100 through real extractors, and
 *   the seam-unreachable lower bound (raw < 0 is arithmetically
 *   impossible through real extractors — the minimum realizable raw is
 *   10) reached through `classifyBundle` with synthetic out-of-set
 *   weights, the same pinned-guard discipline as visibility's
 *   seam-unreachable all-three row.
 * - The FR-011 sum-invariant as the consumer reproduces it: for every
 *   pair, `clamp(0, 100, 50 + tierBoost + Σ(all emitted weights for the
 *   pair, contradiction row included))` equals the reported confidence.
 *   (The `−Σ` spellings in data-model.md Section 8 and quickstart.md
 *   Section 5's closing note are editing artifacts; the normative
 *   arithmetic is Section 4's formula and the walkthrough table —
 *   `50+25+10 = 85` — which this suite pins.)
 * - FR-014 ordering: the feed sorted by the four-key codepoint
 *   comparison, duplicate-free by pair keying — a strict total order with
 *   no tie-break rule.
 *
 * Every expected weight, confidence, and reasoning string is a pinned
 * literal, never computed — a drift from data-model.md Section 7 or the
 * extractors' fixed templates is a bug (Constitution Principle I).
 */

import type { Node } from "typescript/unstable/ast";
import { describe, expect, it } from "vitest";
import type { ExtractionRecord } from "../../src/extract.js";
import { derivePackage, type Effect } from "../../src/models.js";
import {
  type ClassifiedEffects,
  classifyBundle,
  classifyPairs,
  type SignalBundle,
} from "../../src/signals/adapter.js";
import type { RecordEvidence } from "../../src/signals/evidence.js";
import {
  type Signal,
  type SignalSource,
  serializeSignal,
} from "../../src/signals/types.js";
import {
  SIDE_EFFECT_TYPES,
  type SideEffectType,
  TIER_MAP,
  type Tier,
} from "../../src/taxonomy.js";

// ---------------------------------------------------------------------------
// Pinned tables — deliberately local to this suite, never imported from the
// module under test: the adapter must read TIER_MAP, and these literals are
// the independent second copy the arithmetic is diffed against (the same
// posture as the routing suite's doc-parity diff).
// ---------------------------------------------------------------------------

/**
 * The tier boosts (data-model.md Section 4; SC-003) — this suite's own
 * pinned copy of the P0 → +25, P1 → +10, P2/P3/P4 → +0 table. The adapter
 * reads `TIER_MAP` for the tier and these literals for the boost, so a
 * second tier table inside the adapter that drifted from either fails the
 * exhaustive floor test below.
 */
const TIER_BOOST: Readonly<Record<Tier, number>> = {
  P0: 25,
  P1: 10,
  P2: 0,
  P3: 0,
  P4: 0,
};

/** The three protocol labels (src/models.ts `Classification.label`). */
type ClassificationLabel = "contractual" | "incidental" | "ambiguous";

/**
 * The label boundaries (data-model.md Section 4): contractual ≥ 80,
 * ambiguous [50, 80), incidental < 50 — inclusive at 80, exclusive at 50.
 *
 * @param confidence The clamped confidence percentage.
 * @returns The label the formula assigns to that confidence.
 */
function labelForConfidence(confidence: number): ClassificationLabel {
  if (confidence >= 80) {
    return "contractual";
  }
  return confidence >= 50 ? "ambiguous" : "incidental";
}

// ---------------------------------------------------------------------------
// Hand-built records, snapshots, and effects — the seam fixtures every
// sibling extractor suite established (research R12), reused here so the
// adapter is tested as the pure function of (records, effects, evidence)
// it is.
// ---------------------------------------------------------------------------

/**
 * Builds the hand-built rule-table record: the adapter reads only the
 * identity fields (`name`, `relPath`), so the live compiler views (`node`,
 * `scopeChain`) are inert filler — the same localized cast the sibling
 * suites document.
 *
 * @param name The record's unqualified name — the signals' `function`.
 * @param relPath The record's root-relative path — the signals' `package`
 * source.
 * @returns A minimal extraction record carrying the identity fields.
 */
function recordOf(name: string, relPath: string): ExtractionRecord {
  return {
    name,
    relPath,
    line: 1,
    node: undefined as unknown as Node,
    scopeChain: [],
    deferred: false,
  };
}

/**
 * Builds a hand-built evidence snapshot: every component at its neutral
 * value except the overrides under test. Fixture names are chosen to be
 * prefix-free (no closed-list prefix matches their leading characters), so
 * a neutral snapshot emits no naming signal and the fixture's overrides
 * are the pair's entire signal profile.
 *
 * @param record The record the snapshot describes.
 * @param overrides The components under test; every other field is neutral.
 * @returns A complete evidence snapshot.
 */
function snapshotOf(
  record: ExtractionRecord,
  overrides: Partial<Omit<RecordEvidence, "record">> = {},
): RecordEvidence {
  return {
    record,
    exportedFunction: false,
    exportedReturnType: false,
    exportedReceiver: false,
    docText: "",
    docTags: [],
    interfaceMember: false,
    callerModuleCount: 0,
    ...overrides,
  };
}

/**
 * Builds a hand-detected effect — the shape `detectEffects` attributes to a
 * record, before any classification exists on it.
 *
 * @param type The effect's canonical type.
 * @param description The effect's human-readable description.
 * @param location Optional `"file:line:col"` location.
 * @returns A minimal unclassified effect.
 */
function detectedEffect(
  type: SideEffectType,
  description: string,
  location?: string,
): Effect {
  return location === undefined
    ? { type, description }
    : { type, description, location };
}

/**
 * Builds a hand signal for `classifyBundle`'s per-pair core tests: standard
 * identity fields, the given source and weight, no reasoning. The clamp
 * rows deliberately pass weights OUTSIDE the closed weight set (e.g. ±60) —
 * raw scores past the bounds are unreachable through real extractors (the
 * minimum realizable raw is 10), so the lower clamp is pinned at the seam
 * exactly like visibility's seam-unreachable all-three row.
 *
 * @param source The signal's rule family.
 * @param weight The signed integer weight — any integer, including
 * out-of-set values for the clamp rows.
 * @param effectType The pair's canonical effect type; defaults to the
 * writeBanner identity's StdoutWrite.
 * @returns A minimal extractor-shaped signal.
 */
function handSignal(
  source: SignalSource,
  weight: number,
  effectType: SideEffectType = "StdoutWrite",
): Signal {
  return {
    function: "writeBanner",
    package: "src.banner",
    side_effect_type: effectType,
    source,
    weight,
  };
}

// ---------------------------------------------------------------------------
// Run plumbing: fixtures in, ClassifiedEffects out.
// ---------------------------------------------------------------------------

/** One hand-built function record with its effects and evidence overrides. */
interface Fixture {
  /** The record's unqualified name — prefix-free unless the test wants naming. */
  readonly name: string;
  /** The record's root-relative path. */
  readonly relPath: string;
  /** The record's detected effects — the shapes `detectEffects` emits. */
  readonly effects: readonly Effect[];
  /** Evidence overrides; every other component rides at neutral values. */
  readonly overrides?: Partial<Omit<RecordEvidence, "record">>;
}

/** One run's surfaces: the adapter result plus the inputs it consumed. */
interface AdapterRun {
  /** The `classifyPairs` result — the feed and the classified effects. */
  readonly result: ClassifiedEffects;
  /** The run's records, in fixture order. */
  readonly records: readonly ExtractionRecord[];
  /** The input effects map — kept so non-mutation is assertable. */
  readonly inputs: ReadonlyMap<ExtractionRecord, readonly Effect[]>;
}

/**
 * Runs `classifyPairs` over hand-built fixtures: one record, one effects
 * entry, and one evidence snapshot per fixture, exactly the shapes
 * `detectEffects` and `buildRecordEvidence` produce for the same records.
 *
 * @param fixtures The run's records with their effects and overrides.
 * @returns The adapter result plus the records and input effects.
 */
function runFixtures(fixtures: readonly Fixture[]): AdapterRun {
  const records: ExtractionRecord[] = [];
  const effects = new Map<ExtractionRecord, readonly Effect[]>();
  const evidence = new Map<ExtractionRecord, RecordEvidence>();
  for (const fixture of fixtures) {
    const record = recordOf(fixture.name, fixture.relPath);
    records.push(record);
    effects.set(record, fixture.effects);
    evidence.set(record, snapshotOf(record, fixture.overrides));
  }
  return {
    result: classifyPairs(records, effects, evidence),
    records,
    inputs: effects,
  };
}

/**
 * The single-record lookup: a fixture name must identify exactly one
 * record. The throw-based guard surfaces fixture drift (a second
 * same-named record) as a loud failure, not silent misaddressing.
 *
 * @param run The run to look up in.
 * @param name The record's unqualified name.
 * @returns The unique record carrying that name.
 */
function recordOfRun(run: AdapterRun, name: string): ExtractionRecord {
  const matches = run.records.filter((record) => record.name === name);
  if (matches.length !== 1) {
    throw new Error(
      `expected exactly one record named "${name}" in the run, found ${matches.length}`,
    );
  }
  return matches[0];
}

/**
 * The record's classified effects — the output map must key every record
 * (output totality mirrors `detectEffects`' own totality over `records`).
 *
 * @param run The run to read.
 * @param name The record's unqualified name.
 * @returns The record's effects, rebuilt with classification attached.
 */
function classifiedOf(run: AdapterRun, name: string): readonly Effect[] {
  const record = recordOfRun(run, name);
  const effects = run.result.effects.get(record);
  if (effects === undefined) {
    throw new Error(
      `record "${name}" has no classified-effects entry — output totality violated`,
    );
  }
  return effects;
}

/**
 * The pair's wire rows from the feed: the signals whose identity matches
 * the record and the canonical effect type — exactly the rows a Gaze
 * consumer matches to the effect (FR-011's consumer-side join).
 *
 * @param run The run to read.
 * @param name The record's unqualified name.
 * @param effectType The pair's canonical effect type.
 * @returns The pair's emitted signals, in feed order.
 */
function signalsOfPair(
  run: AdapterRun,
  name: string,
  effectType: SideEffectType,
): readonly Signal[] {
  const record = recordOfRun(run, name);
  return run.result.signals.filter(
    (signal) =>
      signal.function === record.name &&
      signal.package === derivePackage(record.relPath) &&
      signal.side_effect_type === effectType,
  );
}

/**
 * Asserts the FR-011 sum-invariant for every effect in the run, the way a
 * consumer reproduces it: sum ALL weights the feed attributes to the
 * effect's pair (the contradiction row included — it is the separate −20
 * term applied exactly once), add 50 and the tier boost, clamp, and the
 * result equals the reported confidence and label.
 *
 * The `−Σ` spellings in data-model.md Section 8 and quickstart.md
 * Section 5's closing note are editing artifacts of the
 * `−(contradiction ? 20 : 0)` term; the normative arithmetic is Section
 * 4's formula and the walkthrough table (`50+25+10 = 85`), which this
 * assertion pins.
 *
 * @param run The run to verify — every record, every effect.
 */
function expectSumInvariant(run: AdapterRun): void {
  for (const record of run.records) {
    const effects = run.result.effects.get(record);
    if (effects === undefined) {
      throw new Error(
        `record "${record.name}" has no classified-effects entry — output totality violated`,
      );
    }
    for (const effect of effects) {
      const pairSignals = run.result.signals.filter(
        (signal) =>
          signal.function === record.name &&
          signal.package === derivePackage(record.relPath) &&
          signal.side_effect_type === effect.type,
      );
      const sum = pairSignals.reduce((total, signal) => total + signal.weight, 0);
      const expected = Math.max(
        0,
        Math.min(100, 50 + TIER_BOOST[TIER_MAP[effect.type]] + sum),
      );
      const classification = effect.classification;
      if (classification === undefined) {
        throw new Error(`effect of "${record.name}" carries no classification`);
      }
      expect(classification.confidence).toBe(expected);
      expect(classification.label).toBe(labelForConfidence(expected));
    }
  }
}

/** The FR-014 ordering key: (package, function, type, source). */
type SignalKey = readonly [string, string, string, string];

/**
 * Extracts a signal's ordering key.
 *
 * @param signal The signal to key.
 * @returns The four-field comparison key.
 */
function keyOf(signal: Signal): SignalKey {
  return [signal.package, signal.function, signal.side_effect_type, signal.source];
}

/**
 * Compares two ordering keys field by field — plain string comparison,
 * which for these ASCII fields IS codepoint comparison (never
 * `localeCompare`, whose collation is locale-dependent and would break
 * determinism).
 *
 * @param a The left key.
 * @param b The right key.
 * @returns Negative when `a` sorts first, positive when `b` does, zero on
 * exact equality.
 */
function compareKeys(a: SignalKey, b: SignalKey): number {
  for (let index = 0; index < 4; index++) {
    if (a[index] < b[index]) {
      return -1;
    }
    if (a[index] > b[index]) {
      return 1;
    }
  }
  return 0;
}

// ---------------------------------------------------------------------------
// The shared runs — each builder returns fresh objects so tests are
// independent and non-mutation assertions have untouched inputs to check.
// ---------------------------------------------------------------------------

/**
 * The quickstart tree's four canonical profile pairs (quickstart.md
 * Sections 4–5): getTotal's naming-only 85, logMessage's all-negative 25,
 * writeBanner's contradiction 25, and tweak's P0 floor 75 — the first six
 * rows of the quickstart's 11-signal feed, mirrored exactly.
 */
function profileRun(): AdapterRun {
  return runFixtures([
    {
      name: "getTotal",
      relPath: "src/calc.ts",
      effects: [detectedEffect("ReturnValue", "returns the total")],
    },
    {
      name: "logMessage",
      relPath: "src/noise.ts",
      effects: [detectedEffect("LogWrite", "logs the message")],
      overrides: { docText: "Logs the message for debugging." },
    },
    {
      name: "writeBanner",
      relPath: "src/banner.ts",
      effects: [detectedEffect("StdoutWrite", "writes the banner")],
      overrides: { docText: "Logs the banner to stdout." },
    },
    {
      name: "tweak",
      relPath: "src/quiet.ts",
      effects: [
        detectedEffect("PointerArgMutation", "mutates the pointed-to argument"),
      ],
    },
  ]);
}

/**
 * The SC-001 label boundaries as exact fixtures (data-model.md Section 4):
 * sumOf 80 (contractual, inclusive), yieldItems 79 (ambiguous), plainEmit
 * 50 (ambiguous, inclusive), writeReport 49 (incidental) — writeReport
 * carrying four extractor sources plus the contradiction, the widest
 * single-pair profile in the suite.
 */
function boundaryRun(): AdapterRun {
  return runFixtures([
    {
      name: "sumOf",
      relPath: "src/bound80.ts",
      effects: [detectedEffect("ReturnValue", "returns the sum")],
      overrides: { docText: "Returns the sum." },
    },
    {
      name: "yieldItems",
      relPath: "src/bound79.ts",
      effects: [detectedEffect("GeneratorYield", "yields the items")],
      overrides: {
        exportedFunction: true,
        exportedReturnType: true,
        docText: "Returns the items.",
      },
    },
    {
      name: "plainEmit",
      relPath: "src/bound50.ts",
      effects: [detectedEffect("LogWrite", "logs the event")],
    },
    {
      name: "writeReport",
      relPath: "src/bound49.ts",
      effects: [detectedEffect("StdoutWrite", "writes the report")],
      overrides: {
        exportedFunction: true,
        exportedReturnType: true,
        callerModuleCount: 3,
        docText: "Logs the report.",
      },
    },
  ]);
}

/**
 * The quickstart's interface boundary (quickstart.md Section 5): handle on
 * StdoutWrite — `interfaceMember` +30 alone reaches exactly 80
 * contractual, and the name's `Handle` prefix is routed away from
 * StdoutWrite (the quickstart's own routing-gate note), so no naming
 * signal fires at all.
 */
function handleRun(): AdapterRun {
  return runFixtures([
    {
      name: "handle",
      relPath: "src/print.ts",
      effects: [detectedEffect("StdoutWrite", "handles the print job")],
      overrides: { interfaceMember: true },
    },
  ]);
}

/**
 * The SC-003 ambiguous floor across all five tiers: neutral snapshots on
 * one P0, P1, P2, P3, and P4 type — 75/60/50/50/50, every label
 * ambiguous (a pair with no signals never leaves the ambiguous band).
 */
function floorRun(): AdapterRun {
  return runFixtures([
    {
      name: "floorP0",
      relPath: "src/floor0.ts",
      effects: [detectedEffect("ReturnValue", "returns a value")],
    },
    {
      name: "floorP1",
      relPath: "src/floor1.ts",
      effects: [detectedEffect("GeneratorYield", "yields a value")],
    },
    {
      name: "floorP2",
      relPath: "src/floor2.ts",
      effects: [detectedEffect("LogWrite", "logs a line")],
    },
    {
      name: "floorP3",
      relPath: "src/floor3.ts",
      effects: [detectedEffect("StdoutWrite", "writes a line")],
    },
    {
      name: "floorP4",
      relPath: "src/floor4.ts",
      effects: [detectedEffect("SyncPoolOp", "pools a value")],
    },
  ]);
}

/**
 * The SC-003 tier offsets: an IDENTICAL signal profile (exported function,
 * visibility +8) on a P0, a P1, and a P2 effect — exactly the +25/+10/+0
 * offsets, 83/68/58.
 */
function offsetRun(): AdapterRun {
  return runFixtures([
    {
      name: "offsetP0",
      relPath: "src/off0.ts",
      effects: [detectedEffect("ReturnValue", "returns a value")],
      overrides: { exportedFunction: true },
    },
    {
      name: "offsetP1",
      relPath: "src/off1.ts",
      effects: [detectedEffect("GeneratorYield", "yields a value")],
      overrides: { exportedFunction: true },
    },
    {
      name: "offsetP2",
      relPath: "src/off2.ts",
      effects: [detectedEffect("LogWrite", "logs a line")],
      overrides: { exportedFunction: true },
    },
  ]);
}

/**
 * The upper clamp through real extractors (FR-009): getPeak stacks
 * visibility +14, naming +10, a direct `@returns` tag +15, and a 4-module
 * caller count +15 on a P0 pair — raw 129, clamped to exactly 100. Four
 * distinct sources on one pair also pins the no-dedup rule.
 */
function clampHighRun(): AdapterRun {
  return runFixtures([
    {
      name: "getPeak",
      relPath: "src/high.ts",
      effects: [detectedEffect("ReturnValue", "returns the peak")],
      overrides: {
        exportedFunction: true,
        exportedReturnType: true,
        docTags: [{ tag: "returns", text: "" }],
        callerModuleCount: 4,
      },
    },
  ]);
}

/**
 * The FR-014 ordering fixture: five records chosen so the four-key
 * codepoint comparison is exercised on every field — `src.A` before
 * `src.a` (case-sensitive package order), `WriteCheck` before
 * `writeBanner` (case-sensitive function order), multiFn's LogWrite pair
 * before its ReturnValue pair (type order within a record), and
 * writeBanner's contradiction before docstring before naming_convention
 * (source order within a pair).
 */
function orderingRun(): AdapterRun {
  return runFixtures([
    {
      name: "zebraFn",
      relPath: "src/A.ts",
      effects: [detectedEffect("ReturnValue", "returns a value")],
      overrides: { exportedFunction: true },
    },
    {
      name: "appleFn",
      relPath: "src/a.ts",
      effects: [detectedEffect("LogWrite", "logs it")],
      overrides: { docText: "logs it" },
    },
    {
      name: "multiFn",
      relPath: "src/multi.ts",
      effects: [
        detectedEffect("ReturnValue", "returns a value"),
        detectedEffect("LogWrite", "logs a line"),
      ],
      overrides: { exportedFunction: true },
    },
    {
      name: "WriteCheck",
      relPath: "src/order.ts",
      effects: [detectedEffect("StdoutWrite", "writes the check")],
    },
    {
      name: "writeBanner",
      relPath: "src/order.ts",
      effects: [detectedEffect("StdoutWrite", "writes the banner")],
      overrides: { docText: "Logs the banner to stdout." },
    },
  ]);
}

/**
 * The same-type fan-out fixture (FR-008): emitAll carries TWO StdoutWrite
 * instances with distinct descriptions, locations, and optional fields —
 * one pair run, one visibility row, both instances classified identically.
 * The second instance carries `target` and `detail` so field preservation
 * is pinned on the full effect shape, not just the required fields.
 */
function fanoutRun(): AdapterRun {
  return runFixtures([
    {
      name: "emitAll",
      relPath: "src/emit.ts",
      effects: [
        {
          type: "StdoutWrite",
          description: "writes the first line of the banner",
          location: "src/emit.ts:3:9",
        },
        {
          type: "StdoutWrite",
          description: "writes the second line of the banner",
          location: "src/emit.ts:4:9",
          target: "stdout",
          detail: { stream: 1 },
        },
      ],
      overrides: { exportedFunction: true },
    },
  ]);
}

/**
 * The distinct-type fan-out fixture (FR-008): one getTotal record carrying
 * a ReturnValue and a LogWrite effect — the `Get` prefix routes to
 * ReturnValue only, so the two pairs diverge (85 contractual vs the 50
 * ambiguous floor) from one name and one snapshot.
 */
function mixedTypesRun(): AdapterRun {
  return runFixtures([
    {
      name: "getTotal",
      relPath: "src/mixed.ts",
      effects: [
        detectedEffect("ReturnValue", "returns the total"),
        detectedEffect("LogWrite", "logs the total"),
      ],
    },
  ]);
}

// ---------------------------------------------------------------------------
// classifyBundle — the per-pair core.
// ---------------------------------------------------------------------------

describe("classifyBundle — the per-pair core (FR-011; data-model.md Sections 4, 5.4)", () => {
  it("classifies the empty bundle at the tier floor for all 48 types — TIER_MAP is the single tier authority", () => {
    // The exhaustive tier-authority pin: for every canonical type, a pair
    // with no signals yields exactly 50 + this suite's own pinned boost
    // (75/60/50/50/50 by tier), label ambiguous. The adapter reads TIER_MAP
    // for the tier; if it carried a second tier table that drifted from
    // either the taxonomy or these literals, one of the 48 rows fails here.
    for (const type of SIDE_EFFECT_TYPES) {
      const bundle: SignalBundle = classifyBundle([], type);
      expect(bundle.signals).toEqual([]);
      expect(bundle.classification).toEqual({
        label: "ambiguous",
        confidence: 50 + TIER_BOOST[TIER_MAP[type]],
      });
    }
  });

  it("passes single-polarity extractor signals through unchanged — no contradiction", () => {
    // All-positive evidence: the bundle's rows are the extractor rows (in
    // source order — naming_convention sorts before visibility) and the
    // formula sums them without any synthesized term: 50+25+10+8 = 93,
    // the quickstart formatLabel total via a different source pair.
    const bundle = classifyBundle(
      [
        handSignal("naming_convention", 10, "ReturnValue"),
        handSignal("visibility", 8, "ReturnValue"),
      ],
      "ReturnValue",
    );
    expect(bundle.signals).toEqual([
      {
        function: "writeBanner",
        package: "src.banner",
        side_effect_type: "ReturnValue",
        source: "naming_convention",
        weight: 10,
      },
      {
        function: "writeBanner",
        package: "src.banner",
        side_effect_type: "ReturnValue",
        source: "visibility",
        weight: 8,
      },
    ]);
    expect(bundle.classification).toEqual({ label: "contractual", confidence: 93 });
  });

  it("synthesizes exactly one contradiction row for mixed polarity — the writeBanner arithmetic", () => {
    // One positive and one negative extractor signal fire the synthesis:
    // exactly one additional row — source `contradiction`, weight −20, the
    // pair's identity fields, fixed-template reasoning — sorted into source
    // order ahead of docstring and naming_convention. The formula applies
    // the −20 exactly once: 50+0+10−15−20 = 25 incidental.
    const bundle = classifyBundle(
      [handSignal("naming_convention", 10), handSignal("docstring", -15)],
      "StdoutWrite",
    );
    expect(bundle.signals).toEqual([
      {
        function: "writeBanner",
        package: "src.banner",
        side_effect_type: "StdoutWrite",
        source: "contradiction",
        weight: -20,
        reasoning: "mixed-polarity evidence: positive and negative signals",
      },
      {
        function: "writeBanner",
        package: "src.banner",
        side_effect_type: "StdoutWrite",
        source: "docstring",
        weight: -15,
      },
      {
        function: "writeBanner",
        package: "src.banner",
        side_effect_type: "StdoutWrite",
        source: "naming_convention",
        weight: 10,
      },
    ]);
    expect(bundle.classification).toEqual({ label: "incidental", confidence: 25 });
  });

  it("applies the −20 exactly once however many positives and negatives mix", () => {
    // Two negatives and one positive still produce ONE −20 row — the
    // contradiction is a property of the pair (mixed polarity), not a
    // per-signal penalty: 50+0+8−15−10−20 = 13 incidental.
    const bundle = classifyBundle(
      [
        handSignal("visibility", 8),
        handSignal("docstring", -15),
        handSignal("naming_convention", -10),
      ],
      "StdoutWrite",
    );
    const contradictions = bundle.signals.filter(
      (signal) => signal.source === "contradiction",
    );
    expect(contradictions).toEqual([
      {
        function: "writeBanner",
        package: "src.banner",
        side_effect_type: "StdoutWrite",
        source: "contradiction",
        weight: -20,
        reasoning: "mixed-polarity evidence: positive and negative signals",
      },
    ]);
    expect(bundle.signals.length).toBe(4);
    expect(bundle.classification).toEqual({ label: "incidental", confidence: 13 });
  });

  it("emits no contradiction for all-negative evidence — the logMessage polarity", () => {
    // Negative evidence alone is agreement about incidentalness, not a
    // contradiction: the bundle carries only the two extractor rows and
    // the formula sums them — 50−10−15 = 25 incidental, the quickstart's
    // logMessage arithmetic.
    const bundle = classifyBundle(
      [
        handSignal("docstring", -15, "LogWrite"),
        handSignal("naming_convention", -10, "LogWrite"),
      ],
      "LogWrite",
    );
    expect(bundle.signals).toEqual([
      {
        function: "writeBanner",
        package: "src.banner",
        side_effect_type: "LogWrite",
        source: "docstring",
        weight: -15,
      },
      {
        function: "writeBanner",
        package: "src.banner",
        side_effect_type: "LogWrite",
        source: "naming_convention",
        weight: -10,
      },
    ]);
    expect(bundle.classification).toEqual({ label: "incidental", confidence: 25 });
  });

  it("clamps a raw score above 100 to exactly 100", () => {
    // The synthetic upper bound: a +60 weight (out of the closed set,
    // deliberately — see handSignal) on a P0 pair gives raw 135, and the
    // bundle reports exactly 100 contractual, never 135.
    const bundle = classifyBundle(
      [handSignal("visibility", 60, "ReturnValue")],
      "ReturnValue",
    );
    expect(bundle.classification).toEqual({ label: "contractual", confidence: 100 });
  });

  it("clamps a raw score below 0 to exactly 0 — and a lone negative is not a contradiction", () => {
    // The synthetic lower bound: raw scores below 0 are unreachable
    // through real extractors (the minimum realizable raw is 10), so the
    // seam owns this row — a −60 weight on a P2 pair gives raw −10,
    // reported as exactly 0 incidental. The single negative weight also
    // pins that contradiction requires BOTH polarities: one row, no
    // synthesis.
    const bundle = classifyBundle(
      [handSignal("docstring", -60, "LogWrite")],
      "LogWrite",
    );
    expect(bundle.signals).toEqual([
      {
        function: "writeBanner",
        package: "src.banner",
        side_effect_type: "LogWrite",
        source: "docstring",
        weight: -60,
      },
    ]);
    expect(bundle.classification).toEqual({ label: "incidental", confidence: 0 });
  });

  it("emits a wire-valid contradiction row — serializeSignal round-trip (FR-001)", () => {
    // The synthesized row must clear the same fail-loud wire gate as every
    // extractor row: closed source set, canonical type, integer weight,
    // non-empty reasoning.
    const bundle = classifyBundle(
      [handSignal("naming_convention", 10), handSignal("docstring", -15)],
      "StdoutWrite",
    );
    const contradiction = bundle.signals[0];
    if (contradiction === undefined || contradiction.source !== "contradiction") {
      throw new Error("the contradiction row must lead this pair's source order");
    }
    expect(serializeSignal(contradiction)).toEqual({
      function: "writeBanner",
      package: "src.banner",
      side_effect_type: "StdoutWrite",
      source: "contradiction",
      weight: -20,
      reasoning: "mixed-polarity evidence: positive and negative signals",
    });
  });
});

// ---------------------------------------------------------------------------
// classifyPairs — fan-out and pair keying.
// ---------------------------------------------------------------------------

describe("classifyPairs — fan-out and pair keying (FR-008; research R8)", () => {
  it("runs the extractors once per (record, effect type) pair — never per effect instance", () => {
    // emitAll's two StdoutWrite instances are ONE pair: exactly one
    // visibility row in the whole feed, from one extractor run over one
    // snapshot — the fan-out counts distinct canonical types, not
    // instances.
    const run = fanoutRun();
    const pairSignals = signalsOfPair(run, "emitAll", "StdoutWrite");
    expect(pairSignals).toEqual([
      {
        function: "emitAll",
        package: "src.emit",
        side_effect_type: "StdoutWrite",
        source: "visibility",
        weight: 8,
        reasoning: "exported API surface: exported function",
      },
    ]);
    expect(run.result.signals.length).toBe(1);
  });

  it("gives same-type effect instances the identical classification", () => {
    // Pair keying's downstream guarantee: both instances carry the pair's
    // one classification — same label, same confidence, value-equal —
    // never per-instance divergence.
    const run = fanoutRun();
    const classified = classifiedOf(run, "emitAll");
    expect(classified.length).toBe(2);
    expect(classified[0]?.classification).toEqual({
      label: "ambiguous",
      confidence: 58,
    });
    expect(classified[1]?.classification).toEqual({
      label: "ambiguous",
      confidence: 58,
    });
    expect(classified[0]?.classification).toEqual(classified[1]?.classification);
  });

  it("runs per DISTINCT canonical type — the routing gate decides per pair", () => {
    // One record, one name, one snapshot, two effect types: the `Get`
    // prefix is evidence for the ReturnValue pair only (the FR-007 gate),
    // so the pairs diverge — 85 contractual vs the 50 ambiguous floor.
    // Pair runs are independent; neither pair's evidence leaks to the
    // other.
    const run = mixedTypesRun();
    expect(signalsOfPair(run, "getTotal", "ReturnValue")).toEqual([
      {
        function: "getTotal",
        package: "src.mixed",
        side_effect_type: "ReturnValue",
        source: "naming_convention",
        weight: 10,
        reasoning: "name starts with the contractual prefix 'Get'",
      },
    ]);
    expect(signalsOfPair(run, "getTotal", "LogWrite")).toEqual([]);
    const classified = classifiedOf(run, "getTotal");
    expect(classified[0]?.classification).toEqual({
      label: "contractual",
      confidence: 85,
    });
    expect(classified[1]?.classification).toEqual({
      label: "ambiguous",
      confidence: 50,
    });
  });

  it("yields zero signals for a record with zero effects", () => {
    // The keyed-empty spelling: detectEffects keys every record, so a
    // clean record arrives as an empty array — no pairs, no rows, and the
    // output map still keys the record (totality).
    const keyed = runFixtures([
      {
        name: "quietWorker",
        relPath: "src/silent.ts",
        effects: [],
      },
    ]);
    expect(keyed.result.signals).toEqual([]);
    expect(classifiedOf(keyed, "quietWorker")).toEqual([]);

    // The absent spelling: a record missing from the effects map is benign
    // no-pairs (the `?? []` default detectEffects itself uses), never an
    // error — unlike a missing evidence snapshot, which fails loud below.
    const record = recordOf("absentWorker", "src/absent.ts");
    const evidence = new Map<ExtractionRecord, RecordEvidence>([
      [record, snapshotOf(record)],
    ]);
    const absent = classifyPairs([record], new Map(), evidence);
    expect(absent.signals).toEqual([]);
    expect(absent.effects.get(record)).toEqual([]);
  });

  it("yields the empty feed and empty map for an empty run", () => {
    // No records, no effects, no evidence: the empty analysis is the
    // empty success, never an error (FR-014's `{"signals": []}` stance).
    const result = classifyPairs([], new Map(), new Map());
    expect(result.signals).toEqual([]);
    expect(result.effects.size).toBe(0);
  });

  it("does not deduplicate extractor results across sources (FR-008)", () => {
    // getPeak's pair carries four extractor signals from four distinct
    // sources — visibility, naming, docstring, caller_count — and all four
    // reach the feed: a naming and a documentation match on one pair yield
    // two signals, never one merged row.
    const run = clampHighRun();
    const sources = signalsOfPair(run, "getPeak", "ReturnValue").map(
      (signal) => signal.source,
    );
    expect(sources).toEqual([
      "caller_count",
      "docstring",
      "naming_convention",
      "visibility",
    ]);
  });

  it("rebuilds classified effects — never mutates the detector's instances (AP-004)", () => {
    // The input effect instances are the detector's immutable values: the
    // adapter must leave them untouched (no classification glued on) and
    // emit NEW values preserving every field — required and optional alike
    // — with the classification attached.
    const run = fanoutRun();
    const inputEffects = run.inputs.get(recordOfRun(run, "emitAll"));
    const first = inputEffects?.[0];
    const second = inputEffects?.[1];
    if (first === undefined || second === undefined) {
      throw new Error("the fan-out fixture must carry two input effects");
    }
    expect(first.classification).toBeUndefined();
    expect(second.classification).toBeUndefined();
    const classified = classifiedOf(run, "emitAll");
    expect(classified[0]).not.toBe(first);
    expect(classified[1]).not.toBe(second);
    expect(classified[1]).toEqual({
      type: "StdoutWrite",
      description: "writes the second line of the banner",
      location: "src/emit.ts:4:9",
      target: "stdout",
      detail: { stream: 1 },
      classification: { label: "ambiguous", confidence: 58 },
    });
  });

  it("fails loud when a record has no evidence snapshot", () => {
    // Evidence totality is the adapter's hard dependency:
    // `buildRecordEvidence` keys every record it is given, so a record in
    // `records` without a snapshot is an upstream bug — fail loud (the
    // callerSignal posture), never silently skip the pair (a Principle II
    // silent false negative).
    const record = recordOf("orphan", "src/orphan.ts");
    const effects = new Map<ExtractionRecord, readonly Effect[]>([
      [record, [detectedEffect("ReturnValue", "returns a value")]],
    ]);
    expect(() => classifyPairs([record], effects, new Map())).toThrow(
      /no evidence snapshot/,
    );
  });
});

// ---------------------------------------------------------------------------
// The formula and labels over real extractor composition.
// ---------------------------------------------------------------------------

describe("the confidence formula and labels over real extractor arithmetic (FR-009/FR-010; SC-001/SC-003; quickstart.md Section 5)", () => {
  it("classifies the quickstart profile — 85/25/25/75 (SC-001)", () => {
    // The four canonical arithmetic shapes through real extractor
    // composition: naming-only 85 contractual, all-negative 25 incidental,
    // contradiction 25 incidental, and the P0 ambiguous floor 75.
    const run = profileRun();
    expect(classifiedOf(run, "getTotal")[0]?.classification).toEqual({
      label: "contractual",
      confidence: 85,
    });
    expect(classifiedOf(run, "logMessage")[0]?.classification).toEqual({
      label: "incidental",
      confidence: 25,
    });
    expect(classifiedOf(run, "writeBanner")[0]?.classification).toEqual({
      label: "incidental",
      confidence: 25,
    });
    expect(classifiedOf(run, "tweak")[0]?.classification).toEqual({
      label: "ambiguous",
      confidence: 75,
    });
    // Output totality: every record in `records` is keyed.
    expect(run.result.effects.size).toBe(4);
  });

  it("emits the profile's six wire rows — the quickstart feed's first six, verbatim (FR-014)", () => {
    // The full pinned shapes: every weight and reasoning string is a
    // literal, so a drift in any extractor template or the contradiction
    // template fails here (Constitution Principle I). The order is the
    // FR-014 four-key codepoint order, writeBanner's contradiction row
    // leading its pair.
    const run = profileRun();
    expect(run.result.signals).toEqual([
      {
        function: "writeBanner",
        package: "src.banner",
        side_effect_type: "StdoutWrite",
        source: "contradiction",
        weight: -20,
        reasoning: "mixed-polarity evidence: positive and negative signals",
      },
      {
        function: "writeBanner",
        package: "src.banner",
        side_effect_type: "StdoutWrite",
        source: "docstring",
        weight: -15,
        reasoning: "documented with the incidental verb 'logs'",
      },
      {
        function: "writeBanner",
        package: "src.banner",
        side_effect_type: "StdoutWrite",
        source: "naming_convention",
        weight: 10,
        reasoning: "name starts with the contractual prefix 'Write'",
      },
      {
        function: "getTotal",
        package: "src.calc",
        side_effect_type: "ReturnValue",
        source: "naming_convention",
        weight: 10,
        reasoning: "name starts with the contractual prefix 'Get'",
      },
      {
        function: "logMessage",
        package: "src.noise",
        side_effect_type: "LogWrite",
        source: "docstring",
        weight: -15,
        reasoning: "documented with the incidental verb 'logs'",
      },
      {
        function: "logMessage",
        package: "src.noise",
        side_effect_type: "LogWrite",
        source: "naming_convention",
        weight: -10,
        reasoning: "name starts with the incidental prefix 'log'",
      },
    ]);
  });

  it("pins the SC-001 label boundaries — 80 contractual, 79 ambiguous, 50 ambiguous, 49 incidental", () => {
    // Inclusive at 80, exclusive at 50 (data-model.md Section 4): four
    // fixtures engineered to land exactly on the boundary integers through
    // real extractor weights — sumOf 50+25+5, yieldItems 50+10+14+5,
    // plainEmit 50+0, writeReport 50+14+10+10−15−20.
    const run = boundaryRun();
    expect(classifiedOf(run, "sumOf")[0]?.classification).toEqual({
      label: "contractual",
      confidence: 80,
    });
    expect(classifiedOf(run, "yieldItems")[0]?.classification).toEqual({
      label: "ambiguous",
      confidence: 79,
    });
    expect(classifiedOf(run, "plainEmit")[0]?.classification).toEqual({
      label: "ambiguous",
      confidence: 50,
    });
    expect(classifiedOf(run, "writeReport")[0]?.classification).toEqual({
      label: "incidental",
      confidence: 49,
    });
  });

  it("emits the boundary pairs' wire rows — writeReport's five-source pair in source order", () => {
    // writeReport is the suite's widest pair: four extractor sources plus
    // the contradiction, with caller_count sorting BEFORE contradiction —
    // the codepoint order of the source strings, not a fixed
    // contradiction-first rule. sumOf and yieldItems pin the positive
    // boundary rows' full shapes.
    const run = boundaryRun();
    expect(signalsOfPair(run, "sumOf", "ReturnValue")).toEqual([
      {
        function: "sumOf",
        package: "src.bound80",
        side_effect_type: "ReturnValue",
        source: "docstring",
        weight: 5,
        reasoning: "documented with the indirect verb 'returns'",
      },
    ]);
    expect(signalsOfPair(run, "yieldItems", "GeneratorYield")).toEqual([
      {
        function: "yieldItems",
        package: "src.bound79",
        side_effect_type: "GeneratorYield",
        source: "docstring",
        weight: 5,
        reasoning: "documented with the indirect verb 'returns'",
      },
      {
        function: "yieldItems",
        package: "src.bound79",
        side_effect_type: "GeneratorYield",
        source: "visibility",
        weight: 14,
        reasoning: "exported API surface: exported function, exported return type",
      },
    ]);
    expect(signalsOfPair(run, "plainEmit", "LogWrite")).toEqual([]);
    expect(signalsOfPair(run, "writeReport", "StdoutWrite")).toEqual([
      {
        function: "writeReport",
        package: "src.bound49",
        side_effect_type: "StdoutWrite",
        source: "caller_count",
        weight: 10,
        reasoning: "called from 3 distinct in-scope modules",
      },
      {
        function: "writeReport",
        package: "src.bound49",
        side_effect_type: "StdoutWrite",
        source: "contradiction",
        weight: -20,
        reasoning: "mixed-polarity evidence: positive and negative signals",
      },
      {
        function: "writeReport",
        package: "src.bound49",
        side_effect_type: "StdoutWrite",
        source: "docstring",
        weight: -15,
        reasoning: "documented with the incidental verb 'logs'",
      },
      {
        function: "writeReport",
        package: "src.bound49",
        side_effect_type: "StdoutWrite",
        source: "naming_convention",
        weight: 10,
        reasoning: "name starts with the contractual prefix 'Write'",
      },
      {
        function: "writeReport",
        package: "src.bound49",
        side_effect_type: "StdoutWrite",
        source: "visibility",
        weight: 14,
        reasoning: "exported API surface: exported function, exported return type",
      },
    ]);
  });

  it("classifies the interface boundary at exactly 80 — and the Handle prefix stays routed away", () => {
    // The quickstart's handle row: `interfaceMember` +30 alone on a P3
    // pair reaches exactly 80 contractual (the boundary via the interface
    // extractor), while the name's `Handle` prefix — the longest
    // applicable closed prefix — is not routed to StdoutWrite, so no
    // naming signal exists at all (the routing gate operating through the
    // adapter's fan-out).
    const run = handleRun();
    expect(signalsOfPair(run, "handle", "StdoutWrite")).toEqual([
      {
        function: "handle",
        package: "src.print",
        side_effect_type: "StdoutWrite",
        source: "interface",
        weight: 30,
        reasoning:
          "member 'handle' is declared in an interface of the enclosing class's heritage",
      },
    ]);
    expect(classifiedOf(run, "handle")[0]?.classification).toEqual({
      label: "contractual",
      confidence: 80,
    });
  });

  it("classifies a signal-less pair at the ambiguous floor for every tier (SC-003)", () => {
    // 75/60/50/50/50 across P0–P4: the tier boost is the ONLY term when
    // no extractor fires, and every result stays inside the ambiguous
    // band — a pair with no evidence never leaves [50, 80).
    const run = floorRun();
    const rows: readonly (readonly [string, number])[] = [
      ["floorP0", 75],
      ["floorP1", 60],
      ["floorP2", 50],
      ["floorP3", 50],
      ["floorP4", 50],
    ];
    for (const [name, confidence] of rows) {
      expect(classifiedOf(run, name)[0]?.classification).toEqual({
        label: "ambiguous",
        confidence,
      });
    }
  });

  it("offsets an identical signal profile by exactly the tier boost (SC-003)", () => {
    // The same +8 visibility profile on a P0, P1, and P2 effect:
    // 83/68/58 — the +25/+10/+0 offsets and nothing else, so the profile
    // arithmetic is tier-additive by construction.
    const run = offsetRun();
    const rows: readonly (readonly [string, number, ClassificationLabel])[] = [
      ["offsetP0", 83, "contractual"],
      ["offsetP1", 68, "ambiguous"],
      ["offsetP2", 58, "ambiguous"],
    ];
    for (const [name, confidence, label] of rows) {
      expect(classifiedOf(run, name)[0]?.classification).toEqual({ label, confidence });
    }
  });

  it("clamps a 129 raw score to exactly 100 through real extractors (FR-009)", () => {
    // getPeak stacks four positive sources on a P0 pair — visibility +14,
    // naming +10, direct `@returns` +15, caller +15 — for raw 129: the
    // reported confidence is exactly 100 contractual, and the wire rows
    // still carry the real weights (the clamp applies to the confidence,
    // never to the emitted evidence).
    const run = clampHighRun();
    expect(classifiedOf(run, "getPeak")[0]?.classification).toEqual({
      label: "contractual",
      confidence: 100,
    });
    expect(signalsOfPair(run, "getPeak", "ReturnValue")).toEqual([
      {
        function: "getPeak",
        package: "src.high",
        side_effect_type: "ReturnValue",
        source: "caller_count",
        weight: 15,
        reasoning: "called from 4 distinct in-scope modules",
      },
      {
        function: "getPeak",
        package: "src.high",
        side_effect_type: "ReturnValue",
        source: "docstring",
        weight: 15,
        reasoning: "documented with the direct tag '@returns'",
      },
      {
        function: "getPeak",
        package: "src.high",
        side_effect_type: "ReturnValue",
        source: "naming_convention",
        weight: 10,
        reasoning: "name starts with the contractual prefix 'Get'",
      },
      {
        function: "getPeak",
        package: "src.high",
        side_effect_type: "ReturnValue",
        source: "visibility",
        weight: 14,
        reasoning: "exported API surface: exported function, exported return type",
      },
    ]);
  });

  it("reproduces every run's confidence from the emitted feed alone (FR-011 sum-invariant)", () => {
    // The consumer-side invariant over every fixture run: for each
    // effect, summing ALL feed weights matched to its pair (contradiction
    // row included) plus 50 plus the tier boost, clamped, equals the
    // reported confidence and label — including the clamped getPeak run,
    // where the invariant holds through the clamp. This is the exact
    // arithmetic Gaze's ComputeScore relies on.
    expectSumInvariant(profileRun());
    expectSumInvariant(boundaryRun());
    expectSumInvariant(handleRun());
    expectSumInvariant(floorRun());
    expectSumInvariant(offsetRun());
    expectSumInvariant(clampHighRun());
    expectSumInvariant(orderingRun());
    expectSumInvariant(fanoutRun());
    expectSumInvariant(mixedTypesRun());
  });

  it("emits wire-valid rows — every signal round-trips serializeSignal (FR-001)", () => {
    // The serializer is the fail-loud wire gate (closed source set,
    // canonical type, integer weight, non-empty reasoning); a feed that
    // survives it unchanged is protocol-shaped by construction.
    for (const run of [profileRun(), boundaryRun(), orderingRun(), clampHighRun()]) {
      for (const signal of run.result.signals) {
        const serialized = serializeSignal(signal);
        expect(serialized.function).toBe(signal.function);
        expect(serialized.package).toBe(signal.package);
        expect(serialized.side_effect_type).toBe(signal.side_effect_type);
        expect(serialized.source).toBe(signal.source);
        expect(serialized.weight).toBe(signal.weight);
        if (signal.reasoning === undefined) {
          expect(Object.hasOwn(serialized, "reasoning")).toBe(false);
        } else {
          expect(serialized.reasoning).toBe(signal.reasoning);
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Signal ordering.
// ---------------------------------------------------------------------------

describe("signal ordering (FR-014; research R15)", () => {
  it("orders the feed by the four-key codepoint comparison — every field exercised", () => {
    // The eight-row fixture: `src.A` before `src.a` (package case
    // sensitivity), `src.a` before `src.multi` before `src.order`
    // (package codepoints), multiFn's LogWrite pair before its
    // ReturnValue pair (type order within one record), `WriteCheck`
    // before `writeBanner` (function case sensitivity), and writeBanner's
    // contradiction before docstring before naming_convention (source
    // order within one pair). Full pinned shapes, order included.
    const run = orderingRun();
    expect(run.result.signals).toEqual([
      {
        function: "zebraFn",
        package: "src.A",
        side_effect_type: "ReturnValue",
        source: "visibility",
        weight: 8,
        reasoning: "exported API surface: exported function",
      },
      {
        function: "appleFn",
        package: "src.a",
        side_effect_type: "LogWrite",
        source: "docstring",
        weight: -15,
        reasoning: "documented with the incidental verb 'logs'",
      },
      {
        function: "multiFn",
        package: "src.multi",
        side_effect_type: "LogWrite",
        source: "visibility",
        weight: 8,
        reasoning: "exported API surface: exported function",
      },
      {
        function: "multiFn",
        package: "src.multi",
        side_effect_type: "ReturnValue",
        source: "visibility",
        weight: 8,
        reasoning: "exported API surface: exported function",
      },
      {
        function: "WriteCheck",
        package: "src.order",
        side_effect_type: "StdoutWrite",
        source: "naming_convention",
        weight: 10,
        reasoning: "name starts with the contractual prefix 'Write'",
      },
      {
        function: "writeBanner",
        package: "src.order",
        side_effect_type: "StdoutWrite",
        source: "contradiction",
        weight: -20,
        reasoning: "mixed-polarity evidence: positive and negative signals",
      },
      {
        function: "writeBanner",
        package: "src.order",
        side_effect_type: "StdoutWrite",
        source: "docstring",
        weight: -15,
        reasoning: "documented with the incidental verb 'logs'",
      },
      {
        function: "writeBanner",
        package: "src.order",
        side_effect_type: "StdoutWrite",
        source: "naming_convention",
        weight: 10,
        reasoning: "name starts with the contractual prefix 'Write'",
      },
    ]);
  });

  it("keeps every run's feed a duplicate-free strict total order — no tie-break rule", () => {
    // Pair keying makes the four-key ordering key duplicate-free by
    // construction, which is what allows the total order to have NO
    // tie-break rule: consecutive keys must compare strictly less, never
    // equal (a duplicate would break the FR-011 sum-invariant a consumer
    // computes by matching rows to the pair). The duplicate-count
    // assertion gives the clearer failure message; the strict-comparison
    // loop is the actual pin.
    for (const run of [
      profileRun(),
      boundaryRun(),
      handleRun(),
      floorRun(),
      offsetRun(),
      clampHighRun(),
      orderingRun(),
      fanoutRun(),
      mixedTypesRun(),
    ]) {
      const keys = run.result.signals.map(keyOf);
      expect(new Set(keys.map((key) => key.join("\u0000"))).size).toBe(keys.length);
      for (let index = 1; index < keys.length; index++) {
        const previous = keys[index - 1];
        const current = keys[index];
        if (previous === undefined || current === undefined) {
          throw new Error("the ordering loop must have both keys");
        }
        expect(compareKeys(previous, current)).toBeLessThan(0);
      }
    }
  });
});
