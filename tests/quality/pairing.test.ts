// Pairing-strategy fixtures for src/quality/pairing.ts (T009 + T023;
// FR-004/FR-005; research R4, R12; data-model.md Sections 5.3–5.4 and 6;
// US2 scenarios 1–7 with US1's naming slice; Constitution Principles I,
// III, and V).
//
// RED-FIRST: src/quality/pairing.ts does not exist yet — T016 creates it —
// so this suite fails on module resolution by design (tasks.md: US1 tests
// are written first and observed to FAIL before the paired implementation
// lands). T023's strategy suites follow the same discipline: the calls and
// imports strategies do not exist yet — T025 creates them — so those tests
// fail on the missing pairs by design.
//
// The contract pinned here, following tests/signals/adapter.test.ts's
// precedent for hand-built inputs (the dependency-injection seam — the
// naming strategy is purely lexical, so no compiler context is needed):
//
// - `buildTargetIndex(records, effects, context)` — the pairing-support
//   view built once per pipeline run (data-model Section 5.4): records in
//   `(file, line, name)` order, byName, byNode, the per-record effect
//   sets, and the live context.
// - `pairTests(tests, index, rootPath, stderr?)` — the three strategies in
//   first-match-wins priority order. The naming strategy (US1's slice,
//   asserted by the hand-built suites below): a test whose title OR
//   nearest enclosing describe title equals a target name pairs; exact
//   (case-sensitive) at confidence 90, case-insensitive-only
//   (`toLowerCase` both sides — platform-stable, no locale fold) at 70;
//   every same-named target pairs in the analyze record order
//   (compareFileLineName); the exact tier shadows the case-insensitive tier
//   per test; unpaired tests produce no pairs — never confidence-0 rows.
//   Within one test's emitted pairs, wire-indistinguishable targets
//   collapse to the first record in analyze record order (T036's
//   FR-005-amended first-wins dedup, keyed on the derived wire identity
//   `(derivePackage(relPath), name)` — same-file AND colliding-package
//   same-named records alike, the iteration-3 F1 amendment; the dedup
//   domain is the test
//   function, so same-titled siblings each keep their pairs).
// - The `Pairing` record: test, target, strategy, confidence.
//
// Hand-built records follow the adapter suite's localized-cast convention:
// the strategy reads only the identity fields (`name`, `relPath`, `line`),
// so the live compiler views are inert filler.
//
// T023's strategy suites (US2) pin the calls (`80`) and imports (`75`)
// tiers over REAL pipeline inputs — `prepareAnalysis` fixture trees in both
// bootstrap modes, the quickstart's shapes — because the strategies read
// the live checker (program mode) and the parse-only sources map, neither
// of which a hand-built context can carry:
//
// - calls — the test's callback subtree contains a call resolving to the
//   target: checker mode through symbol-declaration matching
//   (`getSymbolAtLocation` per callee, aliases followed, the declaration
//   matched against `byNode`), parse-only through terminal-identifier
//   matching; first-match-wins per test (naming shadows calls, calls
//   shadow imports — a strategy's pairs emit only when no higher-priority
//   strategy matched).
// - imports — the test file statically imports the target AND references
//   the binding outside the import clause (lexical scan, both modes):
//   checker mode through specifier symbols with re-exports followed (edge
//   case 7), parse-only through module-specifier path resolution over the
//   discovered in-root file set (the six extensions and `index` forms;
//   barrels uncrossed; package specifiers and root escapes resolve to
//   nothing — the FR-004 containment guard); every still-unpaired test in
//   the file pairs with each referenced target.

import { realpathSync } from "node:fs";
import type { Node } from "typescript/unstable/ast";
import { afterEach, describe, expect, it } from "vitest";
import { prepareAnalysis } from "../../src/analysis.js";
import type { ExtractionRecord } from "../../src/extract.js";
import type { Effect } from "../../src/models.js";
import type { ProgramContext } from "../../src/program.js";
import { collectTestFunctions, type TestFunction } from "../../src/quality/collect.js";
import {
  buildTargetIndex,
  type Pairing,
  pairTests,
  type TargetIndex,
} from "../../src/quality/pairing.js";
import type { SideEffectType } from "../../src/taxonomy.js";
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

// The checker-mode fixture tree's tsconfig — the pipeline.test.ts spelling.
const TSCONFIG = '{"compilerOptions": {"strict": true, "target": "ES2022"}}';

