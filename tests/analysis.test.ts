// Pattern normalization and analysis-scope tables for src/analysis.ts (T008;
// spec US1 tests; FR-001, FR-002; research R11, R12; SC-005; Constitution
// Principles I and II).
//
// RED-FIRST: src/analysis.ts does not exist yet — T012 creates the pattern
// functions and T014 extends the module with the shared analysis pipeline —
// so this suite fails on module resolution by design (tasks.md: US1 tests
// are written first and observed to FAIL before the paired implementation
// lands).
//
// The contracts pinned here, per data-model.md and contracts/analyze.md:
//
// - `normalizePatterns(patterns: unknown): PatternSet` (T012):
//   absent/`null`/empty array/the exact singleton forms `["./..."]` and
//   `["..."]` normalize to `null` — the whole tree; every other element
//   strips one leading `./` then one trailing `/...` into a directory
//   prefix (empty-string, `"."`, and non-singleton `"..."`/`"./..."`
//   elements normalize to prefixes that match nothing).
// - `pathInScope(relPath: string, patternSet: PatternSet): boolean` (T012):
//   `true` when `patternSet` is `null`, or the root-relative POSIX path
//   equals a prefix or begins with `prefix + "/"`; patterns union.
// - `prepareAnalysis(rootPath, patterns, stderr)` (T014): the shared
//   resolveRoot → walkTree → screenCandidates → classifyFiles pipeline with
//   test files additionally excluded from analysis (FR-002/SC-005 — test
//   files and generated files are never analyzed) and the FR-001 pattern
//   filter applied, returning the `ProgramContext` plus the extraction
//   records (data-model.md's internal pipeline order: ProgramContext →
//   ExtractionRecord). The record identity fields asserted here are
//   data-model.md's ExtractionRecord fields `name`, `relPath`, and `line`
//   (1-based declaration line).
//
// Two judgment calls, recorded per the task brief:
//
// 1. The end-to-end scope cases drive `prepareAnalysis` — the analysis
//    pipeline entry tasks.md T014 adds to src/analysis.ts — rather than a
//    serialized `analyze` entry: the `{"functions": [...]}` wire shape
//    (name/package/file/line/side_effects) is assembled by the analyze
//    response entry that T018 lands in src/detector.ts over this pipeline's
//    output, and its dispatch surface is T019 — both later than this suite's
//    T012/T014 green target. The extraction records returned by the pipeline
//    carry the same per-function identity the wire records will.
// 2. The pipeline return shape pinned below is `{ context: ProgramContext;
//    records: ExtractionRecord[] }` — the natural reading of T014's
//    "returning the `ProgramContext` plus `ExtractionRecord[]`", with
//    `records` matching the spec's own vocabulary ("analysis records",
//    FR-002's "no analysis records from them"). The `Prepared` projection
//    uses `Awaited<ReturnType<typeof prepareAnalysis>>`, so the helpers
//    read exactly the surface T014 ships (nothing gate-checks test types
//    today — tsc compiles src only — but the projection keeps this file
// honest against the landed module).
//
// T017 EXTENSION (spec 003; US1 tests; FR-012/FR-013; SC-001, SC-003,
// SC-004, SC-005; research R10, R13; quickstart.md Sections 1, 3, 5, 8;
// contracts/analyze-classification.md): the describe blocks at the bottom
// of this file pin the analyze entry's classification wiring — every
// effect classified (003 FR-012, superseding 002 FR-019's no-classification
// rule), the quickstart controlled-signal profile (SC-001), same-type pair
// sharing (FR-008), tier offsets (SC-003), the clamp, parse-only
// degradation, and byte-identical repeats (SC-005). Two halves, one seam:
// the composition-seam suites drive the exact stage order research R10
// pins for T025's wiring (detectEffects → buildRecordEvidence →
// classifyPairs) over real trees and are green today — T024 landed the
// fan-out core, so only analyze()'s insertion of it is missing — while
// the analyze-wiring suite drives analyze() itself and is RED-FIRST by
// design: its cases fail on the missing classification field until T025
// lands (the same intended red the flipped wire-shape cases in the
// detector suites carry). Unlike the scope fixtures, the classification
// trees DO carry tsconfig.json — the quickstart tree verbatim from
// quickstart.md Section 1 (the profile's interface and caller-count
// signals need program mode); Section 8's parse-only variant reuses the
// same sources without it.
//
// The scope fixtures are tsconfig-less, so the pipeline bootstraps
// parse-only mode (FR-004) — the scope behavior under test (walk,
// screening, test-file exclusion, pattern filter) is decided before the
// bootstrap and is mode-independent. `releaseContext` still disposes a
// program-mode context the way the future analyze handler will, so this
// suite never leaks a native compiler server even if that mode ever
// applies.

import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  analyze,
  normalizePatterns,
  pathInScope,
  prepareAnalysis,
} from "../src/analysis.js";
import { assembleFunctionRecords, detectEffects } from "../src/detector.js";
import { InvalidRootPathError } from "../src/discovery.js";
import { serializeFunctionRecord } from "../src/models.js";
import { classifyPairs } from "../src/signals/adapter.js";
import { buildRecordEvidence } from "../src/signals/evidence.js";
import type { Signal } from "../src/signals/types.js";
import {
  createFixtureTree,
  drainCleanups,
  memorySink,
  registerCleanup,
} from "./helpers/fixtures.js";
import {
  expectWireInvariants,
  extractFunctions,
  recordFor,
  type WireClassification,
  type WireRecord,
} from "./helpers/wire.js";

// Fixture trees and scratch directories register their cleanup with the
// shared helpers so every test body stays linear; afterEach drains the
// queue in creation order.
afterEach(async () => {
  // The stdout-spy cases restore here so every case stays independent.
  vi.restoreAllMocks();
  await drainCleanups();
});

async function makeTree(files: Readonly<Record<string, string>>): Promise<string> {
  const tree = await createFixtureTree(files);
  registerCleanup(tree.cleanup);
  return tree.root;
}

