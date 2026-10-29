// Expect-chain assertion fixtures for src/quality/assertions.ts (T010;
// FR-007's expect form; research R5; data-model.md Section 5.2; US3
// scenarios 1–2, 9–10 as US1's slice; Constitution Principles I and III).
//
// RED-FIRST: src/quality/assertions.ts does not exist yet — T017 creates
// it — so this suite fails on module resolution by design (tasks.md: US1
// tests are written first and observed to FAIL before the paired
// implementation lands).
//
// The contract pinned here:
//
// - Entry point: `collectAssertions(test)` over the paired test's callback
//   subtree — including nested function expressions within it; hooks and
//   describe-scope statements are structurally outside (assumption 13). A
//   test whose callback is a bare identifier (null) collects nothing — the
//   truthful outcome, never a crash.
// - Chain reconstruction: an invocation qualifies when its callee is a
//   property access whose base chain — through intermediate property
//   accesses and `await` wrappers — roots at a call whose callee is the
//   identifier `expect`. The invoked property is the matcher name; the
//   intermediate properties are the modifier chain.
// - One row per matcher invocation (a chain with two matcher invocations
//   yields two rows, US3-10); an expect chain with NO matcher invocation
//   is not an assertion (US3-9).
// - Anchoring: line is the `expect(` call expression's 1-based line and
//   character its 0-based column (US1-1's assertion_location anchor); the
//   asserted expression is expect's FIRST argument; argumentSubtree is the
//   invoked matcher invocation's full CallExpression (data-model Section
//   5.2's pass-4 scan-domain pin).
// - Classification through src/quality/matchers.ts: toBe/toEqual →
//   equality, toBeGreaterThan → comparison, toContain → membership,
//   toThrow → error_check, an unknown/custom matcher → "".
//
// The suite composes src/quality/collect.ts (T015) to obtain real parsed
// callbacks — the two modules land together in US1 — and asserts node
// fields only through position/text projections (the identity-fields-only
// convention extended to the site's anchored nodes).

import { realpathSync } from "node:fs";
import { extname } from "node:path";
import { isCallExpression, isIdentifier } from "typescript/unstable/ast";
import { afterEach, describe, expect, it } from "vitest";
import { buildProgramContext } from "../../src/program.js";
import { type AssertionSite, collectAssertions } from "../../src/quality/assertions.js";
import { collectTestFunctions, type TestFunction } from "../../src/quality/collect.js";
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

async function makeTree(files: Readonly<Record<string, string>>): Promise<string> {
  const tree = await createFixtureTree(files);
  registerCleanup(tree.cleanup);
  // The production caller passes a root that discovery's resolveRoot already
  // realpath-resolved; the fixture's mkdtemp path sits behind macOS's /var
  // symlink, so resolve it the same way before joining paths.
  return realpathSync(tree.root);
}

const COMPILABLE_EXTENSIONS: ReadonlySet<string> = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
]);

// Collects one fixture tree's test functions (parse-only — the chain walk
// is purely lexical) and returns them by title, failing loud on a miss so
// a collection bug can never masquerade as an assertion result.
async function testsIn(
  files: Readonly<Record<string, string>>,
): Promise<TestFunction[]> {
  const root = await makeTree(files);
  const pairs = Object.entries(files)
    .filter(([relPath]) => COMPILABLE_EXTENSIONS.has(extname(relPath)))
    .map(([relPath, text]) => [relPath, text] as const);
  const sink = memorySink();
  const context = buildProgramContext(root, pairs, sink.stream);
  try {
    expect(context.mode).toBe("parse-only");
    return collectTestFunctions(
      pairs.map(([relPath]) => relPath),
      context,
      root,
    );
  } finally {
    if (context.mode === "program") {
      context.dispose();
    }
  }
}

async function sitesIn(files: Readonly<Record<string, string>>, title: string) {
  const tests = await testsIn(files);
  const test = tests.find((candidate) => candidate.title === title);
  if (test === undefined) {
    throw new Error(`fixture collected no test titled "${title}"`);
  }
  return collectAssertions(test);
}

