import { describe, expect, it } from "vitest";
import {
  type ClassifySignalsResult,
  type Signal,
  serializeSignal,
} from "../../src/signals/types.js";
import { ALIAS_MAP, SIDE_EFFECT_TYPES } from "../../src/taxonomy.js";

// Conformance suite for the Signal wire record (FR-001; research R1;
// data-model.md Section 2): the closed source set, canonical type
// resolution through resolveSideEffectType, integer weights, string
// identity fields, the omit-unset-optionals reasoning rule, and the
// {"signals": [...]} result shape — pinned against
// specs/003-classify-signals. Mirrors the models.test.ts serializer
// suites: fail-loud validation is the wire contract's enforcement point,
// not a construction-time convention.

// A minimal valid signal — required fields only, no reasoning. ReturnValue
// is a P0 canonical type and naming_convention one of the six closed
// sources; any valid pairing would serve for shape checks.
const minimalSignal: Signal = {
  function: "getTotal",
  package: "src.calc",
  side_effect_type: "ReturnValue",
  source: "naming_convention",
  weight: 10,
};

// Every field set, so the emit-when-set path is exercised in one fixture.
// Mirrors the quickstart tree's writeBanner naming signal: the Write
// prefix agrees with StdoutWrite through the output-family routing (+10).
function fullSignal(): Signal {
  return {
    function: "writeBanner",
    package: "src.banner",
    side_effect_type: "StdoutWrite",
    source: "naming_convention",
    weight: 10,
    reasoning: "name prefix Write agrees with StdoutWrite",
  };
}

/**
 * Builds a signal whose fields bypass the `Signal` type's static guarantees
 * — values the type cannot express but the serializer must still judge:
 * alias spellings that resolve, non-member source strings, non-integer and
 * non-number weights, null reasoning. FR-001's fail-loud rule is enforced
 * at serialization, so the suite has to reach past the type to exercise
 * it; this one double cast is the localized escape hatch.
 */
function untypedSignal(overrides: Partial<Record<keyof Signal, unknown>>): Signal {
  return { ...minimalSignal, ...overrides } as unknown as Signal;
}

