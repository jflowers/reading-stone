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

describe("collectAssertions (full form coverage)", () => {
  // T026 — US3's full form-coverage suite (FR-007/FR-008; SC-002; US3
  // scenarios 1–10; research R5; data-model Section 4): every matcher
  // family of the pinned table exercised through real chains, the
  // modifier/await parity pins, and the negation-preservation rule.
  it("classifies every matcher family of the pinned table through real chains", async () => {
    const sites = await sitesIn(
      {
        "tests/families.test.ts": `
it("families", () => {
  expect(plain).toBe(1);
  expect(deep).toStrictEqual({ a: 1 });
  expect(close).toBeCloseTo(1.5, 5);
  expect(shallow).toMatchObject({ a: 1 });
  expect(spy).toHaveBeenCalledWith(1, 2);
  expect(spy).toHaveReturnedWith(3);
  expect(count).toBeGreaterThan(2);
  expect(count).toBeLessThanOrEqual(10);
  expect(list).toContain("x");
  expect(list).toContainEqual("x");
  expect(text).toMatch(/x/);
  expect(boom).toThrow();
  expect(boom).toThrowError("bad");
  expect(flag).toBeTruthy();
  expect(value).toBeDefined();
  expect(nan).toBeNaN();
  expect(spy).toHaveBeenCalled();
  expect(spy).toHaveBeenCalledTimes(2);
  expect(instance).toBeInstanceOf(Map);
});
`,
      },
      "families",
    );
    expect(shapeOf(sites).map((site) => site.kind)).toEqual([
      "equality", // toBe
      "equality", // toStrictEqual
      "equality", // toBeCloseTo
      "equality", // toMatchObject
      "equality", // toHaveBeenCalledWith
      "equality", // toHaveReturnedWith
      "comparison", // toBeGreaterThan
      "comparison", // toBeLessThanOrEqual
      "membership", // toContain
      "membership", // toContainEqual
      "membership", // toMatch
      "error_check", // toThrow
      "error_check", // toThrowError
      "", // toBeTruthy
      "", // toBeDefined
      "", // toBeNaN
      "", // toHaveBeenCalled
      "", // toHaveBeenCalledTimes
      "", // toBeInstanceOf
    ]);
    expect(sites.every((site) => site.expectChain)).toBe(true);
  });

  it("preserves kinds under negation, await parity, and the rejects reroute", async () => {
    // US3-7 (negation preserves the relation family — for expect AND
    // node:assert alike), US3-10 (an awaited assertion classifies
    // identically to its non-awaited form), US3-4 (.rejects. reroutes
    // any matcher to error_check).
    const sites = await sitesIn(
      {
        "tests/parity.test.ts": `
it("parity", () => {
  expect(value).not.toBe(1);
  expect(promise).resolves.toEqual(2);
  expect(promise).rejects.toContain("x");
  expect(await expect(promise).resolves.toMatchObject({}));
});
`,
      },
      "parity",
    );
    expect(shapeOf(sites).map((site) => site.kind)).toEqual([
      "equality", // .not. preserves
      "equality", // .resolves. preserves
      "error_check", // .rejects. reroutes membership
      "equality", // awaited resolves chain classifies identically
    ]);
  });
});

