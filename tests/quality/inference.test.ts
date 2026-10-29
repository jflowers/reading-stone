// Fallback-chain inference fixtures for src/quality/inference.ts (T011/
// T029; FR-009/FR-010/FR-011; research R7; data-model.md Sections 5.5
// and 7; US1-7 and US4 scenarios 1–8; Constitution Principles I and II).
//
// RED-FIRST: src/quality/inference.ts does not exist yet — T018 creates it
// — so this suite fails on module resolution by design (tasks.md: US1
// tests are written first and observed to FAIL before the paired
// implementation lands).
//
// The contract pinned here — pure-rule tests over hand-built effect sets
// (no compiler, the dependency-injection seam; the hand-built-record
// convention from tests/signals/adapter.test.ts):
//
// - Entry point: `inferSideEffectType(assertion, pair, effects)` — the
//   assertion site, the pair, and the target's effect set in, one canonical
//   taxonomy name out. The pair and the site's node fields flow through
//   untouched (the provenance-pass seam US4's T031 extends); US1's rules
//   read only the assertion's kind and the effect set.
// - Error rows (`assertion_type === "error_check"`) select by assertion
//   type alone, never provenance: ErrorReturn when present, else
//   ErrorSignal when it carries that, else the ErrorReturn fallback.
// - Value rows (equality, comparison, membership, "") follow the standard
//   chain: ReturnValue when present, else the target's first P0 effect in
//   effect-array order (TIER_MAP membership), else GeneratorYield, else
//   AsyncGeneratorYield, else the ReturnValue fallback — total for every
//   effect-set shape including the empty set (US1-7).
//
// T029's provenance suite (FR-011; SC-003) extends the file below: the
// passes read the site's node fields and the pair's callback, so their
// fixtures run over REAL parsed ASTs — a parse-only ProgramContext per
// scene (the assertions suite's harness), collectTestFunctions +
// collectAssertions for live sites, hand-built pairs and effect sets
// (parse-only call resolution reads only the target's declared name, so
// the record's node stays the localized filler cast). The distinguishing
// effect set throughout: GeneratorYield + ErrorReturn (P0), no
// ReturnValue — a firing pass observably prefers GeneratorYield (US4-1);
// every no-fire path observably maps ErrorReturn (the first P0).

import { realpathSync } from "node:fs";
import { extname } from "node:path";
import type { Node } from "typescript/unstable/ast";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtractionRecord } from "../../src/extract.js";
import type { Effect } from "../../src/models.js";
import { buildProgramContext } from "../../src/program.js";
import { type AssertionSite, collectAssertions } from "../../src/quality/assertions.js";
import { collectTestFunctions, type TestFunction } from "../../src/quality/collect.js";
import {
  collectFileLocalHelpers,
  inferSideEffectType,
  type ProvenanceInputs,
} from "../../src/quality/inference.js";
import type { Pairing } from "../../src/quality/pairing.js";
import type { AssertionKind } from "../../src/quality/types.js";
import type { SideEffectType } from "../../src/taxonomy.js";
import {
  createFixtureTree,
  drainCleanups,
  memorySink,
  registerCleanup,
} from "../helpers/fixtures.js";

function effect(type: SideEffectType): Effect {
  return { type, description: `${type} fixture effect` };
}

const TARGET: ExtractionRecord = {
  name: "fixture",
  relPath: "src/fixture.ts",
  line: 1,
  node: undefined as unknown as Node,
  scopeChain: [],
  deferred: false,
};

const TEST: TestFunction = {
  title: "fixture",
  qualifiedTitle: "fixture",
  relPath: "tests/fixture.test.ts",
  describeTitles: [],
  callback: null,
  line: 1,
  index: 0,
};

const PAIR: Pairing = {
  test: TEST,
  target: TARGET,
  strategy: "naming",
  confidence: 90,
};

// The hand-built site: inference's fallback rules read only `kind`, so the
// node anchors are inert filler — the same localized cast the adapter and
// pairing suites document (US4's provenance passes are what consume them).
function siteOf(kind: AssertionKind): AssertionSite {
  return {
    kind,
    line: 3,
    character: 2,
    assertedExpression: null,
    argumentSubtree: undefined as unknown as Node,
    expectChain: true,
  };
}

