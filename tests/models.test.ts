import { describe, expect, it } from "vitest";
import {
  type Classification,
  derivePackage,
  type Effect,
  type FunctionRecord,
  serializeClassification,
  serializeEffect,
  serializeFunctionRecord,
} from "../src/models.js";

// Conformance suite for the shared record models (FR-013–FR-016; US2
// scenarios 3–5): wire shapes, the omit-unset-optionals rule, fail-loud
// validation, and the package-derivation table, all pinned against
// specs/001-discovery-shared-analysis/data-model.md.

// A minimal valid effect — required fields only. ReturnValue is a P0
// canonical type; any of the 48 members would serve for shape checks.
const minimalEffect: Effect = {
  type: "ReturnValue",
  description: "returns the computed total",
};

// Every optional field set, so the emit-when-set path is exercised in one
// fixture. FileSystemWrite is a P2 canonical type.
function fullEffect(): Effect {
  return {
    type: "FileSystemWrite",
    description: "appends a line to the log file",
    location: "src/logger.ts:42:9",
    target: "logPath",
    detail: { bytes: 128, encoding: "utf-8", nested: { fd: 3 } },
    classification: { label: "contractual", confidence: 87 },
  };
}

describe("serializeClassification", () => {
  it.each(["contractual", "incidental", "ambiguous"] as const)(
    "emits label and confidence for the %s label",
    (label) => {
      const classification: Classification = { label, confidence: 50 };
      expect(serializeClassification(classification)).toEqual({
        label,
        confidence: 50,
      });
    },
  );

  it.each([0, 100])("accepts the boundary confidence %s", (confidence) => {
    expect(serializeClassification({ label: "ambiguous", confidence })).toEqual({
      label: "ambiguous",
      confidence,
    });
  });

  it.each([45.5, -1, 101])("throws on the out-of-range confidence %s", (confidence) => {
    expect(() => serializeClassification({ label: "contractual", confidence })).toThrow(
      `Invalid classification confidence: ${confidence}`,
    );
  });

  it("throws on a label outside the three protocol literals", () => {
    const classification = { label: "definitely", confidence: 90 };
    expect(() => serializeClassification(classification as Classification)).toThrow(
      "Invalid classification label: definitely",
    );
  });
});

describe("serializeEffect", () => {
  it("emits exactly type and description when no optional field is set", () => {
    expect(serializeEffect(minimalEffect)).toEqual({
      type: "ReturnValue",
      description: "returns the computed total",
    });
  });

  it("omits every optional field when unset — absent keys, never null", () => {
    const serialized = serializeEffect({
      type: "ReturnValue",
      description: "returns the computed total",
      location: undefined,
      target: undefined,
      detail: undefined,
      classification: undefined,
    });
    expect(Object.keys(serialized).sort()).toEqual(["description", "type"]);
    for (const key of ["location", "target", "detail", "classification"]) {
      expect(key in serialized).toBe(false);
    }
    // The protocol forbids null for omitted fields (US2 scenario 3).
    expect(Object.values(serialized).includes(null)).toBe(false);
  });

  it("emits every optional field when set", () => {
    expect(serializeEffect(fullEffect())).toEqual({
      type: "FileSystemWrite",
      description: "appends a line to the log file",
      location: "src/logger.ts:42:9",
      target: "logPath",
      detail: { bytes: 128, encoding: "utf-8", nested: { fd: 3 } },
      classification: { label: "contractual", confidence: 87 },
    });
  });

  it("passes the detail object through without interpretation", () => {
    const detail = { bytes: 128, encoding: "utf-8", nested: { fd: 3 } };
    const serialized = serializeEffect({ ...minimalEffect, detail });
    expect(serialized.detail).toEqual(detail);
  });

  it("serializes the nested classification as label and confidence", () => {
    const serialized = serializeEffect({
      ...minimalEffect,
      classification: { label: "incidental", confidence: 23 },
    });
    expect(serialized.classification).toEqual({
      label: "incidental",
      confidence: 23,
    });
  });

  it("resolves an alias spelling to its canonical type", () => {
    const effect = { ...minimalEffect, type: "AsyncTaskSpawn" };
    expect(serializeEffect(effect as Effect).type).toBe("GoroutineSpawn");
  });

  it("throws on a type that is neither canonical nor an alias", () => {
    const effect = { ...minimalEffect, type: "DefinitelyNotASideEffect" };
    expect(() => serializeEffect(effect as Effect)).toThrow(
      "Invalid side effect type: DefinitelyNotASideEffect",
    );
  });
});

