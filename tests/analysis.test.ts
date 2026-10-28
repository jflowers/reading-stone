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
//    honest against the landed module).
//
// Fixtures are tsconfig-less, so the pipeline bootstraps parse-only mode
// (FR-004) — the scope behavior under test (walk, screening, test-file
// exclusion, pattern filter) is decided before the bootstrap and is
// mode-independent. `releaseContext` still disposes a program-mode context
// the way the future analyze handler will, so this suite never leaks a
// native compiler server even if that mode ever applies.

import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { normalizePatterns, pathInScope, prepareAnalysis } from "../src/analysis.js";
import { InvalidRootPathError } from "../src/discovery.js";
import {
  createFixtureTree,
  drainCleanups,
  memorySink,
  registerCleanup,
} from "./helpers/fixtures.js";

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
