/**
 * Caller-index conformance suite (T007, FR-016; research R7; data-model.md
 * Section 5.2).
 *
 * src/signals/caller-index.ts (T009) builds the import-graph-derived
 * CallerIndex: `buildCallerIndex(context, records, inScopePaths)` maps every
 * extraction record to the number of DISTINCT in-scope modules whose call
 * sites resolve to it through the native checker. This suite drives the
 * real pipeline — `prepareAnalysis` over multi-module `createFixtureTree`
 * trees, the index built while the program-mode context is live — so every
 * scenario exercises the exact surfaces T024's adapter will compose.
 *
 * RED-FIRST: this suite was written and observed failing before
 * src/signals/caller-index.ts existed (the module-resolution failure is the
 * red observation), per the task-pairing discipline in tasks.md.
 *
 * Scenario coverage (spec.md US3):
 *
 * - US3-1..4, the count ladder: functions called from exactly 0, 1, 2, 3,
 *   4, and 5 distinct modules yield exactly those counts. The
 *   COUNTS — not the bucket weights — are this index's contract; the
 *   +5/+10/+15 buckets are T010's pure rule over the counts, pinned
 *   separately by tests/signals/caller.test.ts (T008).
 * - US3-5: multiple call sites within one module count that module once.
 * - US3-6: self-recursion is not an inbound caller — positions inside the
 *   record's own body span are excluded.
 * - US3-7: the index is built over the identical discovered,
 *   pattern-filtered, exclusion-filtered file set as `analyze` — both
 *   driven over the same request, the index through T006's `inScopePaths`
 *   and `analyze` through its own response, whose file set and records
 *   must be identical; calls positioned in pattern-excluded or
 *   test-classified files are dropped.
 *
 * Checker-resolution forms (research R7): instance-method calls
 * (`counter.bump()`) and aliased imports (`quad as tagged`) resolve through
 * the checker, as do the three expression forms — variable-assigned,
 * class-property, and object-literal-property arrows — via their
 * name-giving parent declarations. The documented boundaries
 * (data-model.md Section 5.2's resolve-no-caller list: anonymous
 * default-export expressions, accessors, constructors) are pinned as 0s
 * with live usage sites present, so a checker-surface change that silently
 * altered them fails here.
 *
 * Degradation and safety:
 *
 * - Parse-only mode (no tsconfig) yields an empty index — research R7's
 *   documented boundary; degradation reduces precision, never availability.
 * - Constitution Principle V: the index is strictly static. The canary tree
 *   plants a module whose top level throws and puts it inside the
 *   compiler's resolved import graph; any execution or import of analyzed
 *   code would crash the analyzer process with that exact message.
 */

import { afterEach, describe, expect, it } from "vitest";
import { analyze, prepareAnalysis } from "../../src/analysis.js";
import type { ExtractionRecord } from "../../src/extract.js";
import { buildCallerIndex, type CallerIndex } from "../../src/signals/caller-index.js";
import {
  createFixtureTree,
  drainCleanups,
  memorySink,
  registerCleanup,
} from "../helpers/fixtures.js";
import { extractFunctions as wireRecords } from "../helpers/wire.js";

// Fixture trees register their cleanup with the shared helpers so every
// test body stays linear; afterEach drains the queue in creation order.
afterEach(async () => {
  await drainCleanups();
});

// A plain strict config for the program-mode fixtures (the extract suite's
// TSCONFIG): no include/files of its own to interfere — the bootstrap's
// extender config overrides the root set anyway — and target ES2022 so
// class-property initializers are native.
const TSCONFIG = '{"compilerOptions": {"strict": true, "target": "ES2022"}}';

function withTsconfig(
  sources: Readonly<Record<string, string>>,
): Record<string, string> {
  return { ...sources, "tsconfig.json": TSCONFIG };
}