describe("collectAssertions (node:assert forms)", () => {
  // T026/T028 — FR-007's node:assert form; research R5; data-model
  // Sections 4.2 and 5.2: the assert-binding table built from the test
  // file's import/require declarations over the closed module-specifier
  // set, the four binding forms, classification through the pinned
  // member table, and expectChain false for every assert-rooted site.
  it("recognizes the default-import binding form with the full member table", async () => {
    const sites = await sitesIn(
      {
        "tests/default.test.ts": `
import assert from "node:assert";

it("default form", () => {
  assert(truthy);
  assert.ok(truthy);
  assert.ifError(err);
  assert.fail("boom");
  assert.equal(a, b);
  assert.notStrictEqual(a, b);
  assert.match(text, /x/);
  assert.throws(boom);
  assert.weirdCustom(a);
});
`,
      },
      "default form",
    );
    expect(shapeOf(sites).map((site) => site.kind)).toEqual([
      "", // bare truthiness call
      "", // ok
      "", // ifError
      "", // fail
      "equality", // equal
      "equality", // notStrictEqual — US3-7: not-prefixed preserves
      "membership", // match
      "error_check", // throws
      "", // unknown member — the total miss path, never a drop
    ]);
    expect(sites.every((site) => !site.expectChain)).toBe(true);
  });

  it("recognizes the namespace-import binding form", async () => {
    const sites = await sitesIn(
      {
        "tests/namespace.test.ts": `
import * as assert from "node:assert";

it("namespace form", () => {
  assert.strictEqual(a, b);
  assert.doesNotThrow(boom);
  assert(value);
});
`,
      },
      "namespace form",
    );
    expect(shapeOf(sites).map((site) => site.kind)).toEqual([
      "equality", // strictEqual
      "error_check", // doesNotThrow
      "", // bare truthiness on the namespace binding
    ]);
    expect(sites.every((site) => !site.expectChain)).toBe(true);
  });

  it("recognizes named imports — each local name mapped to its assert function", async () => {
    const sites = await sitesIn(
      {
        "tests/named.test.ts": `
import { equal, notEqual as ne, throws } from "node:assert";

it("named form", () => {
  equal(a, b);
  ne(a, b);
  throws(boom);
});
`,
      },
      "named form",
    );
    expect(shapeOf(sites).map((site) => site.kind)).toEqual([
      "equality", // equal
      "equality", // the IMPORTED name (notEqual) routes — not the local rename
      "error_check", // throws
    ]);
    expect(sites.every((site) => !site.expectChain)).toBe(true);
  });

  it("recognizes the CJS require binding form", async () => {
    const sites = await sitesIn(
      {
        "tests/cjs.test.ts": `
const assert = require("node:assert");

it("cjs form", () => {
  assert.ok(truthy);
  assert.deepEqual(a, b);
});
`,
      },
      "cjs form",
    );
    expect(shapeOf(sites).map((site) => site.kind)).toEqual([
      "", // ok
      "equality", // deepEqual
    ]);
    expect(sites.every((site) => !site.expectChain)).toBe(true);
  });

  it("routes node:assert/strict and the bare assert specifier identically", async () => {
    // node:assert/strict changes call SEMANTICS, not routing: the member
    // name routes through the same table, and the binding's module
    // specifier never reaches classification (data-model Section 4.2).
    const strict = await sitesIn(
      {
        "tests/strict.test.ts": `
import assert from "node:assert/strict";

it("strict form", () => {
  assert.equal(a, b);
});
`,
      },
      "strict form",
    );
    expect(shapeOf(strict).map((site) => site.kind)).toEqual(["equality"]);

    const bare = await sitesIn(
      {
        "tests/bare.test.ts": `
import assert from "assert";

it("bare form", () => {
  assert.equal(a, b);
});
`,
      },
      "bare form",
    );
    expect(shapeOf(bare).map((site) => site.kind)).toEqual(["equality"]);
  });

  it("pins the asserted expression as the assert call's first argument", async () => {
    const sites = await sitesIn(
      {
        "tests/subject.test.ts": [
          'import assert from "node:assert";', // 1
          "", // 2
          'it("subject", () => {', // 3
          "  assert.equal(add(1, 2), 3);", // 4
          "});", // 5
        ].join("\n"),
      },
      "subject",
    );
    const site = sites[0];
    if (site === undefined || site.assertedExpression === null) {
      throw new Error("expected one site with an asserted expression");
    }
    // The provenance subject is the assert call's FIRST argument — the
    // add(1, 2) call at line 4, character 15 (just past the
    // `assert.equal(` opener at character 2).
    const asserted = site.assertedExpression;
    const sourceFile = asserted.getSourceFile();
    const start = sourceFile.getLineAndCharacterOfPosition(
      asserted.getStart(sourceFile),
    );
    expect(start.line + 1).toBe(4);
    expect(start.character).toBe(15);
    if (!isCallExpression(asserted) || !isIdentifier(asserted.expression)) {
      throw new Error("expected the asserted expression to be the add(1, 2) call");
    }
    expect(asserted.expression.text).toBe("add");
    // The pass-4 scan domain for node:assert forms (data-model Section
    // 5.2): the assert call's full argument list — the invocation node
    // anchored at the assert identifier.
    const subtree = site.argumentSubtree;
    const subtreeFile = subtree.getSourceFile();
    const subtreeStart = subtreeFile.getLineAndCharacterOfPosition(
      subtree.getStart(subtreeFile),
    );
    expect(subtreeStart.line + 1).toBe(4);
    expect(subtreeStart.character).toBe(2);
  });

  it("anchors awaited assert calls at the outermost wrapper", async () => {
    // The data-model Section 5.2 anchoring pin applies to assert calls
    // alike: `await assert.rejects(p)` anchors at the `await` — the
    // leftmost spelling of the full assertion expression.
    const sites = await sitesIn(
      {
        "tests/awaited.test.ts": [
          'import assert from "node:assert";', // 1
          "", // 2
          'it("awaited", async () => {', // 3
          "  await assert.rejects(boom);", // 4
          "});", // 5
        ].join("\n"),
      },
      "awaited",
    );
    expect(shapeOf(sites)).toEqual([
      {
        kind: "error_check",
        line: 4,
        character: 2, // the `await`, not the `assert`
        expectChain: false,
        hasAssertedExpression: true,
      },
    ]);
  });

  it("collects nothing for same-named locals that are not assert bindings", async () => {
    // Recognition is import-gated (data-model Section 4.2: through the
    // file's import/require declarations over the closed specifier set):
    // a file-local `equal` never entered the table, so its call is not
    // an assertion — the truthful miss, never a name-based guess.
    const sites = await sitesIn(
      {
        "tests/local.test.ts": `
it("local shadow", () => {
  equal(a, b);
});

function equal(a: unknown, b: unknown): boolean {
  return a === b;
}
`,
      },
      "local shadow",
    );
    expect(sites).toEqual([]);
  });
});