describe("serializeFunctionRecord", () => {
  it("emits the five wire fields, mapping side_effects through serializeEffect", () => {
    const record: FunctionRecord = {
      name: "appendLogLine",
      package: "src.logger",
      file: "src/logger.ts",
      line: 41,
      side_effects: [fullEffect(), minimalEffect],
    };
    const serialized = serializeFunctionRecord(record);
    expect(Object.keys(serialized).sort()).toEqual([
      "file",
      "line",
      "name",
      "package",
      "side_effects",
    ]);
    expect(serialized.name).toBe("appendLogLine");
    expect(serialized.package).toBe("src.logger");
    expect(serialized.file).toBe("src/logger.ts");
    expect(serialized.line).toBe(41);
    expect(Array.isArray(serialized.side_effects)).toBe(true);
    expect(serialized.side_effects).toEqual([
      {
        type: "FileSystemWrite",
        description: "appends a line to the log file",
        location: "src/logger.ts:42:9",
        target: "logPath",
        detail: { bytes: 128, encoding: "utf-8", nested: { fd: 3 } },
        classification: { label: "contractual", confidence: 87 },
      },
      { type: "ReturnValue", description: "returns the computed total" },
    ]);
  });

  it("emits an empty array for a record with no side effects", () => {
    const record: FunctionRecord = {
      name: "pureHelper",
      package: "src.utils",
      file: "src/utils.ts",
      line: 7,
      side_effects: [],
    };
    const serialized = serializeFunctionRecord(record);
    expect(Array.isArray(serialized.side_effects)).toBe(true);
    expect(serialized.side_effects).toEqual([]);
  });

  it("round-trips through JSON with the snake_case side_effects key", () => {
    const record: FunctionRecord = {
      name: "pureHelper",
      package: "src.utils",
      file: "src/utils.ts",
      line: 7,
      side_effects: [minimalEffect],
    };
    const parsed = JSON.parse(JSON.stringify(serializeFunctionRecord(record)));
    expect(parsed).toEqual({
      name: "pureHelper",
      package: "src.utils",
      file: "src/utils.ts",
      line: 7,
      side_effects: [
        { type: "ReturnValue", description: "returns the computed total" },
      ],
    });
  });

  it("throws on a line that is not a positive 1-based integer", () => {
    const record: FunctionRecord = {
      name: "badLine",
      package: "src.bad",
      file: "src/bad.ts",
      line: 0,
      side_effects: [],
    };
    expect(() => serializeFunctionRecord(record)).toThrow(
      "Invalid function record line: 0",
    );
  });
});

describe("derivePackage", () => {
  // The exact derivation table from data-model.md (FR-016).
  it.each([
    ["pkg/mod.ts", "pkg.mod"],
    // An index module represents its directory: the trailing .index drops.
    ["pkg/index.ts", "pkg"],
    ["src/deep/thing.ts", "src.deep.thing"],
    // A top-level index keeps its name — no dotted .index suffix to strip.
    ["index.ts", "index"],
    // Only the final extension is stripped: the a.b stem survives.
    ["a.b.ts", "a.b"],
  ])("derives %s as %s", (relPath, expected) => {
    expect(derivePackage(relPath)).toBe(expected);
  });
});
