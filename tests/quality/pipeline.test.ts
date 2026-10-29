// End-to-end exact-row fixtures for src/quality/pipeline.ts (T012;
// FR-012/FR-013; SC-001 initial; US1 scenarios 1–3, 6–8; research R8, R10,
// R11 rung 3; Constitution Principles I, III, and V).
//
// RED-FIRST: src/quality/pipeline.ts does not exist yet — T019 creates it
// — so this suite fails on module resolution by design (tasks.md: US1
// tests are written first and observed to FAIL before the paired
// implementation lands).
//
// The contract pinned here:
//
// - Entry point: `testMapping(rootPath, patterns, stderr)` returning the
//   `TestMappingResult` — one `mappings` key, rows already wire-shaped
//   through serializeMappingRow. Empty inputs (no test files, no
//   production targets, a match-nothing pattern set, no pairs) yield
//   `{"mappings": []}`, never an error (US1-8).
// - SC-001's exact eight-key row set over naming-paired fixtures:
//   test_function (the describe-qualified title), test_file,
//   assertion_location ("<relPath>:<line>", no column), assertion_type,
//   target_function, target_package (derivePackage), side_effect_type,
//   confidence (90/70 for US1's naming strategies).
// - Row order by the FR-013 stable key — UTF-16 code-unit comparison for
//   strings, numeric for line/character (line 10 sorts after line 9, never
//   lexicographically) — with the deterministic AST-walk collection order
//   as the stable-sort final tie-break (two matcher invocations sharing
//   one expect chain).
// - Determinism (R10): two full pipeline runs over fresh prepareAnalysis
//   walks reproduce identical serialized bytes — the walk re-run, not just
//   the serializer.
// - Static-analysis safety (Constitution V): a throwing module planted
//   inside the compiler's resolved import graph is parsed, never executed.
// - Skip diagnostics flow to the injected stderr sink, never the result.

import { chmod } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type TestMappingResult, testMapping } from "../../src/quality/pipeline.js";
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

const TSCONFIG = '{"compilerOptions": {"strict": true, "target": "ES2022"}}';

// The running-as-root guard tests/server.test.ts uses: chmod-based
// inaccessibility is meaningless for root, where mode bits do not restrict
// the owner.
const runningAsRoot = typeof process.getuid === "function" && process.getuid() === 0;

async function mappingOf(
  files: Readonly<Record<string, string>>,
  patterns?: string[],
): Promise<{ result: TestMappingResult; stderr: () => string }> {
  const tree = await createFixtureTree(files);
  registerCleanup(tree.cleanup);
  const sink = memorySink();
  const result = await testMapping(tree.root, patterns, sink.stream);
  return { result, stderr: sink.text };
}

// The wire-row projection: the eight contract-pinned fields, compared with
// toEqual (SC-001's exact-row discipline — the row type itself is the
// MappingRow from src/quality/types.js, so the projection is the identity
// over the wire fields; spelled out to keep every fixture's expected rows
// auditable in place).
function rows(result: TestMappingResult) {
  return result.mappings.map((row) => ({
    test_function: row.test_function,
    test_file: row.test_file,
    assertion_location: row.assertion_location,
    assertion_type: row.assertion_type,
    target_function: row.target_function,
    target_package: row.target_package,
    side_effect_type: row.side_effect_type,
    confidence: row.confidence,
  }));
}

