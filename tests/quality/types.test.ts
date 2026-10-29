/**
 * The MappingRow serializer validation suite (T003, FR-001; research R1,
 * R8; data-model Section 2) — the fail-loud wire contract for the
 * `test_mapping` method's row record, mirroring the stance
 * tests/signals/types.test.ts takes for `serializeSignal`: every closed
 * set, canonical-membership rule, and integer bound is asserted here as
 * a throwing boundary, because a malformed row is an analyzer bug that
 * must never reach the wire (Constitution Principle I).
 *
 * RED STATE (TDD task ordering): T003 precedes T006
 * (src/quality/types.ts). While the module is absent this file fails
 * during collection — 0 tests passing, the failure being the missing
 * module import itself. No test in this file can pass until the
 * serializer exists.
 *
 * The deliberate serializer divergence from `serializeSignal` this suite
 * pins: `side_effect_type` enforces CANONICAL MEMBERSHIP, not
 * alias resolution. `serializeSignal` resolves an alias input to its
 * canonical target (aliases are legitimate detector spellings there);
 * `serializeMappingRow` treats an alias as a construction-time bug and
 * throws — inference constructs canonical-typed values directly, so an
 * alias spelling can only mean a broken construction path (data-model
 * Section 2: "aliases are construction-time bugs that must not reach the
 * wire"; spec FR-001: "canonical type membership"). Both routes go
 * through the same `resolveSideEffectType` oracle — the mechanism is
 * shared, the contract is stricter here.
 */

import { describe, expect, it } from "vitest";
import {
  type AssertionKind,
  type MappingRow,
  serializeMappingRow,
  type TestMappingResult,
} from "../../src/quality/types.js";
import type { SideEffectType } from "../../src/taxonomy.js";
import { resolveSideEffectType } from "../../src/taxonomy.js";

/**
 * A valid row at its most ordinary value — the shape every pipeline
 * stage emits. Field values are transcribed from data-model Section 2's
 * field table; the confidence is the naming-exact strategy's fixed 90
 * (data-model Section 6).
 */
const BASE_ROW: MappingRow = {
  test_function: "math > adds two numbers",
  test_file: "tests/math.test.ts",
  assertion_location: "tests/math.test.ts:4",
  assertion_type: "equality",
  target_function: "add",
  target_package: "src.math",
  side_effect_type: "ReturnValue",
  confidence: 90,
};

/** One row with selective overrides — the invalid-value seam. */
function rowWith(overrides: Partial<MappingRow>): MappingRow {
  return { ...BASE_ROW, ...overrides };
}

describe("serializeMappingRow: valid rows", () => {
  it("round-trips a valid row with exactly the eight wire keys, in wire order", () => {
    const serialized = serializeMappingRow(BASE_ROW);
    expect(serialized).toEqual(BASE_ROW);
    // Wire spellings, never camelCase (the FunctionRecord.side_effects
    // precedent): the key set and its order are the wire contract.
    expect(Object.keys(serialized)).toEqual([
      "test_function",
      "test_file",
      "assertion_location",
      "assertion_type",
      "target_function",
      "target_package",
      "side_effect_type",
      "confidence",
    ]);
  });

  it.each([
    { kind: "equality" },
    { kind: "comparison" },
    { kind: "membership" },
    { kind: "error_check" },
    { kind: "" },
  ] as const)("accepts the closed kind value %j", ({ kind }) => {
    const serialized = serializeMappingRow(
      rowWith({ assertion_type: kind satisfies AssertionKind }),
    );
    expect(serialized.assertion_type).toBe(kind);
  });

  it("accepts an empty test_function (non-static titles are still strings)", () => {
    const serialized = serializeMappingRow(rowWith({ test_function: "" }));
    expect(serialized.test_function).toBe("");
  });

  it.each([0, 70, 75, 80, 90, 100])(
    "accepts the integer confidence %d",
    (confidence) => {
      const serialized = serializeMappingRow(rowWith({ confidence }));
      expect(serialized.confidence).toBe(confidence);
    },
  );

  it("accepts every canonical side-effect type spelling it is fed", () => {
    // A P0, a P1, and a P2 canonical name — the membership check is the
    // full 48-name set through resolveSideEffectType; three suffices to
    // prove the pass-through is not a single-name special case.
    const serialized = serializeMappingRow(
      rowWith({ side_effect_type: "StdoutWrite" }),
    );
    expect(serialized.side_effect_type).toBe("StdoutWrite");
  });
});

