/**
 * Caller bucket-rule conformance suite (T008, FR-004; research R7, R12;
 * data-model.md Section 7).
 *
 * src/signals/caller.ts (T010) is the pure half of US3's caller signal: it
 * maps a (function record, canonical effect type) pair's distinct in-scope
 * calling-module count to FR-004's buckets — exactly 1 → +5, 2–3 → +10, 4
 * or more → +15 — and 0 → no signal at all. The COUNTS are the
 * checker-resolved caller index's contract, pinned over multi-module
 * fixture trees by tests/signals/caller-index.test.ts (T007); this suite
 * pins the WEIGHTS.
 *
 * RED-FIRST: this suite was written and observed failing before
 * src/signals/caller.ts existed (the module-resolution failure is the red
 * observation), per the task-pairing discipline in tasks.md.
 *
 * The evidence seam (research R12) is what makes the rule exhaustively
 * table-testable: the extractor is a pure function of a hand-built count
 * and the pair's identity fields, so every bucket boundary is reachable
 * with no tree, no tsconfig, and no checker — the compiler interaction is
 * the index suite's half, pinned there.
 *
 * Scenario coverage (spec.md US3 scenarios 1–4; data-model.md Section 7):
 *
 * - US3-1: exactly 1 distinct module → +5.
 * - US3-2: 2 and 3 distinct modules → +10.
 * - US3-3: 4 or more (4, 5, 20) → +15.
 * - US3-4: 0 distinct modules → NO signal — weight 0 is neutral evidence
 *   and is not emitted (spec assumption 3), never a 0-weight wire row.
 *
 * Beyond the buckets: the emitted signal carries the identity fields
 * verbatim, a non-empty fixed-template `reasoning` naming the count (pinned
 * exactly — research R1's determinism discipline), and round-trips through
 * `serializeSignal`, so the extractor's output is protocol-shaped by
 * construction. Out-of-domain counts fail loud (Constitution Principle II:
 * an upstream index bug surfaces as a throw, never a silently missing
 * signal).
 */
import { describe, expect, it } from "vitest";
import { callerSignal } from "../../src/signals/caller.js";
import { serializeSignal } from "../../src/signals/types.js";

// The quickstart tree's canonical caller pair: formatLabel in src/util.ts,
// called from exactly two in-scope modules (main1.ts and main2.ts), whose
// ReturnValue effect carries the +10 caller_count signal in the 11-signal
// feed (quickstart.md Sections 4–5).
const FUNCTION = "formatLabel";
const PACKAGE = "src.util";
const EFFECT_TYPE = "ReturnValue";

// FR-004's bucket table over hand-built counts: [count, expected weight],
// undefined marking the no-signal row. 0/1/2/3/4 pin the boundaries; 5 and
// 20 pin "and beyond" (the reference analyzer's own scenario counts).
const BUCKETS: readonly (readonly [number, number | undefined])[] = [
  [0, undefined],
  [1, 5],
  [2, 10],
  [3, 10],
  [4, 15],
  [5, 15],
  [20, 15],
];

describe("FR-004 bucket table (US3-1..4)", () => {
  it.each(BUCKETS)(
    "maps %i distinct calling modules to weight %s",
    (count, expected) => {
      const signal = callerSignal(count, FUNCTION, PACKAGE, EFFECT_TYPE);
      if (expected === undefined) {
        expect(signal).toBeUndefined();
        return;
      }
      expect(signal).toBeDefined();
      expect(signal?.source).toBe("caller_count");
      expect(signal?.weight).toBe(expected);
    },
  );

  it("emits no signal for zero callers — neutral evidence (US3-4)", () => {
    // Spec assumption 3: weight 0 carries no evidence, so it is not emitted
    // — a 0-weight row would add wire noise without shifting the confidence
    // arithmetic, and it would blur the parse-only degradation boundary,
    // where "no signal exists" is the observable fact (research R7):
    // without a checker the index is empty, so no caller_count signal can
    // be attributed at all.
    expect(callerSignal(0, FUNCTION, PACKAGE, EFFECT_TYPE)).toBeUndefined();
  });
});