// The empty parse-only context: a hand-built stand-in carrying no sources
// — exactly what the naming strategy needs (nothing). The checker-mode
// strategies (US2, T025) exercise a live program context instead.
const EMPTY_CONTEXT: ProgramContext = { mode: "parse-only", sources: new Map() };

function recordOf(name: string, relPath: string, line: number): ExtractionRecord {
  return {
    name,
    relPath,
    line,
    node: undefined as unknown as Node,
    scopeChain: [],
    deferred: false,
  };
}

function testOf(
  title: string,
  overrides: Partial<Omit<TestFunction, "callback">> = {},
): TestFunction {
  return {
    title,
    qualifiedTitle: title,
    relPath: "tests/case.test.ts",
    describeTitles: [],
    callback: null,
    line: 1,
    index: 0,
    ...overrides,
  };
}

function indexOver(
  records: readonly ExtractionRecord[],
  effects = new Map<ExtractionRecord, readonly Effect[]>(),
): TargetIndex {
  return buildTargetIndex(records, effects, EMPTY_CONTEXT);
}

// The hand-built runs' entry: the naming tier's suites pair over
// parse-only contexts with null callbacks and an empty sources map, where
// the calls and imports tiers are structurally inert — no callback
// subtree to scan, no source file to resolve — so the placeholder root
// satisfies the production signature while spelling that inertness (the
// strategy suites below drive the full signature over real pipeline
// inputs through `strategyPairsIn`).
function namingTierPairs(
  tests: readonly TestFunction[],
  index: TargetIndex,
): Pairing[] {
  return pairTests(tests, index, "");
}

// The pair projection asserted throughout: the test's title (identity is
// the hand-built reference), the target's identity triple, the strategy,
// and the confidence — the four Pairing fields, node views excluded.
function pairIdentity(pairs: readonly Pairing[]) {
  return pairs.map((pair) => ({
    title: pair.test.title,
    name: pair.target.name,
    relPath: pair.target.relPath,
    line: pair.target.line,
    strategy: pair.strategy,
    confidence: pair.confidence,
  }));
}

const effect = (type: SideEffectType): Effect => ({
  type,
  description: `${type} fixture`,
});

// One full strategy-stage run over a fixture tree (T023's dependency on
// REAL pipeline inputs): prepareAnalysis with the test-arm widening, real
// collection, the real target index over the extracted records, and
// pairTests over both — the same stage sequence src/quality/pipeline.ts
// orchestrates, minus the assertion/inference stages the pairing suites
// do not exercise. The program-mode context is disposed in the finally
// discipline the pipeline owns; the sink text comes back for the
// diagnostic-contract assertions.
interface StrategyRun {
  readonly pairs: readonly Pairing[];
  readonly diagnostics: string;
}

async function strategyPairsIn(
  files: Readonly<Record<string, string>>,
): Promise<StrategyRun> {
  const tree = await createFixtureTree(files);
  registerCleanup(tree.cleanup);
  const sink = memorySink();
  // The production caller passes a root discovery already realpath-resolved;
  // the fixture's mkdtemp path sits behind macOS's /var symlink, so resolve
  // it the same way before analysis (the assertions.test.ts precedent).
  const prepared = await prepareAnalysis(
    realpathSync(tree.root),
    undefined,
    sink.stream,
    {
      includeTestArm: true,
    },
  );
  try {
    const tests = collectTestFunctions(
      prepared.testPaths,
      prepared.context,
      prepared.rootPath,
      sink.stream,
    );
    const index = buildTargetIndex(
      prepared.records,
      new Map<ExtractionRecord, readonly Effect[]>(),
      prepared.context,
    );
    return {
      pairs: pairTests(tests, index, prepared.rootPath, sink.stream),
      diagnostics: sink.text(),
    };
  } finally {
    if (prepared.context.mode === "program") {
      prepared.context.dispose();
    }
  }
}

describe("buildTargetIndex", () => {
  it("exposes the records, byName, byNode, effects, and context views", () => {
    const first = recordOf("add", "src/a.ts", 1);
    const second = recordOf("add", "src/b.ts", 4);
    const effects = new Map<ExtractionRecord, readonly Effect[]>([
      [first, [effect("ReturnValue")]],
    ]);
    const index = indexOver([first, second], effects);
    expect(index.records).toEqual([first, second]);
    expect(index.byName.get("add")).toEqual([first, second]);
    expect(index.byName.get("missing")).toBeUndefined();
    expect(index.byNode.get(first.node)).toBe(first);
    expect(index.effects.get(first)).toEqual([effect("ReturnValue")]);
    expect(index.context).toBe(EMPTY_CONTEXT);
  });
});

