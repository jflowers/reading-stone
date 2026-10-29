// Test-function collection fixtures for src/quality/collect.ts (T008;
// FR-002/FR-003; research R3; data-model.md Section 5.1; spec edge cases
// 2–5; Constitution Principles I and III).
//
// RED-FIRST: src/quality/collect.ts does not exist yet — T015 creates it —
// so this suite fails on module resolution by design (tasks.md: US1 tests
// are written first and observed to FAIL before the paired implementation
// lands).
//
// The contract pinned here, following tests/extract.test.ts's precedent of
// recording the tested surface at the top:
//
// - Entry point: `collectTestFunctions(testPaths, context, rootPath)`
//   returning the deterministically ordered `TestFunction[]`. The leading
//   `(testPaths, context)` pair is data-model Section 1's pinned shape;
//   `rootPath` is threaded explicitly as the program-mode relativization
//   base — the buildCallerIndex/buildRecordEvidence precedent (spec 003):
//   parse-only sources are keyed by root-relative path already, while
//   program-mode source names are absolute and must join back against the
//   resolved root to be found.
// - Collection domain (FR-002, research R3): the callee root after
//   unwrapping intermediate call wrappers (`it.each(table)(title, fn)`) is
//   an identifier `it`/`test` or a property chain rooted at one — the
//   modifier set is deliberately open (`skipIf`/`runIf`/future modifiers
//   stay available). The callback is the LAST argument that is a function
//   expression or arrow function (robust to trailing timeout arguments); a
//   bare-identifier callback still collects with `callback: null` — never
//   dropped. The title is the first argument when a string literal or
//   no-substitution template literal, else `""`.
// - Qualification (FR-003): `qualifiedTitle` joins the enclosing describe
//   titles with " > " outermost-to-innermost, then the title; bare title at
//   top level; empty segments join verbatim.
// - Exclusions by callee root: `bench` and the four hooks.
// - Output sorted by `(relPath, collection index)`.
//
// Assertions read only the serializable identity fields (title,
// qualifiedTitle, relPath, describeTitles, line, index) plus callback
// PRESENCE — never the callback node itself (the identity-fields-only
// convention from tests/extract.test.ts; the node is the assertions
// suite's domain, T010).

import { realpathSync } from "node:fs";
import { extname } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildProgramContext } from "../../src/program.js";
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

// A plain strict config for the program-mode fixture: no include/files of
// its own to interfere (the bootstrap's extender config overrides the root
// set anyway).
const TSCONFIG = '{"compilerOptions": {"strict": true, "target": "ES2022"}}';

// Exactly the six extensions discovery walks; only these reach
// buildProgramContext as pre-read pairs (a planted tsconfig.json is config,
// not source).
const COMPILABLE_EXTENSIONS: ReadonlySet<string> = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
]);

// The collection input the pipeline derives: the test arm's root-relative
// paths in an arbitrary (here: fixture-declaration) order — the collector's
// own output sort makes the order structural, so this suite passes them in
// whatever order the fixture spells them.
function testPathsOf(files: Readonly<Record<string, string>>): string[] {
  return Object.keys(files).filter((relPath) =>
    COMPILABLE_EXTENSIONS.has(extname(relPath)),
  );
}

// Runs one collection over a fixture tree in the requested mode: build the
// tree (plus a root tsconfig in program mode), bootstrap the ProgramContext
// over the pre-read pairs, collect, and dispose the program-mode context
// before returning — the same lifetime discipline the pipeline owns.
async function collectFromTree(
  files: Readonly<Record<string, string>>,
  mode: "parse-only" | "program" = "parse-only",
): Promise<TestFunction[]> {
  const onDisk: Record<string, string> =
    mode === "program" ? { ...files, "tsconfig.json": TSCONFIG } : { ...files };
  const root = await makeTree(onDisk);
  const pairs = Object.entries(files)
    .filter(([relPath]) => COMPILABLE_EXTENSIONS.has(extname(relPath)))
    .map(([relPath, text]) => [relPath, text] as const);
  const sink = memorySink();
  const context = buildProgramContext(root, pairs, sink.stream);
  try {
    // Fail loud when the requested mode did not materialize: a silent
    // tsconfig fallback would turn a "both modes" test into parse-only
    // twice.
    expect(context.mode).toBe(mode);
    return collectTestFunctions(testPathsOf(files), context, root);
  } finally {
    if (context.mode === "program") {
      context.dispose();
    }
  }
}