function infer(kind: AssertionKind, types: readonly SideEffectType[]): SideEffectType {
  return inferSideEffectType(siteOf(kind), PAIR, types.map(effect));
}

describe("inferSideEffectType (error rows)", () => {
  it("selects ErrorReturn when the target carries it", () => {
    expect(infer("error_check", ["ErrorReturn"])).toBe("ErrorReturn");
  });

  it("selects ErrorSignal when ErrorReturn is absent", () => {
    expect(infer("error_check", ["ErrorSignal"])).toBe("ErrorSignal");
  });

  it("prefers ErrorReturn by presence, not effect-array order", () => {
    // The chain is presence-based: ErrorSignal first in the array still
    // loses to a present ErrorReturn.
    expect(infer("error_check", ["ErrorSignal", "ErrorReturn"])).toBe("ErrorReturn");
  });

  it("falls back to ErrorReturn on the empty effect set", () => {
    expect(infer("error_check", [])).toBe("ErrorReturn");
  });

  it("never consults value effects or provenance for error rows", () => {
    // US4-5: error rows select by assertion type alone — a return-family
    // effect set still maps the error channel's chain.
    expect(infer("error_check", ["ReturnValue", "GeneratorYield"])).toBe("ErrorReturn");
  });
});

describe("inferSideEffectType (value rows)", () => {
  it("selects ReturnValue when present, for every value kind", () => {
    expect(infer("equality", ["ReturnValue"])).toBe("ReturnValue");
    expect(infer("comparison", ["ReturnValue"])).toBe("ReturnValue");
    expect(infer("membership", ["ReturnValue"])).toBe("ReturnValue");
    expect(infer("", ["ReturnValue"])).toBe("ReturnValue");
  });

  it("lets ReturnValue shadow a P0 effect that precedes it in the array", () => {
    expect(infer("equality", ["ErrorSignal", "ReturnValue"])).toBe("ReturnValue");
  });

  it("selects the first P0 effect in effect-array order", () => {
    // Both are P0 (TIER_MAP); the array's order decides — the pin
    // detectEffects' deterministic (line, column, type) emission makes
    // stable.
    expect(infer("equality", ["SentinelError", "ReceiverMutation"])).toBe(
      "SentinelError",
    );
    expect(infer("equality", ["ReceiverMutation", "SentinelError"])).toBe(
      "ReceiverMutation",
    );
  });

  it("skips non-P0 effects when picking the first P0", () => {
    // MapMutation is P1 and LogWrite is P2; PointerArgMutation is the only
    // P0 in the array.
    expect(infer("equality", ["MapMutation", "PointerArgMutation", "LogWrite"])).toBe(
      "PointerArgMutation",
    );
  });

  it("falls through to GeneratorYield when no P0 effect is present", () => {
    expect(infer("equality", ["GeneratorYield"])).toBe("GeneratorYield");
    // A P1 mutation does not shadow the generator pass.
    expect(infer("equality", ["MapMutation", "GeneratorYield"])).toBe("GeneratorYield");
  });

  it("falls through to AsyncGeneratorYield when neither P0 nor GeneratorYield is present", () => {
    expect(infer("equality", ["AsyncGeneratorYield"])).toBe("AsyncGeneratorYield");
    // A P2 log write does not shadow the async generator pass.
    expect(infer("equality", ["LogWrite", "AsyncGeneratorYield"])).toBe(
      "AsyncGeneratorYield",
    );
  });

  it("prefers GeneratorYield over AsyncGeneratorYield", () => {
    expect(infer("equality", ["AsyncGeneratorYield", "GeneratorYield"])).toBe(
      "GeneratorYield",
    );
  });

  it("falls back to ReturnValue on the empty effect set", () => {
    // US1-7: inference is total — a target with no detected effects at all
    // maps ReturnValue, never an omission.
    expect(infer("equality", [])).toBe("ReturnValue");
    expect(infer("comparison", [])).toBe("ReturnValue");
    expect(infer("membership", [])).toBe("ReturnValue");
    expect(infer("", [])).toBe("ReturnValue");
  });

  it("falls back to ReturnValue when only inapplicable effects are present", () => {
    // No P0, no generator family — the total fallback (US1-7).
    expect(infer("equality", ["MapMutation", "ContainerMutation"])).toBe("ReturnValue");
  });

  it("treats the unclassified kind as a value row", () => {
    // "" is a recognized assertion with no classification — the standard
    // chain governs it exactly like the classified value kinds.
    expect(infer("", ["ErrorSignal"])).toBe("ErrorSignal");
    expect(infer("", ["GeneratorYield"])).toBe("GeneratorYield");
  });
});