// The count tree: seven modules over util.ts exercising the full count
// ladder plus every checker-resolution form. Expected distinct-module
// counts, enumerated per record (20 records total):
//
//   zero            0  called by nobody
//   solo            1  main.ts (in mainRun)
//   boot            1  main.ts (module level ONLY — pins that module-level
//                        call sites count, not just call sites in bodies)
//   triple          3  alpha.ts, beta.ts, main.ts
//   quart           4  alpha.ts, beta.ts, main.ts, delta.ts — the exact-4
//                        boundary of the "four or more" ladder
//   quad            5  util.ts (siblingCaller — the defining module),
//                      alpha.ts, beta.ts (aliased `tagged`, three sites),
//                      main.ts (module level + mainRun), delta.ts
//   selfRec         0  its own body's call is positionally excluded (US3-6)
//   siblingCaller   0  called by nobody
//   bump            2  util.ts (callBump), beta.ts (betaBump) — instance
//                      methods through two different receiver names
//   callBump        0  called by nobody
//   makeTag         1  gamma.ts (two sites — US3-5: one module, once)
//   add             1  gamma.ts — class-property arrow
//   render          1  gamma.ts — object-literal-property arrow
//   *Run, betaDouble, betaBump  0  defined, called by nobody
//
// quad's five modules pin five separate rules at once: drop the sibling
// call and the count is 4; drop module-level sites and it is 4; count
// beta's three sites separately and it is 7; count gamma-style site
// multiplicity anywhere and it moves — every misreading of the contract
// moves the number.
const COUNT_TREE: Readonly<Record<string, string>> = {
  "src/util.ts": [
    "export function zero(): number {",
    "  return 0;",
    "}",
    "",
    "export function solo(n: number): number {",
    "  return n + 1;",
    "}",
    "",
    "export function triple(n: number): number {",
    "  return n + 3;",
    "}",
    "",
    "export function quad(n: number): number {",
    "  return n + 4;",
    "}",
    "",
    "export function quart(n: number): number {",
    "  return n;",
    "}",
    "",
    "export function selfRec(n: number): number {",
    "  if (n <= 0) {",
    "    return 0;",
    "  }",
    "  return selfRec(n - 1);",
    "}",
    "",
    "export function siblingCaller(): number {",
    "  return quad(1);",
    "}",
    "",
    "export class Counter {",
    "  count = 0;",
    "",
    "  bump(): void {",
    "    this.count += 1;",
    "  }",
    "}",
    "",
    "export function callBump(counter: Counter): void {",
    "  counter.bump();",
    "}",
  ].join("\n"),
  "src/alpha.ts": [
    'import { triple, quad, quart } from "./util";',
    "",
    "export function alphaRun(): number {",
    "  return triple(1) + quad(1) + quart(1);",
    "}",
  ].join("\n"),
  "src/beta.ts": [
    'import { quad as tagged, triple, quart, Counter } from "./util";',
    "",
    "export function betaRun(): number {",
    "  return tagged(1) + triple(1) + quart(2);",
    "}",
    "",
    "export function betaBump(counter: Counter): void {",
    "  counter.bump();",
    "}",
    "",
    "export function betaDouble(): number {",
    "  return tagged(1) + tagged(2);",
    "}",
  ].join("\n"),
  "src/main.ts": [
    'import { quad, solo, triple, quart } from "./util";',
    "",
    "export function boot(n: number): number {",
    "  return n;",
    "}",
    "",
    "const bootstrapped = quad(1);",
    "const wired = boot(1);",
    "",
    "export function mainRun(): number {",
    "  return solo(1) + triple(1) + quad(2) + quart(3);",
    "}",
  ].join("\n"),
  "src/arrows.ts": [
    "export const makeTag = (n: number): number => {",
    "  return n + 1;",
    "};",
    "",
    "export class Tagger {",
    "  parts: number[] = [];",
    "",
    "  add = (n: number): void => {",
    "    this.parts.push(n);",
    "  };",
    "}",
    "",
    "export const renderer = {",
    "  render: (n: number): number => {",
    "    return n + 2;",
    "  },",
    "};",
  ].join("\n"),
  "src/gamma.ts": [
    'import { makeTag, Tagger, renderer } from "./arrows";',
    "",
    "export function gammaRun(): number {",
    "  const tagger = new Tagger();",
    "  tagger.add(1);",
    "  return makeTag(1) + makeTag(2) + renderer.render(1);",
    "}",
  ].join("\n"),
  "src/delta.ts": [
    'import { quad, quart } from "./util";',
    "",
    "export function deltaRun(): number {",
    "  return quad(1) + quart(1);",
    "}",
  ].join("\n"),
};