describe("serializeSignal", () => {
  it("emits exactly the five required fields for a minimal signal", () => {
    expect(serializeSignal(minimalSignal)).toEqual({
      function: "getTotal",
      package: "src.calc",
      side_effect_type: "ReturnValue",
      source: "naming_convention",
      weight: 10,
    });
  });

  // FR-001's closed source set transcribed verbatim — six values: the
  // reference analyzer's five plus the contradiction extension FR-011
  // pins (and Clarification Q2 pins docstring, never jsdoc).
  it.each([
    "interface",
    "visibility",
    "caller_count",
    "naming_convention",
    "docstring",
    "contradiction",
  ] as const)("accepts the closed source %s", (source) => {
    expect(serializeSignal({ ...minimalSignal, source })).toEqual({
      ...minimalSignal,
      source,
    });
  });

  // Near-miss strings: jsdoc is the rejected module-name spelling
  // (Clarification Q2), label the never-on-signals classification leak,
  // and toString the prototype-chain hazard an `in`-based membership
  // check would pass.
  it.each(["jsdoc", "label", "doc_string", "contradictions", "toString"])(
    "throws on the non-member source string %s",
    (source) => {
      expect(() => serializeSignal(untypedSignal({ source }))).toThrow(
        `Invalid signal source: ${source}`,
      );
    },
  );

  it("throws on the empty source string", () => {
    expect(() => serializeSignal(untypedSignal({ source: "" }))).toThrow(
      "Invalid signal source: ",
    );
  });

  it.each([42, null, undefined])("throws on the non-string source %s", (source) => {
    expect(() => serializeSignal(untypedSignal({ source }))).toThrow(
      `Invalid signal source: ${source}`,
    );
  });

  // side_effect_type validates through resolveSideEffectType exactly as
  // serializeEffect does: every canonical name passes through unchanged…
  it.each([...SIDE_EFFECT_TYPES])(
    "passes the canonical side effect type %s through unchanged",
    (sideEffectType) => {
      const signal = { ...minimalSignal, side_effect_type: sideEffectType };
      expect(serializeSignal(signal).side_effect_type).toBe(sideEffectType);
    },
  );

  // …every alias resolves to its canonical target — aliases never reach
  // the wire…
  it.each(Object.entries(ALIAS_MAP))(
    "resolves the alias %s to the canonical %s",
    (alias, canonical) => {
      const signal = untypedSignal({ side_effect_type: alias });
      expect(serializeSignal(signal).side_effect_type).toBe(canonical);
    },
  );

  // …and anything else fails loud. "returnvalue" pins the exact-casing
  // requirement; toString again guards the prototype chain.
  it.each(["DefinitelyNotASideEffect", "returnvalue", "toString"])(
    "throws on the side effect type %s that is neither canonical nor alias",
    (sideEffectType) => {
      const signal = untypedSignal({ side_effect_type: sideEffectType });
      expect(() => serializeSignal(signal)).toThrow(
        `Invalid side effect type: ${sideEffectType}`,
      );
    },
  );

  it("throws on the empty side effect type", () => {
    expect(() => serializeSignal(untypedSignal({ side_effect_type: "" }))).toThrow(
      "Invalid side effect type: ",
    );
  });

  // Signed integers from the closed weight set (data-model.md Section 7),
  // including visibility's documented clamped component sums (+14, +20):
  // integer-ness is the serializer's check — the closed set itself is the
  // extractors' pinned rules, so arithmetic sums stay serializable.
  it.each([30, 20, 15, 14, 10, 8, 5, -10, -15, -20])(
    "accepts the signed integer weight %s",
    (weight) => {
      expect(serializeSignal({ ...minimalSignal, weight })).toEqual({
        ...minimalSignal,
        weight,
      });
    },
  );

  it.each([10.5, -0.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "throws on the non-integer weight %s",
    (weight) => {
      expect(() => serializeSignal({ ...minimalSignal, weight })).toThrow(
        `Invalid signal weight: ${weight} (must be an integer)`,
      );
    },
  );

  it.each(["10", null, undefined])("throws on the non-number weight %s", (weight) => {
    expect(() => serializeSignal(untypedSignal({ weight }))).toThrow(
      `Invalid signal weight: ${weight} (must be an integer)`,
    );
  });

  it.each([
    ["number", 42],
    ["object", null],
    ["undefined", undefined],
    ["boolean", true],
  ])("throws on a non-string function of type %s", (kind, value) => {
    expect(() => serializeSignal(untypedSignal({ function: value }))).toThrow(
      `Invalid signal function: expected a string, got ${kind}`,
    );
  });

  it.each([
    ["number", 42],
    ["object", null],
    ["undefined", undefined],
    ["boolean", true],
  ])("throws on a non-string package of type %s", (kind, value) => {
    expect(() => serializeSignal(untypedSignal({ package: value }))).toThrow(
      `Invalid signal package: expected a string, got ${kind}`,
    );
  });

  // reasoning follows the omit-unset-optionals rule (US2 scenario 3):
  // absent or explicitly undefined omits the field — never null.
  it("omits reasoning when absent — absent key, never null", () => {
    const serialized = serializeSignal(minimalSignal);
    expect(Object.keys(serialized).sort()).toEqual([
      "function",
      "package",
      "side_effect_type",
      "source",
      "weight",
    ]);
    expect("reasoning" in serialized).toBe(false);
    // The protocol forbids null for omitted fields.
    expect(Object.values(serialized).includes(null)).toBe(false);
  });

  it("omits reasoning when explicitly undefined", () => {
    const serialized = serializeSignal({ ...minimalSignal, reasoning: undefined });
    expect("reasoning" in serialized).toBe(false);
    expect(Object.keys(serialized)).toHaveLength(5);
  });

  it("emits reasoning when present", () => {
    expect(serializeSignal(fullSignal())).toEqual({
      function: "writeBanner",
      package: "src.banner",
      side_effect_type: "StdoutWrite",
      source: "naming_convention",
      weight: 10,
      reasoning: "name prefix Write agrees with StdoutWrite",
    });
  });

  it("throws on the empty reasoning string", () => {
    expect(() => serializeSignal({ ...minimalSignal, reasoning: "" })).toThrow(
      "Invalid signal reasoning: must be a non-empty string when present",
    );
  });

  it("throws on null reasoning — null never reaches the wire", () => {
    expect(() => serializeSignal(untypedSignal({ reasoning: null }))).toThrow(
      "Invalid signal reasoning: expected a string, got object",
    );
  });

  it("round-trips through JSON with the snake_case side_effect_type key", () => {
    const parsed = JSON.parse(JSON.stringify(serializeSignal(fullSignal())));
    expect(parsed).toEqual({
      function: "writeBanner",
      package: "src.banner",
      side_effect_type: "StdoutWrite",
      source: "naming_convention",
      weight: 10,
      reasoning: "name prefix Write agrees with StdoutWrite",
    });
  });
});

describe("classify_signals result shape", () => {
  // FR-014 / data-model.md Section 2: the result is {"signals": [...]} —
  // exactly one key. The server wraps the serialized array under this key
  // (T030); pinning the shape here keeps a second result field from
  // appearing by accident.
  it('is {"signals": [...]} with exactly one key', () => {
    const result: ClassifySignalsResult = {
      signals: [minimalSignal, fullSignal()],
    };
    expect(Object.keys(result)).toEqual(["signals"]);
    expect(Array.isArray(result.signals)).toBe(true);
    expect(result.signals).toHaveLength(2);
    // The wire name survives JSON serialization — no camelCase rename.
    expect(Object.keys(JSON.parse(JSON.stringify(result)))).toEqual(["signals"]);
  });

  // An analysis with no signals is a {"signals": []} success — never an
  // error (a pattern set matching no files; spec 002 FR-001 semantics).
  it('serializes an empty analysis as {"signals": []}', () => {
    const result: ClassifySignalsResult = { signals: [] };
    expect(JSON.parse(JSON.stringify(result))).toEqual({ signals: [] });
  });
});