// ---------------------------------------------------------------------------
// T029 — the provenance-pass suite (FR-011; SC-003; US4 scenarios 1–8;
// research R7; data-model Sections 5.5 and 7). Parse-only scenes over real
// parsed ASTs: the passes read the site's node fields and the pair's
// callback, so every fixture below drives the same collection stages the
// pipeline drives, then infers over hand-built pairs and effect sets.
// ---------------------------------------------------------------------------

// Fixture trees register their cleanup with the shared helpers so every
// test body stays linear; afterEach drains the queue in creation order.
afterEach(async () => {
  await drainCleanups();
});

async function makeTree(files: Readonly<Record<string, string>>): Promise<string> {
  const tree = await createFixtureTree(files);
  registerCleanup(tree.cleanup);
  // The production caller passes a root that discovery's resolveRoot
  // already realpath-resolved; the fixture's mkdtemp path sits behind
  // macOS's /var symlink, so resolve it the same way.
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

// The distinguishing effect set used throughout: GeneratorYield present,
// ErrorReturn (P0) present, ReturnValue absent — a firing pass observably
// prefers GeneratorYield (US4-1's exact scenario shape); every no-fire
// path observably maps ErrorReturn (the first P0 in effect-array order).
const GENERATOR_AND_P0: readonly SideEffectType[] = ["GeneratorYield", "ErrorReturn"];

/** One parse-only scene: the test, its live sites, and the pass inputs. */
interface ProvenanceScene {
  /** The collected test function (real callback AST). */
  readonly test: TestFunction;
  /** The test's collected assertion sites. */
  readonly sites: readonly AssertionSite[];
  /** The pass inputs: the parse-only context and the file's helper table. */
  readonly inputs: ProvenanceInputs;
  /** The scene's captured diagnostics — asserted empty where pinned. */
  readonly stderrText: () => string;
}

// Builds one parse-only scene (the assertions suite's harness shape): the
// fixture tree, the context over its compilable files, the collected test
// by title, its assertion sites, and the provenance inputs built exactly
// as the pipeline builds them — collectFileLocalHelpers over the test
// callback's source file.
async function sceneIn(
  files: Readonly<Record<string, string>>,
  title: string,
): Promise<ProvenanceScene> {
  const root = await makeTree(files);
  const pairs = Object.entries(files)
    .filter(([relPath]) => COMPILABLE_EXTENSIONS.has(extname(relPath)))
    .map(([relPath, text]) => [relPath, text] as const);
  const sink = memorySink();
  const context = buildProgramContext(root, pairs, sink.stream);
  try {
    expect(context.mode).toBe("parse-only");
    const tests = collectTestFunctions(
      pairs.map(([relPath]) => relPath),
      context,
      root,
      sink.stream,
    );
    const test = tests.find((candidate) => candidate.title === title);
    if (test === undefined) {
      throw new Error(`fixture collected no test titled "${title}"`);
    }
    if (test.callback === null) {
      throw new Error(`fixture test "${title}" collected a null callback`);
    }
    return {
      test,
      sites: collectAssertions(test, sink.stream),
      inputs: {
        context,
        helpers: collectFileLocalHelpers(test.callback.getSourceFile()),
      },
      stderrText: sink.text,
    };
  } finally {
    if (context.mode === "program") {
      context.dispose();
    }
  }
}

// The hand-built pair: parse-only call resolution reads only the target's
// declared name, so the record reuses the localized filler-cast node —
// the same convention the fallback suite documents above.
function pairFor(test: TestFunction, targetName: string): Pairing {
  const target: ExtractionRecord = {
    ...TARGET,
    name: targetName,
    relPath: `src/${targetName}.ts`,
  };
  return { test, target, strategy: "naming", confidence: 90 };
}

function soleSite(scene: ProvenanceScene): AssertionSite {
  if (scene.sites.length !== 1) {
    throw new Error(
      `fixture collected ${scene.sites.length} sites, expected exactly 1`,
    );
  }
  return scene.sites[0];
}

function inferWithProvenance(
  scene: ProvenanceScene,
  targetName: string,
  types: readonly SideEffectType[],
): SideEffectType {
  return inferSideEffectType(
    soleSite(scene),
    pairFor(scene.test, targetName),
    types.map(effect),
    scene.inputs,
  );
}

describe("inferSideEffectType provenance (pass 1 — direct identity)", () => {
  it("prefers the return family for a direct identity call (US4-1)", async () => {
    const scene = await sceneIn(
      {
        "tests/direct.test.ts":
          'it("direct", () => {\n  expect(stream()).toBeDefined();\n});\n',
      },
      "direct",
    );
    // Provenance fires: GeneratorYield is preferred over the P0 ErrorReturn.
    expect(inferWithProvenance(scene, "stream", GENERATOR_AND_P0)).toBe(
      "GeneratorYield",
    );
    // The counterfactual: the same site without provenance inputs maps the
    // standard chain's first P0 — the pass is what reordered the family.
    expect(
      inferSideEffectType(
        soleSite(scene),
        pairFor(scene.test, "stream"),
        GENERATOR_AND_P0.map(effect),
      ),
    ).toBe("ErrorReturn");
  });

  it("unwraps await and parenthesized wrappers around the direct call", async () => {
    const scene = await sceneIn(
      {
        "tests/wrapped.test.ts": [
          'import { loadCart } from "../src/cart.js";',
          "",
          'it("wrapped", async () => {',
          "  expect((await loadCart())).toBeDefined();",
          "});",
        ].join("\n"),
      },
      "wrapped",
    );
    expect(inferWithProvenance(scene, "loadCart", GENERATOR_AND_P0)).toBe(
      "GeneratorYield",
    );
  });

  it("matches a method callee's terminal identifier on a new-expression receiver", async () => {
    const scene = await sceneIn(
      {
        "tests/render.test.ts": [
          "class Widget {",
          "  render(): string {",
          '    return "<div/>";',
          "  }",
          "}",
          "",
          'it("render", () => {',
          '  expect(new Widget().render()).toContain("div");',
          "});",
        ].join("\n"),
      },
      "render",
    );
    expect(inferWithProvenance(scene, "render", GENERATOR_AND_P0)).toBe(
      "GeneratorYield",
    );
  });
});

describe("inferSideEffectType provenance (pass 2 — indirect root resolution)", () => {
  const PASS_TWO_FILES: Readonly<Record<string, string>> = {
    "tests/indirect.test.ts": [
      'import { loadCart } from "../src/cart.js";',
      "",
      'it("plain", () => {',
      "  const result = loadCart();",
      '  expect(result.items).toContain("book");',
      "});",
      "",
      'it("awaited", async () => {',
      "  const r = await loadCart();",
      "  expect(r).toBeDefined();",
      "});",
      "",
      'it("destructured object", () => {',
      "  const { items } = loadCart();",
      '  expect(items).toContain("book");',
      "});",
      "",
      'it("destructured array", () => {',
      "  const [first] = loadCart();",
      "  expect(first).toBeDefined();",
      "});",
      "",
      'it("nested property chain", () => {',
      "  const result = loadCart();",
      '  expect(result.cart.items).toContain("book");',
      "});",
    ].join("\n"),
  };

  it("resolves a plain local binding and its property chain (US4-2)", async () => {
    const scene = await sceneIn(PASS_TWO_FILES, "plain");
    expect(inferWithProvenance(scene, "loadCart", GENERATOR_AND_P0)).toBe(
      "GeneratorYield",
    );
  });

  it("resolves through await wrappers", async () => {
    const scene = await sceneIn(PASS_TWO_FILES, "awaited");
    expect(inferWithProvenance(scene, "loadCart", GENERATOR_AND_P0)).toBe(
      "GeneratorYield",
    );
  });

  it("resolves through object destructuring patterns", async () => {
    const scene = await sceneIn(PASS_TWO_FILES, "destructured object");
    expect(inferWithProvenance(scene, "loadCart", GENERATOR_AND_P0)).toBe(
      "GeneratorYield",
    );
  });

  it("resolves through array destructuring patterns", async () => {
    const scene = await sceneIn(PASS_TWO_FILES, "destructured array");
    expect(inferWithProvenance(scene, "loadCart", GENERATOR_AND_P0)).toBe(
      "GeneratorYield",
    );
  });

  it("resolves the root identifier of a nested property chain", async () => {
    const scene = await sceneIn(PASS_TWO_FILES, "nested property chain");
    expect(inferWithProvenance(scene, "loadCart", GENERATOR_AND_P0)).toBe(
      "GeneratorYield",
    );
  });
});

describe("inferSideEffectType provenance (pass 3 — helper function bridging)", () => {
  const HELPER_FILES: Readonly<Record<string, string>> = {
    "tests/helpers.test.ts": [
      'import { add } from "../src/math.js";',
      "",
      "function doubled(n: number): number;",
      "function doubled(n: number): number {",
      "  return add(n, n);",
      "}",
      "",
      'const shouted = (s: string): string => add(s, "!");',
      "",
      "async function fetched(): Promise<number> {",
      "  return await add(1, 2);",
      "}",
      "",
      "let loose = (n: number): number => add(n, 0);",
      "",
      'it("declared helper", () => {',
      "  expect(doubled(2)).toBe(4);",
      "});",
      "",
      'it("arrow helper", () => {',
      '  expect(shouted("hi")).toBe("hi!");',
      "});",
      "",
      'it("awaited return helper", async () => {',
      "  expect(await fetched()).toBeDefined();",
      "});",
      "",
      'it("let-bound helper is not a bridge", () => {',
      "  expect(loose(2)).toBe(2);",
      "});",
    ].join("\n"),
  };

  it("bridges through a file-scope declared helper's return (US4-3)", async () => {
    // The overload signature above the implementation is skipped by the
    // helper table (no body); the body-bearing twin carries the bridge.
    const scene = await sceneIn(HELPER_FILES, "declared helper");
    expect(inferWithProvenance(scene, "add", GENERATOR_AND_P0)).toBe("GeneratorYield");
  });

  it("bridges through a const-bound expression-bodied arrow helper", async () => {
    const scene = await sceneIn(HELPER_FILES, "arrow helper");
    expect(inferWithProvenance(scene, "add", GENERATOR_AND_P0)).toBe("GeneratorYield");
  });

  it("bridges through an awaited return statement", async () => {
    const scene = await sceneIn(HELPER_FILES, "awaited return helper");
    expect(inferWithProvenance(scene, "add", GENERATOR_AND_P0)).toBe("GeneratorYield");
  });

  it("does not bridge through a let-bound helper", async () => {
    // The const requirement is the conservative boundary: a reassignable
    // binding's initializer proves nothing about the call site.
    const scene = await sceneIn(HELPER_FILES, "let-bound helper is not a bridge");
    expect(inferWithProvenance(scene, "add", GENERATOR_AND_P0)).toBe("ErrorReturn");
  });
});

describe("inferSideEffectType provenance (pass 4 — inline call matching)", () => {
  it("matches a target call inline in the matcher's arguments (US4-4)", async () => {
    const scene = await sceneIn(
      {
        "tests/inline.test.ts": [
          'import { make } from "../src/make.js";',
          "",
          'it("inline", () => {',
          '  const items = ["a"];',
          '  expect(items).toContain(make("b"));',
          "});",
        ].join("\n"),
      },
      "inline",
    );
    expect(inferWithProvenance(scene, "make", GENERATOR_AND_P0)).toBe("GeneratorYield");
  });
});

describe("inferSideEffectType provenance (selection rules)", () => {
  it("falls through to the standard chain when no return-family effect is present (US4-7)", async () => {
    const scene = await sceneIn(
      {
        "tests/direct.test.ts":
          'it("direct", () => {\n  expect(stream()).toBeDefined();\n});\n',
      },
      "direct",
    );
    // Pass 1 fires, but ReceiverMutation (P0) is the only family present —
    // provenance only reorders the return family ahead of the chain.
    expect(inferWithProvenance(scene, "stream", ["ReceiverMutation", "LogWrite"])).toBe(
      "ReceiverMutation",
    );
    // No P0 either — the generator passes are absent, so the total
    // fallback governs.
    expect(inferWithProvenance(scene, "stream", ["MapMutation"])).toBe("ReturnValue");
    expect(inferWithProvenance(scene, "stream", [])).toBe("ReturnValue");
  });

  it("never applies provenance to error rows (US4-5)", async () => {
    const scene = await sceneIn(
      {
        "tests/error.test.ts": [
          'import { loadCart } from "../src/cart.js";',
          "",
          'it("error", () => {',
          "  expect(loadCart()).toThrow(Error);",
          "});",
        ].join("\n"),
      },
      "error",
    );
    expect(soleSite(scene).kind).toBe("error_check");
    // The asserted expression IS a direct target call — pass 1 would fire
    // on a value row — but the error chain selects by kind alone.
    expect(inferWithProvenance(scene, "loadCart", GENERATOR_AND_P0)).toBe(
      "ErrorReturn",
    );
    expect(
      inferWithProvenance(scene, "loadCart", ["ErrorSignal", "GeneratorYield"]),
    ).toBe("ErrorSignal");
    expect(inferWithProvenance(scene, "loadCart", ["GeneratorYield"])).toBe(
      "ErrorReturn",
    );
  });

  it("maps the first P0 when no pass succeeds (US4-6)", async () => {
    const scene = await sceneIn(
      {
        "tests/unrelated.test.ts": [
          "function unrelated(): number {",
          "  return 1;",
          "}",
          "",
          'it("unrelated", () => {',
          "  expect(unrelated()).toBeDefined();",
          "});",
        ].join("\n"),
      },
      "unrelated",
    );
    // The asserted call resolves to `unrelated` — a file-scope helper in
    // the table whose return derives from no target call — so no pass
    // fires and the standard chain governs.
    expect(
      inferWithProvenance(scene, "loadCart", ["SentinelError", "ReceiverMutation"]),
    ).toBe("SentinelError");
    // An effect-less target maps the total fallback (US1-7).
    expect(inferWithProvenance(scene, "loadCart", [])).toBe("ReturnValue");
  });

  it("maps the fallback for a bare-literal asserted expression", async () => {
    const scene = await sceneIn(
      {
        "tests/literal.test.ts":
          'it("literal", () => {\n  expect(42).toBeDefined();\n});\n',
      },
      "literal",
    );
    // A numeric-literal root carries no spine identifier — passes 2 and 3
    // have no subject, and the subtree holds no target call.
    expect(inferWithProvenance(scene, "loadCart", ["SentinelError"])).toBe(
      "SentinelError",
    );
  });
});

describe("inferSideEffectType provenance (conservative boundaries — US4-8)", () => {
  it("does not resolve a describe-scope binding", async () => {
    const scene = await sceneIn(
      {
        "tests/describe-scope.test.ts": [
          'import { loadCart } from "../src/cart.js";',
          "",
          'describe("cart", () => {',
          "  const shared = loadCart();",
          "",
          '  it("reads the shared binding", () => {',
          "    expect(shared).toBeDefined();",
          "  });",
          "});",
        ].join("\n"),
      },
      "reads the shared binding",
    );
    // Pass 2 searches the TEST FUNCTION's locals only — the describe
    // callback's declarator does not qualify, and the argument subtree
    // holds no target call.
    expect(inferWithProvenance(scene, "loadCart", GENERATOR_AND_P0)).toBe(
      "ErrorReturn",
    );
  });

  it("does not resolve an inner-closure binding", async () => {
    const scene = await sceneIn(
      {
        "tests/closure.test.ts": [
          'import { loadCart } from "../src/cart.js";',
          "",
          'it("closure locals", () => {',
          "  const probe = () => {",
          "    const inner = loadCart();",
          "    expect(inner).toBeDefined();",
          "  };",
          "  probe();",
          "});",
        ].join("\n"),
      },
      "closure locals",
    );
    // The site collects (nested functions are inside the assertion walk's
    // domain), but the binding is the closure's local, never the test's.
    expect(inferWithProvenance(scene, "loadCart", GENERATOR_AND_P0)).toBe(
      "ErrorReturn",
    );
  });

  it("does not follow const or let alias chains", async () => {
    const scene = await sceneIn(
      {
        "tests/alias.test.ts": [
          'import { loadCart } from "../src/cart.js";',
          "",
          'it("alias chain", () => {',
          "  const direct = loadCart();",
          "  const alias = direct;",
          "  let mutable = direct;",
          "  expect(alias).toBeDefined();",
          "});",
        ].join("\n"),
      },
      "alias chain",
    );
    // `const alias = direct` and `let mutable = direct` bind through bare
    // identifier initializers — never a direct call, const and let alike.
    expect(inferWithProvenance(scene, "loadCart", GENERATOR_AND_P0)).toBe(
      "ErrorReturn",
    );
  });

  it("does not cross control-flow merges", async () => {
    const scene = await sceneIn(
      {
        "tests/merge.test.ts": [
          'import { loadCart } from "../src/cart.js";',
          "",
          'it("merge", () => {',
          "  let out;",
          "  if (ready) {",
          "    out = loadCart();",
          "  }",
          "  expect(out).toBeDefined();",
          "});",
        ].join("\n"),
      },
      "merge",
    );
    // The `let out` declarator carries no initializer — an assignment
    // inside the branch is structurally unreachable as provenance.
    expect(inferWithProvenance(scene, "loadCart", GENERATOR_AND_P0)).toBe(
      "ErrorReturn",
    );
  });

  it("resolves nothing for an element-access callee spine", async () => {
    const scene = await sceneIn(
      {
        "tests/element.test.ts": [
          'it("element", () => {',
          "  const pickers = [() => 1];",
          "  expect(pickers[0]()).toBeDefined();",
          "});",
        ].join("\n"),
      },
      "element",
    );
    // The callee is an element access — no terminal identifier for pass 1
    // or pass 4, no identifier callee for the pass-3 bridge, and the
    // `pickers` declarator's initializer is an array literal.
    expect(inferWithProvenance(scene, "loadCart", GENERATOR_AND_P0)).toBe(
      "ErrorReturn",
    );
  });
});

describe("inferSideEffectType provenance (bounded-walk guard)", () => {
  it("treats a depth-exceeded helper body as no evidence, without diagnostics", async () => {
    // 2500 nested parentheses — past the 2000 budget, trivially parseable —
    // inside the HELPER's return statement: the helper body is the one
    // provenance surface the assertion walk never touches (it sits at file
    // scope, outside the callback), so the site collects normally and only
    // the pass-3 bridge walk crosses the budget.
    const parens = "(".repeat(2500);
    const closers = ")".repeat(2500);
    const scene = await sceneIn(
      {
        "tests/deep-helper.test.ts": [
          'import { add } from "../src/math.js";',
          "",
          "function deepBridge(n: number): number {",
          `  return ${parens}add(n, n)${closers};`,
          "}",
          "",
          'it("deep", () => {',
          "  expect(deepBridge(2)).toBe(4);",
          "});",
        ].join("\n"),
      },
      "deep",
    );
    // The sentinel is caught at the provenance boundary as no evidence: no
    // crash, the row still emits under the fallback chain (nothing was
    // skipped), and no diagnostic is written — unlike the pairing and
    // assertion walks whose budget skips lose rows.
    expect(inferWithProvenance(scene, "add", GENERATOR_AND_P0)).toBe("ErrorReturn");
    expect(scene.stderrText()).toBe("");
  });
});
