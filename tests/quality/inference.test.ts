// Fallback-chain inference fixtures for src/quality/inference.ts (T011;
// FR-009/FR-010; research R7; data-model.md Section 7; US1-7 and US4
// scenarios 5–7 as US1's slice; Constitution Principles I and II).
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
//   ErrorSignal when present, else the ErrorReturn fallback.
// - Value rows (equality, comparison, membership, "") follow the standard
//   chain: ReturnValue when present, else the target's first P0 effect in
//   effect-array order (TIER_MAP membership), else GeneratorYield, else
//   AsyncGeneratorYield, else the ReturnValue fallback — total for every
//   effect-set shape including the empty set (US1-7).

import type { Node } from "typescript/unstable/ast";
import { describe, expect, it } from "vitest";
import type { ExtractionRecord } from "../../src/extract.js";
import type { Effect } from "../../src/models.js";
import type { AssertionSite } from "../../src/quality/assertions.js";
import type { TestFunction } from "../../src/quality/collect.js";
import { inferSideEffectType } from "../../src/quality/inference.js";
import type { Pairing } from "../../src/quality/pairing.js";
import type { AssertionKind } from "../../src/quality/types.js";
import type { SideEffectType } from "../../src/taxonomy.js";

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
