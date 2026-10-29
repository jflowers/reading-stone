/**
 * API-visibility component-sum conformance suite (T013, FR-003; research
 * R5, R12; data-model.md Section 7).
 *
 * src/signals/visibility.ts (T021) is the pure half of US1's `visibility`
 * signal: `(evidence, effectType) → Signal | undefined` — the weight is the
 * sum of the applicable components (exported function +8, exported return
 * type +6, exported receiver +6), clamped to a maximum of +20; zero
 * applicable components emit no signal at all. A weight that drifts from
 * data-model.md Section 7 is a bug — the same posture as the caller bucket
 * table (caller.ts) and the interface rule (interface.ts).
 *
 * RED-FIRST: this suite was written and observed failing before
 * src/signals/visibility.ts existed (the module-resolution failure is the
 * red observation), per the task-pairing discipline in tasks.md.
 *
 * The evidence seam (research R12) is what makes the rule exhaustively
 * table-testable: the extractor is a pure function of a hand-built snapshot
 * and the pair's effect type, so the full component table runs with no
 * tree, no tsconfig, and no checker. The EXPORTEDNESS FACTS — which
 * declarations count as exported (the ESM and CJS forms), which return-type
 * annotations resolve to exported symbols, the class-member/receiver split
 * — are the seam's contract, pinned over program-mode fixture trees by
 * tests/signals/evidence.test.ts (T011); this suite pins the ARITHMETIC
 * over those facts and, through the seam, the parse-only boundary.
 *
 * Scenario coverage (spec.md FR-003, assumption 4; data-model.md Section 7):
 *
 * - The component-sum table: all eight combinations of the three
 *   components — exported function alone → +8; exported return type alone
 *   → +6 (a module-private function with an exported return type still
 *   emits +6 — components are independent); exported receiver alone → +6;
 *   the pairwise sums +14/+14/+12 (data-model.md Section 7 names +14 as an
 *   emitted intermediate clamped sum); all three → +20.
 * - The clamp guard: 8+6+6 = 20 exactly, so the +20 clamp is
 *   arithmetically inert for every input the three booleans can produce —
 *   retained as the pinned guard (FR-003 pins it; research R5's rejected
 *   alternative is dropping it), never removed to simplify tests.
 * - Positive-only (assumption 4): zero applicable components emit NO signal
 *   — a module-private function emits nothing, never a negative signal and
 *   never a 0-weight wire row.
 * - The emitted weight is the clamped sum with source `visibility`.
 * - Parse-only degradation: the +8 and receiver components are syntactic
 *   facts that survive without a checker; only the return-type component
 *   is lost (research R5's degradation boundary).
 *
 * Beyond the table: the emitted signal carries the identity fields verbatim
 * (`function` = record name, `package` = `derivePackage` of the record's
 * path), a non-empty fixed-template `reasoning` naming the applicable
 * components in a pinned order (research R1's determinism discipline), and
 * round-trips through `serializeSignal`, so the extractor's output is
 * protocol-shaped by construction.
 */

import type { Node } from "typescript/unstable/ast";
import { afterEach, describe, expect, it } from "vitest";
import { prepareAnalysis } from "../../src/analysis.js";
import type { ExtractionRecord } from "../../src/extract.js";
import {
  buildRecordEvidence,
  type RecordEvidence,
} from "../../src/signals/evidence.js";
import { serializeSignal } from "../../src/signals/types.js";
import { visibilitySignal } from "../../src/signals/visibility.js";
import {
  createFixtureTree,
  drainCleanups,
  memorySink,
  registerCleanup,
} from "../helpers/fixtures.js";

// Fixture trees register their cleanup with the shared helpers so every
// test body stays linear; afterEach drains the queue in creation order.
afterEach(async () => {
  await drainCleanups();
});

// A plain strict config for the program-mode seam fixtures (the evidence
// suite's TSCONFIG): no include/files of its own to interfere — the
// bootstrap's extender config overrides the root set anyway.
const TSCONFIG = '{"compilerOptions": {"strict": true, "target": "ES2022"}}';

function withTsconfig(
  sources: Readonly<Record<string, string>>,
): Record<string, string> {
  return { ...sources, "tsconfig.json": TSCONFIG };
}