describe("pairTests (naming strategy)", () => {
  it("pairs a test whose title exactly equals a target name at confidence 90", () => {
    const target = recordOf("add", "src/math.ts", 1);
    const pairs = namingTierPairs([testOf("add")], indexOver([target]));
    expect(pairIdentity(pairs)).toEqual([
      {
        title: "add",
        name: "add",
        relPath: "src/math.ts",
        line: 1,
        strategy: "naming",
        confidence: 90,
      },
    ]);
    // Reference identity into the collector's output and the prepared
    // records (data-model Section 5.3) — the pair carries the very objects,
    // not copies, so downstream stages keep AST access.
    expect(pairs[0]?.test.title).toBe("add");
    expect(pairs[0]?.target).toBe(target);
  });

  it("pairs a case-insensitive-only match at confidence 70", () => {
    const target = recordOf("add", "src/math.ts", 1);
    const pairs = namingTierPairs([testOf("Add")], indexOver([target]));
    expect(pairIdentity(pairs)).toEqual([
      {
        title: "Add",
        name: "add",
        relPath: "src/math.ts",
        line: 1,
        strategy: "naming",
        confidence: 70,
      },
    ]);
  });

  it("pairs on the nearest enclosing describe title as strongly as the test title", () => {
    const target = recordOf("math", "src/math.ts", 1);
    const test = testOf("unrelated", { describeTitles: ["outer", "math"] });
    const pairs = namingTierPairs([test], indexOver([target]));
    expect(pairIdentity(pairs)).toEqual([
      {
        title: "unrelated",
        name: "math",
        relPath: "src/math.ts",
        line: 1,
        strategy: "naming",
        confidence: 90,
      },
    ]);
  });

  it("pairs every strategy match when both the title and the describe title hit", () => {
    // The match rule is a disjunction (data-model Section 6): the title and
    // the nearest describe title each contribute their matches, one tier.
    const titleHit = recordOf("alpha", "src/a.ts", 1);
    const describeHit = recordOf("beta", "src/b.ts", 1);
    const test = testOf("alpha", { describeTitles: ["beta"] });
    const pairs = namingTierPairs([test], indexOver([titleHit, describeHit]));
    expect(pairIdentity(pairs)).toEqual([
      {
        title: "alpha",
        name: "alpha",
        relPath: "src/a.ts",
        line: 1,
        strategy: "naming",
        confidence: 90,
      },
      {
        title: "alpha",
        name: "beta",
        relPath: "src/b.ts",
        line: 1,
        strategy: "naming",
        confidence: 90,
      },
    ]);
  });

  it("shadows the case-insensitive tier when any exact match exists", () => {
    // Research R4: a test matching one target exactly and another
    // case-insensitively emits ONLY the exact pair — the exact tier wins
    // per test, evaluation stops there.
    const exact = recordOf("Add", "src/z.ts", 1);
    const foldOnly = recordOf("add", "src/a.ts", 1);
    const pairs = namingTierPairs([testOf("Add")], indexOver([foldOnly, exact]));
    expect(pairIdentity(pairs)).toEqual([
      {
        title: "Add",
        name: "Add",
        relPath: "src/z.ts",
        line: 1,
        strategy: "naming",
        confidence: 90,
      },
    ]);
  });

  it("pairs every same-named target in the analyze record order", () => {
    // Declaration order spells b before a; the record order (file, line,
    // name) via compareFileLineName governs — every distinct
    // (target_package, target_function) pairs, deterministically ordered.
    const inB = recordOf("add", "src/b.ts", 1);
    const inA = recordOf("add", "src/a.ts", 5);
    const pairs = namingTierPairs([testOf("add")], indexOver([inB, inA]));
    expect(pairIdentity(pairs)).toEqual([
      {
        title: "add",
        name: "add",
        relPath: "src/a.ts",
        line: 5,
        strategy: "naming",
        confidence: 90,
      },
      {
        title: "add",
        name: "add",
        relPath: "src/b.ts",
        line: 1,
        strategy: "naming",
        confidence: 90,
      },
    ]);
  });

  it("produces no pairs for a test matched by no strategy", () => {
    // US1-3: an unpaired test produces no pairs and no rows — never
    // confidence-0 rows.
    const target = recordOf("add", "src/math.ts", 1);
    expect(namingTierPairs([testOf("unrelated")], indexOver([target]))).toEqual([]);
  });

  it("pairs each test independently", () => {
    const target = recordOf("add", "src/math.ts", 1);
    const pairs = namingTierPairs(
      [testOf("add"), testOf("unrelated"), testOf("ADD")],
      indexOver([target]),
    );
    expect(pairIdentity(pairs)).toEqual([
      {
        title: "add",
        name: "add",
        relPath: "src/math.ts",
        line: 1,
        strategy: "naming",
        confidence: 90,
      },
      {
        title: "ADD",
        name: "add",
        relPath: "src/math.ts",
        line: 1,
        strategy: "naming",
        confidence: 70,
      },
    ]);
  });

  it("matches case-insensitively through the nearest describe title too", () => {
    const target = recordOf("Math", "src/math.ts", 1);
    const test = testOf("unrelated", { describeTitles: ["math"] });
    const pairs = namingTierPairs([test], indexOver([target]));
    expect(pairIdentity(pairs)).toEqual([
      {
        title: "unrelated",
        name: "Math",
        relPath: "src/math.ts",
        line: 1,
        strategy: "naming",
        confidence: 70,
      },
    ]);
  });

  it("ignores farther describe titles — only the nearest one pairs", () => {
    // The naming strategy reads the NEAREST enclosing describe title
    // (data-model Section 5.1: "nearest for name pairing"); the outer
    // levels qualify the title, never pair it.
    const outer = recordOf("outer", "src/a.ts", 1);
    const test = testOf("unrelated", { describeTitles: ["outer", "inner"] });
    expect(namingTierPairs([test], indexOver([outer]))).toEqual([]);
  });

  it("returns no pairs over an empty target index", () => {
    expect(namingTierPairs([testOf("add")], indexOver([]))).toEqual([]);
  });

  it("returns no pairs for an empty test list", () => {
    const target = recordOf("add", "src/math.ts", 1);
    expect(namingTierPairs([], indexOver([target]))).toEqual([]);
  });
});