async function makeScratchDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "reading-stone-scratch-"));
  registerCleanup(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

// chmod-based inaccessibility is meaningless for root, where mode bits do
// not restrict the owner.
const runningAsRoot = typeof process.getuid === "function" && process.getuid() === 0;

// Shared fixture texts (module-scope constants prevent drift between the
// on-disk tree and the expected records). Every excluded-file fixture
// declares a real named function — a file that WOULD produce a record if it
// were analyzed — so "no records from them" is a strong assertion, not a
// vacuous one.
const KEEP = "export function keep(): number {\n  return 3;\n}\n";
const TESTED = "export function tested(): number {\n  return 1;\n}\n";
const X_CASE = "export function xCase(): number {\n  return 1;\n}\n";
const Y_CASE = "export function yCase(): number {\n  return 1;\n}\n";
const GENERATED =
  "// @generated\nexport function generated(): number {\n  return 2;\n}\n";
const ALPHA = "export function alpha(): number {\n  return 1;\n}\n";
const BETA = "export function beta(): number {\n  return 2;\n}\n";
const GAMMA = "export function gamma(): number {\n  return 3;\n}\n";
const APP = "export function app(): number {\n  return 1;\n}\n";

// The pipeline result as this suite consumes it: T014's real return type,
// projected onto the structural surface the scope assertions rely on.
type Prepared = Awaited<ReturnType<typeof prepareAnalysis>>;

// One extraction record as (relPath, name, line) — the identity tuple
// data-model.md's ExtractionRecord documents.
function recordTuples(prepared: Prepared): Array<[string, string, number]> {
  return prepared.records.map((record): [string, string, number] => [
    record.relPath,
    record.name,
    record.line,
  ]);
}

function recordPaths(prepared: Prepared): string[] {
  return prepared.records.map((record) => record.relPath);
}

// A program-mode context owns a live native compiler server (src/program.ts)
// and its consumer owns that lifetime; a direct-calling test releases it the
// way the future analyze handler will. Parse-mode bootstraps close their own
// client before returning, so this never fires for the tsconfig-less
// fixtures below.
function releaseContext(prepared: Prepared): void {
  const { context } = prepared;
  if (context.mode === "program") {
    context.dispose();
  }
}

async function analyzeTree(rootPath: string, patterns: unknown) {
  const sink = memorySink();
  const prepared = await prepareAnalysis(rootPath, patterns, sink.stream);
  return { prepared, sink };
}

describe("normalizePatterns: catch-all forms (FR-001)", () => {
  it.each([
    { label: "absent patterns", patterns: undefined },
    { label: "null patterns", patterns: null },
    { label: "the empty array", patterns: [] as string[] },
    { label: 'the exact singleton ["./..."]', patterns: ["./..."] },
    { label: 'the exact singleton ["..."]', patterns: ["..."] },
  ])("treats $label as the whole tree", ({ patterns }) => {
    const patternSet = normalizePatterns(patterns);
    // PatternSet null is the whole-tree marker (data-model.md PatternSet).
    expect(patternSet).toBe(null);
    // ...and every root-relative POSIX path is in scope under it.
    expect(pathInScope("src/deep/nested/thing.ts", patternSet)).toBe(true);
    expect(pathInScope("root-level.ts", patternSet)).toBe(true);
  });

  it("treats a null PatternSet as the whole tree in pathInScope directly", () => {
    // The in-scope test over the literal null marker, independent of
    // normalization: null means the whole tree.
    expect(pathInScope("anything.ts", null)).toBe(true);
    expect(pathInScope("a/b/c.ts", null)).toBe(true);
  });
});

describe("normalizePatterns: prefix normalization (FR-001)", () => {
  it.each([
    { patterns: ["src/..."], expected: ["src"] },
    { patterns: ["./src"], expected: ["src"] },
    { patterns: ["./src/..."], expected: ["src"] },
    { patterns: ["src"], expected: ["src"] },
    { patterns: ["src/utils"], expected: ["src/utils"] },
    { patterns: ["a/b/..."], expected: ["a/b"] },
    { patterns: ["./src/...", "lib"], expected: ["lib", "src"] },
  ])("normalizes $patterns into directory prefixes", ({ patterns, expected }) => {
    const patternSet = normalizePatterns(patterns);
    expect(patternSet).not.toBe(null);
    if (patternSet === null) {
      throw new Error(
        `expected prefixes for ${JSON.stringify(patterns)}, received null`,
      );
    }
    // The prefix multiset is exact. Element order is not contractually
    // pinned (only determinism is — Constitution I), so the comparison is
    // order-insensitive.
    expect([...patternSet].sort()).toEqual([...expected].sort());
  });
});

describe("pathInScope: in-scope table (FR-001)", () => {
  it.each([
    // Whole tree.
    {
      label: "absent patterns mean the whole tree",
      patterns: undefined,
      relPath: "src/deep/nested/thing.ts",
      expected: true,
    },
    {
      label: "null patterns mean the whole tree",
      patterns: null,
      relPath: "root-level.ts",
      expected: true,
    },
    {
      label: "empty patterns mean the whole tree",
      patterns: [] as string[],
      relPath: "anywhere/deep/file.tsx",
      expected: true,
    },
    // Exact-prefix equality.
    {
      label: "a path equal to the prefix is in scope",
      patterns: ["src"],
      relPath: "src",
      expected: true,
    },
    {
      label: "a file pattern equals the file",
      patterns: ["src/lib.ts"],
      relPath: "src/lib.ts",
      expected: true,
    },
    // prefix + "/" begins-match.
    {
      label: "a path under the prefix is in scope",
      patterns: ["src"],
      relPath: "src/lib.ts",
      expected: true,
    },
    {
      label: "a deeply nested path under the prefix is in scope",
      patterns: ["src"],
      relPath: "src/utils/deep/math.ts",
      expected: true,
    },
    {
      label: "a stripped /... form scopes the subtree",
      patterns: ["src/..."],
      relPath: "src/deep/nested.ts",
      expected: true,
    },
    {
      label: "a stripped ./ form scopes the subtree",
      patterns: ["./src"],
      relPath: "src/a.ts",
      expected: true,
    },
    {
      label: "a stripped ./ and /... form scopes the subtree",
      patterns: ["./src/..."],
      relPath: "src/a.ts",
      expected: true,
    },
    // Negatives: the prefix must anchor the path and end at a segment
    // boundary.
    {
      label: "a longer segment sharing the prefix text is out of scope",
      patterns: ["src"],
      relPath: "srcx/lib.ts",
      expected: false,
    },
    {
      label: "the prefix must anchor at the path start",
      patterns: ["src"],
      relPath: "lib/src/thing.ts",
      expected: false,
    },
    {
      label: "a partial final segment is not the prefix",
      patterns: ["src/utils"],
      relPath: "src/util.ts",
      expected: false,
    },
    {
      label: "the prefix boundary needs the slash",
      patterns: ["src/utils"],
      relPath: "src/utils.ts",
      expected: false,
    },
    {
      label: "a file pattern does not scope siblings",
      patterns: ["src/lib.ts"],
      relPath: "src/other.ts",
      expected: false,
    },
    {
      label: "a file pattern does not scope near-names",
      patterns: ["src/lib.ts"],
      relPath: "src/lib.tsx",
      expected: false,
    },
    {
      label: "a stripped /... form excludes other roots",
      patterns: ["src/..."],
      relPath: "lib/a.ts",
      expected: false,
    },
    {
      label: "a stripped ./ and /... form excludes other roots",
      patterns: ["./src/..."],
      relPath: "lib/a.ts",
      expected: false,
    },
    // Union.
    {
      label: "the union matches the first pattern",
      patterns: ["lib", "src/utils"],
      relPath: "lib/a.ts",
      expected: true,
    },
    {
      label: "the union matches the second pattern",
      patterns: ["lib", "src/utils"],
      relPath: "src/utils/b.ts",
      expected: true,
    },
    {
      label: "the union excludes unmatched paths",
      patterns: ["lib", "src/utils"],
      relPath: "src/a.ts",
      expected: false,
    },
    // Match-nothing elements.
    {
      label: "an empty-string element matches nothing",
      patterns: [""],
      relPath: "src/a.ts",
      expected: false,
    },
    {
      label: "an empty-string element matches nothing at the root",
      patterns: [""],
      relPath: "a.ts",
      expected: false,
    },
    {
      label: 'a "." element matches nothing',
      patterns: ["."],
      relPath: "src/a.ts",
      expected: false,
    },
    {
      label: 'a "." element matches nothing at the root',
      patterns: ["."],
      relPath: "a.ts",
      expected: false,
    },
    {
      label: 'a bare "./" element matches nothing',
      patterns: ["./"],
      relPath: "src/a.ts",
      expected: false,
    },
    {
      label: 'a non-singleton "..." contributes nothing to the union',
      patterns: ["...", "src"],
      relPath: "src/a.ts",
      expected: true,
    },
    {
      label: 'a non-singleton "..." never matches alone',
      patterns: ["...", "src"],
      relPath: "lib/a.ts",
      expected: false,
    },
    {
      label: 'a non-singleton "./..." contributes nothing to the union',
      patterns: ["./...", "src"],
      relPath: "src/a.ts",
      expected: true,
    },
    {
      label: 'a non-singleton "./..." never matches alone',
      patterns: ["./...", "src"],
      relPath: "lib/a.ts",
      expected: false,
    },
    {
      label: "only one leading ./ is stripped",
      patterns: ["././src"],
      relPath: "src/a.ts",
      expected: false,
    },
    // A matching-nothing set.
    {
      label: "a prefix matching no file excludes everything",
      patterns: ["nowhere"],
      relPath: "src/a.ts",
      expected: false,
    },
  ])("$label: $relPath is $expected", ({ patterns, relPath, expected }) => {
    // The composed form the pipeline uses: normalize once, then test
    // scope (tasks.md T014 applies exactly this pair as the filter).
    expect(pathInScope(relPath, normalizePatterns(patterns))).toBe(expected);
  });
});

describe("prepareAnalysis: analysis scope (FR-002, SC-005)", () => {
  it("analyzes source files while test files and generated files never produce records", {
    timeout: 30_000,
  }, async () => {
    const root = await makeTree({
      "src/lib.ts": KEEP,
      "src/foo.test.ts": TESTED,
      "__tests__/x.ts": X_CASE,
      "tests/y.ts": Y_CASE,
      "src/generated.ts": GENERATED,
    });
    const sink = memorySink();
    const stdout = vi.spyOn(process.stdout, "write");

    // Absent patterns mean the whole tree (FR-001), and the whole tree
    // minus the exclusions is exactly the one handwritten source file:
    // the test-named file, both test-directory files, and the
    // @generated-marked file all declare functions that appear nowhere.
    const prepared = await prepareAnalysis(root, undefined, sink.stream);

    expect(recordPaths(prepared)).toEqual(["src/lib.ts"]);
    const [record] = prepared.records;
    expect(record?.name).toBe("keep");
    expect(record?.line).toBe(1);
    // Test-file and generated-marker exclusion is a silent documented
    // policy (FR-002 over discovery's exclusion chain): no skip
    // diagnostics, and stdout stays reserved for JSON-RPC responses.
    expect(sink.text()).toBe("");
    expect(stdout).not.toHaveBeenCalled();
    releaseContext(prepared);
  });

  it.each([
    {
      summary: "the src subtree under a bare prefix",
      patterns: ["src"],
      expected: ["src/alpha.ts", "src/nested/beta.ts"],
    },
    {
      summary: "the src subtree under a stripped /... form",
      patterns: ["src/..."],
      expected: ["src/alpha.ts", "src/nested/beta.ts"],
    },
    {
      summary: "the src subtree under a stripped ./ form",
      patterns: ["./src"],
      expected: ["src/alpha.ts", "src/nested/beta.ts"],
    },
    {
      summary: "the src subtree under a stripped ./ and /... form",
      patterns: ["./src/..."],
      expected: ["src/alpha.ts", "src/nested/beta.ts"],
    },
    {
      summary: "the lib subtree only",
      patterns: ["lib"],
      expected: ["lib/gamma.ts"],
    },
  ])(
    "scopes analysis records to $summary",
    { timeout: 30_000 },
    async ({ patterns, expected }) => {
      const root = await makeTree({
        "src/alpha.ts": ALPHA,
        "src/nested/beta.ts": BETA,
        "lib/gamma.ts": GAMMA,
      });
      const { prepared, sink } = await analyzeTree(root, patterns);
      // Only functions from in-scope files are reported (spec US1 scenario
      // 7), in the deterministic (file, line, name) record order.
      expect(recordPaths(prepared)).toEqual(expected);
      expect(sink.text()).toBe("");
      releaseContext(prepared);
    },
  );

  it.each([
    { label: "a directory prefix that matches no file", patterns: ["nowhere"] },
    { label: "the empty-string element", patterns: [""] },
    { label: 'the "." element', patterns: ["."] },
  ])(
    "returns empty records, never an error, for $label",
    { timeout: 30_000 },
    async ({ patterns }) => {
      const root = await makeTree({ "src/lib.ts": KEEP });
      const { prepared, sink } = await analyzeTree(root, patterns);
      // A pattern set matching nothing yields empty results, never an error
      // (FR-001 / spec edge case): the call resolved — this line is reached
      // — and the record list is exactly empty.
      expect(prepared.records).toEqual([]);
      expect(sink.text()).toBe("");
      releaseContext(prepared);
    },
  );
});

describe("prepareAnalysis: root path resolution", () => {
  it("resolves a relative root_path against process.cwd()", {
    timeout: 30_000,
  }, async () => {
    const root = await makeTree({ "app.ts": APP });
    const expected = await analyzeTree(root, undefined);
    // The fixture sits under a tmpdir; chdir to that directory so the
    // tree is genuinely beneath process.cwd() and the mkdtemp basename is
    // a real relative path. process.chdir affects the whole worker
    // process; the cwd is restored in a finally so the window is exactly
    // one pipeline call.
    const previousCwd = process.cwd();
    process.chdir(dirname(root));
    try {
      const viaRelative = await analyzeTree(basename(root), undefined);
      expect(recordTuples(viaRelative.prepared)).toEqual(
        recordTuples(expected.prepared),
      );
      releaseContext(viaRelative.prepared);
    } finally {
      process.chdir(previousCwd);
    }
    releaseContext(expected.prepared);
  });

  it("rejects a nonexistent root with InvalidRootPathError", async () => {
    const scratch = await makeScratchDir();
    const missing = join(scratch, "does-not-exist");
    const sink = memorySink();
    await expect(
      prepareAnalysis(missing, undefined, sink.stream),
    ).rejects.toBeInstanceOf(InvalidRootPathError);
    await expect(prepareAnalysis(missing, undefined, sink.stream)).rejects.toThrow(
      "root_path is not a directory:",
    );
  });

  it("rejects a file used as the root with InvalidRootPathError", async () => {
    const root = await makeTree({ "not-a-directory.ts": "" });
    const fileAsRoot = join(root, "not-a-directory.ts");
    const sink = memorySink();
    await expect(
      prepareAnalysis(fileAsRoot, undefined, sink.stream),
    ).rejects.toBeInstanceOf(InvalidRootPathError);
    await expect(prepareAnalysis(fileAsRoot, undefined, sink.stream)).rejects.toThrow(
      "root_path is not a directory:",
    );
  });

  // The root is made inaccessible through an unsearchable parent directory
  // (chmod 000): realpath/stat on the root itself succeed even at mode 000,
  // so the locked parent is what drives validation to EACCES — the same
  // fixture shape as tests/discovery.test.ts.
  it.skipIf(runningAsRoot)(
    "rejects an inaccessible root with InvalidRootPathError",
    async () => {
      const scratch = await makeScratchDir();
      const locked = join(scratch, "locked");
      const project = join(locked, "project");
      await mkdir(project, { recursive: true });
      await chmod(locked, 0o000);
      try {
        const sink = memorySink();
        await expect(
          prepareAnalysis(project, undefined, sink.stream),
        ).rejects.toBeInstanceOf(InvalidRootPathError);
        await expect(prepareAnalysis(project, undefined, sink.stream)).rejects.toThrow(
          "root_path is not a directory:",
        );
      } finally {
        // Restore searchability so scratch teardown can never be blocked
        // by the mode bits.
        await chmod(locked, 0o700);
      }
    },
  );
});

// Scripts ONE test's pipeline stages (the tests/program.test.ts
// compiler-drift-guard pattern): the real modules pass through untouched
// except that `extractFunctions` always throws — a mid-pipeline failure
// after a successful bootstrap — and `buildProgramContext` returns a
// recording fake context whose dispose is a spy. The fake never spawns a
// native compiler server, so the failure-path contract is pinned without
// one. Returns the dispose spy for the release assertions.
function mockFailingExtraction(
  mode: "program" | "parse-only",
): ReturnType<typeof vi.fn> {
  const dispose = vi.fn();
  vi.doMock("../src/program.js", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../src/program.js")>();
    return {
      ...actual,
      buildProgramContext: () =>
        mode === "program"
          ? { mode: "program", dispose }
          : { mode: "parse-only", sources: new Map() },
    };
  });
  vi.doMock("../src/extract.js", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../src/extract.js")>();
    return {
      ...actual,
      extractFunctions: () => {
        throw new Error("compiler channel died during extraction");
      },
    };
  });
  return dispose;
}

