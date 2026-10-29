/**
 * Interface-satisfaction rule conformance suite (T012, FR-002; research
 * R6, R12; data-model.md Sections 5.1, 7).
 *
 * src/signals/interface.ts (T020) is the pure half of US1's interface
 * signal: `(evidence, effectType) → Signal | undefined` — a class-member
 * record whose `evidence.interfaceMember` is true emits exactly one
 * `interface` signal, weight +30, identity fields from the record, and a
 * non-empty fixed-template reasoning; every other record emits nothing.
 * The SATISFACTION FACTS are the evidence seam's contract (heritage
 * resolution, the declared-member table, the toString hazard), pinned over
 * program-mode fixture trees by tests/signals/evidence.test.ts (T011);
 * this suite pins the RULE over those facts and, through the seam, that
 * the real pipeline's snapshots drive it.
 *
 * RED-FIRST: this suite was written and observed failing before
 * src/signals/interface.ts existed (the module-resolution failure is the
 * red observation), per the task-pairing discipline in tasks.md.
 *
 * The evidence seam (research R12) is what makes the rule exhaustively
 * table-testable: the extractor is a pure function of a hand-built
 * snapshot and the pair's effect type, so the full rule table runs with
 * no tree, no tsconfig, and no checker — the compiler interaction is the
 * evidence suite's half, pinned there and consumed here through
 * buildRecordEvidence over real trees.
 *
 * Scenario coverage (spec.md US1; data-model.md Section 7):
 *
 * - FR-002's positive rule: a satisfying class member emits exactly one
 *   +30 `interface` signal with the record's identity fields.
 * - The composite heritage: `extends Base implements Shape` — both
 *   tokens on one class; the interface clause's declared member fires
 *   alongside the silent class extends clause.
 * - The no-signal rows: a member no heritage interface declares, a class
 *   base through either heritage token, an invalid extends-an-interface
 *   clause (Principle II — undeterminable is absence of evidence, never
 *   an error), the toString apparent-member hazard, and structural
 *   satisfaction (an object literal has no enclosing class).
 * - Generic interfaces: `implements Repository<string>` resolves the base
 *   symbol through the type arguments, and the declared `save` member
 *   fires.
 * - Effect-type blindness: interface evidence agrees with every effect
 *   type — no routing gate, unlike naming and docstring evidence.
 * - Parse-only degradation: no checker means no interface signal for any
 *   record and never an error — degradation reduces precision, never
 *   availability (spec assumption 10).
 *
 * Beyond the table: the emitted signal carries the identity fields
 * verbatim (`function` = record name, `package` = `derivePackage` of the
 * record's path), a non-empty fixed-template `reasoning` naming the
 * member and the rule (pinned exactly — research R1's determinism
 * discipline), and round-trips through `serializeSignal`, so the
 * extractor's output is protocol-shaped by construction.
 */

import type { Node } from "typescript/unstable/ast";
import { afterEach, describe, expect, it } from "vitest";
import { prepareAnalysis } from "../../src/analysis.js";
import type { ExtractionRecord } from "../../src/extract.js";
import {
  buildRecordEvidence,
  type RecordEvidence,
} from "../../src/signals/evidence.js";
import { interfaceSignal } from "../../src/signals/interface.js";
import { serializeSignal } from "../../src/signals/types.js";
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

// A plain strict config for the program-mode fixtures (the evidence
// suite's TSCONFIG): no include/files of its own to interfere — the
// bootstrap's extender config overrides the root set anyway.
const TSCONFIG = '{"compilerOptions": {"strict": true, "target": "ES2022"}}';

function withTsconfig(
  sources: Readonly<Record<string, string>>,
): Record<string, string> {
  return { ...sources, "tsconfig.json": TSCONFIG };
}

// The quickstart tree's canonical interface pair: PrintHandler's `handle`
// satisfies the module-local Handler interface, whose StdoutWrite effect
// carries the +30 interface signal at the contractual boundary
// (quickstart.md Sections 4–5). The pure half's identity fixture mirrors
// it exactly.
const FUNCTION = "handle";
const REL_PATH = "src/print.ts";
const PACKAGE = "src.print";
const EFFECT_TYPE = "StdoutWrite";

