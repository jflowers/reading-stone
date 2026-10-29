// Naming-strategy pairing fixtures for src/quality/pairing.ts (T009;
// FR-004/FR-005's naming tier; research R4; data-model.md Sections 5.3–5.4
// and 6; US2 scenarios 1–2 as US1's slice; Constitution Principles I and
// III).
//
// RED-FIRST: src/quality/pairing.ts does not exist yet — T016 creates it —
// so this suite fails on module resolution by design (tasks.md: US1 tests
// are written first and observed to FAIL before the paired implementation
// lands).
//
// The contract pinned here, following tests/signals/adapter.test.ts's
// precedent for hand-built inputs (the dependency-injection seam — the
// naming strategy is purely lexical, so no compiler context is needed):
//
// - `buildTargetIndex(records, effects, context)` — the pairing-support
//   view built once per pipeline run (data-model Section 5.4): records in
//   `(file, line, name)` order, byName, byNode, the per-record effect
//   sets, and the live context.
// - `pairTests(tests, index)` — the naming strategy (US1's slice): a test
//   whose title OR nearest enclosing describe title equals a target name
//   pairs; exact (case-sensitive) at confidence 90, case-insensitive-only
//   (`toLowerCase` both sides — platform-stable, no locale fold) at 70;
//   every same-named target pairs in the analyze record order
//   (compareFileLineName); the exact tier shadows the case-insensitive tier
//   per test; unpaired tests produce no pairs — never confidence-0 rows.
//   Within one test's emitted pairs, wire-indistinguishable same-file
//   same-name targets collapse to the first record in analyze record order
//   (T036's FR-005-amended first-wins dedup; the dedup domain is the test
//   function, so same-titled siblings each keep their pairs).
// - The `Pairing` record: test, target, strategy, confidence.
//
// Hand-built records follow the adapter suite's localized-cast convention:
// the strategy reads only the identity fields (`name`, `relPath`, `line`),
// so the live compiler views are inert filler.

import type { Node } from "typescript/unstable/ast";
import { describe, expect, it } from "vitest";
import type { ExtractionRecord } from "../../src/extract.js";
import type { Effect } from "../../src/models.js";
import type { ProgramContext } from "../../src/program.js";
import type { TestFunction } from "../../src/quality/collect.js";
import {
  buildTargetIndex,
  type Pairing,
  pairTests,
  type TargetIndex,
} from "../../src/quality/pairing.js";
import type { SideEffectType } from "../../src/taxonomy.js";

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
    const pairs = pairTests([testOf("add")], indexOver([target]));
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
    const pairs = pairTests([testOf("Add")], indexOver([target]));
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
    const pairs = pairTests([test], indexOver([target]));
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
    const pairs = pairTests([test], indexOver([titleHit, describeHit]));
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
    const pairs = pairTests([testOf("Add")], indexOver([foldOnly, exact]));
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
    const pairs = pairTests([testOf("add")], indexOver([inB, inA]));
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
    expect(pairTests([testOf("unrelated")], indexOver([target]))).toEqual([]);
  });

  it("pairs each test independently", () => {
    const target = recordOf("add", "src/math.ts", 1);
    const pairs = pairTests(
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
    const pairs = pairTests([test], indexOver([target]));
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
    expect(pairTests([test], indexOver([outer]))).toEqual([]);
  });

  it("returns no pairs over an empty target index", () => {
    expect(pairTests([testOf("add")], indexOver([]))).toEqual([]);
  });

  it("returns no pairs for an empty test list", () => {
    const target = recordOf("add", "src/math.ts", 1);
    expect(pairTests([], indexOver([target]))).toEqual([]);
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
  // records in different files stay distinct (the "pairs every same-named
  // target in the analyze record order" case above pins that half).
  it("collapses same-file same-name targets to the first record in analyze record order", () => {
    // Declaration order spells the later line first; the record order
    // (file, line, name) puts line 3 before line 9, so the FIRST record —
    // line 3 — owns the pair and the line-9 record collapses.
    const later = recordOf("render", "src/ui.ts", 9);
    const first = recordOf("render", "src/ui.ts", 3);
    const pairs = pairTests([testOf("render")], indexOver([later, first]));
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
    const pairs = pairTests([testOf("render")], indexOver([later, first]));
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

  it("dedups per test function — same-titled sibling tests each keep their pairs", () => {
    // Edge case 2 unchanged (FR-005 amended): two same-titled sibling
    // tests inside one describe are distinct test functions sharing one
    // test_function; the dedup domain is the test function's own
    // emission, never the wire tuple, so each sibling keeps its pair —
    // the rows disambiguate downstream through assertion_location.
    const target = recordOf("render", "src/ui.ts", 1);
    const first = testOf("render", { line: 2, index: 0 });
    const second = testOf("render", { line: 5, index: 1 });
    const pairs = pairTests([first, second], indexOver([target]));
    expect(pairs).toHaveLength(2);
    expect(pairs[0]?.test).toBe(first);
    expect(pairs[1]?.test).toBe(second);
  });
});
