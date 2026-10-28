// Shared wire-level scaffolding for the detector rule suites.
//
// The review council's test-conventions finding (dispatch 44e85014) called out
// memorySink being copied into every new suite and recommended shared test
// helpers under tests/helpers/. This module is that consolidation for the
// detector-rules suites: the stderr sink, the analyze-entry driver, the
// record lookup, the contract-pinned effect projections, and the FR-018
// through FR-020 wire invariants — the same code tests/detector.test.ts
// carries per-file (its copies stay untouched; merging them is a separate
// cross-file change).
//
// ASSERTION DISCIPLINE (same as tests/detector.test.ts): effect
// `description` wording is implementation-defined, so effects are projected
// to the contract-pinned fields {type, location, target, detail} and compared
// with toEqual — exact canonical type, exact root-relative file:line:col
// (1-based), exact target where research R6.6 pins it, zero extra effects.
import { Writable } from "node:stream";
import { expect } from "vitest";
import { analyze } from "../../src/analysis.js";
import { derivePackage } from "../../src/models.js";
import { SIDE_EFFECT_TYPES } from "../../src/taxonomy.js";

/** One serialized effect as the analyze entry returns it. */
export interface WireEffect {
  readonly type: string;
  readonly description: string;
  readonly location?: string;
  readonly target?: string;
  readonly detail?: Record<string, unknown>;
}

/** One serialized function record (name, package, file, line, side_effects). */
export interface WireRecord {
  readonly name: string;
  readonly package: string;
  readonly file: string;
  readonly line: number;
  readonly side_effects: readonly WireEffect[];
}

/** In-memory stand-in for the Server's stderr diagnostics channel. */
export function memorySink(): { stream: Writable; text: () => string } {
  const chunks: string[] = [];
  const stream = new Writable({
    decodeStrings: false,
    write(
      chunk: string | Uint8Array,
      _encoding: string,
      callback: (error?: Error | null) => void,
    ): void {
      const decoded =
        typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
      chunks.push(decoded);
      callback();
    },
  });
  return { stream, text: () => chunks.join("") };
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

// The closed effect key set (FR-019 forbids classification; anything else
// beyond these five keys is a wire-shape violation).
const EFFECT_KEYS: readonly string[] = [
  "type",
  "description",
  "location",
  "target",
  "detail",
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

/**
 * FR-018/FR-019/FR-020 invariants over a whole result: canonical types only
 * (so no alias ever reaches the wire), no classification field, exact
 * record/effect key sets, package derivation, locations rooted in the
 * record's file, detail only on ambiguity effects, and both documented
 * total orders (records by (file, line, name); effects by (line, column,
 * type)).
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
      expect("classification" in effect).toBe(false);
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