// Imports a fresh, mock-respecting copy of src/analysis.ts: vi.resetModules()
// clears the registry so the dynamic import re-evaluates the module (and its
// program/extract dependencies) through the active doMock registrations,
// while the file's static import — used by every unmocked test above — keeps
// its original real-module binding.
async function importFreshAnalysis(): Promise<typeof import("../src/analysis.js")> {
  vi.resetModules();
  return await import("../src/analysis.js");
}

describe("prepareAnalysis: extraction-failure context release", () => {
  afterEach(() => {
    vi.doUnmock("../src/program.js");
    vi.doUnmock("../src/extract.js");
    vi.resetModules();
  });

  it("disposes the program-mode compiler context when extraction throws — and still rethrows the failure", {
    timeout: 30_000,
  }, async () => {
    const dispose = mockFailingExtraction("program");
    const root = await makeTree({ "src/lib.ts": KEEP });
    const sink = memorySink();
    const { prepareAnalysis: freshPrepare } = await importFreshAnalysis();
    await expect(freshPrepare(root, undefined, sink.stream)).rejects.toThrow(
      "compiler channel died during extraction",
    );
    // Exactly one release: the failed pipeline never hands the context to
    // a consumer, so the catch path is the only disposer.
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("rethrows a parse-only extraction failure unchanged — nothing to dispose, no dispose call", {
    timeout: 30_000,
  }, async () => {
    const dispose = mockFailingExtraction("parse-only");
    const root = await makeTree({ "src/lib.ts": KEEP });
    const sink = memorySink();
    const { prepareAnalysis: freshPrepare } = await importFreshAnalysis();
    await expect(freshPrepare(root, undefined, sink.stream)).rejects.toThrow(
      "compiler channel died during extraction",
    );
    expect(dispose).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// T017 (spec 003; US1 tests; FR-012/FR-013; SC-001–SC-005; research R10,
// R13; quickstart.md Sections 1, 3, 5, 8;
// contracts/analyze-classification.md). The suites below pin the analyze
// entry's classification wiring in two halves: composition-seam suites
// (green — T024 landed the fan-out core) and an analyze-wiring suite
// (RED-FIRST — analyze() attaches nothing until T025 inserts the seam).
// ---------------------------------------------------------------------------

// The quickstart tree (quickstart.md Section 1), verbatim — the canonical
// controlled-signal profile fixture: one signal category per function,
// deliberately minimal, WITH a tsconfig because the profile's interface
// and caller-count signals need program mode. The interface in print.ts
// is module-local so the +6 exported-receiver component does not fire;
// handle's `Handle` prefix is deliberately routed away from StdoutWrite
// (the routing gate), leaving the interface signal alone at the
// contractual boundary. Section 8's parse-only variant reuses the same
// sources without the tsconfig.
const QUICKSTART_TSCONFIG = `{
  "compilerOptions": {
    "strict": true
  }
}`;

const QUICKSTART_SOURCES: Readonly<Record<string, string>> = {
  "src/calc.ts": `function getTotal(input: number): number {
  return input * 2;
}
`,
  "src/noise.ts": `/**
 * Logs the message for debugging.
 */
function logMessage(message: string, logger: { info(m: string): void }): void {
  logger.info(message);
}
`,
  "src/banner.ts": `/**
 * Logs the banner to stdout.
 */
function writeBanner(banner: string): void {
  console.log(banner);
}
`,
  "src/quiet.ts": `function tweak(counter: { n: number }): void {
  counter.n = counter.n + 1;
}
`,
  "src/print.ts": `interface Handler {
  handle(event: string): void;
}

class PrintHandler implements Handler {
  handle(event: string): void {
    console.log(event);
  }
}
`,
  "src/util.ts": `export function formatLabel(value: string): string {
  return \`[\${value}]\`;
}
`,
  "src/main1.ts": `import { formatLabel } from "./util";

export function main1(): string {
  return formatLabel("one");
}
`,
  "src/main2.ts": `import { formatLabel } from "./util";

export function main2(): string {
  return formatLabel("two");
}
`,
};

function quickstartFiles(withTsconfig: boolean): Record<string, string> {
  return withTsconfig
    ? { ...QUICKSTART_SOURCES, "tsconfig.json": QUICKSTART_TSCONFIG }
    : { ...QUICKSTART_SOURCES };
}

// One classified run through the composition seam — the exact stage order
// research R10 pins for T025's analyze() wiring (the adapter header's
// composition contract): detection, then evidence while the context is
// live, then the fan-out, then the unchanged assembly and serialization.
// The mode assertion sits inside the try on purpose (the runEvidence
// discipline in tests/signals/evidence.test.ts): a silent tsconfig
// fallback to parse-only would degrade the program-mode profile
// vacuously — every interface and caller assertion passing as its
// absence — without failing a single test.
interface ClassifiedRun {
  readonly functions: readonly WireRecord[];
  readonly signals: readonly Signal[];
}

async function classifiedTree(
  rootPath: string,
  expectedMode: "program" | "parse-only",
): Promise<ClassifiedRun> {
  const sink = memorySink();
  const prepared = await prepareAnalysis(rootPath, undefined, sink.stream);
  try {
    expect(prepared.context.mode).toBe(expectedMode);
    const effects = detectEffects(prepared.records, prepared.context);
    const evidence = buildRecordEvidence(
      prepared.context,
      prepared.records,
      prepared.inScopePaths,
    );
    const classified = classifyPairs(prepared.records, effects, evidence);
    const assembled = assembleFunctionRecords(prepared.records, classified.effects);
    return {
      functions: extractFunctions(assembled.map(serializeFunctionRecord)),
      signals: classified.signals,
    };
  } finally {
    if (prepared.context.mode === "program") {
      prepared.context.dispose();
    }
  }
}

// The contract-pinned signal projection (quickstart Section 4's jq shape):
// the five pinned fields per row — `reasoning` wording is
// implementation-defined and stays out. Used for the per-pair wire-set
// assertions (the contradiction set, the clamp's evidence).
function signalRows(
  run: ClassifiedRun,
  fn: string,
  effectType: string,
): ReadonlyArray<Record<string, unknown>> {
  return run.signals
    .filter(
      (signal) => signal.function === fn && signal.side_effect_type === effectType,
    )
    .map((signal) => ({
      function: signal.function,
      package: signal.package,
      side_effect_type: signal.side_effect_type,
      source: signal.source,
      weight: signal.weight,
    }));
}

// The profile projection (quickstart Section 3's jq shape): records as
// {name, file, effects: [{type, classification}]} — every field the
// classification contract pins. Effect `description` wording is
// implementation-defined and stays out of the projection (the wire
// helper's assertion discipline); the classification is passed through
// verbatim so the analyze-wiring cases fail on `undefined` until T025.
interface ProfileEffect {
  readonly type: string;
  readonly classification: WireClassification | undefined;
}

interface ProfileRecord {
  readonly name: string;
  readonly file: string;
  readonly effects: readonly ProfileEffect[];
}

function profileOf(functions: readonly WireRecord[]): ProfileRecord[] {
  return functions.map(
    (record): ProfileRecord => ({
      name: record.name,
      file: record.file,
      effects: record.side_effects.map(
        (effect): ProfileEffect => ({
          type: effect.type,
          classification: effect.classification,
        }),
      ),
    }),
  );
}

// The quickstart program-mode profile (quickstart Sections 3 and 5) — the
// exact {label, confidence} per effect, each row's arithmetic in its
// comment. SC-001's definition: every contributing signal pinned, the
// expected confidence exact arithmetic, never a snapshot.
const QUICKSTART_PROFILE: readonly ProfileRecord[] = [
  {
    name: "writeBanner",
    file: "src/banner.ts",
    // 50 + 0 (P3) + naming `Write` +10 − docstring `Logs` −15 −
    // contradiction 20 = 25 — the tree's one mixed-polarity pair.
    effects: [
      {
        type: "StdoutWrite",
        classification: { label: "incidental", confidence: 25 },
      },
    ],
  },
  {
    name: "getTotal",
    file: "src/calc.ts",
    // 50 + 25 (P0) + naming `Get` +10 = 85 — the naming-only profile.
    effects: [
      {
        type: "ReturnValue",
        classification: { label: "contractual", confidence: 85 },
      },
    ],
  },
  {
    name: "main1",
    file: "src/main1.ts",
    // 50 + 25 (P0) + visibility (exported) +8 = 83.
    effects: [
      {
        type: "ReturnValue",
        classification: { label: "contractual", confidence: 83 },
      },
    ],
  },
  {
    name: "main2",
    file: "src/main2.ts",
    // 50 + 25 (P0) + visibility (exported) +8 = 83.
    effects: [
      {
        type: "ReturnValue",
        classification: { label: "contractual", confidence: 83 },
      },
    ],
  },
  {
    name: "logMessage",
    file: "src/noise.ts",
    // 50 + 0 (P2) − naming `log` −10 − docstring `Logs` −15 = 25 —
    // all-negative agreement, so no contradiction fires.
    effects: [
      {
        type: "LogWrite",
        classification: { label: "incidental", confidence: 25 },
      },
    ],
  },
  {
    name: "handle",
    file: "src/print.ts",
    // 50 + 0 (P3) + interface +30 = 80 — the contractual boundary
    // (FR-010's ≥ 80 line, inclusive); the `Handle` prefix is routed
    // away from StdoutWrite, so the interface signal stands alone.
    effects: [
      {
        type: "StdoutWrite",
        classification: { label: "contractual", confidence: 80 },
      },
    ],
  },
  {
    name: "tweak",
    file: "src/quiet.ts",
    // 50 + 25 (P0) = 75 — the no-signal P0 floor (US1 scenario 3).
    effects: [
      {
        type: "PointerArgMutation",
        classification: { label: "ambiguous", confidence: 75 },
      },
    ],
  },
  {
    name: "formatLabel",
    file: "src/util.ts",
    // 50 + 25 (P0) + caller_count +10 (main1 and main2 — two distinct
    // modules) + visibility (exported) +8 = 93.
    effects: [
      {
        type: "ReturnValue",
        classification: { label: "contractual", confidence: 93 },
      },
    ],
  },
];

// The parse-only profile (quickstart Section 8): exactly two visible
// shifts — handle 80 → 50 (the checker-dependent interface signal absent,
// the P3 floor) and formatLabel 93 → 83 (the caller signal absent; the
// syntactic visibility +8 survives) — with every syntactic-signal
// classification unchanged. Derived from the program-mode table so the
// "only these two shift" claim is the fixture's own shape, not a second
// hand-copied table that could drift.
const QUICKSTART_PROFILE_PARSE_ONLY: readonly ProfileRecord[] = QUICKSTART_PROFILE.map(
  (record) => {
    if (record.name === "handle") {
      return {
        ...record,
        effects: [
          {
            type: "StdoutWrite",
            classification: { label: "ambiguous", confidence: 50 },
          },
        ],
      };
    }
    if (record.name === "formatLabel") {
      return {
        ...record,
        effects: [
          {
            type: "ReturnValue",
            classification: { label: "contractual", confidence: 83 },
          },
        ],
      };
    }
    return record;
  },
);

describe("classification seam: quickstart controlled-signal profile (003 FR-012/FR-013; SC-001/SC-004; quickstart Sections 1-5)", () => {
  // Program mode over the canonical tree is shared across the suite's
  // tests (the detector-rules describe-level pattern): one native
  // compiler server's worth of pipeline, cleaned in afterAll.
  let run: ClassifiedRun = { functions: [], signals: [] };
  let cleanup: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    const tree = await createFixtureTree(quickstartFiles(true));
    cleanup = tree.cleanup;
    run = await classifiedTree(tree.root, "program");
  }, 60_000);

  afterAll(async () => {
    await cleanup?.();
  });

  it("every effect carries a serializer-valid classification — the 002 wire shape plus the 003 amendment (SC-004)", () => {
    expectWireInvariants(run.functions);
  });

  it("asserts the exact {label, confidence} arithmetic per effect (SC-001; quickstart Sections 3+5)", () => {
    expect(profileOf(run.functions)).toEqual(QUICKSTART_PROFILE);
  });

  it("writeBanner's contradiction fires exactly once — the three-signal wire set (003 FR-011/SC-002)", () => {
    // The pair's complete wire set: naming +10 (the `Write` prefix,
    // routed to StdoutWrite through the output family), docstring −15
    // (the incidental verb "logs" in the banner JSDoc), and exactly ONE
    // synthesized contradiction row at −20 — mixed polarity fires the
    // penalty once however many signals of either polarity fired. The
    // rows come from the feed in four-key order, so source order within
    // the pair is codepoint order: contradiction < docstring <
    // naming_convention.
    expect(signalRows(run, "writeBanner", "StdoutWrite")).toEqual([
      {
        function: "writeBanner",
        package: "src.banner",
        side_effect_type: "StdoutWrite",
        source: "contradiction",
        weight: -20,
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
    // The sum-invariant form those rows pin: 50 + 0 (P3) + 10 − 15 − 20
    // = 25 — a consumer summing the pair's rows (the contradiction row
    // included) reproduces the reported confidence exactly (FR-011).
    const banner = recordFor(run.functions, "writeBanner", "src/banner.ts");
    expect(banner.side_effects[0]?.classification).toEqual({
      label: "incidental",
      confidence: 25,
    });
  });
});

describe("classification seam: same-type effects share one classification (003 FR-008)", () => {
  it("two ReturnValue effects on one record carry the identical, exact classification", {
    timeout: 30_000,
  }, async () => {
    // The fan-out counts DISTINCT canonical types, never effect
    // instances, so a record with two returns runs one pair and both
    // instances carry its one classification: 50 + 25 (P0) + naming
    // `Get` +10 = 85 contractual (parse-only keeps the naming signal —
    // prefix matching is syntactic).
    const root = await makeTree({
      "dual.ts": `function getSign(value: number): number {
  if (value > 0) {
    return 1;
  }
  return 0 - value;
}
`,
    });
    const run = await classifiedTree(root, "parse-only");
    expectWireInvariants(run.functions);
    expect(profileOf(run.functions)).toEqual([
      {
        name: "getSign",
        file: "dual.ts",
        effects: [
          {
            type: "ReturnValue",
            classification: { label: "contractual", confidence: 85 },
          },
          {
            type: "ReturnValue",
            classification: { label: "contractual", confidence: 85 },
          },
        ],
      },
    ]);
    // The sharing itself, asserted directly: the second instance's
    // classification equals the first's — one pair run, identical value.
    const record = recordFor(run.functions, "getSign", "dual.ts");
    const [first, second] = record.side_effects;
    expect(second?.classification).toEqual(first?.classification);
  });
});

describe("classification seam: tier offsets on identical signal profiles (003 SC-003)", () => {
  it("empty signal profiles on P0, P1, and P2 effects yield 75/60/50 — exactly the +25/+10/+0 offsets", {
    timeout: 30_000,
  }, async () => {
    // Three module-private, undocumented, unrouted, uncalled functions —
    // identical (empty) signal profiles — whose effects sit at the three
    // boost tiers: adjust → PointerArgMutation (P0), bumpTotal →
    // GlobalMutation (P1), note → LogWrite (P2, the `log` receiver
    // name-form). Parse-only keeps every involved rule syntactic.
    const root = await makeTree({
      "tiers.ts": `let total = 0;
function bumpTotal(): void {
  total = total + 1;
}
function adjust(counter: { n: number }): void {
  counter.n = counter.n + 2;
}
function note(log: { info(message: string): void }): void {
  log.info("tick");
}
`,
    });
    const run = await classifiedTree(root, "parse-only");
    expectWireInvariants(run.functions);
    expect(profileOf(run.functions)).toEqual([
      {
        name: "bumpTotal",
        file: "tiers.ts",
        // 50 + 10 (P1) = 60.
        effects: [
          {
            type: "GlobalMutation",
            classification: { label: "ambiguous", confidence: 60 },
          },
        ],
      },
      {
        name: "adjust",
        file: "tiers.ts",
        // 50 + 25 (P0) = 75.
        effects: [
          {
            type: "PointerArgMutation",
            classification: { label: "ambiguous", confidence: 75 },
          },
        ],
      },
      {
        name: "note",
        file: "tiers.ts",
        // 50 + 0 (P2) = 50.
        effects: [
          {
            type: "LogWrite",
            classification: { label: "ambiguous", confidence: 50 },
          },
        ],
      },
    ]);
    // SC-003's offset form, computed from the reported confidences:
    // relative to the P2 floor, the identical profiles differ by exactly
    // the tier boosts (the taxonomy's TIER_MAP arithmetic — P2–P4 all
    // boost +0, which is why the quickstart's own +0 rows are P3).
    const byName = new Map(run.functions.map((record) => [record.name, record]));
    const confidenceOf = (name: string): number => {
      const classification = byName.get(name)?.side_effects[0]?.classification;
      if (classification === undefined) {
        throw new Error(`record "${name}" carries no classified effect`);
      }
      return classification.confidence;
    };
    expect(confidenceOf("adjust") - confidenceOf("note")).toBe(25);
    expect(confidenceOf("bumpTotal") - confidenceOf("note")).toBe(10);
  });
});

describe("classification seam: confidence clamp (003 FR-009)", () => {
  it("a real-tree profile whose raw score exceeds 100 yields exactly 100", {
    timeout: 30_000,
  }, async () => {
    // buildTag stacks every positive signal the pipeline can produce on
    // one pair: interface +30 (Shaper declares the member ShaperImpl
    // implements), visibility +6 (the exported-receiver component —
    // class members never take the function component; the primitive
    // `string` return type fires nothing), caller_count +15 (four
    // distinct calling modules), naming +10 (the `Build` prefix, routed
    // to ReturnValue through the value family) on a P0 pair (+25) — raw
    // 50 + 25 + 30 + 6 + 15 + 10 = 136, reported as exactly 100.
    //
    // The lower clamp (raw < 0 → exactly 0) is unreachable through real
    // extractor arithmetic — the minimum realizable raw is 10 (a lone
    // caller +5 against naming −10, docstring −15, and the contradiction
    // −20 on a P2+ pair) — so it is pinned at the classifyBundle seam
    // with deliberately out-of-set weights by tests/signals/adapter.test
    // .ts (T016), exactly as visibility's seam-unreachable all-three
    // row is. This suite owns the end-to-end upper bound.
    const caller = (name: string, value: string): string =>
      `import { ShaperImpl } from "./api";

export function ${name}(): string {
  const shaper = new ShaperImpl();
  return shaper.buildTag(${value});
}
`;
    const root = await makeTree({
      "tsconfig.json": QUICKSTART_TSCONFIG,
      "src/api.ts": `export interface Shaper {
  buildTag(value: number): string;
}
export class ShaperImpl implements Shaper {
  buildTag(value: number): string {
    return \`<\${value}>\`;
  }
}
`,
      "src/use-a.ts": caller("useA", "1"),
      "src/use-b.ts": caller("useB", "2"),
      "src/use-c.ts": caller("useC", "3"),
      "src/use-d.ts": caller("useD", "4"),
    });
    const run = await classifiedTree(root, "program");
    expectWireInvariants(run.functions);
    // The four extractor rows prove the raw score is genuinely 136 — the
    // reported 100 is the clamp, never a coincidence of smaller
    // arithmetic. Four-key order within the pair: caller_count <
    // interface < naming_convention < visibility.
    expect(signalRows(run, "buildTag", "ReturnValue")).toEqual([
      {
        function: "buildTag",
        package: "src.api",
        side_effect_type: "ReturnValue",
        source: "caller_count",
        weight: 15,
      },
      {
        function: "buildTag",
        package: "src.api",
        side_effect_type: "ReturnValue",
        source: "interface",
        weight: 30,
      },
      {
        function: "buildTag",
        package: "src.api",
        side_effect_type: "ReturnValue",
        source: "naming_convention",
        weight: 10,
      },
      {
        function: "buildTag",
        package: "src.api",
        side_effect_type: "ReturnValue",
        source: "visibility",
        weight: 6,
      },
    ]);
    const record = recordFor(run.functions, "buildTag", "src/api.ts");
    expect(record.side_effects[0]?.classification).toEqual({
      label: "contractual",
      confidence: 100,
    });
  });
});

describe("classification seam: parse-only degradation — precision, never availability (003 SC-004; quickstart Section 8)", () => {
  let run: ClassifiedRun = { functions: [], signals: [] };
  let cleanup: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    // The same quickstart sources minus the tsconfig: the pipeline
    // bootstraps parse-only (FR-004), the checker-dependent interface
    // and caller_count signals are absent, and every effect is still
    // classified — degradation reduces precision, never availability.
    const tree = await createFixtureTree(quickstartFiles(false));
    cleanup = tree.cleanup;
    run = await classifiedTree(tree.root, "parse-only");
  }, 30_000);

  afterAll(async () => {
    await cleanup?.();
  });

  it("every effect STILL carries a classification — SC-004 holds in both modes", () => {
    expectWireInvariants(run.functions);
  });

  it("the checker-dependent signals drop: handle 80 → 50 and formatLabel 93 → 83; every syntactic classification unchanged", () => {
    expect(profileOf(run.functions)).toEqual(QUICKSTART_PROFILE_PARSE_ONLY);
  });
});

describe("classification seam: detection-ambiguity markers coexist with classification (003 assumption 14)", () => {
  it('an eval-carrying effect keeps detail.confidence "ambiguous" and still receives a computed classification', {
    timeout: 30_000,
  }, async () => {
    // Detection confidence (spec 002 FR-017's marker) and the
    // classification label are distinct notions that coexist on one
    // effect: classification is attached after detection and never
    // alters the marker, while the marker-carrying effect is classified
    // by the same uniform formula — here the syntactic visibility +8 on
    // a P2 pair: 50 + 0 + 8 = 58 (the labels coincide at "ambiguous";
    // the notions do not — one is a detection-confidence string, the
    // other a computed {label, confidence} verdict).
    const root = await makeTree({
      "opaque.ts": `export function runDynamic(code: string): void {
  eval(code);
}
`,
    });
    const run = await classifiedTree(root, "parse-only");
    expectWireInvariants(run.functions);
    const record = recordFor(run.functions, "runDynamic", "opaque.ts");
    expect(record.side_effects).toHaveLength(1);
    const effect = record.side_effects[0];
    expect(effect?.type).toBe("CallbackInvocation");
    expect(effect?.detail).toEqual({ confidence: "ambiguous" });
    expect(effect?.classification).toEqual({ label: "ambiguous", confidence: 58 });
  });
});

describe("analyze wiring: classified effects on the wire (003 FR-012/FR-013; SC-001/SC-004/SC-005) — RED-FIRST until T025", () => {
  // analyze() does not attach classifications until T025 inserts the
  // signal core between detection and assembly (research R10), so every
  // case in this suite currently fails on the missing field — the
  // intended red observation tasks.md's test-first discipline requires.
  // The paired implementation turns them green without touching these
  // assertions.
  let root = "";
  let viaAnalyze: readonly Record<string, unknown>[] = [];
  let viaSeam: ClassifiedRun = { functions: [], signals: [] };
  let cleanup: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    const tree = await createFixtureTree(quickstartFiles(true));
    cleanup = tree.cleanup;
    root = tree.root;
    viaAnalyze = await analyze(root, undefined, memorySink().stream);
    viaSeam = await classifiedTree(root, "program");
  }, 60_000);

  afterAll(async () => {
    await cleanup?.();
  });

  it("every effect in the analyze response carries a serializer-valid classification (SC-004; 002 FR-019 superseded)", () => {
    expectWireInvariants(extractFunctions(viaAnalyze));
  });

  it("analyze reports the quickstart profile exactly (SC-001; quickstart Section 3)", () => {
    expect(profileOf(extractFunctions(viaAnalyze))).toEqual(QUICKSTART_PROFILE);
  });

  it("analyze's response is byte-identical to the composition seam's — one pipeline, one output (FR-013)", () => {
    // FR-013's one-shared-pipeline guarantee in its strongest local
    // form: the method's serialized response equals the classified
    // composition run over the same tree, byte for byte — analyze()
    // differs from the seam by nothing but the wiring T025 inserts.
    expect(JSON.stringify(viaAnalyze)).toBe(JSON.stringify(viaSeam.functions));
  });

  it("repeats byte-identically including classification fields (SC-005; quickstart Section 6)", {
    timeout: 30_000,
  }, async () => {
    // The golden determinism check: the same request twice returns the
    // same serialized payload — AND the classification fields are present
    // in both, so the byte-identity covers them rather than passing
    // vacuously on two identical classification-less responses.
    const second = await analyze(root, undefined, memorySink().stream);
    expect(JSON.stringify(second)).toBe(JSON.stringify(viaAnalyze));
    expectWireInvariants(extractFunctions(viaAnalyze));
    expectWireInvariants(extractFunctions(second));
  });

  it("parse-only: analyze still classifies every effect, with the degraded profile (SC-004 both modes; quickstart Section 8)", {
    timeout: 30_000,
  }, async () => {
    const tree = await createFixtureTree(quickstartFiles(false));
    registerCleanup(tree.cleanup);
    const result = await analyze(tree.root, undefined, memorySink().stream);
    const functions = extractFunctions(result);
    expectWireInvariants(functions);
    expect(profileOf(functions)).toEqual(QUICKSTART_PROFILE_PARSE_ONLY);
  });
});