describe("pairTests (same-file-same-name pair-key dedup)", () => {
  // T036 — the iteration-2 review-fix suite (F1; FR-005 amended; data-model
  // Section 6 amended): two distinct records sharing one file and one
  // declared name (same-named methods of different classes, same-named
  // declarations in different scopes) are wire-indistinguishable targets —
  // identical pair key once the test side is constant — so only the FIRST
  // in analyze record order survives (first-wins, the byNode node-key
  // discipline). The collapse is a documented conservative imprecision:
  // the later same-named record emits no pairs and no rows. Same-named
  // records in different files whose paths derive GENUINELY different
  // packages stay distinct (the "pairs every same-named target in the
  // analyze record order" case above pins that half); same-named records
  // in colliding-package files collapse like the same-file case (the
  // iteration-3 F1 variant-a fixture below pins that half).
  it("collapses same-file same-name targets to the first record in analyze record order", () => {
    // Declaration order spells the later line first; the record order
    // (file, line, name) puts line 3 before line 9, so the FIRST record —
    // line 3 — owns the pair and the line-9 record collapses.
    const later = recordOf("render", "src/ui.ts", 9);
    const first = recordOf("render", "src/ui.ts", 3);
    const pairs = namingTierPairs([testOf("render")], indexOver([later, first]));
    expect(pairIdentity(pairs)).toEqual([
      {
        title: "render",
        name: "render",
        relPath: "src/ui.ts",
        line: 3,
        strategy: "naming",
        confidence: 90,
      },
    ]);
  });

  it("collapses same-file same-name targets in the case-insensitive tier too", () => {
    // The dedup is strategy-tier-agnostic: the fold tier's record-ordered
    // emission flows through the same per-test pair-key collapse.
    const later = recordOf("Render", "src/ui.ts", 9);
    const first = recordOf("Render", "src/ui.ts", 3);
    const pairs = namingTierPairs([testOf("render")], indexOver([later, first]));
    expect(pairIdentity(pairs)).toEqual([
      {
        title: "render",
        name: "Render",
        relPath: "src/ui.ts",
        line: 3,
        strategy: "naming",
        confidence: 70,
      },
    ]);
  });

  it("collapses same-named targets in colliding-package files to the first record in analyze record order", () => {
    // Iteration-3 F1 variant a (FR-005 amended; data-model Section 6
    // amended): derivePackage is NOT injective over files — src/pkg.ts
    // and src/pkg/index.ts both derive "src.pkg" (the file-vs-index
    // flattening) — so same-named records in those different files are
    // wire-indistinguishable exactly like the same-file case. The
    // analyze record order (file, line, name) puts "src/pkg.ts" first
    // ("." sorts before "/" in UTF-16 code-unit order), so its record
    // owns the pair and the nested index record collapses.
    const nested = recordOf("util", "src/pkg/index.ts", 1);
    const flat = recordOf("util", "src/pkg.ts", 5);
    const pairs = namingTierPairs([testOf("util")], indexOver([nested, flat]));
    expect(pairIdentity(pairs)).toEqual([
      {
        title: "util",
        name: "util",
        relPath: "src/pkg.ts",
        line: 5,
        strategy: "naming",
        confidence: 90,
      },
    ]);
  });

  it("dedups per test function — same-titled sibling tests each keep their pairs", () => {
    // Edge case 2 unchanged (FR-005 amended): two same-titled sibling
    // tests inside one describe are distinct test functions sharing one
    // test_function; the dedup domain is the test function's own
    // emission, never the wire tuple, so each sibling keeps its pair —
    // the rows disambiguate downstream through assertion_location.
    const target = recordOf("render", "src/ui.ts", 1);
    const first = testOf("render", { line: 2, index: 0 });
    const second = testOf("render", { line: 5, index: 1 });
    const pairs = namingTierPairs([first, second], indexOver([target]));
    expect(pairs).toHaveLength(2);
    expect(pairs[0]?.test).toBe(first);
    expect(pairs[1]?.test).toBe(second);
  });
});