// The site projection asserted throughout: the classifiable identity and
// the wire-relevant anchors, with node fields reduced to presence.
function shapeOf(sites: readonly AssertionSite[]) {
  return sites.map((site) => ({
    kind: site.kind,
    line: site.line,
    character: site.character,
    expectChain: site.expectChain,
    hasAssertedExpression: site.assertedExpression !== null,
  }));
}

describe("collectAssertions", () => {
  it("classifies the core matchers through the pinned table", async () => {
    const sites = await sitesIn(
      {
        "tests/kinds.test.ts": `
it("kinds", () => {
  expect(plain).toBe(1);
  expect(deep).toEqual({ a: 1 });
  expect(count).toBeGreaterThan(2);
  expect(list).toContain("x");
  expect(boom).toThrow();
  expect(custom).toCustomCheck(3);
});
`,
      },
      "kinds",
    );
    expect(shapeOf(sites)).toEqual([
      {
        kind: "equality",
        line: 3,
        character: 2,
        expectChain: true,
        hasAssertedExpression: true,
      },
      {
        kind: "equality",
        line: 4,
        character: 2,
        expectChain: true,
        hasAssertedExpression: true,
      },
      {
        kind: "comparison",
        line: 5,
        character: 2,
        expectChain: true,
        hasAssertedExpression: true,
      },
      {
        kind: "membership",
        line: 6,
        character: 2,
        expectChain: true,
        hasAssertedExpression: true,
      },
      {
        kind: "error_check",
        line: 7,
        character: 2,
        expectChain: true,
        hasAssertedExpression: true,
      },
      // The miss path is total: an unknown or custom matcher routes to ""
      // — never an exception, never a drop (US3-6).
      {
        kind: "",
        line: 8,
        character: 2,
        expectChain: true,
        hasAssertedExpression: true,
      },
    ]);
  });

  it("applies the modifier rules through the chain", async () => {
    const sites = await sitesIn(
      {
        "tests/modifiers.test.ts": `
it("modifiers", () => {
  expect(value).not.toBe(1);
  expect(promise).resolves.toEqual(2);
  expect(promise).rejects.toThrow("bad");
  expect(other).rejects.toEqual(2);
});
`,
      },
      "modifiers",
    );
    expect(shapeOf(sites).map((site) => site.kind)).toEqual([
      // .not. preserves the matcher's kind.
      "equality",
      // .resolves. preserves the matcher's kind.
      "equality",
      // .rejects. routes to error_check regardless of matcher.
      "error_check",
      "error_check",
    ]);
  });

  it("treats await wrappers as transparent in classification and base chains", async () => {
    const sites = await sitesIn(
      {
        "tests/await.test.ts": `
it("awaited chain", async () => {
  await expect(promise).resolves.toEqual(2);
});
it("awaited base", async () => {
  (await expect(promise)).toBe(2);
});
`,
      },
      "awaited chain",
    );
    // US3-10: the awaited chain classifies identically to its non-awaited
    // form — the await is unwrapped before classification ever sees it.
    expect(shapeOf(sites)).toEqual([
      {
        kind: "equality",
        line: 3,
        character: 2,
        expectChain: true,
        hasAssertedExpression: true,
      },
    ]);

    // The base chain itself may pass through an await wrapper: the
    // parenthesized `(await expect(p))` receiver still roots at expect.
    const baseSites = await sitesIn(
      {
        "tests/await.test.ts": `
it("awaited chain", async () => {
  await expect(promise).resolves.toEqual(2);
});
it("awaited base", async () => {
  (await expect(promise)).toBe(2);
});
`,
      },
      "awaited base",
    );
    expect(shapeOf(baseSites)).toEqual([
      {
        kind: "equality",
        line: 6,
        character: 2,
        expectChain: true,
        hasAssertedExpression: true,
      },
    ]);
  });

  it("collects nothing for an expect chain with no matcher invocation", async () => {
    const sites = await sitesIn(
      {
        "tests/no-matcher.test.ts": `
it("no matcher", () => {
  expect(value);
  expect(other).not;
});
`,
      },
      "no matcher",
    );
    // US3-9: a bare expect call is not an assertion; a dangling modifier
    // property access is not an invocation.
    expect(sites).toEqual([]);
  });

  it("collects one site per matcher invocation on a shared chain", async () => {
    const sites = await sitesIn(
      {
        "tests/double.test.ts": `
it("double", () => {
  expect(value).toBe(1).toBeNull();
});
`,
      },
      "double",
    );
    // US3-10: two matcher invocations on one expect chain share the
    // chain's single call anchor — identical line AND character — and emit
    // in the source order of the matcher properties (the deterministic
    // AST-walk collection order that the row sort's final tie-break pins).
    expect(shapeOf(sites)).toEqual([
      {
        kind: "equality",
        line: 3,
        character: 2,
        expectChain: true,
        hasAssertedExpression: true,
      },
      {
        kind: "",
        line: 3,
        character: 2,
        expectChain: true,
        hasAssertedExpression: true,
      },
    ]);
    // The pass-4 scan domain: each site's argumentSubtree is ITS matcher
    // invocation's CallExpression, so the first (inner, shorter) invocation
    // spans strictly less text than the second — the subtree pin made
    // observable through node extents.
    const first = sites[0];
    const second = sites[1];
    if (first === undefined || second === undefined) {
      throw new Error("expected two sites on the shared chain");
    }
    const firstEnd = first.argumentSubtree.getEnd();
    const secondEnd = second.argumentSubtree.getEnd();
    expect(firstEnd).toBeLessThan(secondEnd);
  });

  it("anchors line and character at the expect call, not the matcher", async () => {
    const sites = await sitesIn(
      {
        "tests/located.test.ts": [
          'it("located", () => {', // 1
          "  expect(add(1, 2)).toBe(3);", // 2
          "    expect(deep).toEqual({});", // 3
          "});", // 4
        ].join("\n"),
      },
      "located",
    );
    expect(shapeOf(sites)).toEqual([
      {
        kind: "equality",
        line: 2,
        character: 2,
        expectChain: true,
        hasAssertedExpression: true,
      },
      {
        kind: "equality",
        line: 3,
        character: 4,
        expectChain: true,
        hasAssertedExpression: true,
      },
    ]);
  });

  it("pins the asserted expression as expect's first argument and the scan domain", async () => {
    const sites = await sitesIn(
      {
        "tests/subject.test.ts": [
          'import { add } from "../src/math.js";', // 1
          "", // 2
          'it("subject", () => {', // 3
          "  expect(add(1, 2)).toBe(3);", // 4
          "});", // 5
        ].join("\n"),
      },
      "subject",
    );
    const site = sites[0];
    if (site === undefined || site.assertedExpression === null) {
      throw new Error("expected one site with an asserted expression");
    }
    // The provenance subject is expect's FIRST argument — here the
    // add(1, 2) call starting at line 4, character 9 (just past the
    // `expect(` opener at character 2).
    const asserted = site.assertedExpression;
    const sourceFile = asserted.getSourceFile();
    const start = sourceFile.getLineAndCharacterOfPosition(
      asserted.getStart(sourceFile),
    );
    expect(start.line + 1).toBe(4);
    expect(start.character).toBe(9);
    expect(isCallExpression(asserted)).toBe(true);
    // The callee property is `expression` in the unstable AST's
    // CallExpression shape (there is no `callee` field) — the same
    // spelling src/quality/collect.ts reads.
    if (isCallExpression(asserted) && isIdentifier(asserted.expression)) {
      expect(asserted.expression.text).toBe("add");
    } else {
      throw new Error("expected the asserted expression to be the add(1, 2) call");
    }
    // The pass-4 scan domain (data-model Section 5.2): the invoked matcher
    // invocation's full CallExpression — anchored exactly at the expect
    // call — so its subtree spans BOTH the expect arguments and the
    // matcher's own arguments.
    const subtree = site.argumentSubtree;
    const subtreeFile = subtree.getSourceFile();
    const subtreeStart = subtreeFile.getLineAndCharacterOfPosition(
      subtree.getStart(subtreeFile),
    );
    expect(subtreeStart.line + 1).toBe(4);
    expect(subtreeStart.character).toBe(2);
  });

  it("scans the callback subtree including nested function expressions, excluding outer scopes", async () => {
    const sites = await sitesIn(
      {
        "tests/scope.test.ts": `
describe("suite", () => {
  beforeEach(() => {
    expect(hooked).toBe(0);
  });
  it("scoped", () => {
    Promise.resolve().then(() => {
      expect(nested).toBe(1);
    });
    expect(direct).toBe(2);
  });
});
`,
      },
      "scoped",
    );
    // FR-007: the paired test's callback subtree INCLUDING nested function
    // expressions; the beforeEach hook and describe-scope statements are
    // structurally outside (assumption 13) — only the test's own two
    // assertions collect, in source order.
    expect(shapeOf(sites)).toEqual([
      {
        kind: "equality",
        line: 8,
        character: 6,
        expectChain: true,
        hasAssertedExpression: true,
      },
      {
        kind: "equality",
        line: 10,
        character: 4,
        expectChain: true,
        hasAssertedExpression: true,
      },
    ]);
  });

  it("collects nothing for a test whose callback is a bare identifier", async () => {
    const sites = await sitesIn(
      {
        "tests/reference.test.ts":
          'it("delegated", runCase);\n\nfunction runCase(): void {\n  expect(1).toBe(1);\n}\n',
      },
      "delegated",
    );
    // The callback is a reference, not a function expression — no subtree,
    // no assertions; the truthful outcome (US3-8's pipeline shape), never a
    // crash and never a scan of the referenced function's body.
    expect(sites).toEqual([]);
  });
});