// The quickstart tree's canonical visibility pair: formatLabel in
// src/util.ts — an exported function whose `string` return is a primitive,
// so the +8 function component fires alone (quickstart.md Sections 4–5:
// the visibility +8 rows of the 11-signal feed; main1/main2 are the same
// shape). The pure half's identity fixture mirrors it exactly.
const FUNCTION = "formatLabel";
const REL_PATH = "src/util.ts";
const PACKAGE = "src.util";
const EFFECT_TYPE = "ReturnValue";

/**
 * Builds the hand-built rule-table record: the pure rule reads only the
 * identity fields (`name`, `relPath`), so the live compiler views (`node`,
 * `scopeChain`) are inert filler. The one `node` cast is the same localized
 * escape hatch tests/signals/types.test.ts documents for `untypedSignal` —
 * the seam's point is precisely that no rule touches the node — and the
 * builder is the pattern tests/signals/interface.test.ts established for
 * the sibling rule suites.
 *
 * @param name The record's unqualified name — the signal's `function`.
 * @param relPath The record's root-relative path — the signal's `package`
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
 * value except the overrides under test. The rule's only inputs beyond
 * identity are the three visibility components, so the table's rows vary
 * them and nothing else — the sibling fields riding at neutral values also
 * pin that the visibility rule never reads them.
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

// The all-components snapshot — the maximal hand-built row. The seam never
// produces this shape (evidence.ts's class-member split keeps the function
// and receiver components disjoint), which is exactly why the pure table,
// not the seam, owns the all-three and clamp rows.
function allThreeSnapshot(): RecordEvidence {
  return snapshotOf(recordOf(FUNCTION, REL_PATH), {
    exportedFunction: true,
    exportedReturnType: true,
    exportedReceiver: true,
  });
}

// FR-003's component-sum table over hand-built snapshots: one row per
// combination of the three components — [exportedFunction,
// exportedReturnType, exportedReceiver, expected clamped weight, expected
// reasoning] — with `undefined` marking the no-signal row. Every weight is
// a pinned literal, never computed: 8/6/6 pin the components themselves,
// 14/14/12 pin the pairwise independence of the sums, 20 pins the
// all-three clamp bound, and the undefined row pins positive-only
// visibility (spec assumption 4). The reasoning literals pin the template —
// the "exported API surface: " prefix, the fixed component order function →
// return type → receiver, and the ", " join — for all seven emitted
// combinations (the zero row emits nothing, so its reasoning is unused).
const COMPONENT_ROWS: readonly (readonly [
  boolean,
  boolean,
  boolean,
  number | undefined,
  string,
])[] = [
  [false, false, false, undefined, ""],
  [true, false, false, 8, "exported API surface: exported function"],
  [false, true, false, 6, "exported API surface: exported return type"],
  [false, false, true, 6, "exported API surface: exported receiver"],
  [
    true,
    true,
    false,
    14,
    "exported API surface: exported function, exported return type",
  ],
  [true, false, true, 14, "exported API surface: exported function, exported receiver"],
  [
    false,
    true,
    true,
    12,
    "exported API surface: exported return type, exported receiver",
  ],
  [
    true,
    true,
    true,
    20,
    "exported API surface: exported function, exported return type, exported receiver",
  ],
];

describe("FR-003 component-sum table (pure, hand-built snapshots)", () => {
  it.each(COMPONENT_ROWS)(
    "sums function=%s returnType=%s receiver=%s into weight %s",
    (exportedFunction, exportedReturnType, exportedReceiver, expected, reasoning) => {
      const signal = visibilitySignal(
        snapshotOf(recordOf(FUNCTION, REL_PATH), {
          exportedFunction,
          exportedReturnType,
          exportedReceiver,
        }),
        EFFECT_TYPE,
      );
      if (expected === undefined) {
        expect(signal).toBeUndefined();
        return;
      }
      expect(signal).toEqual({
        function: FUNCTION,
        package: PACKAGE,
        side_effect_type: EFFECT_TYPE,
        source: "visibility",
        weight: expected,
        reasoning,
      });
    },
  );

  it("emits no signal for zero applicable components — positive-only (assumption 4)", () => {
    // A module-private function with no exported reference emits nothing —
    // never a negative signal and never a 0-weight wire row: the issue
    // defines only positive components and the clamp reinforces a
    // positive-only design (spec assumption 4), so the confidence
    // arithmetic simply proceeds without a visibility term.
    const modulePrivate = snapshotOf(recordOf("quietWorker", "src/internal.ts"));
    expect(visibilitySignal(modulePrivate, EFFECT_TYPE)).toBeUndefined();
  });

  it("passes any pair's identity fields through unchanged", () => {
    // A different function, path, and effect type ride along verbatim:
    // `function` is the record's unqualified name and `package` its
    // derivePackage value — here a top-level file, whose dotted path is
    // the bare stem (the interface suite's identity fixture shape).
    const signal = visibilitySignal(
      snapshotOf(recordOf("save", "repo.ts"), { exportedFunction: true }),
      "LogWrite",
    );
    if (signal === undefined) {
      throw new Error("the exported snapshot must emit a signal");
    }
    expect(signal.function).toBe("save");
    expect(signal.package).toBe("repo");
    expect(signal.side_effect_type).toBe("LogWrite");
  });

  it("is effect-type-blind — no routing gate", () => {
    // Visibility evidence agrees with every effect type equally, unlike
    // naming and docstring evidence (FR-005/FR-006): exportedness
    // obligates the function as a whole, so the same snapshot yields the
    // same source, weight, and reasoning for any canonical type — the
    // type is identity only (the interface rule's stance, shared here).
    for (const effectType of ["StdoutWrite", "ReturnValue", "LogWrite"] as const) {
      const signal = visibilitySignal(allThreeSnapshot(), effectType);
      if (signal === undefined) {
        throw new Error("the all-three snapshot must emit a signal");
      }
      expect(signal.source).toBe("visibility");
      expect(signal.weight).toBe(20);
      expect(signal.reasoning).toBe(
        "exported API surface: exported function, exported return type, exported receiver",
      );
    }
  });

  it("is pure — the same inputs produce the deep-equal signal", () => {
    expect(visibilitySignal(allThreeSnapshot(), EFFECT_TYPE)).toEqual(
      visibilitySignal(allThreeSnapshot(), EFFECT_TYPE),
    );
  });
});

describe("the +20 clamp guard (data-model.md Section 7)", () => {
  it("clamps the all-three component sum to exactly +20 — the pinned guard", () => {
    // 8+6+6 = 20 exactly, so the clamp is arithmetically inert for every
    // input the three booleans can produce — and it is retained anyway:
    // FR-003 pins the +20 maximum, and research R5's rejected alternative
    // is dropping the inert clamp. The guard is never removed to simplify
    // tests; this row pins that the emitted weight is exactly 20, so a
    // future fourth component (or a re-tuned weight) that pushes the raw
    // sum past 20 fails here loud. The all-three shape is reachable only
    // in the rule's input space — the seam's class-member split keeps the
    // function and receiver components disjoint on real records — which is
    // exactly why the pure table owns this row.
    const signal = visibilitySignal(allThreeSnapshot(), EFFECT_TYPE);
    if (signal === undefined) {
      throw new Error("the all-three snapshot must emit a signal");
    }
    expect(signal.weight).toBe(20);
    expect(signal.source).toBe("visibility");
  });
});

describe("wire validity (FR-001)", () => {
  it("round-trips every emitted component sum through serializeSignal", () => {
    // The serializer is the fail-loud wire gate (closed source set,
    // canonical type, integer weight, non-empty reasoning); an extractor
    // output that survives it unchanged is protocol-shaped by construction
    // — including the intermediate sums (+14/+12), whose arithmetic-not-
    // enumerable status types.ts documents for the closed weight set.
    for (const [
      exportedFunction,
      exportedReturnType,
      exportedReceiver,
      expected,
      reasoning,
    ] of COMPONENT_ROWS) {
      const signal = visibilitySignal(
        snapshotOf(recordOf(FUNCTION, REL_PATH), {
          exportedFunction,
          exportedReturnType,
          exportedReceiver,
        }),
        EFFECT_TYPE,
      );
      if (expected === undefined) {
        expect(signal).toBeUndefined();
        continue;
      }
      if (signal === undefined) {
        throw new Error("an emitted row must serialize — the signal is missing");
      }
      expect(serializeSignal(signal)).toEqual({
        function: FUNCTION,
        package: PACKAGE,
        side_effect_type: EFFECT_TYPE,
        source: "visibility",
        weight: expected,
        reasoning,
      });
    }
  });
});

// ---------------------------------------------------------------------------
// The evidence-seam half: the real pipeline's snapshots drive the rule.
// ---------------------------------------------------------------------------

/** One run's assertion surfaces: the records and their evidence map. */
interface EvidenceRun {
  readonly records: readonly ExtractionRecord[];
  readonly evidence: ReadonlyMap<ExtractionRecord, RecordEvidence>;
}