// The parity tree: one function called from an in-scope module, a
// pattern-excluded module that is STILL inside the compiler's program
// (entry.ts imports it, and the hermetic host serves in-root files on
// demand), and a test-classified file that also calls it.
const PARITY_TREE: Readonly<Record<string, string>> = {
  "src/target.ts": [
    "export function targeted(n: number): number {",
    "  return n + 1;",
    "}",
  ].join("\n"),
  "src/entry.ts": [
    'import { targeted } from "./target";',
    'import { callFromLib } from "../lib/caller";',
    "",
    "export function entryRun(): number {",
    "  return targeted(1) + callFromLib();",
    "}",
  ].join("\n"),
  "lib/caller.ts": [
    'import { targeted } from "../src/target";',
    "",
    "export function callFromLib(): number {",
    "  return targeted(2);",
    "}",
  ].join("\n"),
  // A test-classified file (basename target.test.ts) that also calls
  // targeted. Discovery excludes it from the analysis file set, so its
  // call never counts. Nothing imports it — in real trees, test files sit
  // outside the analyzed source graph — so this pins the exclusion at the
  // discovery layer, while the pattern-excluded lib/caller.ts pins the
  // in-program filter drop: imported by in-scope entry.ts, present in the
  // compiler's program, dropped only by the inScopePaths membership test.
  "target.test.ts": [
    'import { targeted } from "./src/target";',
    "",
    "export function testProbe(): number {",
    "  return targeted(3);",
    "}",
  ].join("\n"),
};

// The boundary tree: the three documented resolve-no-caller forms
// (data-model.md Section 5.2), each with a live usage site present so the
// 0s are strong pins of the checker surface, not vacuous absences — the
// default-export arrow is queried through its ExportAssignment parent, the
// accessor is read through a property access, and the constructor is
// invoked through a new expression.
const EDGES_TREE: Readonly<Record<string, string>> = {
  "src/edges.ts": [
    "export default () => {",
    "  return 1;",
    "};",
    "",
    "export class Boxed {",
    "  constructor(",
    "    public value: number,",
    "  ) {}",
    "",
    "  get doubled(): number {",
    "    return this.value * 2;",
    "  }",
    "}",
    "",
    "export function make(): Boxed {",
    "  return new Boxed(1);",
    "}",
    "",
    "export function consume(box: Boxed): number {",
    "  return box.doubled;",
    "}",
  ].join("\n"),
};

// The canary tree (Constitution V): a module whose top level throws,
// placed inside the compiler's resolved graph by caller.ts's side-effect
// import. Static analysis parses and resolves it; nothing may execute or
// import it. If any pipeline stage ever evaluated analyzed code, the
// analyzer process would crash with this exact message.
const CANARY_TREE: Readonly<Record<string, string>> = {
  "src/canary.ts": 'throw new Error("reading-stone executed analyzed code");',
  "src/target.ts": [
    "export function targeted(n: number): number {",
    "  return n + 1;",
    "}",
  ].join("\n"),
  "src/caller.ts": [
    'import "./canary";',
    'import { targeted } from "./target";',
    "",
    "export function callTarget(): number {",
    "  return targeted(1);",
    "}",
  ].join("\n"),
};

// The result of one index run: the materialized map plus the surfaces its
// assertions read. `root` and `patterns` carry the request identity so the
// parity suite can drive `analyze` over the SAME request (US3-7). The
// context is NOT returned — it is disposed before the caller sees this
// object. Every map value is computed inside buildCallerIndex while the
// compiler was live, and the record fields read here (name, relPath) were
// computed at extraction time, so assertions never need the live native
// compiler server.
interface IndexRun {
  root: string;
  patterns: unknown;
  index: CallerIndex;
  records: readonly ExtractionRecord[];
  inScopePaths: readonly string[];
}

// Runs the real pipeline over a fixture tree and builds the index while
// the program-mode context is live: createFixtureTree → prepareAnalysis →
// buildCallerIndex → dispose. The program-mode assertion is inside the try
// on purpose: a silent tsconfig fallback would degrade every count to the
// parse-only empty index (all counts vacuously 0) without failing a
// single count assertion below.
async function runIndex(
  files: Readonly<Record<string, string>>,
  patterns: unknown = undefined,
): Promise<IndexRun> {
  const tree = await createFixtureTree(files);
  registerCleanup(tree.cleanup);
  const sink = memorySink();
  const prepared = await prepareAnalysis(tree.root, patterns, sink.stream);
  try {
    expect(prepared.context.mode).toBe("program");
    const index = buildCallerIndex(
      prepared.context,
      prepared.records,
      prepared.inScopePaths,
      prepared.rootPath,
    );
    return {
      root: tree.root,
      patterns,
      index,
      records: prepared.records,
      inScopePaths: prepared.inScopePaths,
    };
  } finally {
    if (prepared.context.mode === "program") {
      prepared.context.dispose();
    }
  }
}

