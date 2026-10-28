// Detector conformance suite for the analysis pipeline, src/analysis.ts and
// src/detector.ts (T010; spec US1; SC-001, SC-002; FR-010 through FR-019;
// research R6, R7; Constitution Principles I and II).
//
// RED-FIRST: src/analysis.ts does not exist yet — T012 through T018 create it
// (pattern rules T012, extraction T013, pipeline T014, P0 rules T015, P1
// rules T016, P2-P4 rules T017, ambiguity plus response assembly T018) — so
// this suite fails on module resolution by design (tasks.md: US1 tests are
// written first and observed to FAIL before the paired implementation lands).
// It greens progressively as those tasks land.
//
// ENTRY CONTRACT: every case drives the public analyze entry end-to-end —
// analyze(rootPath, patterns, stderr) from ../src/analysis.js — over an
// mkdtemp fixture tree, then asserts on the serialized records it returns.
// tasks.md T018 documents the entry as "returning serialized
// FunctionRecord[]"; data-model.md's AnalyzeResult section documents
// {"functions": [...]} as the JSON-RPC result payload the server handler
// (T019) assembles around that array. analyzeTree below accepts both
// documented shapes and fails loud on anything else; the wire envelope itself
// is pinned end-to-end by tests/server.test.ts (T011).
//
// ASSERTION DISCIPLINE: effect `description` wording is implementation-
// defined (data-model.md: "deterministic fixed templates ... pinned by golden
// tests, not by the contract"), so effects are projected to the
// contract-pinned fields {type, location, target, detail} and compared with
// toEqual — exact canonical type, exact root-relative file:line:col (1-based
// line and column, per quickstart.md's documented records), exact target,
// zero extra effects. `target` is asserted only where research R6.6 pins it
// (the written path as written, the base identifier for element writes, the
// binding name for identifier writes, the constructor name for
// `throw new X(...)`); forms R6.6 leaves to "omitted otherwise" (method-call
// mutations, yields, spawns, non-`new` throw expressions, sentinel
// declarations) assert type and location only.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { analyze } from "../src/analysis.js";
import { derivePackage } from "../src/models.js";
import { SIDE_EFFECT_TYPES } from "../src/taxonomy.js";
import { createFixtureTree, memorySink } from "./helpers/fixtures.js";

/** One serialized effect as the analyze entry returns it (spec 001 shape). */
interface WireEffect {
  readonly type: string;
  readonly description: string;
  readonly location?: string;
  readonly target?: string;
  readonly detail?: Record<string, unknown>;
}

/** One serialized function record (name, package, file, line, side_effects). */
interface WireRecord {
  readonly name: string;
  readonly package: string;
  readonly file: string;
  readonly line: number;
  readonly side_effects: readonly WireEffect[];
}

// Narrows the entry's result through the two documented shapes (see the
// header's ENTRY CONTRACT note). A missing functions array is a malformed
// result, not a soft zero — fail loud rather than assert against [].
function isFunctionsContainer(
  value: unknown,
): value is { functions: readonly WireRecord[] } {
  return (
    typeof value === "object" &&
    value !== null &&
    Array.isArray((value as { functions?: unknown }).functions)
  );
}

function extractFunctions(result: unknown): readonly WireRecord[] {
  if (Array.isArray(result)) {
    return result as readonly WireRecord[];
  }
  if (isFunctionsContainer(result)) {
    return result.functions;
  }
  throw new Error(
    "unexpected analyze result shape: expected the serialized FunctionRecord[] payload or an object with a functions array",
  );
}

// Runs one analysis with a fresh stderr sink and whole-tree patterns
// (absent). Pattern scoping itself is T008's suite; this file pins detection.
async function analyzeTree(root: string): Promise<{
  functions: readonly WireRecord[];
  stderr: () => string;
}> {
  const sink = memorySink();
  const result: unknown = await analyze(root, undefined, sink.stream);
  return { functions: extractFunctions(result), stderr: sink.text };
}

