// Shared wire-level scaffolding for the detector rule suites.
//
// The review council's test-conventions finding (dispatch 44e85014) called out
// memorySink being copied into every new suite and recommended shared test
// helpers under tests/helpers/. This module is that consolidation for the
// detector-rules suites: the analyze-entry driver, the record lookup, the
// contract-pinned effect projections, and the FR-018 through FR-020 wire
// invariants, plus spec 003's classification amendment: every analyze
// effect classified (FR-012). The stderr sink itself lives in
// tests/helpers/fixtures.ts (the suite-wide shared helper every test file
// imports) and is re-exported here so the detector-rules suites keep a
// single import surface.
//
// ASSERTION DISCIPLINE (same as tests/detector.test.ts): effect
// `description` wording is implementation-defined, so effects are projected
// to the contract-pinned fields {type, location, target, detail} and compared
// with toEqual — exact canonical type, exact root-relative file:line:col
// (1-based), exact target where research R6.6 pins it, zero extra effects.
// Classification (003 FR-012) is validated structurally by
// expectWireInvariants, not by these detection-field projections.
import { expect } from "vitest";
import { analyze } from "../../src/analysis.js";
import { derivePackage } from "../../src/models.js";
import { SIDE_EFFECT_TYPES } from "../../src/taxonomy.js";
import { memorySink } from "./fixtures.js";

export { memorySink };

/**
 * The classification on one serialized effect — the wire shape
 * `serializeClassification` (src/models.ts) emits for src/models.ts's
 * `Classification`: both fields always present.
 */
export interface WireClassification {
  readonly label: "contractual" | "incidental" | "ambiguous";
  readonly confidence: number;
}

/** One serialized effect as the analyze entry returns it. */
export interface WireEffect {
  readonly type: string;
  readonly description: string;
  readonly location?: string;
  readonly target?: string;
  readonly detail?: Record<string, unknown>;
  readonly classification?: WireClassification;
}

/** One serialized function record (name, package, file, line, side_effects). */
export interface WireRecord {
  readonly name: string;
  readonly package: string;
  readonly file: string;
  readonly line: number;
  readonly side_effects: readonly WireEffect[];
}

/**
 * Narrows the analyze entry's result through its two documented shapes: the
 * serialized FunctionRecord[] payload or an object with a functions array.
 * Anything else is a malformed result — fail loud, never a soft zero.
 */
export function extractFunctions(result: unknown): readonly WireRecord[] {
  if (Array.isArray(result)) {
    return result as readonly WireRecord[];
  }
  if (
    typeof result === "object" &&
    result !== null &&
    Array.isArray((result as { functions?: unknown }).functions)
  ) {
    return (result as { functions: readonly WireRecord[] }).functions;
  }
  throw new Error(
    "unexpected analyze result shape: expected the serialized FunctionRecord[] payload or an object with a functions array",
  );
}

/**
 * Runs one analysis with a fresh stderr sink and whole-tree patterns
 * (absent). Pattern scoping is tests/analysis.test.ts's suite; the rule
 * suites pin detection.
 */
export async function analyzeTree(root: string): Promise<{
  functions: readonly WireRecord[];
  stderr: () => string;
}> {
  const sink = memorySink();
  const result: unknown = await analyze(root, undefined, sink.stream);
  return { functions: extractFunctions(result), stderr: sink.text };
}

/**
 * Finds the unique record for (name, file) — the one-record-per-fixture
 * invariant every rule case relies on; a miss or a duplicate is an
 * extraction or fixture bug, never a soft match.
 */
export function recordFor(
  functions: readonly WireRecord[],
  name: string,
  file: string,
): WireRecord {
  let found: WireRecord | undefined;
  let count = 0;
  for (const record of functions) {
    if (record.name === name && record.file === file) {
      found = record;
      count += 1;
    }
  }
  if (count !== 1 || found === undefined) {
    throw new Error(
      'expected exactly one record named "' +
        name +
        '" in ' +
        file +
        ", found " +
        count,
    );
  }
  return found;
}

/** Contract-pinned projection of one effect: every field except the
 * implementation-defined description template. */
export function projected(effect: WireEffect): Record<string, unknown> {
  return {
    type: effect.type,
    location: effect.location,
    target: effect.target,
    detail: effect.detail,
  };
}

export function projectedEffects(
  record: WireRecord,
): ReadonlyArray<Record<string, unknown>> {
  return record.side_effects.map(projected);
}

/** Type + location only — used where research R6.6 leaves `target` unpinned. */
export function locatedEffects(
  record: WireRecord,
): ReadonlyArray<Record<string, unknown>> {
  return record.side_effects.map((effect) => ({
    type: effect.type,
    location: effect.location,
  }));
}