// The serializable identity asserted throughout (the identity-fields-only
// convention): the TestFunction fields data-model Section 5.1 pins, with
// the callback node reduced to its presence.
function identity(tests: readonly TestFunction[]) {
  return tests.map((test) => ({
    title: test.title,
    qualifiedTitle: test.qualifiedTitle,
    relPath: test.relPath,
    describeTitles: test.describeTitles,
    line: test.line,
    index: test.index,
    hasCallback: test.callback !== null,
  }));
}

describe("collectTestFunctions", () => {
  it("collects it and test invocations with their modifier variants", async () => {
    const tests = await collectFromTree({
      "tests/modifiers.test.ts": `
it("plain it", () => {});
it.only("focused", () => {});
it.skip("skipped", () => {});
it.concurrent("parallel", () => {});
it.fails("expected failure", () => {});
test("plain test", () => {});
test.only("focused test", () => {});
it.skipIf(process.env.CI !== undefined)("conditional", () => {});
`,
    });
    // The modifier set is open by design (FR-002): every root-identifier
    // form with any property chain collects — availability first, never
    // dropped for an unrecognized modifier.
    expect(identity(tests)).toEqual([
      {
        title: "plain it",
        qualifiedTitle: "plain it",
        relPath: "tests/modifiers.test.ts",
        describeTitles: [],
        line: 2,
        index: 0,
        hasCallback: true,
      },
      {
        title: "focused",
        qualifiedTitle: "focused",
        relPath: "tests/modifiers.test.ts",
        describeTitles: [],
        line: 3,
        index: 1,
        hasCallback: true,
      },
      {
        title: "skipped",
        qualifiedTitle: "skipped",
        relPath: "tests/modifiers.test.ts",
        describeTitles: [],
        line: 4,
        index: 2,
        hasCallback: true,
      },
      {
        title: "parallel",
        qualifiedTitle: "parallel",
        relPath: "tests/modifiers.test.ts",
        describeTitles: [],
        line: 5,
        index: 3,
        hasCallback: true,
      },
      {
        title: "expected failure",
        qualifiedTitle: "expected failure",
        relPath: "tests/modifiers.test.ts",
        describeTitles: [],
        line: 6,
        index: 4,
        hasCallback: true,
      },
      {
        title: "plain test",
        qualifiedTitle: "plain test",
        relPath: "tests/modifiers.test.ts",
        describeTitles: [],
        line: 7,
        index: 5,
        hasCallback: true,
      },
      {
        title: "focused test",
        qualifiedTitle: "focused test",
        relPath: "tests/modifiers.test.ts",
        describeTitles: [],
        line: 8,
        index: 6,
        hasCallback: true,
      },
      {
        title: "conditional",
        qualifiedTitle: "conditional",
        relPath: "tests/modifiers.test.ts",
        describeTitles: [],
        line: 9,
        index: 7,
        hasCallback: true,
      },
    ]);
  });

  it("unwraps it.each and test.each — title and callback live on the outer call", async () => {
    // Line-indexed fixture (each entry's 1-based index IS its line number):
    // the invocation line is the OUTER call's start — the `it.each` token
    // line — and the title is the static template text verbatim, `$a`
    // placeholders included (research R3).
    const tests = await collectFromTree({
      "tests/each.test.ts": [
        'it.each([{ a: 1, b: 2 }])("adds $a and $b", ({ a, b }) => {',
        "  expect(a + b).toBe(3);",
        "});",
        'test.each([1, 2])("doubles %i", (n) => {',
        "  expect(n * 2).toBeGreaterThan(0);",
        "});",
        "",
      ].join("\n"),
    });
    expect(identity(tests)).toEqual([
      {
        title: "adds $a and $b",
        qualifiedTitle: "adds $a and $b",
        relPath: "tests/each.test.ts",
        describeTitles: [],
        line: 1,
        index: 0,
        hasCallback: true,
      },
      {
        title: "doubles %i",
        qualifiedTitle: "doubles %i",
        relPath: "tests/each.test.ts",
        describeTitles: [],
        line: 4,
        index: 1,
        hasCallback: true,
      },
    ]);
  });

  it("keeps the callback as the last function-expression argument, robust to trailing timeouts", async () => {
    const tests = await collectFromTree({
      "tests/timeout.test.ts": `
it("slow", () => {
  expect(1).toBe(1);
}, 5000);
`,
    });
    expect(identity(tests)).toEqual([
      {
        title: "slow",
        qualifiedTitle: "slow",
        relPath: "tests/timeout.test.ts",
        describeTitles: [],
        line: 2,
        index: 0,
        hasCallback: true,
      },
    ]);
  });

  it("qualifies titles through the describe stack, outermost first", async () => {
    const tests = await collectFromTree({
      "tests/describe.test.ts": `
describe("outer", () => {
  it("nested", () => {});
  describe("inner", () => {
    it("deep", () => {});
  });
});
it("top level", () => {});
`,
    });
    expect(identity(tests)).toEqual([
      {
        title: "nested",
        qualifiedTitle: "outer > nested",
        relPath: "tests/describe.test.ts",
        describeTitles: ["outer"],
        line: 3,
        index: 0,
        hasCallback: true,
      },
      {
        title: "deep",
        qualifiedTitle: "outer > inner > deep",
        relPath: "tests/describe.test.ts",
        describeTitles: ["outer", "inner"],
        line: 5,
        index: 1,
        hasCallback: true,
      },
      {
        title: "top level",
        qualifiedTitle: "top level",
        relPath: "tests/describe.test.ts",
        describeTitles: [],
        line: 8,
        index: 2,
        hasCallback: true,
      },
    ]);
  });

  it("treats describe.each as a container, unwrapping like it.each", async () => {
    const tests = await collectFromTree({
      "tests/describe-each.test.ts": `
describe.each([1, 2])("case %i", (n) => {
  it("inner", () => {
    expect(n).toBeGreaterThan(0);
  });
});
`,
    });
    expect(identity(tests)).toEqual([
      {
        title: "inner",
        qualifiedTitle: "case %i > inner",
        relPath: "tests/describe-each.test.ts",
        describeTitles: ["case %i"],
        line: 3,
        index: 0,
        hasCallback: true,
      },
    ]);
  });

  it("collects non-static titles as empty strings, never drops the test", async () => {
    const tests = await collectFromTree({
      "tests/titles.test.ts": `
it(\`template literal\`, () => {});
it(\`dynamic \${1 + 1}\`, () => {});
it(getTitle(), () => {});
it(42, () => {});
`,
    });
    // The static-text rule: a string literal or a NO-substitution template
    // literal qualifies; a substituted template, a call, or any other first
    // argument yields "" — the test still collects (FR-002: never dropped).
    expect(identity(tests)).toEqual([
      {
        title: "template literal",
        qualifiedTitle: "template literal",
        relPath: "tests/titles.test.ts",
        describeTitles: [],
        line: 2,
        index: 0,
        hasCallback: true,
      },
      {
        title: "",
        qualifiedTitle: "",
        relPath: "tests/titles.test.ts",
        describeTitles: [],
        line: 3,
        index: 1,
        hasCallback: true,
      },
      {
        title: "",
        qualifiedTitle: "",
        relPath: "tests/titles.test.ts",
        describeTitles: [],
        line: 4,
        index: 2,
        hasCallback: true,
      },
      {
        title: "",
        qualifiedTitle: "",
        relPath: "tests/titles.test.ts",
        describeTitles: [],
        line: 5,
        index: 3,
        hasCallback: true,
      },
    ]);
  });

  it("applies the same static-text rule to describe titles", async () => {
    const tests = await collectFromTree({
      "tests/dynamic-describe.test.ts": `
describe(\`suite \${1 + 1}\`, () => {
  it("inner", () => {});
});
`,
    });
    // A non-static describe title joins verbatim as the empty segment
    // (FR-003: empty segments join verbatim — " > inner" with the leading
    // empty segment, never a dropped level).
    expect(identity(tests)).toEqual([
      {
        title: "inner",
        qualifiedTitle: " > inner",
        relPath: "tests/dynamic-describe.test.ts",
        describeTitles: [""],
        line: 3,
        index: 0,
        hasCallback: true,
      },
    ]);
  });

  it("excludes hooks and bench callbacks by callee root", async () => {
    const tests = await collectFromTree({
      "tests/hooks.test.ts": `
beforeEach(() => {
  expect(1).toBe(1);
});
afterEach(() => {});
beforeAll(() => {});
afterAll(() => {});
bench("fast thing", () => {});
it("the one test", () => {});
`,
    });
    expect(identity(tests)).toEqual([
      {
        title: "the one test",
        qualifiedTitle: "the one test",
        relPath: "tests/hooks.test.ts",
        describeTitles: [],
        line: 9,
        index: 0,
        hasCallback: true,
      },
    ]);
  });

  it("collects a bare-identifier callback with callback null", async () => {
    const tests = await collectFromTree({
      "tests/reference.test.ts": `
it("delegated", runCase);

function runCase(): void {
  expect(1).toBe(1);
}
`,
    });
    // Research R3: the callback argument is a reference, not a function
    // expression — the test still collects (title-based and import-graph
    // pairing still apply), with `callback: null` and no assertion subtree.
    expect(identity(tests)).toEqual([
      {
        title: "delegated",
        qualifiedTitle: "delegated",
        relPath: "tests/reference.test.ts",
        describeTitles: [],
        line: 2,
        index: 0,
        hasCallback: false,
      },
    ]);
  });

  it("keeps same-titled siblings as distinct entries sharing one test_function", async () => {
    const tests = await collectFromTree({
      "tests/siblings.test.ts": `
describe("suite", () => {
  it("same title", () => {});
  it("same title", () => {});
});
`,
    });
    // Spec edge case 2: the qualified titles collide exactly — the rows
    // disambiguate through assertion_location downstream; here the entries
    // stay distinct through line and index.
    expect(identity(tests)).toEqual([
      {
        title: "same title",
        qualifiedTitle: "suite > same title",
        relPath: "tests/siblings.test.ts",
        describeTitles: ["suite"],
        line: 3,
        index: 0,
        hasCallback: true,
      },
      {
        title: "same title",
        qualifiedTitle: "suite > same title",
        relPath: "tests/siblings.test.ts",
        describeTitles: ["suite"],
        line: 4,
        index: 1,
        hasCallback: true,
      },
    ]);
  });

  it("collects .js test files first-class", async () => {
    const tests = await collectFromTree({
      "tests/legacy.test.js": `
it("js test", function () {
  expect(1).toBe(1);
});
`,
    });
    expect(identity(tests)).toEqual([
      {
        title: "js test",
        qualifiedTitle: "js test",
        relPath: "tests/legacy.test.js",
        describeTitles: [],
        line: 2,
        index: 0,
        hasCallback: true,
      },
    ]);
  });

  it("sorts output by relPath regardless of the input path order", async () => {
    // Fixture declaration order spells b before a; the collector's explicit
    // output sort — not the caller's ordering — makes (relPath, index) the
    // structural order (determinism, Constitution I).
    const tests = await collectFromTree({
      "tests/b.test.ts": `
it("bee", () => {});
it("bee two", () => {});
`,
      "tests/a.test.ts": `
it("ay", () => {});
`,
    });
    expect(
      identity(tests).map((test) => `${test.relPath}:${test.index}:${test.title}`),
    ).toEqual([
      "tests/a.test.ts:0:ay",
      "tests/b.test.ts:0:bee",
      "tests/b.test.ts:1:bee two",
    ]);
  });

  it("collects through program mode over the admitted test arm", async () => {
    // The program arm's source names are absolute (join(root, relPath) —
    // the extender config's own spelling), so the collector resolves each
    // test path through the program before walking it (FR-006's widened
    // bootstrap).
    const tests = await collectFromTree(
      {
        "src/math.ts":
          "export function add(a: number, b: number): number {\n  return a + b;\n}\n",
        "tests/math.test.ts":
          'import { add } from "../src/math.js";\n\nit("add", () => {\n  expect(add(1, 2)).toBe(3);\n});\n',
      },
      "program",
    );
    expect(identity(tests)).toEqual([
      {
        title: "add",
        qualifiedTitle: "add",
        relPath: "tests/math.test.ts",
        describeTitles: [],
        line: 3,
        index: 0,
        hasCallback: true,
      },
    ]);
  });

  it("skips a test path absent from the bootstrap without error", async () => {
    // A pre-read skip (readBounded's bounded-read diagnostic) excludes the
    // file from the bootstrap; its diagnostic was already written by the
    // reader, so the collector's own behavior is the silent absence — never
    // a crash, never a second diagnostic.
    const root = await makeTree({
      "tests/present.test.ts": 'it("here", () => {});\n',
    });
    const sink = memorySink();
    const context = buildProgramContext(
      root,
      [["tests/present.test.ts", 'it("here", () => {});\n']] as const,
      sink.stream,
    );
    expect(context.mode).toBe("parse-only");
    const tests = collectTestFunctions(
      ["tests/present.test.ts", "tests/missing.test.ts"],
      context,
      root,
    );
    expect(identity(tests)).toEqual([
      {
        title: "here",
        qualifiedTitle: "here",
        relPath: "tests/present.test.ts",
        describeTitles: [],
        line: 1,
        index: 0,
        hasCallback: true,
      },
    ]);
  });

  it("returns an empty array for an empty test arm", async () => {
    const root = await makeTree({});
    const sink = memorySink();
    const context = buildProgramContext(root, [], sink.stream);
    expect(context.mode).toBe("parse-only");
    expect(collectTestFunctions([], context, root)).toEqual([]);
  });
});