describe("testMapping", () => {
  it("returns the exact eight-key row set over a naming-paired fixture", async () => {
    // SC-001's initial shape, in both bootstrap modes: the same sources
    // with a tsconfig (checker) and without (parse-only) produce the
    // identical rows — the naming strategy is purely lexical, so
    // degradation reduces precision never (US1's rows are mode-stable).
    const sources: Readonly<Record<string, string>> = {
      "src/math.ts":
        "export function add(a: number, b: number): number {\n  return a + b;\n}\n",
      "tests/math.test.ts": [
        'import { add } from "../src/math.js";', // 1
        "", // 2
        'describe("math", () => {', // 3
        '  it("add", () => {', // 4
        "    expect(add(1, 2)).toBe(3);", // 5
        "  });", // 6
        "});", // 7
      ].join("\n"),
    };
    const expected = [
      {
        test_function: "math > add",
        test_file: "tests/math.test.ts",
        assertion_location: "tests/math.test.ts:5",
        assertion_type: "equality",
        target_function: "add",
        target_package: "src.math",
        side_effect_type: "ReturnValue",
        confidence: 90,
      },
    ];

    const checker = await mappingOf({ ...sources, "tsconfig.json": TSCONFIG });
    expect(rows(checker.result)).toEqual(expected);

    const parseOnly = await mappingOf(sources);
    expect(rows(parseOnly.result)).toEqual(expected);
  });

  it("carries exactly one result key", async () => {
    const { result } = await mappingOf({
      "src/math.ts":
        "export function add(a: number, b: number): number {\n  return a + b;\n}\n",
      "tests/math.test.ts":
        'import { add } from "../src/math.js";\n\nit("add", () => {\n  expect(add(1, 2)).toBe(3);\n});\n',
    });
    expect(Object.keys(result).sort()).toEqual(["mappings"]);
  });

  it("emits one row per assertion — three assertions yield three rows", async () => {
    // US1-2: a paired test with three assertions yields three rows sharing
    // the target fields with distinct assertion_location values in source
    // order.
    const { result } = await mappingOf({
      "src/math.ts":
        "export function clamp(value: number): number {\n  if (value < 0) {\n    return 0;\n  }\n  return value;\n}\n",
      "tests/clamp.test.ts": [
        'import { clamp } from "../src/math.js";', // 1
        "", // 2
        'it("clamp", () => {', // 3
        "  expect(clamp(-1)).toBe(0);", // 4
        "  expect(clamp(2)).toBe(2);", // 5
        "  expect(clamp(0)).toBe(0);", // 6
        "});", // 7
      ].join("\n"),
    });
    const projected = rows(result);
    expect(projected).toHaveLength(3);
    expect(projected.map((row) => row.assertion_location)).toEqual([
      "tests/clamp.test.ts:4",
      "tests/clamp.test.ts:5",
      "tests/clamp.test.ts:6",
    ]);
    // Every row shares the pair's target fields and confidence
    // (assumption 17: confidence sharing — no per-assertion confidence).
    for (const row of projected) {
      expect(row.test_function).toBe("clamp");
      expect(row.target_function).toBe("clamp");
      expect(row.target_package).toBe("src.math");
      expect(row.confidence).toBe(90);
    }
  });

  it("emits no rows for an unpaired test", async () => {
    // US1-3: a test matched by no strategy produces no rows — never
    // confidence-0 rows.
    const { result } = await mappingOf({
      "src/math.ts":
        "export function add(a: number, b: number): number {\n  return a + b;\n}\n",
      "tests/math.test.ts": [
        'import { add } from "../src/math.js";', // 1
        "", // 2
        'it("add", () => {', // 3
        "  expect(add(1, 2)).toBe(3);", // 4
        "});", // 5
        "", // 6
        'it("something unrelated", () => {', // 7
        "  expect(1).toBe(1);", // 8
        "});", // 9
      ].join("\n"),
    });
    expect(rows(result).map((row) => row.test_function)).toEqual(["add"]);
  });

  it("emits value rows with the ReturnValue fallback for an effect-less target", async () => {
    // US1-7: a paired test whose target has no detected effects still
    // emits its rows with the ReturnValue fallback — inference is total.
    const { result } = await mappingOf({
      "src/noop.ts": "export function noop(): void {}\n",
      "tests/noop.test.ts":
        'import { noop } from "../src/noop.js";\n\nit("noop", () => {\n  expect(noop()).toBeUndefined();\n});\n',
    });
    expect(rows(result)).toEqual([
      {
        test_function: "noop",
        test_file: "tests/noop.test.ts",
        assertion_location: "tests/noop.test.ts:4",
        assertion_type: "",
        target_function: "noop",
        target_package: "src.noop",
        side_effect_type: "ReturnValue",
        confidence: 90,
      },
    ]);
  });

  it("emits case-insensitive naming pairs at confidence 70", async () => {
    const { result } = await mappingOf({
      "src/math.ts":
        "export function add(a: number, b: number): number {\n  return a + b;\n}\n",
      "tests/case.test.ts":
        'import { add } from "../src/math.js";\n\nit("Add", () => {\n  expect(add(1, 2)).toBe(3);\n});\n',
    });
    expect(rows(result).map((row) => [row.test_function, row.confidence])).toEqual([
      ["Add", 70],
    ]);
  });

  it("orders rows by the stable key — numeric lines, package before line", async () => {
    // FR-013's key in action: test_file first (a before z), then
    // test_function, then target_package (alpha before beta), then the
    // assertion line NUMERICALLY — line 10 sorts after line 9, never
    // lexicographically where "10" < "9".
    const dualTarget: Readonly<Record<string, string>> = {
      "alpha/dual.ts": "export function dual(): number {\n  return 1;\n}\n",
      "beta/dual.ts": "export function dual(): number {\n  return 2;\n}\n",
      "tests/z.test.ts": [
        'import { dual } from "../alpha/dual.js";', // 1
        "", // 2
        'it("dual", () => {', // 3
        "  // pad the file so assertions land on lines 9 and 10 — the", // 4
        "  // numeric-order pin: lexicographic string order would sort", // 5
        '  // "z.test.ts:10" before "z.test.ts:9". Two expects, not', // 6
        "  // four — one row per (pair, assertion) (FR-012), so the", // 7
        "  // padding lines, never sibling assertions, carry the offset.", // 8
        "  expect(9).toBe(9);", // 9
        "  expect(10).toBe(10);", // 10
        "});", // 11
      ].join("\n"),
      "tests/a.test.ts": [
        'it("dual", () => {', // 1
        "  expect(5).toBe(5);", // 2
        "});", // 3
      ].join("\n"),
    };
    const { result } = await mappingOf(dualTarget);
    const projected = rows(result);
    expect(
      projected.map(
        (row) => `${row.test_file}:${row.target_package}:${row.assertion_location}`,
      ),
    ).toEqual([
      // tests/a.test.ts sorts before tests/z.test.ts on the first key.
      "tests/a.test.ts:alpha.dual:tests/a.test.ts:2",
      "tests/a.test.ts:beta.dual:tests/a.test.ts:2",
      // Within z: alpha before beta (target_package), line 9 before
      // line 10 — numerically.
      "tests/z.test.ts:alpha.dual:tests/z.test.ts:9",
      "tests/z.test.ts:alpha.dual:tests/z.test.ts:10",
      "tests/z.test.ts:beta.dual:tests/z.test.ts:9",
      "tests/z.test.ts:beta.dual:tests/z.test.ts:10",
    ]);
  });

  it("emits tied rows sharing one expect chain in AST-walk collection order", async () => {
    // The stable key is not injective by construction: two matcher
    // invocations on one expect chain share the chain's single anchor, so
    // the rows tie on the full key and emit in the assertion-collection
    // order of the source walk — the pinned final tie-break preserving
    // byte-identical repeat responses (data-model Section 8).
    const { result } = await mappingOf({
      "src/math.ts":
        "export function add(a: number, b: number): number {\n  return a + b;\n}\n",
      "tests/tie.test.ts": [
        'import { add } from "../src/math.js";', // 1
        "", // 2
        'it("add", () => {', // 3
        "  expect(add(1, 2)).toBe(3).toBeNull();", // 4
        "});", // 5
      ].join("\n"),
    });
    expect(rows(result)).toEqual([
      {
        test_function: "add",
        test_file: "tests/tie.test.ts",
        assertion_location: "tests/tie.test.ts:4",
        assertion_type: "equality",
        target_function: "add",
        target_package: "src.math",
        side_effect_type: "ReturnValue",
        confidence: 90,
      },
      {
        test_function: "add",
        test_file: "tests/tie.test.ts",
        assertion_location: "tests/tie.test.ts:4",
        assertion_type: "",
        target_function: "add",
        target_package: "src.math",
        side_effect_type: "ReturnValue",
        confidence: 90,
      },
    ]);
  });

  it("reproduces identical serialized bytes across two full pipeline runs", async () => {
    // R10: the determinism golden — two complete testMapping calls, each
    // with its own prepareAnalysis walk, produce byte-identical serialized
    // rows (Constitution I: a pure function of the analyzed tree).
    const files: Readonly<Record<string, string>> = {
      "src/math.ts":
        "export function add(a: number, b: number): number {\n  return a + b;\n}\n",
      "tests/math.test.ts": [
        'import { add } from "../src/math.js";', // 1
        "", // 2
        'describe("math", () => {', // 3
        '  it("add", () => {', // 4
        "    expect(add(1, 2)).toBe(3);", // 5
        "  });", // 6
        "});", // 7
      ].join("\n"),
      "tsconfig.json": TSCONFIG,
    };
    const first = await mappingOf(files);
    const second = await mappingOf(files);
    expect(JSON.stringify(second.result.mappings)).toBe(
      JSON.stringify(first.result.mappings),
    );
    expect(second.result.mappings).toEqual(first.result.mappings);
  });

  it("parses a throwing module inside the resolved import graph, never executes it", async () => {
    // Constitution V, the caller-index canary precedent: analyzed source
    // is untrusted input. If the pipeline ever imported or executed the
    // canary module, its module-scope throw would fire; the static
    // pipeline parses it and answers normally.
    const { result } = await mappingOf({
      "tsconfig.json": TSCONFIG,
      "src/canary.ts":
        'throw new Error("canary module executed — static analysis violated");\n\nexport function boom(): number {\n  return 1;\n}\n',
      "tests/canary.test.ts":
        'import { boom } from "../src/canary.js";\n\nit("boom", () => {\n  expect(boom()).toBe(1);\n});\n',
    });
    expect(rows(result)).toEqual([
      {
        test_function: "boom",
        test_file: "tests/canary.test.ts",
        assertion_location: "tests/canary.test.ts:4",
        assertion_type: "equality",
        target_function: "boom",
        target_package: "src.canary",
        side_effect_type: "ReturnValue",
        confidence: 90,
      },
    ]);
  });

  it("answers empty inputs with an empty mappings array, never an error", async () => {
    // US1-8: no test files, no production targets, and a match-nothing
    // pattern set are all successes.
    const noTests = await mappingOf({
      "src/math.ts":
        "export function add(a: number, b: number): number {\n  return a + b;\n}\n",
    });
    expect(noTests.result).toEqual({ mappings: [] });

    const noTargets = await mappingOf({
      "tests/math.test.ts":
        'import { add } from "../src/math.js";\n\nit("add", () => {\n  expect(add(1, 2)).toBe(3);\n});\n',
    });
    expect(noTargets.result).toEqual({ mappings: [] });

    const matchNothing = await mappingOf(
      {
        "src/math.ts":
          "export function add(a: number, b: number): number {\n  return a + b;\n}\n",
        "tests/math.test.ts":
          'import { add } from "../src/math.js";\n\nit("add", () => {\n  expect(add(1, 2)).toBe(3);\n});\n',
      },
      ["nope"],
    );
    expect(matchNothing.result).toEqual({ mappings: [] });
  });

  it("narrows the target arm with patterns while the test arm stays full", async () => {
    // FR-006 arm scoping: `patterns` narrow the TARGET (source) arm exactly
    // as analyze applies them; the TEST arm is never narrowed — a pattern
    // set naming no test file still collects every test.
    const files: Readonly<Record<string, string>> = {
      "alpha/kept.ts": "export function pick(): number {\n  return 1;\n}\n",
      "beta/dropped.ts": "export function pick(): number {\n  return 2;\n}\n",
      "tests/pick.test.ts":
        'import { pick } from "../alpha/kept.js";\n\nit("pick", () => {\n  expect(pick()).toBe(1);\n});\n',
    };
    const { result } = await mappingOf(files, ["alpha"]);
    expect(rows(result).map((row) => row.target_package)).toEqual(["alpha.kept"]);
  });

  it.skipIf(runningAsRoot)(
    "routes skip diagnostics to the injected stderr, never the result",
    async () => {
      // The bounded reader's safety-skip diagnostic for an unreadable
      // FILE flows to the injected sink; the analysis still answers over
      // the readable remainder. (An inaccessible DIRECTORY fails the
      // walk itself — walkTree deliberately propagates nested readdir
      // failures, because silently omitting an unreadable subtree would
      // be a silent false negative, Constitution II — so the file-level
      // one-diagnostic skip is the shape the pipeline contracts.)
      const tree = await createFixtureTree({
        "src/math.ts":
          "export function add(a: number, b: number): number {\n  return a + b;\n}\n",
        "tests/math.test.ts":
          'import { add } from "../src/math.js";\n\nit("add", () => {\n  expect(add(1, 2)).toBe(3);\n});\n',
        "src/locked.ts": "export function locked(): number {\n  return 1;\n}\n",
      });
      registerCleanup(tree.cleanup);
      const locked = join(tree.root, "src/locked.ts");
      await chmod(locked, 0o000);
      try {
        const sink = memorySink();
        const result = await testMapping(tree.root, undefined, sink.stream);
        expect(rows(result).map((row) => row.target_function)).toEqual(["add"]);
        expect(sink.text()).toContain("reading-stone:");
      } finally {
        await chmod(locked, 0o644);
      }
    },
  );

  it("defaults the stderr sink to process.stderr without touching stdout", async () => {
    // The Testability principle's defaulting seam: the injected sink is
    // optional, defaulting to process.stderr — the signature production
    // callers use.
    const tree = await createFixtureTree({
      "src/math.ts":
        "export function add(a: number, b: number): number {\n  return a + b;\n}\n",
      "tests/math.test.ts":
        'import { add } from "../src/math.js";\n\nit("add", () => {\n  expect(add(1, 2)).toBe(3);\n});\n',
    });
    registerCleanup(tree.cleanup);
    const result = await testMapping(tree.root);
    expect(rows(result).map((row) => row.target_function)).toEqual(["add"]);
  });
});