// Finds the unique record for (name, file) — the one-record-per-fixture
// invariant every table case relies on; a miss or a duplicate is an
// extraction or fixture bug, never a soft match.
function recordFor(
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

// Contract-pinned projection of one effect: every field except the
// implementation-defined description template.
function projected(effect: WireEffect): Record<string, unknown> {
  return {
    type: effect.type,
    location: effect.location,
    target: effect.target,
    detail: effect.detail,
  };
}

function projectedEffects(record: WireRecord): ReadonlyArray<Record<string, unknown>> {
  return record.side_effects.map(projected);
}

// Type + location only — used where R6.6 leaves `target` unpinned.
function locatedEffects(record: WireRecord): ReadonlyArray<Record<string, unknown>> {
  return record.side_effects.map((effect) => ({
    type: effect.type,
    location: effect.location,
  }));
}

function projectRecord(record: WireRecord): Record<string, unknown> {
  return {
    name: record.name,
    package: record.package,
    file: record.file,
    line: record.line,
    effects: record.side_effects.map(projected),
  };
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

// FR-018/FR-019/FR-020 invariants over a whole result: canonical types only
// (so no alias — AsyncTaskSpawn in particular — ever reaches the wire), no
// classification field, exact record/effect key sets, package derivation,
// locations rooted in the record's file, detail only on ambiguity effects,
// and both documented total orders (records by (file, line, name); effects
// by (line, column, type)).
function expectWireInvariants(functions: readonly WireRecord[]): void {
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

// Sources shared between the parse-only and program-mode trees — the mode
// boundary tests analyze the SAME code in both modes and assert that the
// classification differs (FR-015) or the ambiguity set differs (FR-017).
const AMB_EVAL_SOURCE = `export function runCode(code: string): void {
  eval(code);
}
`;

const AMB_FUNCTION_SOURCE = `export function compile(source: string): void {
  const make = new Function(source);
  if (make) {
    return;
  }
}
`;

const AMB_COMPUTED_SOURCE = `export function dispatch(obj: Record<string, () => void>, key: string): void {
  obj[key]();
}
`;

const AMB_ANY_SOURCE = `export function poke(target: any): void {
  target.hit();
}
`;

const AMB_UNKNOWN_SOURCE = `export function callMystery(): void {
  mystery();
}
`;

const PARAM_COMPUTED_SOURCE = `export function writeAt(p: number[], v: number): void {
  p[0] = v;
}
`;

const PARAM_METHODS_SOURCE = `export function appendTo(p: unknown[], v: unknown): void {
  p.push(v);
}
`;

// The method-arm mode boundary: a mutator-named method on a parameter
// whose type is NOT array-like — SliceMutation in parse-only (the
// type-blind name-form), a clean fallthrough under the checker.
const NONARRAY_PARAM_METHODS_SOURCE = `export function appendToObject(p: { push(v: unknown): void }, v: unknown): void {
  p.push(v);
}
`;

// The same tsconfig shape tests/program.test.ts uses to exercise the program
// bootstrap (a valid config whose root set the pipeline overrides anyway).
const TSCONFIG_STRICT =
  '{"compilerOptions": {"strict": true, "target": "ES2022", "module": "commonjs"}}';

// quickstart.md section 1's scratch tree, verbatim; section 3 pins the exact
// expected records (the tree intentionally has no tsconfig — parse-only).
const QUICKSTART_MATH = `export function add(a: number, b: number): number {
  return a + b;
}
`;

const QUICKSTART_SCORE = `export function grade(score: number): string {
  if (score >= 90) {
    return "A";
  }
  return "F";
}
`;

const QUICKSTART_MUTATE = `export class Counter {
  count = 0;

  bump(): void {
    this.count = this.count + 1;
  }
}

export function reset(counter: Counter): void {
  counter.count = 0;
}
`;

const QUICKSTART_TEST = `import { expect, it } from "vitest";
import { add } from "../src/utils/math.js";

it("adds", () => {
  expect(add(1, 2)).toBe(3);
});
`;

describe("P0 conformance fixture table and purity (SC-001, SC-002, FR-011 through FR-014)", () => {
  let root = "";
  let result: readonly WireRecord[] = [];
  let stderr: () => string = () => "";
  let cleanup: (() => Promise<void>) | undefined;

  // One fixture per P0 row, each in its own file so every location
  // assertion is exact (quickstart.md's column convention: 1-based).
  beforeAll(async () => {
    const tree = await createFixtureTree({
      "return-named.ts": `export function addValues(a: number, b: number): number {
  return a + b;
}
`,
      "return-arrow.ts": `export const double = (n: number): number =>
  n * 2;
`,
      "bare-return.ts": `export function maybeRun(flag: boolean): void {
  if (flag) {
    return;
  }
}
`,
      "throw-new.ts": `export function detonate(): void {
  throw new Error("boom");
}
`,
      "throw-expr.ts": `export function rethrow(err: Error): void {
  throw err;
}
`,
      "promise-reject.ts": `export function rejectNow(): void {
  Promise.reject(new Error("nope"));
}
`,
      "async-throw.ts": `export async function failAsync(): Promise<void> {
  throw new Error("async boom");
}
`,
      "process-exit.ts": `export function die(): void {
  process.exit(1);
}
`,
      "sentinel-class.ts": `class BoomError extends Error {}

export function carrier(): void {
  return;
}
`,
      "sentinel-first.ts": `class MarkerError extends Error {}

export function first(): void {
  return;
}

export function second(): void {
  return;
}
`,
      "sentinel-const.ts": `const ERR = new Error("x");

export function carrierConst(): void {
  return;
}
`,
      "sentinel-none.ts": `class LonelyError extends Error {}
`,
      "receiver-simple.ts": `export class Widget {
  size = 0;

  setSize(v: number): void {
    this.size = v;
  }
}
`,
      "receiver-element.ts": `export class Registry {
  [key: string]: string;

  put(k: string, v: string): void {
    this[k] = v;
  }
}
`,
      "receiver-compound.ts": `export class Score {
  points = 0;

  add(n: number): void {
    this.points += n;
  }
}
`,
      "receiver-increment.ts": `export class Tally {
  count = 0;

  tick(): void {
    this.count++;
  }
}
`,
      "receiver-delete.ts": `export class Cache {
  entry?: string;

  drop(): void {
    delete this.entry;
  }
}
`,
      "pointer-simple.ts": `export function setLabel(p: { label: string }, v: string): void {
  p.label = v;
}
`,
      "pointer-compound.ts": `export function addPoints(p: { points: number }, n: number): void {
  p.points += n;
}
`,
      "pointer-delete.ts": `export function dropTag(p: { tag?: string }): void {
  delete p.tag;
}
`,
      "pointer-increment.ts": `export function bumpCount(p: { count: number }): void {
  p.count++;
}
`,
      "pure-arithmetic.ts": `export function pureArithmetic(a: number, b: number): void {
  const total = a + b;
  const average = total / 2;
  if (average < 0) {
    return;
  }
}
`,
      "pure-strings.ts": `export function pureStrings(parts: string[]): void {
  const joined = parts.join("-");
  const upper = joined.toUpperCase();
  if (upper.length > 10) {
    return;
  }
}
`,
      "pure-guard.ts": `export function logFreeGuard(items: unknown[]): void {
  if (items.length === 0) {
    return;
  }
  const first = items[0];
  if (first === undefined) {
    return;
  }
}
`,
    });
    cleanup = tree.cleanup;
    root = tree.root;
    const run = await analyzeTree(root);
    result = run.functions;
    stderr = run.stderr;
  }, 120_000);

  afterAll(async () => {
    await cleanup?.();
  });

  it("ReturnValue: a named function returning an expression reports exactly one effect (FR-011)", () => {
    const record = recordFor(result, "addValues", "return-named.ts");
    expect(record.line).toBe(1);
    expect(projectedEffects(record)).toEqual([
      { type: "ReturnValue", location: "return-named.ts:2:3" },
    ]);
  });

  it("ReturnValue: an arrow with an expression body reports the implicit return at the body expression (FR-011)", () => {
    const record = recordFor(result, "double", "return-arrow.ts");
    expect(record.line).toBe(1);
    // The expression body is the returned value; its start is the
    // construct location.
    expect(projectedEffects(record)).toEqual([
      { type: "ReturnValue", location: "return-arrow.ts:2:3" },
    ]);
  });

  it("ReturnValue: a bare return statement never matches — zero false positives (FR-011)", () => {
    const record = recordFor(result, "maybeRun", "bare-return.ts");
    expect(projectedEffects(record)).toEqual([]);
  });

  it("throw new X dual-emits ErrorReturn and ErrorSignal at one construct, targeted at the constructor name (FR-012, R6.6)", () => {
    const record = recordFor(result, "detonate", "throw-new.ts");
    // Same line:column, so the (line, column, type) order sorts
    // ErrorReturn before ErrorSignal.
    expect(projectedEffects(record)).toEqual([
      { type: "ErrorReturn", location: "throw-new.ts:2:3", target: "Error" },
      { type: "ErrorSignal", location: "throw-new.ts:2:3", target: "Error" },
    ]);
  });

  it("throw of a non-constructor expression dual-emits identically (FR-012)", () => {
    const record = recordFor(result, "rethrow", "throw-expr.ts");
    // R6.6 pins targets only for `throw new X(...)`; the task text and
    // R6.6 disagree on the non-`new` form, so only type and location
    // are pinned here.
    expect(locatedEffects(record)).toEqual([
      { type: "ErrorReturn", location: "throw-expr.ts:2:3" },
      { type: "ErrorSignal", location: "throw-expr.ts:2:3" },
    ]);
  });

  it("Promise.reject dual-emits ErrorReturn and ErrorSignal (FR-012)", () => {
    const record = recordFor(result, "rejectNow", "promise-reject.ts");
    expect(locatedEffects(record)).toEqual([
      { type: "ErrorReturn", location: "promise-reject.ts:2:3" },
      { type: "ErrorSignal", location: "promise-reject.ts:2:3" },
    ]);
  });

  it("a throw inside an async function dual-emits identically — the rejection channel (FR-012)", () => {
    const record = recordFor(result, "failAsync", "async-throw.ts");
    expect(projectedEffects(record)).toEqual([
      { type: "ErrorReturn", location: "async-throw.ts:2:3", target: "Error" },
      { type: "ErrorSignal", location: "async-throw.ts:2:3", target: "Error" },
    ]);
  });

  it("process.exit emits ErrorSignal plus ProcessExit and never ErrorReturn (FR-012)", () => {
    const record = recordFor(result, "die", "process-exit.ts");
    // Same line:column — ErrorSignal sorts before ProcessExit.
    expect(locatedEffects(record)).toEqual([
      { type: "ErrorSignal", location: "process-exit.ts:2:3" },
      { type: "ProcessExit", location: "process-exit.ts:2:3" },
    ]);
    expect(record.side_effects.map((effect) => effect.type)).not.toContain(
      "ErrorReturn",
    );
  });

  it("SentinelError: a module-scope Error subclass attaches to the file's function record (FR-013)", () => {
    const record = recordFor(result, "carrier", "sentinel-class.ts");
    expect(record.line).toBe(3);
    expect(locatedEffects(record)).toEqual([
      { type: "SentinelError", location: "sentinel-class.ts:1:1" },
    ]);
  });

  it("SentinelError: attaches to the FIRST function record in source order, never to later ones (FR-013)", () => {
    const first = recordFor(result, "first", "sentinel-first.ts");
    const second = recordFor(result, "second", "sentinel-first.ts");
    expect(locatedEffects(first)).toEqual([
      { type: "SentinelError", location: "sentinel-first.ts:1:1" },
    ]);
    expect(locatedEffects(second)).toEqual([]);
  });

  it("SentinelError: a module-scope Error-instance constant carries the declaration location (FR-013)", () => {
    const record = recordFor(result, "carrierConst", "sentinel-const.ts");
    expect(locatedEffects(record)).toEqual([
      { type: "SentinelError", location: "sentinel-const.ts:1:1" },
    ]);
  });

  it("SentinelError: a file declaring no functions carries no sentinel and produces no record (FR-013)", () => {
    const lonely = result.filter((record) => record.file === "sentinel-none.ts");
    expect(lonely).toEqual([]);
  });

  it("ReceiverMutation: this.size = v (FR-014)", () => {
    const record = recordFor(result, "setSize", "receiver-simple.ts");
    expect(record.line).toBe(4);
    expect(projectedEffects(record)).toEqual([
      {
        type: "ReceiverMutation",
        location: "receiver-simple.ts:5:5",
        target: "this.size",
      },
    ]);
  });

  it("ReceiverMutation: this[k] = v, targeted at the base identifier (FR-014, R6.6)", () => {
    const record = recordFor(result, "put", "receiver-element.ts");
    expect(record.line).toBe(4);
    expect(projectedEffects(record)).toEqual([
      {
        type: "ReceiverMutation",
        location: "receiver-element.ts:5:5",
        target: "this",
      },
    ]);
  });

  it("ReceiverMutation: compound this.points += n (FR-014)", () => {
    const record = recordFor(result, "add", "receiver-compound.ts");
    expect(record.line).toBe(4);
    expect(projectedEffects(record)).toEqual([
      {
        type: "ReceiverMutation",
        location: "receiver-compound.ts:5:5",
        target: "this.points",
      },
    ]);
  });

  it("ReceiverMutation: increment this.count++ (FR-014)", () => {
    const record = recordFor(result, "tick", "receiver-increment.ts");
    expect(record.line).toBe(4);
    expect(projectedEffects(record)).toEqual([
      {
        type: "ReceiverMutation",
        location: "receiver-increment.ts:5:5",
        target: "this.count",
      },
    ]);
  });

  it("ReceiverMutation: delete this.entry (FR-014)", () => {
    const record = recordFor(result, "drop", "receiver-delete.ts");
    expect(record.line).toBe(4);
    expect(projectedEffects(record)).toEqual([
      {
        type: "ReceiverMutation",
        location: "receiver-delete.ts:5:5",
        target: "this.entry",
      },
    ]);
  });

  it("PointerArgMutation: p.label = v (FR-015 dot-write form)", () => {
    const record = recordFor(result, "setLabel", "pointer-simple.ts");
    expect(record.line).toBe(1);
    expect(projectedEffects(record)).toEqual([
      {
        type: "PointerArgMutation",
        location: "pointer-simple.ts:2:3",
        target: "p.label",
      },
    ]);
  });

  it("PointerArgMutation: compound p.points += n (FR-015)", () => {
    const record = recordFor(result, "addPoints", "pointer-compound.ts");
    expect(projectedEffects(record)).toEqual([
      {
        type: "PointerArgMutation",
        location: "pointer-compound.ts:2:3",
        target: "p.points",
      },
    ]);
  });

  it("PointerArgMutation: delete p.tag (FR-015)", () => {
    const record = recordFor(result, "dropTag", "pointer-delete.ts");
    expect(projectedEffects(record)).toEqual([
      {
        type: "PointerArgMutation",
        location: "pointer-delete.ts:2:3",
        target: "p.tag",
      },
    ]);
  });

  it("PointerArgMutation: increment p.count++ (FR-015)", () => {
    const record = recordFor(result, "bumpCount", "pointer-increment.ts");
    expect(projectedEffects(record)).toEqual([
      {
        type: "PointerArgMutation",
        location: "pointer-increment.ts:2:3",
        target: "p.count",
      },
    ]);
  });

  describe("purity (SC-002)", () => {
    it("pure arithmetic — locals, reads, and a bare guard return — reports no effects", () => {
      const record = recordFor(result, "pureArithmetic", "pure-arithmetic.ts");
      expect(projectedEffects(record)).toEqual([]);
    });

    it("pure string building reports no effects", () => {
      const record = recordFor(result, "pureStrings", "pure-strings.ts");
      expect(projectedEffects(record)).toEqual([]);
    });

    it("a log-free guard reports no effects", () => {
      const record = recordFor(result, "logFreeGuard", "pure-guard.ts");
      expect(projectedEffects(record)).toEqual([]);
    });
  });

  it("wire shape over the P0 table: canonical types, no classification, key sets, and both documented orders (FR-018, FR-019, FR-020)", () => {
    expectWireInvariants(result);
  });

  it("a clean tree writes no stderr diagnostics", () => {
    expect(stderr()).toBe("");
  });
});

describe("P1 rules, carve-outs, and ambiguity in parse-only mode (FR-014 through FR-017, research R7)", () => {
  let root = "";
  let result: readonly WireRecord[] = [];
  let stderr: () => string = () => "";
  let cleanup: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    const tree = await createFixtureTree({
      "values.ts": "export let value = 1;\n",
      "global-let.ts": `let count = 0;

export function bumpGlobal(): void {
  count = count + 1;
}
`,
      "global-import.ts": `import { value } from "./values.js";

export function reassignImport(): void {
  value = 5;
}
`,
      "spawn.ts": `export function spawnPromise(): void {
  new Promise<void>((resolve) => {
    resolve();
  });
}

export function spawnTimeout(): void {
  setTimeout(() => {}, 10);
}

export function spawnInterval(): void {
  setInterval(() => {}, 10);
}

export function spawnMicrotask(): void {
  queueMicrotask(() => {});
}

export function spawnNextTick(): void {
  process.nextTick(() => {});
}
`,
      "deferred.ts": `export function later(): void {
  let total = 0;
  setTimeout(() => {
    total = total + 1;
  }, 10);
}
`,
      "closure.ts": `export function makeCounter(): () => number {
  let total = 0;
  const tick = (): number => {
    total = total + 1;
    return total;
  };
  return tick;
}
`,
      "yield.ts": `export function* countdown(): Generator<number> {
  yield 3;
  yield* [1, 2];
}
`,
      "carve-out-local.ts": `function helper(n: number): number {
  return n + 1;
}

export function caller(v: number): void {
  helper(v);
}
`,
      "amb-eval.ts": AMB_EVAL_SOURCE,
      "amb-function.ts": AMB_FUNCTION_SOURCE,
      "amb-computed.ts": AMB_COMPUTED_SOURCE,
      "amb-any.ts": AMB_ANY_SOURCE,
      "amb-unknown.ts": AMB_UNKNOWN_SOURCE,
      "param-computed.ts": PARAM_COMPUTED_SOURCE,
      "param-methods.ts": PARAM_METHODS_SOURCE,
      "param-methods-nonarray.ts": NONARRAY_PARAM_METHODS_SOURCE,
    });
    cleanup = tree.cleanup;
    root = tree.root;
    const run = await analyzeTree(root);
    result = run.functions;
    stderr = run.stderr;
  }, 120_000);

  afterAll(async () => {
    await cleanup?.();
  });

  it("GlobalMutation: writing a module-scope let from inside a function (FR-014)", () => {
    const record = recordFor(result, "bumpGlobal", "global-let.ts");
    expect(record.line).toBe(3);
    expect(projectedEffects(record)).toEqual([
      {
        type: "GlobalMutation",
        location: "global-let.ts:4:3",
        target: "count",
      },
    ]);
  });

  it("GlobalMutation: writing an imported binding — a module-scope binding — from inside a function (FR-014)", () => {
    const record = recordFor(result, "reassignImport", "global-import.ts");
    expect(record.line).toBe(3);
    expect(projectedEffects(record)).toEqual([
      {
        type: "GlobalMutation",
        location: "global-import.ts:4:3",
        target: "value",
      },
    ]);
  });

  it("GoroutineSpawn: new Promise, setTimeout, setInterval, queueMicrotask, and process.nextTick each emit exactly one spawn effect (FR-016)", () => {
    const cases: ReadonlyArray<[string, string]> = [
      ["spawnPromise", "spawn.ts:2:3"],
      ["spawnTimeout", "spawn.ts:8:3"],
      ["spawnInterval", "spawn.ts:12:3"],
      ["spawnMicrotask", "spawn.ts:16:3"],
      ["spawnNextTick", "spawn.ts:20:3"],
    ];
    for (const [name, location] of cases) {
      expect(locatedEffects(recordFor(result, name, "spawn.ts"))).toEqual([
        { type: "GoroutineSpawn", location },
      ]);
    }
  });

  it("the AsyncTaskSpawn alias never reaches the wire — scheduling constructs emit canonical GoroutineSpawn (FR-016, FR-018)", () => {
    const types = result.flatMap((record) =>
      record.side_effects.map((effect) => effect.type),
    );
    expect(types).not.toContain("AsyncTaskSpawn");
    expect(types).toContain("GoroutineSpawn");
  });

  it("DeferredReturnMutation: writing an enclosing function-scope binding inside a setTimeout callback pairs with the spawn (FR-014, research R6.5)", () => {
    const record = recordFor(result, "later", "deferred.ts");
    expect(projectedEffects(record)).toEqual([
      { type: "GoroutineSpawn", location: "deferred.ts:3:3" },
      {
        type: "DeferredReturnMutation",
        location: "deferred.ts:4:5",
        target: "total",
      },
    ]);
  });

  it("closure writes to enclosing function-scope bindings are never GlobalMutation, and innermost attribution keeps them off the enclosing record (FR-014, FR-009)", () => {
    const outer = recordFor(result, "makeCounter", "closure.ts");
    // makeCounter's only effect is its own return: the closure write
    // belongs to the nested extracted record (FR-009), never to the
    // outer function, and never as GlobalMutation.
    expect(projectedEffects(outer)).toEqual([
      { type: "ReturnValue", location: "closure.ts:7:3" },
    ]);
    const tick = recordFor(result, "tick", "closure.ts");
    expect(tick.side_effects.map((effect) => effect.type)).not.toContain(
      "GlobalMutation",
    );
    // ClosureCaptureMutation itself is P4 best-effort (FR-010 MAY), so
    // its presence is deliberately not pinned — only the FR-014 MUST NOT.
    expect(locatedEffects(tick)).toContainEqual({
      type: "ReturnValue",
      location: "closure.ts:5:5",
    });
  });

  it("GeneratorYield: yield and yield* in a synchronous generator each emit one effect (P1 must, FR-010)", () => {
    const record = recordFor(result, "countdown", "yield.ts");
    expect(locatedEffects(record)).toEqual([
      { type: "GeneratorYield", location: "yield.ts:2:3" },
      { type: "GeneratorYield", location: "yield.ts:3:3" },
    ]);
  });

  it("ambiguity: eval reports a CallbackInvocation with detail.confidence ambiguous (FR-017)", () => {
    const record = recordFor(result, "runCode", "amb-eval.ts");
    expect(projectedEffects(record)).toEqual([
      {
        type: "CallbackInvocation",
        location: "amb-eval.ts:2:3",
        detail: { confidence: "ambiguous" },
      },
    ]);
  });

  it("ambiguity: new Function reports an ambiguous CallbackInvocation (FR-017)", () => {
    const record = recordFor(result, "compile", "amb-function.ts");
    expect(projectedEffects(record)).toEqual([
      {
        type: "CallbackInvocation",
        location: "amb-function.ts:2:16",
        detail: { confidence: "ambiguous" },
      },
    ]);
  });

  it("ambiguity: a call through a computed member reports an ambiguous CallbackInvocation (FR-017)", () => {
    const record = recordFor(result, "dispatch", "amb-computed.ts");
    expect(projectedEffects(record)).toEqual([
      {
        type: "CallbackInvocation",
        location: "amb-computed.ts:2:3",
        detail: { confidence: "ambiguous" },
      },
    ]);
  });

  it("the mode boundary: parse-only does NOT add type-based ambiguity for any-typed receivers or unknown-global callees (FR-017, R7)", () => {
    const anyReceiver = recordFor(result, "poke", "amb-any.ts");
    expect(projectedEffects(anyReceiver)).toEqual([]);
    const unknownCallee = recordFor(result, "callMystery", "amb-unknown.ts");
    expect(projectedEffects(unknownCallee)).toEqual([]);
  });

  it("the zero-false-positive carve-out: calls resolving to a locally-defined function are never reported (FR-017)", () => {
    const caller = recordFor(result, "caller", "carve-out-local.ts");
    expect(projectedEffects(caller)).toEqual([]);
    const helper = recordFor(result, "helper", "carve-out-local.ts");
    expect(projectedEffects(helper)).toEqual([
      { type: "ReturnValue", location: "carve-out-local.ts:2:3" },
    ]);
  });

  it("parse-only computed-key writes on parameters default to MapMutation — the documented false-positive surface (FR-015)", () => {
    const record = recordFor(result, "writeAt", "param-computed.ts");
    expect(projectedEffects(record)).toEqual([
      { type: "MapMutation", location: "param-computed.ts:2:3", target: "p" },
    ]);
  });

  it("parse-only mutating array methods on parameters are still SliceMutation — the type-blind name-form surface (FR-015)", () => {
    const record = recordFor(result, "appendTo", "param-methods.ts");
    expect(locatedEffects(record)).toEqual([
      { type: "SliceMutation", location: "param-methods.ts:2:3" },
    ]);
  });

  it("parse-only mutating array methods on NON-array-typed parameters are still SliceMutation — no checker to consult, the name and shape decide (FR-015)", () => {
    const record = recordFor(result, "appendToObject", "param-methods-nonarray.ts");
    expect(locatedEffects(record)).toEqual([
      { type: "SliceMutation", location: "param-methods-nonarray.ts:2:3" },
    ]);
  });

  it("wire shape over the P1/ambiguity tree: canonical types, no classification, key sets, and both documented orders (FR-018, FR-019, FR-020)", () => {
    expectWireInvariants(result);
  });

  it("a clean tree writes no stderr diagnostics", () => {
    expect(stderr()).toBe("");
  });

  it("repeated analysis of the same tree produces identical serialized records (FR-020, SC-006)", {
    timeout: 120_000,
  }, async () => {
    const again = await analyzeTree(root);
    expect(JSON.stringify(again.functions)).toBe(JSON.stringify(result));
    expect(again.stderr()).toBe("");
  });
});

describe("FR-015 param-write split and type-based ambiguity in program mode (checker available, FR-003)", () => {
  let result: readonly WireRecord[] = [];
  let stderr: () => string = () => "";
  let cleanup: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    const tree = await createFixtureTree({
      "tsconfig.json": TSCONFIG_STRICT,
      "fr015-array.ts": `export function arrayWrites(p: number[], i: number, v: number): void {
  p[0] = v;
  p.push(v);
  p.pop();
  p.shift();
  p.unshift(v);
  p.splice(i, 1);
  p.sort();
  p.reverse();
  p.fill(0);
  p.copyWithin(0, 1);
  p.length = 0;
}
`,
      "fr015-length.ts": `export function truncate(p: number[]): void {
  p.length = 0;
}
`,
      "fr015-map.ts": `export function mapWrite(p: Map<string, number>, k: string, v: number): void {
  p.set(k, v);
}
`,
      "fr015-record.ts": `export function recordWrite(p: Record<string, number>, k: string, v: number): void {
  p[k] = v;
}
`,
      "fr015-set.ts": `export function setOps(values: Set<string>, v: string): void {
  values.add(v);
  values.delete(v);
  values.clear();
}
`,
      "fr015-map-membership.ts": `export function mapMembership(p: Map<string, number>, k: string): void {
  p.delete(k);
  p.clear();
}
`,
      "fr015-weak.ts": `export function weakOps(tags: WeakSet<object>, cache: WeakMap<object, number>, k: object, v: number): void {
  tags.add(k);
  tags.delete(k);
  cache.set(k, v);
  cache.delete(k);
}
`,
      "fr015-local.ts": `export function localContainers(v: string): void {
  const seen = new Set<string>();
  seen.add(v);
  seen.clear();
}
`,
      "param-computed.ts": PARAM_COMPUTED_SOURCE,
      "param-methods.ts": PARAM_METHODS_SOURCE,
      "param-methods-nonarray.ts": NONARRAY_PARAM_METHODS_SOURCE,
      "nameform-edges.ts": `export function sendJson(res: { json(body: unknown): void }, body: unknown): void {
  res.json(body);
}

export function closePort(port: { close(): void }): void {
  port.close();
}

export function cancelWork(controller: { abort(): void }): void {
  controller.abort();
}
`,
      "amb-eval.ts": AMB_EVAL_SOURCE,
      "amb-function.ts": AMB_FUNCTION_SOURCE,
      "amb-computed.ts": AMB_COMPUTED_SOURCE,
      "amb-any.ts": AMB_ANY_SOURCE,
      "amb-unknown.ts": AMB_UNKNOWN_SOURCE,
    });
    cleanup = tree.cleanup;
    const run = await analyzeTree(tree.root);
    result = run.functions;
    stderr = run.stderr;
  }, 120_000);

  afterAll(async () => {
    await cleanup?.();
  });

  it("element writes and the nine mutating array methods on an array-typed parameter are all SliceMutation, never PointerArgMutation (FR-015)", () => {
    const record = recordFor(result, "arrayWrites", "fr015-array.ts");
    expect(locatedEffects(record)).toEqual([
      { type: "SliceMutation", location: "fr015-array.ts:2:3" },
      { type: "SliceMutation", location: "fr015-array.ts:3:3" },
      { type: "SliceMutation", location: "fr015-array.ts:4:3" },
      { type: "SliceMutation", location: "fr015-array.ts:5:3" },
      { type: "SliceMutation", location: "fr015-array.ts:6:3" },
      { type: "SliceMutation", location: "fr015-array.ts:7:3" },
      { type: "SliceMutation", location: "fr015-array.ts:8:3" },
      { type: "SliceMutation", location: "fr015-array.ts:9:3" },
      { type: "SliceMutation", location: "fr015-array.ts:10:3" },
      { type: "SliceMutation", location: "fr015-array.ts:11:3" },
      { type: "SliceMutation", location: "fr015-array.ts:12:3" },
    ]);
    expect(record.side_effects.map((effect) => effect.type)).not.toContain(
      "PointerArgMutation",
    );
  });

  it("p.length = 0 on an array-typed parameter is SliceMutation — the array-truncation carve-out — never PointerArgMutation (FR-015)", () => {
    const record = recordFor(result, "truncate", "fr015-length.ts");
    expect(projectedEffects(record)).toEqual([
      {
        type: "SliceMutation",
        location: "fr015-length.ts:2:3",
        target: "p.length",
      },
    ]);
  });

  it("Map.set on a Map-typed parameter is MapMutation (FR-015)", () => {
    const record = recordFor(result, "mapWrite", "fr015-map.ts");
    expect(locatedEffects(record)).toEqual([
      { type: "MapMutation", location: "fr015-map.ts:2:3" },
    ]);
  });

  it("a computed-key write on a record-typed parameter is MapMutation, targeted at the base identifier (FR-015, R6.6)", () => {
    const record = recordFor(result, "recordWrite", "fr015-record.ts");
    expect(projectedEffects(record)).toEqual([
      { type: "MapMutation", location: "fr015-record.ts:2:3", target: "p" },
    ]);
  });

  it("Set.add/delete/clear on a parameter are ContainerMutation — only Map.set follows the MapMutation split (FR-015)", () => {
    const record = recordFor(result, "setOps", "fr015-set.ts");
    expect(locatedEffects(record)).toEqual([
      { type: "ContainerMutation", location: "fr015-set.ts:2:3" },
      { type: "ContainerMutation", location: "fr015-set.ts:3:3" },
      { type: "ContainerMutation", location: "fr015-set.ts:4:3" },
    ]);
  });

  it("Map.delete/clear on a parameter are ContainerMutation (FR-015)", () => {
    const record = recordFor(result, "mapMembership", "fr015-map-membership.ts");
    expect(locatedEffects(record)).toEqual([
      { type: "ContainerMutation", location: "fr015-map-membership.ts:2:3" },
      { type: "ContainerMutation", location: "fr015-map-membership.ts:3:3" },
    ]);
  });

  it("WeakSet.add/delete and WeakMap.set/delete are ContainerMutation (FR-015)", () => {
    const record = recordFor(result, "weakOps", "fr015-weak.ts");
    expect(locatedEffects(record)).toEqual([
      { type: "ContainerMutation", location: "fr015-weak.ts:2:3" },
      { type: "ContainerMutation", location: "fr015-weak.ts:3:3" },
      { type: "ContainerMutation", location: "fr015-weak.ts:4:3" },
      { type: "ContainerMutation", location: "fr015-weak.ts:5:3" },
    ]);
  });

  it("membership methods on non-parameter (local) receivers are ContainerMutation (FR-015)", () => {
    const record = recordFor(result, "localContainers", "fr015-local.ts");
    expect(locatedEffects(record)).toEqual([
      { type: "ContainerMutation", location: "fr015-local.ts:3:3" },
      { type: "ContainerMutation", location: "fr015-local.ts:4:3" },
    ]);
  });

  it("the mode boundary in reverse: with the checker, an element write on an array-typed parameter is SliceMutation (FR-015)", () => {
    const record = recordFor(result, "writeAt", "param-computed.ts");
    expect(projectedEffects(record)).toEqual([
      { type: "SliceMutation", location: "param-computed.ts:2:3", target: "p" },
    ]);
  });

  it("mutating array methods on parameters stay SliceMutation under the checker (FR-015)", () => {
    const record = recordFor(result, "appendTo", "param-methods.ts");
    expect(locatedEffects(record)).toEqual([
      { type: "SliceMutation", location: "param-methods.ts:2:3" },
    ]);
  });

  it("the method-arm mode boundary: a mutating array method on a NON-array-typed parameter is not SliceMutation under the checker — the call falls through clean (FR-015)", () => {
    const record = recordFor(result, "appendToObject", "param-methods-nonarray.ts");
    expect(projectedEffects(record)).toEqual([]);
  });

  it("name-form persistence under the checker: res.json on a non-Response-typed receiver named res still emits HTTPResponseWrite (FR-015)", () => {
    const record = recordFor(result, "sendJson", "nameform-edges.ts");
    expect(locatedEffects(record)).toEqual([
      { type: "HTTPResponseWrite", location: "nameform-edges.ts:2:3" },
    ]);
  });

  it("name-form persistence under the checker: port.close on a non-MessagePort-typed receiver named port still emits ChannelClose — never ResourceManagement (FR-015)", () => {
    const record = recordFor(result, "closePort", "nameform-edges.ts");
    expect(locatedEffects(record)).toEqual([
      { type: "ChannelClose", location: "nameform-edges.ts:6:3" },
    ]);
  });

  it("name-form persistence under the checker: .abort on a non-AbortController-typed receiver still emits ContextCancellation — receiver-blind in both modes (FR-015)", () => {
    const record = recordFor(result, "cancelWork", "nameform-edges.ts");
    expect(locatedEffects(record)).toEqual([
      { type: "ContextCancellation", location: "nameform-edges.ts:10:3" },
    ]);
  });

  it("type-based ambiguity: a call on an any-typed receiver reports an ambiguous CallbackInvocation — program mode only (FR-017, R7)", () => {
    const record = recordFor(result, "poke", "amb-any.ts");
    expect(projectedEffects(record)).toEqual([
      {
        type: "CallbackInvocation",
        location: "amb-any.ts:2:3",
        detail: { confidence: "ambiguous" },
      },
    ]);
  });

  it("type-based ambiguity: a callee resolving to no declaration reports an ambiguous CallbackInvocation — program mode only (FR-017, R7)", () => {
    const record = recordFor(result, "callMystery", "amb-unknown.ts");
    expect(projectedEffects(record)).toEqual([
      {
        type: "CallbackInvocation",
        location: "amb-unknown.ts:2:3",
        detail: { confidence: "ambiguous" },
      },
    ]);
  });

  it("the syntactic ambiguity forms also report in program mode — eval, new Function, and computed members fire in both modes (FR-017)", () => {
    const evaluated = recordFor(result, "runCode", "amb-eval.ts");
    expect(projectedEffects(evaluated)).toEqual([
      {
        type: "CallbackInvocation",
        location: "amb-eval.ts:2:3",
        detail: { confidence: "ambiguous" },
      },
    ]);
    const constructed = recordFor(result, "compile", "amb-function.ts");
    expect(projectedEffects(constructed)).toEqual([
      {
        type: "CallbackInvocation",
        location: "amb-function.ts:2:16",
        detail: { confidence: "ambiguous" },
      },
    ]);
    const computed = recordFor(result, "dispatch", "amb-computed.ts");
    expect(projectedEffects(computed)).toEqual([
      {
        type: "CallbackInvocation",
        location: "amb-computed.ts:2:3",
        detail: { confidence: "ambiguous" },
      },
    ]);
  });

  it("wire shape over the program-mode tree: canonical types, no classification, key sets, and both documented orders (FR-018, FR-019, FR-020)", () => {
    expectWireInvariants(result);
  });

  it("a clean tree writes no stderr diagnostics", () => {
    expect(stderr()).toBe("");
  });
});