// Drives `analyze` over the same request one IndexRun came from — the same
// root and the same patterns — and projects its response to the surfaces
// the US3-7 parity assertions read: the distinct reported files (sorted)
// and the (file, name) record identities in response order. Both runs
// share one prepareAnalysis walk by construction; comparing their outputs
// pins that identity against the real method, not a hardcoded expectation.
async function analyzeSameRequest(run: IndexRun): Promise<{
  files: string[];
  recordKeys: readonly (readonly [string, string])[];
}> {
  const sink = memorySink();
  const result: unknown = await analyze(run.root, run.patterns, sink.stream);
  const records = wireRecords(result);
  return {
    files: [...new Set(records.map((record) => record.file))].sort(),
    recordKeys: records.map((record) => [record.file, record.name] as const),
  };
}

// The loud lookup: a missing record name, an ambiguous name, or a record
// without an index entry each fail with a named error rather than
// comparing an undefined silently. The final get also pins the map's
// record-identity keying — a value-keyed map would return undefined here
// and fail loud.
function countFor(
  index: CallerIndex,
  records: readonly ExtractionRecord[],
  name: string,
): number {
  const matches = records.filter((record) => record.name === name);
  if (matches.length === 0) {
    const available = [...new Set(records.map((record) => record.name))].join(", ");
    throw new Error(`no extraction record named "${name}" (records: ${available})`);
  }
  if (matches.length > 1) {
    throw new Error(`ambiguous record name "${name}" (${matches.length} records)`);
  }
  const count = index.get(matches[0]);
  if (count === undefined) {
    throw new Error(`record "${name}" has no caller-index entry — totality violated`);
  }
  return count;
}

function namesOf(records: readonly ExtractionRecord[]): string[] {
  return records.map((record) => record.name);
}

describe("distinct-module counts over the count tree (US3-1..4)", () => {
  it("yields 0 for a function called by nobody (US3-4)", async () => {
    const run = await runIndex(withTsconfig(COUNT_TREE));
    expect(countFor(run.index, run.records, "zero")).toBe(0);
  });

  it("yields 1 for a function called from exactly one module (US3-1)", async () => {
    const run = await runIndex(withTsconfig(COUNT_TREE));
    expect(countFor(run.index, run.records, "solo")).toBe(1);
  });

  it("yields 2 for a function called from two modules (US3-2)", async () => {
    const run = await runIndex(withTsconfig(COUNT_TREE));
    expect(countFor(run.index, run.records, "bump")).toBe(2);
  });

  it("yields 3 for a function called from three modules (US3-2)", async () => {
    const run = await runIndex(withTsconfig(COUNT_TREE));
    expect(countFor(run.index, run.records, "triple")).toBe(3);
  });

  it("yields 4 for a function called from exactly four modules (US3-3)", async () => {
    const run = await runIndex(withTsconfig(COUNT_TREE));
    // alpha, beta, main, and delta call quart; its defining module does
    // not — exactly four, the boundary count of the "four or more" bucket.
    expect(countFor(run.index, run.records, "quart")).toBe(4);
  });

  it("yields 5 for a function called from five modules, four or more (US3-3)", async () => {
    const run = await runIndex(withTsconfig(COUNT_TREE));
    // util (siblingCaller) + alpha + beta (aliased, three sites) + main
    // (module level + in mainRun) + delta — five distinct modules, eight
    // call sites. Asserting 5, not ">= 4": the count is exact, and the
    // bucket boundary is T008/T010's concern, not the index's.
    expect(countFor(run.index, run.records, "quad")).toBe(5);
  });

  it("counts a module once regardless of its call-site count (US3-5)", async () => {
    const run = await runIndex(withTsconfig(COUNT_TREE));
    // gammaRun calls makeTag twice; site-counting would yield 2.
    expect(countFor(run.index, run.records, "makeTag")).toBe(1);
    // beta calls quad three times (betaRun once, betaDouble twice) and
    // main twice; quad's eight sites span exactly five modules.
    expect(countFor(run.index, run.records, "quad")).toBe(5);
  });

  it("does not count a function's own recursive call (US3-6)", async () => {
    const run = await runIndex(withTsconfig(COUNT_TREE));
    // selfRec calls itself inside its own body span — the one call site
    // in the tree is the self-call, so the count is 0, not 1.
    expect(countFor(run.index, run.records, "selfRec")).toBe(0);
  });

  it("counts the defining module when other functions in it call the record", async () => {
    const run = await runIndex(withTsconfig(COUNT_TREE));
    // siblingCaller's quad(1) is a same-module, different-function call:
    // the defining module is an inbound caller like any other. Without it
    // quad would be 4, not 5.
    expect(countFor(run.index, run.records, "quad")).toBe(5);
  });

  it("counts module-level call sites, not only calls inside function bodies", async () => {
    const run = await runIndex(withTsconfig(COUNT_TREE));
    // boot is called ONLY at module level (const wired = boot(1)); a
    // body-only call-site restriction would yield 0.
    expect(countFor(run.index, run.records, "boot")).toBe(1);
  });

  it("gives every record an entry, with 0 for uncalled records (US3-4)", async () => {
    const run = await runIndex(withTsconfig(COUNT_TREE));
    // Totality: one entry per record — 20 records over the seven modules.
    expect(run.index.size).toBe(run.records.length);
    expect(run.records.length).toBe(20);
    for (const record of run.records) {
      expect(run.index.has(record)).toBe(true);
    }
    // The uncalled records carry explicit 0s, not missing entries.
    expect(countFor(run.index, run.records, "siblingCaller")).toBe(0);
    expect(countFor(run.index, run.records, "callBump")).toBe(0);
    expect(countFor(run.index, run.records, "mainRun")).toBe(0);
    expect(countFor(run.index, run.records, "gammaRun")).toBe(0);
  });
});