describe("serializeMappingRow: fail-loud validation", () => {
  it.each(["generic", "identity", "EQUALITY", "equality ", "error-check"])(
    "throws on the kind value %j (never generic, never anything outside the closed set)",
    (kind) => {
      expect(() =>
        serializeMappingRow(rowWith({ assertion_type: kind as AssertionKind })),
      ).toThrow(/Invalid assertion type/);
    },
  );

  it("throws on a null kind (never null — the empty string is the unclassified convention)", () => {
    expect(() =>
      serializeMappingRow(
        rowWith({ assertion_type: null as unknown as AssertionKind }),
      ),
    ).toThrow(/Invalid assertion type/);
  });

  it("throws on an alias side_effect_type spelling (construction-time bug; aliases never emitted)", () => {
    // BarrierOp is a real alias in taxonomy's ALIAS_MAP (→ WaitGroupOp).
    // The guard makes the pin self-validating: a taxonomy rename fails
    // here loudly instead of making the throw below vacuously pass.
    expect(resolveSideEffectType("BarrierOp")).toBe("WaitGroupOp");
    expect(() =>
      serializeMappingRow(rowWith({ side_effect_type: "BarrierOp" as SideEffectType })),
    ).toThrow(/Invalid side effect type/);
  });

  it.each(["ReturnsValue", "toString", ""])(
    "throws on the non-canonical, non-alias side_effect_type %j",
    (type) => {
      expect(() =>
        serializeMappingRow(rowWith({ side_effect_type: type as SideEffectType })),
      ).toThrow(/Invalid side effect type/);
    },
  );

  it.each([-1, 101, 90.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "throws on the out-of-range or fractional confidence %d",
    (confidence) => {
      expect(() => serializeMappingRow(rowWith({ confidence }))).toThrow(
        /Invalid mapping confidence/,
      );
    },
  );

  it.each(["90", null, undefined])(
    "throws on the non-number confidence %j",
    (confidence) => {
      expect(() =>
        serializeMappingRow(rowWith({ confidence: confidence as unknown as number })),
      ).toThrow(/Invalid mapping confidence/);
    },
  );

  it.each([
    { field: "test_function" },
    { field: "test_file" },
    { field: "assertion_location" },
    { field: "target_function" },
    { field: "target_package" },
  ])("type-checks the string field %s", ({ field }) => {
    const overrides = { [field]: 42 } as Partial<MappingRow>;
    expect(() => serializeMappingRow(rowWith(overrides))).toThrow(
      new RegExp(`Invalid mapping ${field}: expected a string, got number`),
    );
  });
});

describe("TestMappingResult: the one-key wire shape", () => {
  it("wraps the row array under exactly one mappings key", () => {
    // The handler's result wrapper is compile-time pinned to this
    // interface (data-model Section 2); this runtime pin keeps the wire
    // spelling honest — exactly one key, never a bare array on the wire.
    const result: TestMappingResult = { mappings: [serializeMappingRow(BASE_ROW)] };
    expect(Object.keys(result)).toEqual(["mappings"]);
    expect(result.mappings).toHaveLength(1);
  });

  it("admits the empty analysis as an empty mappings array", () => {
    const result: TestMappingResult = { mappings: [] };
    expect(Object.keys(result)).toEqual(["mappings"]);
    expect(result.mappings).toEqual([]);
  });
});