// Runs the real pipeline over a fixture tree and computes evidence while
// the context is live: createFixtureTree → prepareAnalysis →
// buildRecordEvidence → dispose. The mode assertion is inside the try on
// purpose (the runIndex discipline): a silent tsconfig fallback to
// parse-only would degrade the checker-resolved component vacuously —
// every exportedReturnType assertion would pass as false — without failing
// a single one.
async function runEvidence(
  files: Readonly<Record<string, string>>,
  expectedMode: "program" | "parse-only" = "program",
): Promise<EvidenceRun> {
  const tree = await createFixtureTree(files);
  registerCleanup(tree.cleanup);
  const sink = memorySink();
  const prepared = await prepareAnalysis(tree.root, undefined, sink.stream);
  try {
    expect(prepared.context.mode).toBe(expectedMode);
    const evidence = buildRecordEvidence(
      prepared.context,
      prepared.records,
      prepared.inScopePaths,
      prepared.rootPath,
    );
    return { records: prepared.records, evidence };
  } finally {
    if (prepared.context.mode === "program") {
      prepared.context.dispose();
    }
  }
}

// The single-record lookup: (relPath, name) must identify exactly one
// record with an evidence entry — the throw-based guards surface fixture
// drift (a second same-named record, a missing snapshot) as loud failures,
// not silent misaddressing.
function evOf(run: EvidenceRun, relPath: string, name: string): RecordEvidence {
  const matches = run.records.filter(
    (record) => record.relPath === relPath && record.name === name,
  );
  if (matches.length !== 1) {
    throw new Error(
      `expected exactly one record "${name}" in ${relPath}, found ${matches.length}`,
    );
  }
  const evidence = run.evidence.get(matches[0]);
  if (evidence === undefined) {
    throw new Error(
      `record "${name}" in ${relPath} has no evidence entry — totality violated`,
    );
  }
  return evidence;
}