describe("checker resolution forms (research R7)", () => {
  it("resolves instance-method calls across modules", async () => {
    const run = await runIndex(withTsconfig(COUNT_TREE));
    // bump is called as counter.bump() in util.ts and beta.ts through two
    // differently-named receivers — receiver-name heuristics would need
    // both; the checker resolves both to the Counter.bump declaration.
    expect(countFor(run.index, run.records, "bump")).toBe(2);
  });

  it("resolves aliased imports", async () => {
    const run = await runIndex(withTsconfig(COUNT_TREE));
    // beta imports quad AS tagged; its three tagged(...) sites resolve to
    // the same declaration as alpha's and main's direct quad(...) sites.
    expect(countFor(run.index, run.records, "quad")).toBe(5);
  });

  it("resolves variable-assigned arrows through their binding", async () => {
    const run = await runIndex(withTsconfig(COUNT_TREE));
    expect(countFor(run.index, run.records, "makeTag")).toBe(1);
  });

  it("resolves class-property arrows", async () => {
    const run = await runIndex(withTsconfig(COUNT_TREE));
    expect(countFor(run.index, run.records, "add")).toBe(1);
  });

  it("resolves object-literal property arrows", async () => {
    const run = await runIndex(withTsconfig(COUNT_TREE));
    expect(countFor(run.index, run.records, "render")).toBe(1);
  });
});

describe("file-set parity with analyze (US3-7)", () => {
  it("enumerates the same in-scope file set and drops test-file calls (whole tree)", async () => {
    const run = await runIndex(withTsconfig(PARITY_TREE));
    // T006's inScopePaths IS the analyze file set: discovery's sorted,
    // test-excluded source list. The test-classified target.test.ts is
    // absent from it, and its call never counts — targeted's two callers
    // are entry.ts and lib/caller.ts, both in scope.
    expect(run.inScopePaths).toEqual([
      "lib/caller.ts",
      "src/entry.ts",
      "src/target.ts",
    ]);
    expect(namesOf(run.records)).toEqual(["callFromLib", "entryRun", "targeted"]);
    expect(countFor(run.index, run.records, "targeted")).toBe(2);
    // US3-7's letter, driven: analyze itself over the SAME request (same
    // root, absent patterns) reports exactly the file set the index
    // filtered by, and the same records. Every in-scope file in this tree
    // declares a record, so the response's distinct file set observes the
    // whole in-scope set — a file set analyze reports that differed from
    // inScopePaths in either direction fails here.
    const analyzed = await analyzeSameRequest(run);
    expect(analyzed.files).toEqual([...run.inScopePaths]);
    expect(analyzed.recordKeys).toEqual(
      run.records.map((record) => [record.relPath, record.name] as const),
    );
  });

  it("drops calls positioned in pattern-excluded modules (scoped request)", async () => {
    const run = await runIndex(withTsconfig(PARITY_TREE), ["./src"]);
    // The scoped request narrows the file set to src/, but lib/caller.ts
    // is still inside the compiler's program — entry.ts imports it, and
    // the hermetic host serves in-root files on demand. Its targeted(2)
    // call exists as a usage; only the inScopePaths membership test drops
    // it. The whole-tree run above counts 2; this run counts 1.
    expect(run.inScopePaths).toEqual(["src/entry.ts", "src/target.ts"]);
    expect(namesOf(run.records)).toEqual(["entryRun", "targeted"]);
    expect(countFor(run.index, run.records, "targeted")).toBe(1);
    // The same-request analyze comparison under patterns: the scoped
    // response reports exactly the narrowed file set the index filtered
    // by — lib/caller.ts sits inside the compiler's program yet outside
    // both surfaces.
    const analyzed = await analyzeSameRequest(run);
    expect(analyzed.files).toEqual([...run.inScopePaths]);
    expect(analyzed.recordKeys).toEqual(
      run.records.map((record) => [record.relPath, record.name] as const),
    );
    expect(analyzed.files).not.toContain("lib/caller.ts");
  });
});

