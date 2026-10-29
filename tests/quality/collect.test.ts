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
// before returning — the same lifetime discipline the pipeline owns. The
// diagnostic sink defaults to a fresh memory sink and is shared by the
// bootstrap and the collection so a caller can assert on every diagnostic
// the run wrote (the bounded-walk guard suite).
async function collectFromTree(
  files: Readonly<Record<string, string>>,
  mode: "parse-only" | "program" = "parse-only",
  sink = memorySink(),
): Promise<TestFunction[]> {
  const onDisk: Record<string, string> =
    mode === "program" ? { ...files, "tsconfig.json": TSCONFIG } : { ...files };
  const root = await makeTree(onDisk);
  const pairs = Object.entries(files)
    .filter(([relPath]) => COMPILABLE_EXTENSIONS.has(extname(relPath)))
    .map(([relPath, text]) => [relPath, text] as const);
  const context = buildProgramContext(root, pairs, sink.stream);
  try {
    // Fail loud when the requested mode did not materialize: a silent
    // tsconfig fallback would turn a "both modes" test into parse-only
    // twice.
    expect(context.mode).toBe(mode);
    return collectTestFunctions(testPathsOf(files), context, root, sink.stream);
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

describe("collectTestFunctions (bounded-walk guard)", () => {
  // T038 — the iteration-2 review-fix suite (F2; plan.md Scale/Scope;
  // Constitution V): the collection walk is depth-bounded by the shared
  // MAPPING_WALK_DEPTH_BUDGET (2000), so a programmatically pathological
  // describe nest degrades to a per-file skip with exactly one diagnostic
  // to the injected stderr — sibling files keep their tests, and the call
  // never crashes. The fixture is generated, not spelled: nesting past
  // the budget is not a shape anyone writes by hand.
  const DEPTH = 2500;

  function pathologicalNest(): string {
    const open = Array.from(
      { length: DEPTH },
      (_, level) => `describe("d${level}", () => {`,
    ).join("\n");
    const close = Array.from({ length: DEPTH }, () => "});").join("\n");
    return `${open}\nit("deep", () => {});\n${close}\n`;
  }

  it("skips a pathological describe nest whole, with exactly one diagnostic", async () => {
    const sink = memorySink();
    const tests = await collectFromTree(
      {
        "tests/pathological.test.ts": pathologicalNest(),
        "tests/normal.test.ts": 'it("ok", () => {});\n',
      },
      "parse-only",
      sink,
    );
    // The pathological file contributes nothing — including its shallow
    // tail, since the skip unit is the FILE (the extractFromFile
    // discipline) — while the sibling file's tests survive.
    expect(identity(tests)).toEqual([
      {
        title: "ok",
        qualifiedTitle: "ok",
        relPath: "tests/normal.test.ts",
        describeTitles: [],
        line: 1,
        index: 0,
        hasCallback: true,
      },
    ]);
    expect(sink.text()).toBe(
      "reading-stone: skipping tests/pathological.test.ts: ast depth exceeds budget\n",
    );
  });

  it("guards the program-mode walk identically", async () => {
    // Both bootstrap modes share the one walk (research R5's parity), so
    // the guard holds in checker mode too: the pathological file is
    // served by the live compiler and skipped identically.
    const sink = memorySink();
    const tests = await collectFromTree(
      {
        "tests/pathological.test.ts": pathologicalNest(),
        "tests/normal.test.ts": 'it("ok", () => {});\n',
      },
      "program",
      sink,
    );
    expect(identity(tests)).toEqual([
      {
        title: "ok",
        qualifiedTitle: "ok",
        relPath: "tests/normal.test.ts",
        describeTitles: [],
        line: 1,
        index: 0,
        hasCallback: true,
      },
    ]);
    expect(sink.text()).toBe(
      "reading-stone: skipping tests/pathological.test.ts: ast depth exceeds budget\n",
    );
  });
});

describe("collectTestFunctions (control-flow interiors)", () => {
  // T040/T041 (iteration-3 F3; FR-002 as amended; research R3's walk
  // domain; data-model.md Section 5.1): the walk descends into the
  // conservative control-flow interiors — `if`/`else` branches,
  // `for`/`for-of`/`for-in`/`while`/`do-while` loop bodies, and plain
  // blocks — within the file top level AND describe callback bodies,
  // collecting the it/test/describe invocations found at
  // expression-statement position within them (the loop-registration
  // form vitest itself documents: `for (const c of cases) it(c.label,
  // fn)`). `switch`, `try`/`catch`/`finally`, and labeled statements stay
  // OUTSIDE the domain (iteration-3 F2 — the deliberately conservative
  // enumeration: anything not enumerated is not walked), and nested
  // function bodies — helpers — are never entered: a helper is a
  // different scope, not a container.

  it("collects a for-of registered it at top level, non-static title as empty string", async () => {
    // Line-indexed fixture (each entry's 1-based index IS its line): the
    // loop-registered test's title is the non-static `c.label`, so the
    // static-text rule yields `""` — availability first, never dropped
    // (FR-002).
    const tests = await collectFromTree({
      "tests/for-of.test.ts": [
        'const cases = [{ label: "a" }, { label: "b" }];',
        "for (const c of cases) {",
        "  it(c.label, () => {",
        "    expect(1).toBe(1);",
        "  });",
        "}",
        "",
      ].join("\n"),
    });
    expect(identity(tests)).toEqual([
      {
        title: "",
        qualifiedTitle: "",
        relPath: "tests/for-of.test.ts",
        describeTitles: [],
        line: 3,
        index: 0,
        hasCallback: true,
      },
    ]);
  });

  it("collects if-gated tests from both branches", async () => {
    const tests = await collectFromTree({
      "tests/gated.test.ts": [
        "const focused = process.env.FOCUS !== undefined;",
        "if (focused) {",
        '  it("gated test", () => {',
        "    expect(1).toBe(1);",
        "  });",
        "} else {",
        '  it("other branch", () => {});',
        "}",
        "",
      ].join("\n"),
    });
    // The walk is static — both branches are walked; the runtime guard is
    // never evaluated (Constitution V: analyzed source is never run).
    expect(identity(tests)).toEqual([
      {
        title: "gated test",
        qualifiedTitle: "gated test",
        relPath: "tests/gated.test.ts",
        describeTitles: [],
        line: 3,
        index: 0,
        hasCallback: true,
      },
      {
        title: "other branch",
        qualifiedTitle: "other branch",
        relPath: "tests/gated.test.ts",
        describeTitles: [],
        line: 7,
        index: 1,
        hasCallback: true,
      },
    ]);
  });

  it("collects control flow inside describe bodies with qualification", async () => {
    const tests = await collectFromTree({
      "tests/nested-control.test.ts": [
        'describe("suite", () => {',
        "  for (const c of [1, 2]) {",
        `    it(\`case \${c}\`, () => {});`,
        "  }",
        "  if (process.env.CI === undefined) {",
        '    it("local only", () => {});',
        "  }",
        "});",
        "",
      ].join("\n"),
    });
    // The describe stack applies unchanged through control-flow interiors:
    // the substituted template title joins verbatim as the empty segment
    // (FR-003), the static title qualifies normally.
    expect(identity(tests)).toEqual([
      {
        title: "",
        qualifiedTitle: "suite > ",
        relPath: "tests/nested-control.test.ts",
        describeTitles: ["suite"],
        line: 3,
        index: 0,
        hasCallback: true,
      },
      {
        title: "local only",
        qualifiedTitle: "suite > local only",
        relPath: "tests/nested-control.test.ts",
        describeTitles: ["suite"],
        line: 6,
        index: 1,
        hasCallback: true,
      },
    ]);
  });

  it("does not collect from helper function bodies", async () => {
    const tests = await collectFromTree({
      "tests/helper.test.ts": [
        "function makeCase(label: string): void {",
        "  it(label, () => {",
        "    expect(1).toBe(1);",
        "  });",
        "}",
        "const helper = (): void => {",
        '  it("arrow helper", () => {});',
        "};",
        'it("real test", () => {});',
        "",
      ].join("\n"),
    });
    // A helper is a different scope, never a container (research R3): the
    // declared function's body and the arrow assigned to a const are both
    // outside the statement-level walk — only the real top-level test
    // collects.
    expect(identity(tests)).toEqual([
      {
        title: "real test",
        qualifiedTitle: "real test",
        relPath: "tests/helper.test.ts",
        describeTitles: [],
        line: 9,
        index: 0,
        hasCallback: true,
      },
    ]);
  });

  it("collects from every enumerated loop kind and plain blocks", async () => {
    const tests = await collectFromTree({
      "tests/loops.test.ts": [
        "for (let i = 0; i < 1; i++) {",
        '  it("classic for", () => {});',
        "}",
        "for (const key in { a: 1 }) {",
        '  it("for-in", () => {});',
        "}",
        "while (false) {",
        '  it("while", () => {});',
        "}",
        "do {",
        '  it("do-while", () => {});',
        "} while (false);",
        "{",
        '  it("plain block", () => {});',
        "}",
        "",
      ].join("\n"),
    });
    // All five enumerated interior kinds collect, in source order; the
    // statically-false guards are irrelevant — the walk never evaluates
    // conditions (Constitution V).
    expect(identity(tests)).toEqual([
      {
        title: "classic for",
        qualifiedTitle: "classic for",
        relPath: "tests/loops.test.ts",
        describeTitles: [],
        line: 2,
        index: 0,
        hasCallback: true,
      },
      {
        title: "for-in",
        qualifiedTitle: "for-in",
        relPath: "tests/loops.test.ts",
        describeTitles: [],
        line: 5,
        index: 1,
        hasCallback: true,
      },
      {
        title: "while",
        qualifiedTitle: "while",
        relPath: "tests/loops.test.ts",
        describeTitles: [],
        line: 8,
        index: 2,
        hasCallback: true,
      },
      {
        title: "do-while",
        qualifiedTitle: "do-while",
        relPath: "tests/loops.test.ts",
        describeTitles: [],
        line: 11,
        index: 3,
        hasCallback: true,
      },
      {
        title: "plain block",
        qualifiedTitle: "plain block",
        relPath: "tests/loops.test.ts",
        describeTitles: [],
        line: 14,
        index: 4,
        hasCallback: true,
      },
    ]);
  });

  it("stays outside switch, try/catch/finally, and labeled interiors", async () => {
    const tests = await collectFromTree({
      "tests/excluded.test.ts": [
        "switch (process.platform) {",
        '  case "darwin":',
        '    it("darwin only", () => {});',
        "    break;",
        "}",
        "try {",
        '  it("in try", () => {});',
        "} catch {",
        '  it("in catch", () => {});',
        "} finally {",
        '  it("in finally", () => {});',
        "}",
        "label: {",
        '  it("labeled", () => {});',
        "}",
        'it("after", () => {});',
        "",
      ].join("\n"),
    });
    // Iteration-3 F2: `switch`, `try`/`catch`/`finally`, and labeled
    // statements are OUTSIDE the walk domain — the enumeration is
    // deliberately conservative, so their interiors contribute nothing
    // even at expression-statement position. Only the plain top-level
    // test collects.
    expect(identity(tests)).toEqual([
      {
        title: "after",
        qualifiedTitle: "after",
        relPath: "tests/excluded.test.ts",
        describeTitles: [],
        line: 16,
        index: 0,
        hasCallback: true,
      },
    ]);
  });

  it("collects control-flow interiors through program mode identically", async () => {
    // Both bootstrap modes share the one walk (research R5's parity), so
    // the broadened domain holds in checker mode too — the loop-registered
    // test is served by the live compiler and collected identically.
    const tests = await collectFromTree(
      {
        "src/cases.ts": 'export const cases = ["a", "b"];\n',
        "tests/cases.test.ts": [
          'import { cases } from "../src/cases.js";',
          "",
          "for (const label of cases) {",
          "  it(label, () => {",
          "    expect(label.length).toBeGreaterThan(0);",
          "  });",
          "}",
          "",
        ].join("\n"),
      },
      "program",
    );
    expect(identity(tests)).toEqual([
      {
        title: "",
        qualifiedTitle: "",
        relPath: "tests/cases.test.ts",
        describeTitles: [],
        line: 4,
        index: 0,
        hasCallback: true,
      },
    ]);
  });
});