// The component tree: one file holding every firing and non-firing
// component form (research R5; the evidence suite's exportedness matrix,
// with this suite's own names so failures self-locate):
//
//   hiddenConfig       module-private, returns exported Config  → +6
//   loadConfig         exported, returns exported Config        → +14
//   localHelper        module-private, primitive return         → no signal
//   Registry.register  method on an exported class              → +6
//   Internal.helper    method on an unexported class            → no signal
const COMPONENT_SOURCES: Readonly<Record<string, string>> = {
  "src/api.ts": [
    "export interface Config {",
    "  name: string;",
    "}",
    "",
    // The independence row: no export anywhere on the binding, but the
    // annotated return type references the exported Config — the +6 fires
    // alone (FR-003: components are independent).
    "function hiddenConfig(): Config {",
    '  return { name: "hidden" };',
    "}",
    "",
    // The sum row: the export modifier (+8) alongside the exported Config
    // return annotation (+6) — 14, data-model.md Section 7's named
    // intermediate clamped sum.
    "export function loadConfig(): Config {",
    '  return { name: "loaded" };',
    "}",
    "",
    // The zero row: module-private, primitive return — no applicable
    // component (positive-only, assumption 4).
    "function localHelper(): void {",
    "  return;",
    "}",
    "",
    // The receiver row: a class-member record never takes the function
    // component — the exported enclosing class is the receiver component.
    "export class Registry {",
    "  register(item: string): void {",
    "    return;",
    "  }",
    "}",
    "",
    // The receiver zero row: the unexported class's method emits nothing.
    "class Internal {",
    "  helper(): void {",
    "    return;",
    "  }",
    "}",
    "",
  ].join("\n"),
};