describe("documented checker boundaries (data-model Section 5.2)", () => {
  it("resolves no callers for anonymous default-export expressions", async () => {
    const run = await runIndex(withTsconfig(EDGES_TREE));
    // The default arrow has no name-giving parent declaration (its parent
    // is the ExportAssignment itself); the documented boundary is 0.
    expect(countFor(run.index, run.records, "default")).toBe(0);
  });

  it("resolves no callers for accessors despite property-access usages", async () => {
    const run = await runIndex(withTsconfig(EDGES_TREE));
    // consume reads box.doubled — a live usage of the accessor — but a
    // property access is not a call expression, so no call is paired.
    expect(countFor(run.index, run.records, "doubled")).toBe(0);
  });

  it("resolves no callers for constructors despite new-expression sites", async () => {
    const run = await runIndex(withTsconfig(EDGES_TREE));
    // make news up Boxed(1) — a live construction site — but new
    // expressions are not call expressions in the usage API's pairing.
    expect(countFor(run.index, run.records, "constructor")).toBe(0);
  });
});

describe("parse-only degradation (research R7)", () => {
  it("yields an empty index over a tree without a tsconfig", async () => {
    // The count tree WITHOUT the tsconfig: extraction is purely lexical
    // (research R5) so the records are still there, but no checker
    // exists to resolve calls — the documented degradation boundary is
    // an empty index (no entries at all), not an all-zero one.
    const tree = await createFixtureTree(COUNT_TREE);
    registerCleanup(tree.cleanup);
    const sink = memorySink();
    const prepared = await prepareAnalysis(tree.root, undefined, sink.stream);
    try {
      expect(prepared.context.mode).toBe("parse-only");
      expect(namesOf(prepared.records)).toContain("quad");
      const index = buildCallerIndex(
        prepared.context,
        prepared.records,
        prepared.inScopePaths,
        prepared.rootPath,
      );
      expect(index.size).toBe(0);
      for (const record of prepared.records) {
        expect(index.has(record)).toBe(false);
      }
    } finally {
      if (prepared.context.mode === "program") {
        prepared.context.dispose();
      }
    }
  });
});

describe("degenerate inputs", () => {
  it("yields an empty index for an empty record list", async () => {
    // The empty-records branch runs against a LIVE program-mode context:
    // prepare a real one-function tree, then hand buildCallerIndex an
    // empty record list while the compiler is live.
    const tree = await createFixtureTree({
      ...withTsconfig({
        "src/one.ts": "export function one(): number {\n  return 1;\n}\n",
      }),
    });
    registerCleanup(tree.cleanup);
    const sink = memorySink();
    const prepared = await prepareAnalysis(tree.root, undefined, sink.stream);
    try {
      expect(prepared.context.mode).toBe("program");
      expect(prepared.records.length).toBeGreaterThan(0);
      const index = buildCallerIndex(
        prepared.context,
        [],
        prepared.inScopePaths,
        prepared.rootPath,
      );
      expect(index.size).toBe(0);
    } finally {
      if (prepared.context.mode === "program") {
        prepared.context.dispose();
      }
    }
  });
});

describe("analysis safety (Constitution V)", () => {
  it("never executes or imports analyzed code", async () => {
    // The canary module's top level throws, and caller.ts places it
    // inside the compiler's resolved import graph. Every stage here —
    // discovery, pre-read, bootstrap, extraction, the caller-index
    // queries — is strictly static; if any stage evaluated the graph,
    // this test would not reach its assertion. Reaching it with the
    // canary resolved in-program is the proof.
    const run = await runIndex(withTsconfig(CANARY_TREE));
    expect(countFor(run.index, run.records, "targeted")).toBe(1);
  });
});