// The pinned reasoning template (research R1): names the matched member
// (the rule's token) and the rule itself, the data-model Section 7 rule
// text. Implementation-defined wording, stable per analyzer version —
// this suite is where it is pinned.
const REASONING = `member '${FUNCTION}' is declared in an interface of the enclosing class's heritage`;

/**
 * Builds the hand-built rule-table record: the pure rule reads only the
 * identity fields (`name`, `relPath`), so the live compiler views
 * (`node`, `scopeChain`) are inert filler. The one `node` cast is the
 * same localized escape hatch tests/signals/types.test.ts documents for
 * `untypedSignal` — the seam's point is precisely that no rule touches
 * the node — and this builder is the pattern the sibling rule suites
 * (visibility, naming, jsdoc) copy for their own tables.
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
 * value except the overrides under test. The rule's only input beyond
 * identity is `interfaceMember`, so the table's rows vary it and nothing
 * else — the sibling components riding at neutral values also pin that
 * the interface rule never reads them.
 *
 * @param record The record the snapshot describes.
 * @param overrides The components under test; every other field is
 * neutral.
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

// The satisfying snapshot — the quickstart handle pair as a hand-built
// row: a class member whose heritage interface declares it.
function satisfyingSnapshot(): RecordEvidence {
  return snapshotOf(recordOf(FUNCTION, REL_PATH), { interfaceMember: true });
}

// The emitted signal must exist for the satisfying snapshot — the
// throw-based guard keeps the shape assertions below honest (an
// undefined would otherwise fail them with misleading diffs).
function emittedSignal(): ReturnType<typeof interfaceSignal> {
  const signal = interfaceSignal(satisfyingSnapshot(), EFFECT_TYPE);
  if (signal === undefined) {
    throw new Error("the satisfying snapshot must emit a signal");
  }
  return signal;
}

describe("FR-002 rule table (pure, hand-built snapshots)", () => {
  it("emits exactly one +30 interface signal for a satisfying class member", () => {
    // The full six-field shape: identity fields verbatim, the closed
    // source, the pinned weight, and the fixed-template reasoning —
    // exactly one signal, structurally (the return type admits no more).
    expect(interfaceSignal(satisfyingSnapshot(), EFFECT_TYPE)).toEqual({
      function: FUNCTION,
      package: PACKAGE,
      side_effect_type: EFFECT_TYPE,
      source: "interface",
      weight: 30,
      reasoning: REASONING,
    });
  });

  it("emits nothing when no heritage interface declares the member", () => {
    // The no-signal rows collapse onto one falsy arm: the snapshot
    // carries no class-membership field, because `interfaceMember` is
    // only ever true for a class member an interface declares — so a
    // class member nothing declares, and a module-scope record alike,
    // are both just `interfaceMember: false`.
    const classMemberNothingDeclares = snapshotOf(recordOf("volume", "src/shape.ts"));
    const moduleScopeRecord = snapshotOf(recordOf("solo", "src/main.ts"));
    expect(interfaceSignal(classMemberNothingDeclares, EFFECT_TYPE)).toBeUndefined();
    expect(interfaceSignal(moduleScopeRecord, EFFECT_TYPE)).toBeUndefined();
  });

  it("passes the identity fields through verbatim", () => {
    // A different function, path, and effect type ride along unchanged:
    // `function` is the record's unqualified name and `package` its
    // derivePackage value — here a top-level file, whose dotted path is
    // the bare stem.
    const signal = interfaceSignal(
      snapshotOf(recordOf("save", "repo.ts"), { interfaceMember: true }),
      "LogWrite",
    );
    if (signal === undefined) {
      throw new Error("the satisfying snapshot must emit a signal");
    }
    expect(signal.function).toBe("save");
    expect(signal.package).toBe("repo");
    expect(signal.side_effect_type).toBe("LogWrite");
  });

  it("is effect-type-blind — no routing gate", () => {
    // Interface evidence agrees with every effect type equally, unlike
    // naming and docstring evidence (FR-005/FR-006): the same snapshot
    // yields the same source, weight, and reasoning for any canonical
    // type — the type is identity only.
    for (const effectType of ["StdoutWrite", "ReturnValue", "LogWrite"]) {
      const signal = interfaceSignal(satisfyingSnapshot(), effectType);
      if (signal === undefined) {
        throw new Error("the satisfying snapshot must emit a signal");
      }
      expect(signal.source).toBe("interface");
      expect(signal.weight).toBe(30);
      expect(signal.reasoning).toBe(REASONING);
    }
  });

  it("is pure — the same inputs produce the deep-equal signal", () => {
    expect(interfaceSignal(satisfyingSnapshot(), EFFECT_TYPE)).toEqual(
      interfaceSignal(satisfyingSnapshot(), EFFECT_TYPE),
    );
  });
});

describe("reasoning template (research R1 determinism)", () => {
  it("names the member and the declared-contract rule", () => {
    expect(emittedSignal().reasoning).toBe(REASONING);
  });
});

describe("wire validity (FR-001)", () => {
  it("round-trips the emitted signal through serializeSignal", () => {
    // The serializer is the fail-loud wire gate (closed source set,
    // canonical type, integer weight, non-empty reasoning); an extractor
    // output that survives it unchanged is protocol-shaped by
    // construction.
    expect(serializeSignal(emittedSignal())).toEqual({
      function: FUNCTION,
      package: PACKAGE,
      side_effect_type: EFFECT_TYPE,
      source: "interface",
      weight: 30,
      reasoning: REASONING,
    });
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
// parse-only would degrade the checker-resolved components vacuously —
// every interfaceMember assertion would pass as false — without failing
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

// The totality guard: every extracted record must have its snapshot — a
// missing entry is a loud failure, never a soft skip.
function evidenceOf(run: EvidenceRun, record: ExtractionRecord): RecordEvidence {
  const evidence = run.evidence.get(record);
  if (evidence === undefined) {
    throw new Error(
      `record "${record.name}" has no evidence entry — totality violated`,
    );
  }
  return evidence;
}

// The same-name group lookup: every matching record, in record order.
// Records are sorted by (relPath, line, name), so a same-name group
// comes back in source-line order — the area and toString groups below
// are addressed by class through that order.
function recordsOf(
  run: EvidenceRun,
  relPath: string,
  name: string,
): ExtractionRecord[] {
  return run.records.filter(
    (record) => record.relPath === relPath && record.name === name,
  );
}

// The single-record lookup for unique names: (relPath, name) must
// identify exactly one record — the throw-based guards surface fixture
// drift (a second same-named record) as loud failures, not silent
// misaddressing.
function evOf(run: EvidenceRun, relPath: string, name: string): RecordEvidence {
  const matches = recordsOf(run, relPath, name);
  if (matches.length !== 1) {
    throw new Error(
      `expected exactly one record "${name}" in ${relPath}, found ${matches.length}`,
    );
  }
  return evidenceOf(run, matches[0]);
}

// The satisfaction tree: one file holding every firing and non-firing
// heritage form (research R6; the evidence suite's heritage matrix, with
// the signal suite's own class names so failures self-locate):
//
//   Circle.area       implements Shape (declares area)       → fires
//   Circle.volume     Shape declares no volume               → no
//   Ring.area         extends class Base                     → no
//   Structural.area   implements class Base                  → no
//   Invalid.area      extends Shape — invalid TypeScript     → no
//   Mixed.area        extends Base implements Shape — the
//                     interface clause fires alongside the
//                     class extends clause                  → fires
//   Hazard.toString   implements Shape (no toString)         → no
//   Declared.toString implements Labelled (declares it)      → fires
//   StringRepo.save   implements Repository<string>          → fires
//   structural.area   object literal — no enclosing class    → no
const SATISFACTION_SOURCES: Readonly<Record<string, string>> = {
  "src/shape.ts": [
    "export interface Shape {",
    "  area(): number;",
    "}",
    "",
    "export interface Labelled {",
    "  toString(): string;",
    "}",
    "",
    "interface Repository<T> {",
    "  save(item: T): void;",
    "}",
    "",
    "export class Base {",
    "  area(): number {",
    "    return 0;",
    "  }",
    "}",
    "",
    "export class Circle implements Shape {",
    "  area(): number {",
    "    return 1;",
    "  }",
    "",
    "  volume(): number {",
    "    return 2;",
    "  }",
    "}",
    "",
    "export class Ring extends Base {",
    "  area(): number {",
    "    return 3;",
    "  }",
    "}",
    "",
    "export class Structural implements Base {",
    "  area(): number {",
    "    return 4;",
    "  }",
    "}",
    "",
    // A class cannot extend an interface — semantically invalid
    // TypeScript an untrusted tree can contain. Every checker route
    // comes back empty, so the seam answers absence of evidence and the
    // rule emits nothing (Constitution Principle II), never an error.
    "export class Invalid extends Shape {",
    "  area(): number {",
    "    return 5;",
    "  }",
    "}",
    "",
    // The composite heritage: both tokens on one class — an extends
    // clause naming a class (silent through the declaration-kind gate)
    // alongside an implements clause naming Shape. The heritage walk
    // must continue past the class base and fire on the interface
    // clause's declared member; a walk that stopped at the first
    // clause, or at a class base, would drop the signal.
    "export class Mixed extends Base implements Shape {",
    "  area(): number {",
    "    return 6;",
    "  }",
    "}",
    "",
    // The apparent-member hazard: Shape does NOT declare toString, so an
    // apparent-member lookup would find Object.prototype's toString on
    // every interface and manufacture a +30 here. Declared tables do
    // not — and Declared provides the positive contrast.
    "export class Hazard implements Shape {",
    "  toString(): string {",
    '    return "h";',
    "  }",
    "}",
    "",
    "export class Declared implements Labelled {",
    "  toString(): string {",
    '    return "d";',
    "  }",
    "}",
    "",
    // Generic interface satisfaction: the base expression carries type
    // arguments, and the declared member table behind it still holds
    // `save`.
    "export class StringRepo implements Repository<string> {",
    "  save(item: string): void {",
    "    console.log(item);",
    "  }",
    "}",
    "",
    // Structural satisfaction: an object literal contextually typed as
    // the interface declares the member shape but has no enclosing
    // class — no heritage, no signal.
    "const structural: Shape = {",
    "  area() {",
    "    return 9;",
    "  },",
    "};",
    "export const shapeHolder = structural;",
    "",
  ].join("\n"),
};

describe("satisfaction through the evidence seam (research R6, program mode)", () => {
  it("fires for a member an implements-clause interface declares", async () => {
    const run = await runEvidence(withTsconfig(SATISFACTION_SOURCES));
    // Circle's area — the second of the seven area records — carries
    // the full signal over the seam-produced snapshot: identity fields
    // from the real record, +30, the closed source.
    const areaRecords = recordsOf(run, "src/shape.ts", "area");
    expect(areaRecords).toHaveLength(7);
    expect(interfaceSignal(evidenceOf(run, areaRecords[1]), EFFECT_TYPE)).toEqual({
      function: "area",
      package: "src.shape",
      side_effect_type: EFFECT_TYPE,
      source: "interface",
      weight: 30,
      reasoning:
        "member 'area' is declared in an interface of the enclosing class's heritage",
    });
    // The same class's undeclared member stays silent: Shape's table
    // carries no `volume`.
    expect(
      interfaceSignal(evOf(run, "src/shape.ts", "volume"), EFFECT_TYPE),
    ).toBeUndefined();
  });

  it("does not fire for class bases, through either heritage token", async () => {
    const run = await runEvidence(withTsconfig(SATISFACTION_SOURCES));
    // The seven `area` records in source-line order — Base, Circle,
    // Ring, Structural, Invalid, Mixed, structural — each judged through
    // the seam. Ring.area (extends class Base) and Structural.area
    // (implements class Base) stay silent: both base symbols resolve and
    // both declare `area`, but neither base is an InterfaceDeclaration —
    // the declaration-kind gate, through either heritage token. Mixed
    // (extends Base implements Shape) carries both tokens on one class
    // and still fires through its interface clause — the composite row
    // the dedicated test below pins in full.
    const firing = recordsOf(run, "src/shape.ts", "area").map(
      (record) => interfaceSignal(evidenceOf(run, record), EFFECT_TYPE) !== undefined,
    );
    expect(firing).toEqual([false, true, false, false, false, true, false]);
  });

  it("fires through the composite heritage — extends a class, implements the interface", async () => {
    const run = await runEvidence(withTsconfig(SATISFACTION_SOURCES));
    // Mixed.area — the sixth of the seven area records — carries both
    // heritage tokens on one class: the extends clause names class Base
    // (silent through the declaration-kind gate) and the implements
    // clause names Shape, whose declared `area` fires with the full
    // signal shape over the seam-produced snapshot.
    const areaRecords = recordsOf(run, "src/shape.ts", "area");
    expect(interfaceSignal(evidenceOf(run, areaRecords[5]), EFFECT_TYPE)).toEqual({
      function: "area",
      package: "src.shape",
      side_effect_type: EFFECT_TYPE,
      source: "interface",
      weight: 30,
      reasoning:
        "member 'area' is declared in an interface of the enclosing class's heritage",
    });
  });

  it("resolves invalid extends-an-interface to no signal, never an error", async () => {
    const run = await runEvidence(withTsconfig(SATISFACTION_SOURCES));
    // Invalid.area — the fifth area record: the invalid clause resolves
    // through no checker route, so the rule's answer is silence — not a
    // throw, not a manufactured match (Principle II).
    const areaRecords = recordsOf(run, "src/shape.ts", "area");
    const invalidArea = evidenceOf(run, areaRecords[4]);
    expect(interfaceSignal(invalidArea, EFFECT_TYPE)).toBeUndefined();
  });

  it("never suffers the toString apparent-member hazard", async () => {
    const run = await runEvidence(withTsconfig(SATISFACTION_SOURCES));
    // Hazard's toString (first) stays silent: Shape does not declare it;
    // Declared's (second) fires: Labelled does. The same method name
    // fires only when declared — the hazard this fixture exists to pin.
    const toStringRecords = recordsOf(run, "src/shape.ts", "toString");
    expect(toStringRecords).toHaveLength(2);
    expect(
      interfaceSignal(evidenceOf(run, toStringRecords[0]), EFFECT_TYPE),
    ).toBeUndefined();
    expect(
      interfaceSignal(evidenceOf(run, toStringRecords[1]), EFFECT_TYPE),
    ).toBeDefined();
  });

  it("fires for members declared in generic interfaces", async () => {
    const run = await runEvidence(withTsconfig(SATISFACTION_SOURCES));
    // Repository<string>'s base expression carries type arguments; the
    // declared member table behind the symbol still holds `save`.
    expect(interfaceSignal(evOf(run, "src/shape.ts", "save"), EFFECT_TYPE)).toEqual({
      function: "save",
      package: "src.shape",
      side_effect_type: EFFECT_TYPE,
      source: "interface",
      weight: 30,
      reasoning:
        "member 'save' is declared in an interface of the enclosing class's heritage",
    });
  });

  it("keeps structural satisfaction off the signal — no enclosing class", async () => {
    const run = await runEvidence(withTsconfig(SATISFACTION_SOURCES));
    // The object literal contextually typed as Shape: its `area` method
    // extracts as a record, but no heritage exists to satisfy — the
    // last of the six area records.
    const areaRecords = recordsOf(run, "src/shape.ts", "area");
    const structuralArea = evidenceOf(run, areaRecords[areaRecords.length - 1]);
    expect(interfaceSignal(structuralArea, EFFECT_TYPE)).toBeUndefined();
  });
});

describe("parse-only degradation (research R6, Constitution Principle II)", () => {
  it("emits no interface signal and never errors — undeterminable is absence of evidence", async () => {
    // The same tree minus tsconfig: every record still extracts and gets
    // a snapshot, but no checker is live, so interfaceMember is false
    // across the tree — the request completes normally with the signal
    // simply absent (spec assumption 10: degradation reduces precision,
    // never availability).
    const run = await runEvidence(SATISFACTION_SOURCES, "parse-only");
    expect(run.records.length).toBeGreaterThan(0);
    for (const record of run.records) {
      expect(interfaceSignal(evidenceOf(run, record), EFFECT_TYPE)).toBeUndefined();
    }
  });
});