describe("collectAssertions (bounded-walk guard)", () => {
  // T038 — the iteration-2 review-fix suite (F2; plan.md Scale/Scope;
  // Constitution V): the assertion walk is depth-bounded by the shared
  // MAPPING_WALK_DEPTH_BUDGET (2000), so a programmatically pathological
  // callback subtree degrades to a per-test site discard with exactly one
  // diagnostic to the injected stderr — sibling tests keep their sites,
  // and the call never crashes.
  it("discards only the pathological test's sites past the depth budget", async () => {
    // 2500 nested parentheses — past the 2000 budget, trivially parseable
    // by the native compiler (its stacks grow) — wrapping the asserted
    // value so the subtree walk must recurse the full depth to reach the
    // matcher.
    const parens = "(".repeat(2500);
    const closers = ")".repeat(2500);
    const tests = await testsIn({
      "tests/shallow.test.ts": 'it("shallow", () => {\n  expect(1).toBe(1);\n});\n',
      "tests/deep.test.ts": `it("deep", () => {\n  expect(${parens}1${closers}).toBe(1);\n});\n`,
    });
    const shallow = tests.find((candidate) => candidate.title === "shallow");
    const deep = tests.find((candidate) => candidate.title === "deep");
    if (shallow === undefined || deep === undefined) {
      throw new Error("fixture collected no shallow/deep tests");
    }

    const sink = memorySink();
    // The pathological test's sites are discarded — `[]`, the same
    // truthful shape as an assertion-free callback — with exactly one
    // diagnostic naming the test (skip unit: the test, never the file,
    // never the request).
    expect(collectAssertions(deep, sink.stream)).toEqual([]);
    expect(sink.text()).toBe(
      "reading-stone: skipping assertions in tests/deep.test.ts:1: ast depth exceeds budget\n",
    );

    // The sibling test's sites collect normally on a clean sink — one
    // pathological callback never contaminates its siblings.
    const shallowSink = memorySink();
    expect(shapeOf(collectAssertions(shallow, shallowSink.stream))).toEqual([
      {
        kind: "equality",
        line: 2,
        character: 2,
        expectChain: true,
        hasAssertedExpression: true,
      },
    ]);
    expect(shallowSink.text()).toBe("");
  });
});