describe("emitted signal shape", () => {
  it("emits the full six-field signal with the identity fields verbatim", () => {
    // The quickstart's formatLabel pair: 2 distinct modules → +10.
    expect(callerSignal(2, FUNCTION, PACKAGE, EFFECT_TYPE)).toEqual({
      function: FUNCTION,
      package: PACKAGE,
      side_effect_type: EFFECT_TYPE,
      source: "caller_count",
      weight: 10,
      reasoning: "called from 2 distinct in-scope modules",
    });
  });

  it("passes any pair's identity fields through unchanged", () => {
    // The rule is identity-blind: a different function, package, and effect
    // type ride along verbatim — and unlike naming/docstring evidence
    // (FR-005/FR-006) no routing gate applies, so the same count yields the
    // same weight for every effect type.
    const signal = callerSignal(4, "writeBanner", "src.banner", "StdoutWrite");
    expect(signal).toEqual({
      function: "writeBanner",
      package: "src.banner",
      side_effect_type: "StdoutWrite",
      source: "caller_count",
      weight: 15,
      reasoning: "called from 4 distinct in-scope modules",
    });
  });
});

describe("reasoning template (research R1 determinism)", () => {
  it("names the count, singular for exactly one module", () => {
    expect(callerSignal(1, FUNCTION, PACKAGE, EFFECT_TYPE)?.reasoning).toBe(
      "called from 1 distinct in-scope module",
    );
  });

  it("names the count, plural for two and beyond", () => {
    expect(callerSignal(2, FUNCTION, PACKAGE, EFFECT_TYPE)?.reasoning).toBe(
      "called from 2 distinct in-scope modules",
    );
    expect(callerSignal(4, FUNCTION, PACKAGE, EFFECT_TYPE)?.reasoning).toBe(
      "called from 4 distinct in-scope modules",
    );
    expect(callerSignal(20, FUNCTION, PACKAGE, EFFECT_TYPE)?.reasoning).toBe(
      "called from 20 distinct in-scope modules",
    );
  });

  it("is pure — the same inputs produce the deep-equal signal", () => {
    expect(callerSignal(3, FUNCTION, PACKAGE, EFFECT_TYPE)).toEqual(
      callerSignal(3, FUNCTION, PACKAGE, EFFECT_TYPE),
    );
  });
});

describe("wire validity (FR-001)", () => {
  it("round-trips every emitted bucket through serializeSignal", () => {
    // The serializer is the fail-loud wire gate (closed source set, canonical
    // type, integer weight, non-empty reasoning); an extractor output that
    // survives it unchanged is protocol-shaped by construction.
    for (const [count, weight] of BUCKETS) {
      const signal = callerSignal(count, FUNCTION, PACKAGE, EFFECT_TYPE);
      if (weight === undefined) {
        expect(signal).toBeUndefined();
        continue;
      }
      expect(serializeSignal(signal)).toEqual({
        function: FUNCTION,
        package: PACKAGE,
        side_effect_type: EFFECT_TYPE,
        source: "caller_count",
        weight,
        reasoning: `called from ${count} distinct in-scope module${count === 1 ? "" : "s"}`,
      });
    }
  });
});

describe("out-of-domain counts", () => {
  it.each([-1, -3, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "throws on the invalid count %s",
    (count) => {
      // The index produces Set.size values — non-negative integers by
      // construction — so these are upstream-bug inputs: fail loud (the
      // models.ts serializer posture) rather than silently suppressing the
      // caller signal, a Principle II silent false negative.
      expect(() => callerSignal(count, FUNCTION, PACKAGE, EFFECT_TYPE)).toThrow(
        `Invalid caller module count: ${count} (must be a non-negative integer)`,
      );
    },
  );
});