// The strategy suites' projection: the collected test's qualified title
// (the collector's identity for real fixture tests), the target's identity
// triple, the winning strategy, and its confidence — the four Pairing
// fields, node views excluded (the naming suites' pairIdentity shape).
function strategyIdentity(pairs: readonly Pairing[]) {
  return pairs.map((pair) => ({
    test: pair.test.qualifiedTitle,
    name: pair.target.name,
    relPath: pair.target.relPath,
    line: pair.target.line,
    strategy: pair.strategy,
    confidence: pair.confidence,
  }));
}

// The three-strategy source shared by the checker-mode suites: one target
// file, one test file. Spellings per test; the tree is inline so every
// fixture reads as the quickstart's shapes.
const MATH_SOURCE =
  "export function add(a: number, b: number): number {\n  return a + b;\n}\n";

describe("pairTests (calls and imports strategies)", () => {
  it("pairs a call-only test at 80 through symbol-declaration matching in checker mode", async () => {
    // US2-2: the title matches nothing, the callback calls the target.
    // Checker mode resolves the callee through getSymbolAtLocation and
    // matches the declaration against byNode — the verified
    // evidence.ts route with aliases followed.
    const run = await strategyPairsIn({
      "tsconfig.json": TSCONFIG,
      "src/math.ts":
        "export function clamp(value: number): number {\n  if (value < 0) {\n    return 0;\n  }\n  return value;\n}\n",
      "tests/clamp.test.ts": [
        'import { clamp } from "../src/math";', // 1
        "", // 2
        'it("keeps values in range", () => {', // 3
        "  expect(clamp(-5)).toBe(0);", // 4
        "});", // 5
      ].join("\n"),
    });
    expect(strategyIdentity(run.pairs)).toEqual([
      {
        test: "keeps values in range",
        name: "clamp",
        relPath: "src/math.ts",
        line: 1,
        strategy: "calls",
        confidence: 80,
      },
    ]);
  });

  it("pairs a call-only test at 80 through terminal-identifier matching in parse-only mode", async () => {
    // US2-2's parse-only twin: the same tree minus tsconfig pairs through
    // the callee's terminal identifier text against target names (the
    // documented lexical false-positive surface) — degradation reduces
    // precision, never availability.
    const run = await strategyPairsIn({
      "src/math.ts":
        "export function clamp(value: number): number {\n  if (value < 0) {\n    return 0;\n  }\n  return value;\n}\n",
      "tests/clamp.test.ts": [
        'import { clamp } from "../src/math";', // 1
        "", // 2
        'it("keeps values in range", () => {', // 3
        "  expect(clamp(-5)).toBe(0);", // 4
        "});", // 5
      ].join("\n"),
    });
    expect(strategyIdentity(run.pairs)).toEqual([
      {
        test: "keeps values in range",
        name: "clamp",
        relPath: "src/math.ts",
        line: 1,
        strategy: "calls",
        confidence: 80,
      },
    ]);
  });

  it("stops at naming — an exact title match shadows the calls tier (first-match-wins)", async () => {
    // US2-1/US2-7: a test whose title exactly equals the target name AND
    // whose callback calls the target emits ONLY the naming pair at 90 —
    // evaluation stops at the first strategy with any match, so the calls
    // tier's 80 row never also appears for the same pair.
    const sources: Readonly<Record<string, string>> = {
      "src/math.ts": MATH_SOURCE,
      "tests/math.test.ts": [
        'import { add } from "../src/math";', // 1
        "", // 2
        'it("add", () => {', // 3
        "  expect(add(1, 2)).toBe(3);", // 4
        "});", // 5
      ].join("\n"),
    };
    const expected = [
      {
        test: "add",
        name: "add",
        relPath: "src/math.ts",
        line: 1,
        strategy: "naming",
        confidence: 90,
      },
    ];
    const checker = await strategyPairsIn({ ...sources, "tsconfig.json": TSCONFIG });
    expect(strategyIdentity(checker.pairs)).toEqual(expected);
    const parseOnly = await strategyPairsIn(sources);
    expect(strategyIdentity(parseOnly.pairs)).toEqual(expected);
  });

  it("stops at calls — a callback call shadows the imports tier (first-match-wins)", async () => {
    // US2-7's second shadow: a test whose callback calls the target in a
    // file that ALSO imports it emits the calls pair at 80, never the
    // imports pair at 75 — the imports tier is the file-scoped fallback
    // for tests the callback could not pair.
    const sources: Readonly<Record<string, string>> = {
      "src/math.ts": MATH_SOURCE,
      "tests/math.test.ts": [
        'import { add } from "../src/math";', // 1
        "", // 2
        'it("adds numbers", () => {', // 3
        "  expect(add(1, 2)).toBe(3);", // 4
        "});", // 5
      ].join("\n"),
    };
    const expected = [
      {
        test: "adds numbers",
        name: "add",
        relPath: "src/math.ts",
        line: 1,
        strategy: "calls",
        confidence: 80,
      },
    ];
    const checker = await strategyPairsIn({ ...sources, "tsconfig.json": TSCONFIG });
    expect(strategyIdentity(checker.pairs)).toEqual(expected);
    const parseOnly = await strategyPairsIn(sources);
    expect(strategyIdentity(parseOnly.pairs)).toEqual(expected);
  });

  it("pairs an import-only test at 75 — the reference sits in a file-local helper (US2-4)", async () => {
    // US2-4: no title match, no target call inside the callback (the
    // call sits in the file-local `double` helper, structurally outside
    // every test callback); the file imports the target and references
    // the binding outside the import clause — import-graph evidence.
    const sources: Readonly<Record<string, string>> = {
      "src/math.ts": MATH_SOURCE,
      "tests/math.test.ts": [
        'import { add } from "../src/math";', // 1
        "", // 2
        "function double(n: number): number {", // 3
        "  return add(n, n);", // 4
        "}", // 5
        "", // 6
        'it("delegates through a helper", () => {', // 7
        "  expect(double(2)).toBe(4);", // 8
        "});", // 9
      ].join("\n"),
    };
    const expected = [
      {
        test: "delegates through a helper",
        name: "add",
        relPath: "src/math.ts",
        line: 1,
        strategy: "imports",
        confidence: 75,
      },
    ];
    const checker = await strategyPairsIn({ ...sources, "tsconfig.json": TSCONFIG });
    expect(strategyIdentity(checker.pairs)).toEqual(expected);
    const parseOnly = await strategyPairsIn(sources);
    expect(strategyIdentity(parseOnly.pairs)).toEqual(expected);
  });

  it("treats an unused import as dead evidence — only the referenced import pairs (US2-5)", async () => {
    // US2-5: the file imports two target-set functions but references
    // only `add` (inside the helper); `subtract` never appears outside
    // the import clause, so its specifier is dead evidence and pairs
    // nothing — the reference scan runs before any resolution.
    const sources: Readonly<Record<string, string>> = {
      "src/arith.ts": [
        "export function add(a: number, b: number): number {", // 1
        "  return a + b;", // 2
        "}", // 3
        "", // 4
        "export function subtract(a: number, b: number): number {", // 5
        "  return a - b;", // 6
        "}", // 7
      ].join("\n"),
      "tests/arith.test.ts": [
        'import { add, subtract } from "../src/arith";', // 1
        "", // 2
        "function double(n: number): number {", // 3
        "  return add(n, n);", // 4
        "}", // 5
        "", // 6
        'it("delegates through a helper", () => {', // 7
        "  expect(double(2)).toBe(4);", // 8
        "});", // 9
      ].join("\n"),
    };
    const expected = [
      {
        test: "delegates through a helper",
        name: "add",
        relPath: "src/arith.ts",
        line: 1,
        strategy: "imports",
        confidence: 75,
      },
    ];
    const checker = await strategyPairsIn({ ...sources, "tsconfig.json": TSCONFIG });
    expect(strategyIdentity(checker.pairs)).toEqual(expected);
    const parseOnly = await strategyPairsIn(sources);
    expect(strategyIdentity(parseOnly.pairs)).toEqual(expected);
  });

  it("emits each distinct same-named target across packages, record-ordered (US2-6)", async () => {
    // US2-6: the calls tier's parse-only name matching reaches every
    // same-named target — `format` in src/a/util.ts and src/b/util.ts
    // derive genuinely different packages, so both pairs survive the
    // wire-key dedup, deterministically ordered by (file, line, name).
    const run = await strategyPairsIn({
      "src/a/util.ts":
        "export function format(value: string): string {\n  return value;\n}\n",
      "src/b/util.ts":
        "export function format(value: string): string {\n  return value.trim();\n}\n",
      "tests/util.test.ts": [
        'it("formats values", () => {', // 1
        '  expect(format("x")).toBe("x");', // 2
        "});", // 3
      ].join("\n"),
    });
    expect(strategyIdentity(run.pairs)).toEqual([
      {
        test: "formats values",
        name: "format",
        relPath: "src/a/util.ts",
        line: 1,
        strategy: "calls",
        confidence: 80,
      },
      {
        test: "formats values",
        name: "format",
        relPath: "src/b/util.ts",
        line: 1,
        strategy: "calls",
        confidence: 80,
      },
    ]);
  });

  it("collapses same-file same-named records first-wins under the calls tier (F1 re-pin)", async () => {
    // FR-005 amended, the multi-strategy re-pin of T036's naming-tier
    // slice: two same-named methods of different classes in ONE file are
    // wire-indistinguishable targets, so a call-only test matching both
    // pairs with the FIRST in analyze record order only (Alpha.render,
    // line 2) — the later record collapses as conservative imprecision.
    const run = await strategyPairsIn({
      "src/ui.ts": [
        "export class Alpha {", // 1
        "  render(): number {", // 2
        "    return 1;", // 3
        "  }", // 4
        "}", // 5
        "", // 6
        "export class Beta {", // 7
        "  render(): number {", // 8
        "    return 2;", // 9
        "  }", // 10
        "}", // 11
      ].join("\n"),
      "tests/ui.test.ts": [
        'it("draws widgets", () => {', // 1
        "  const view = makeView();", // 2
        "  expect(view.render()).toBe(1);", // 3
        "});", // 4
      ].join("\n"),
    });
    expect(strategyIdentity(run.pairs)).toEqual([
      {
        test: "draws widgets",
        name: "render",
        relPath: "src/ui.ts",
        line: 2,
        strategy: "calls",
        confidence: 80,
      },
    ]);
  });

  it("collapses colliding-package same-named records first-wins under the calls tier (F1 re-pin)", async () => {
    // FR-005 amended, iteration-3 F1 variant a's multi-strategy re-pin:
    // src/pkg.ts and src/pkg/index.ts both derive "src.pkg" (the
    // file-vs-index flattening), so their same-named functions are
    // wire-indistinguishable across DIFFERENT files — the pair set keeps
    // the FIRST in analyze record order ("src/pkg.ts" sorts before
    // "src/pkg/index.ts") and collapses the other.
    const run = await strategyPairsIn({
      "src/pkg.ts": "export function util(): number {\n  return 1;\n}\n",
      "src/pkg/index.ts": "export function util(): number {\n  return 2;\n}\n",
      "tests/pkg.test.ts": [
        'it("uses util", () => {', // 1
        "  expect(util()).toBe(1);", // 2
        "});", // 3
      ].join("\n"),
    });
    expect(strategyIdentity(run.pairs)).toEqual([
      {
        test: "uses util",
        name: "util",
        relPath: "src/pkg.ts",
        line: 1,
        strategy: "calls",
        confidence: 80,
      },
    ]);
  });

  it("follows a barrel re-export to the declaring function in checker mode (edge case 7)", async () => {
    // Edge case 7: the test imports `add` through the ../src/index
    // barrel; checker mode follows the re-export alias chain (import
    // specifier → export specifier in the barrel → the declaring
    // function) to the record in src/math.ts — pair at 75.
    const run = await strategyPairsIn({
      "tsconfig.json": TSCONFIG,
      "src/math.ts": MATH_SOURCE,
      "src/index.ts": 'export { add } from "./math";\n',
      "tests/math.test.ts": [
        'import { add } from "../src/index";', // 1
        "", // 2
        "function double(n: number): number {", // 3
        "  return add(n, n);", // 4
        "}", // 5
        "", // 6
        'it("delegates through a helper", () => {', // 7
        "  expect(double(2)).toBe(4);", // 8
        "});", // 9
      ].join("\n"),
    });
    expect(strategyIdentity(run.pairs)).toEqual([
      {
        test: "delegates through a helper",
        name: "add",
        relPath: "src/math.ts",
        line: 1,
        strategy: "imports",
        confidence: 75,
      },
    ]);
  });

  it("resolves extensionless specifiers through the walked extensions and index forms in parse-only mode", async () => {
    // Research R12's parse-only resolution: "../src/widget" resolves
    // through the six-extension enumeration to widget.tsx; "../src/pkg"
    // resolves through the index forms to pkg/index.ts — both pair at
    // the unchanged 75 (degradation reduces precision, never
    // availability).
    const run = await strategyPairsIn({
      "src/widget.tsx": 'export function render(): string {\n  return "w";\n}\n',
      "src/pkg/index.ts": "export function util(): number {\n  return 1;\n}\n",
      "tests/widget.test.ts": [
        'import { render } from "../src/widget";', // 1
        "", // 2
        "function makeLabel(): string {", // 3
        "  return render();", // 4
        "}", // 5
        "", // 6
        'it("renders widgets", () => {', // 7
        '  expect(makeLabel()).toBe("w");', // 8
        "});", // 9
      ].join("\n"),
      "tests/pkg.test.ts": [
        'import { util } from "../src/pkg";', // 1
        "", // 2
        "function compute(): number {", // 3
        "  return util();", // 4
        "}", // 5
        "", // 6
        'it("uses util", () => {', // 7
        "  expect(compute()).toBe(1);", // 8
        "});", // 9
      ].join("\n"),
    });
    expect(strategyIdentity(run.pairs)).toEqual([
      {
        test: "uses util",
        name: "util",
        relPath: "src/pkg/index.ts",
        line: 1,
        strategy: "imports",
        confidence: 75,
      },
      {
        test: "renders widgets",
        name: "render",
        relPath: "src/widget.tsx",
        line: 1,
        strategy: "imports",
        confidence: 75,
      },
    ]);
  });

  it("uncrosses barrels in parse-only mode — the barrel file carries no matching record", async () => {
    // Research R12's degradation boundary: parse-only resolves
    // "../src/index" to the barrel FILE, then matches imported names
    // against the records IN that file — re-exports are never followed
    // — so the barrel's own import-only tests pair nothing. The binding
    // IS referenced (the helper calls it), so the miss is the uncrossed
    // barrel, never dead evidence.
    const run = await strategyPairsIn({
      "src/math.ts": MATH_SOURCE,
      "src/index.ts": 'export { add } from "./math";\n',
      "tests/math.test.ts": [
        'import { add } from "../src/index";', // 1
        "", // 2
        "function double(n: number): number {", // 3
        "  return add(n, n);", // 4
        "}", // 5
        "", // 6
        'it("delegates through a helper", () => {', // 7
        "  expect(double(2)).toBe(4);", // 8
        "});", // 9
      ].join("\n"),
    });
    expect(run.pairs).toEqual([]);
  });

  it("resolves package specifiers and root escapes to nothing in parse-only mode", async () => {
    // The FR-004 containment guard: package specifiers ("node:..."
    // and bare package names) and relative specifiers escaping the
    // analysis root denote no in-root target — resolution is a pure
    // lookup over the discovered file set, never a filesystem probe
    // (Constitution V). The bindings are referenced, so the misses are
    // the guard, never dead evidence.
    const run = await strategyPairsIn({
      "src/math.ts": MATH_SOURCE,
      "tests/scope.test.ts": [
        'import { inspect } from "node:util";', // 1
        'import { leftPad } from "left-pad";', // 2
        'import { secret } from "../../../outside/mod";', // 3
        "", // 4
        "function probe(value: unknown): string {", // 5
        "  inspect(value);", // 6
        "  leftPad(String(value));", // 7
        "  return secret(String(value));", // 8
        "}", // 9
        "", // 10
        'it("probes values", () => {', // 11
        '  expect(probe(1)).toBe("");', // 12
        "});", // 13
      ].join("\n"),
    });
    expect(run.pairs).toEqual([]);
  });
});