// The closed effect key set (003 FR-012 requires a classification on every
// analyze effect, superseding 002's FR-019; anything beyond these six keys
// is a wire-shape violation). Exported as the single authority — the
// detector-rules suites and tests/detector.test.ts's local wire-invariant
// check both consume this one copy.
export const EFFECT_KEYS: readonly string[] = [
  "type",
  "description",
  "location",
  "target",
  "detail",
  "classification",
];

// (line, column, type) — the documented within-record effect order (FR-020).
function effectSortKey(effect: WireEffect): readonly [number, number, string] {
  const parts = (effect.location ?? "").split(":");
  const line = Number.parseInt(parts[parts.length - 2] ?? "0", 10);
  const column = Number.parseInt(parts[parts.length - 1] ?? "0", 10);
  return [line, column, effect.type];
}

function compareStrings(a: string, b: string): number {
  if (a < b) {
    return -1;
  }
  if (a > b) {
    return 1;
  }
  return 0;
}

function compareRecordKeys(
  a: readonly [string, number, string],
  b: readonly [string, number, string],
): number {
  if (a[0] !== b[0]) {
    return compareStrings(a[0], b[0]);
  }
  if (a[1] !== b[1]) {
    return a[1] - b[1];
  }
  return compareStrings(a[2], b[2]);
}

function compareEffectKeys(
  a: readonly [number, number, string],
  b: readonly [number, number, string],
): number {
  if (a[0] !== b[0]) {
    return a[0] - b[0];
  }
  if (a[1] !== b[1]) {
    return a[1] - b[1];
  }
  return compareStrings(a[2], b[2]);
}

// The three protocol labels — the membership set serializeClassification
// (src/models.ts) enforces, mirrored here so the wire helper validates the
// same closed set the serializer does.
const CLASSIFICATION_LABELS: ReadonlySet<string> = new Set([
  "contractual",
  "incidental",
  "ambiguous",
]);

/**
 * 003 FR-012 requires every analyze effect to carry a classification, and
 * `serializeClassification` pins its validity: exactly the two fields
 * {label, confidence}, one of the three protocol labels, an integer
 * confidence in 0-100. A missing or malformed value is an analyze-wiring bug
 * (T025), never a soft skip — fail loud, naming the effect. Exported as the
 * single authority: `expectWireInvariants` below and tests/detector.test.ts's
 * local wire-invariant check both consume this one copy — one copy, one
 * authority, never a second validation block to drift.
 */
export function expectValidClassification(effect: WireEffect): void {
  if (effect.classification === undefined) {
    throw new Error(
      `effect of type "${effect.type}" at ${
        effect.location ?? "<unknown location>"
      } carries no classification (003 FR-012)`,
    );
  }
  expect(Object.keys(effect.classification).sort()).toEqual(["confidence", "label"]);
  expect(CLASSIFICATION_LABELS).toContain(effect.classification.label);
  expect(Number.isInteger(effect.classification.confidence)).toBe(true);
  expect(effect.classification.confidence).toBeGreaterThanOrEqual(0);
  expect(effect.classification.confidence).toBeLessThanOrEqual(100);
}

/**
 * FR-018/FR-020 invariants plus 003's classification amendment (FR-012,
 * superseding 002's FR-019) over a whole result: canonical types only (so
 * no alias ever reaches the wire), every effect classified with a
 * serializer-valid {label, confidence}, exact record/effect key sets,
 * package derivation, locations rooted in the record's file, detail only on
 * ambiguity effects, and both documented total orders (records by (file,
 * line, name); effects by (line, column, type)).
 */
export function expectWireInvariants(functions: readonly WireRecord[]): void {
  const recordKeys = functions.map((record): readonly [string, number, string] => [
    record.file,
    record.line,
    record.name,
  ]);
  expect(recordKeys).toEqual([...recordKeys].sort(compareRecordKeys));
  for (const record of functions) {
    expect(Object.keys(record).sort()).toEqual([
      "file",
      "line",
      "name",
      "package",
      "side_effects",
    ]);
    expect(record.package).toBe(derivePackage(record.file));
    const effectKeys = record.side_effects.map(effectSortKey);
    expect(effectKeys).toEqual([...effectKeys].sort(compareEffectKeys));
    for (const effect of record.side_effects) {
      expect(SIDE_EFFECT_TYPES).toContain(effect.type);
      expectValidClassification(effect);
      for (const key of Object.keys(effect)) {
        expect(EFFECT_KEYS).toContain(key);
      }
      expect(typeof effect.description).toBe("string");
      expect(effect.description.length).toBeGreaterThan(0);
      expect(effect.location).toBeDefined();
      expect(effect.location ?? "").toMatch(/^[^:]+:\d+:\d+$/);
      expect((effect.location ?? "").startsWith(`${record.file}:`)).toBe(true);
      if (effect.detail !== undefined) {
        expect(effect.type).toBe("CallbackInvocation");
        expect(effect.detail).toEqual({ confidence: "ambiguous" });
      }
    }
  }
}