describe("component sums through the evidence seam (research R5, program mode)", () => {
  it("fires the return-type component alone for a module-private function → +6", async () => {
    // The independence row over a real snapshot: hiddenConfig's binding is
    // not exported, but its Config annotation resolves to the exported
    // interface, so the +6 fires alone — components are independent
    // (FR-003), and the return-type contract counts even for module-private
    // helpers. Full signal shape over the seam-produced snapshot, identity
    // fields from the real record.
    const run = await runEvidence(withTsconfig(COMPONENT_SOURCES));
    const signal = visibilitySignal(
      evOf(run, "src/api.ts", "hiddenConfig"),
      EFFECT_TYPE,
    );
    if (signal === undefined) {
      throw new Error("hiddenConfig must emit a visibility signal");
    }
    expect(signal).toEqual({
      function: "hiddenConfig",
      package: "src.api",
      side_effect_type: EFFECT_TYPE,
      source: "visibility",
      weight: 6,
      reasoning: "exported API surface: exported return type",
    });
  });

  it("sums the function and return-type components → +14", async () => {
    // loadConfig: the export modifier's +8 alongside the exported Config
    // annotation's +6 — the intermediate clamped sum data-model.md Section
    // 7 names explicitly.
    const run = await runEvidence(withTsconfig(COMPONENT_SOURCES));
    const signal = visibilitySignal(evOf(run, "src/api.ts", "loadConfig"), EFFECT_TYPE);
    if (signal === undefined) {
      throw new Error("loadConfig must emit a visibility signal");
    }
    expect(signal).toEqual({
      function: "loadConfig",
      package: "src.api",
      side_effect_type: EFFECT_TYPE,
      source: "visibility",
      weight: 14,
      reasoning: "exported API surface: exported function, exported return type",
    });
  });

  it("fires the receiver component for a method on an exported class → +6", async () => {
    // Registry.register: the class-member record takes the receiver
    // component (the enclosing class's exportedness), never the function
    // component — the seam's component split, consumed here as weight.
    const run = await runEvidence(withTsconfig(COMPONENT_SOURCES));
    const signal = visibilitySignal(evOf(run, "src/api.ts", "register"), EFFECT_TYPE);
    if (signal === undefined) {
      throw new Error("register must emit a visibility signal");
    }
    expect(signal).toEqual({
      function: "register",
      package: "src.api",
      side_effect_type: EFFECT_TYPE,
      source: "visibility",
      weight: 6,
      reasoning: "exported API surface: exported receiver",
    });
  });

  it("emits nothing for records with no applicable component", async () => {
    // The zero rows over real snapshots: a module-private function with a
    // primitive return, and a method on an unexported class — no
    // applicable component, so no signal (positive-only, assumption 4).
    const run = await runEvidence(withTsconfig(COMPONENT_SOURCES));
    expect(
      visibilitySignal(evOf(run, "src/api.ts", "localHelper"), EFFECT_TYPE),
    ).toBeUndefined();
    expect(
      visibilitySignal(evOf(run, "src/api.ts", "helper"), EFFECT_TYPE),
    ).toBeUndefined();
  });
});

describe("parse-only degradation (research R5; Constitution Principle II)", () => {
  it("keeps the +8 and receiver components and loses only the return-type component", async () => {
    // The same tree minus tsconfig: the export modifiers are syntactic
    // facts, so loadConfig keeps its function component (14 → 8) and
    // Registry.register keeps its receiver component (+6); the return-type
    // component needs the checker, so hiddenConfig — whose +6 was its only
    // component — drops to zero applicable components and emits nothing.
    // Degradation reduces precision, never availability (spec assumption
    // 10; the quickstart's Section 8 boundary: the syntactic visibility +8
    // survives).
    const run = await runEvidence(COMPONENT_SOURCES, "parse-only");
    const load = visibilitySignal(evOf(run, "src/api.ts", "loadConfig"), EFFECT_TYPE);
    if (load === undefined) {
      throw new Error("loadConfig must keep its syntactic +8");
    }
    expect(load).toEqual({
      function: "loadConfig",
      package: "src.api",
      side_effect_type: EFFECT_TYPE,
      source: "visibility",
      weight: 8,
      reasoning: "exported API surface: exported function",
    });
    const register = visibilitySignal(evOf(run, "src/api.ts", "register"), EFFECT_TYPE);
    if (register === undefined) {
      throw new Error("register must keep its syntactic +6");
    }
    expect(register.weight).toBe(6);
    expect(
      visibilitySignal(evOf(run, "src/api.ts", "hiddenConfig"), EFFECT_TYPE),
    ).toBeUndefined();
    // The zero rows stay zero — degradation never adds evidence.
    expect(
      visibilitySignal(evOf(run, "src/api.ts", "localHelper"), EFFECT_TYPE),
    ).toBeUndefined();
    expect(
      visibilitySignal(evOf(run, "src/api.ts", "helper"), EFFECT_TYPE),
    ).toBeUndefined();
  });
});