describe("quickstart conformance tree: the documented records in both bootstrap modes (SC-001, FR-003, FR-004)", () => {
  // quickstart.md section 3's exact expected records (name, package, file,
  // line, and the projected effects), ordered by (file, line, name).
  const expectedRecords: ReadonlyArray<Record<string, unknown>> = [
    {
      name: "bump",
      package: "src.mutate",
      file: "src/mutate.ts",
      line: 4,
      effects: [
        {
          type: "ReceiverMutation",
          location: "src/mutate.ts:5:5",
          target: "this.count",
        },
      ],
    },
    {
      name: "reset",
      package: "src.mutate",
      file: "src/mutate.ts",
      line: 9,
      effects: [
        {
          type: "PointerArgMutation",
          location: "src/mutate.ts:10:3",
          target: "counter.count",
        },
      ],
    },
    {
      name: "grade",
      package: "src.score",
      file: "src/score.ts",
      line: 1,
      effects: [
        { type: "ReturnValue", location: "src/score.ts:3:5" },
        { type: "ReturnValue", location: "src/score.ts:5:3" },
      ],
    },
    {
      name: "add",
      package: "src.utils.math",
      file: "src/utils/math.ts",
      line: 1,
      effects: [{ type: "ReturnValue", location: "src/utils/math.ts:2:3" }],
    },
  ];

  function quickstartFiles(): Record<string, string> {
    return {
      "src/utils/math.ts": QUICKSTART_MATH,
      "src/score.ts": QUICKSTART_SCORE,
      "src/mutate.ts": QUICKSTART_MUTATE,
      "tests/math.test.ts": QUICKSTART_TEST,
    };
  }

  it("parse-only (no tsconfig): the exact documented records, ordered by (file, line, name), with no records from the test file (SC-001, SC-005)", {
    timeout: 120_000,
  }, async () => {
    const tree = await createFixtureTree(quickstartFiles());
    try {
      const run = await analyzeTree(tree.root);
      expect(run.functions.map(projectRecord)).toEqual(expectedRecords);
      expectWireInvariants(run.functions);
      expect(run.stderr()).toBe("");
    } finally {
      await tree.cleanup();
    }
  });

  it("program mode (valid tsconfig): the same tree produces the identical documented records (FR-003, quickstart.md)", {
    timeout: 120_000,
  }, async () => {
    const tree = await createFixtureTree({
      ...quickstartFiles(),
      "tsconfig.json": TSCONFIG_STRICT,
    });
    try {
      const run = await analyzeTree(tree.root);
      expect(run.functions.map(projectRecord)).toEqual(expectedRecords);
      expectWireInvariants(run.functions);
      expect(run.stderr()).toBe("");
    } finally {
      await tree.cleanup();
    }
  });
});
