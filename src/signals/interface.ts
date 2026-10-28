import { derivePackage } from "../models.js";
import type { SideEffectType } from "../taxonomy.js";
import type { RecordEvidence } from "./evidence.js";
import type { Signal } from "./types.js";

/**
 * The interface-satisfaction extractor (FR-002; research R6; data-model.md
 * Section 7) — the pure half of US1's `interface` signal, and one of the
 * five extractors the adapter fans out per (function record, canonical
 * effect type) pair (FR-008).
 *
 * The rule is one row of pinned weight arithmetic, not tuning: a
 * class-member record whose enclosing class's heritage declares an
 * interface member carrying the record's name emits exactly one +30
 * `interface` signal; every other record emits nothing. A weight that
 * drifts from data-model.md Section 7 is a bug — the same posture as the
 * caller bucket table (caller.ts) and the confidence formula (FR-009).
 *
 * Evidence seam (research R12): the rule is a pure function of the snapshot
 * and the pair's effect type — no compiler interaction, no I/O, no
 * `ProgramContext`. Every compiler-shaped decision — heritage resolution
 * through the checker, the InterfaceDeclaration-kind gate, the
 * declared-member table keyed by the compiler's escaped-name spelling, the
 * `toString` apparent-member hazard — lives entirely in evidence.ts's
 * `RecordEvidence.interfaceMember` (T019), pinned over program-mode fixture
 * trees by tests/signals/evidence.test.ts (T011); the one runtime import
 * here is `derivePackage`, the pure string helper that renders the record's
 * dotted module path. The seam is what makes the rule exhaustively
 * table-testable with hand-built snapshots (tests/signals/interface.test.ts,
 * T012) — no tree, no tsconfig, no checker for the weights, exactly like
 * the sibling pure rules (visibility, caller, naming, jsdoc).
 *
 * Effect-type blindness: interface evidence agrees with every effect type
 * equally — a declared interface contract obligates the method as a whole,
 * not one effect category — so unlike naming and documentation evidence
 * (FR-005/FR-006) there is no routing gate, and `effectType` rides along as
 * identity only.
 *
 * Parse-only degradation (FR-002; spec assumption 10): without a checker
 * the seam answers `interfaceMember: false` for every record, so no
 * interface signal exists at all — undeterminable is absence of evidence,
 * never an error (Constitution Principle II), and degradation reduces
 * precision, never availability.
 *
 * Determinism (Constitution Principle I; research R1): the emitted
 * `reasoning` is a fixed template naming the matched member and the rule —
 * a pure function of the matched rule and its token, stable per analyzer
 * version and pinned by the test suite exactly like effect `description`
 * strings.
 */

/**
 * Maps one (function record, canonical effect type) pair's evidence snapshot
 * to FR-002's `interface` signal.
 *
 * The identity fields pass through verbatim — `function` is the record's
 * unqualified name and `package` its `derivePackage` value — and the rule
 * is effect-type-blind (see the module header): the same snapshot yields
 * the same source, weight, and reasoning for any canonical effect type.
 *
 * @param evidence The record's evidence snapshot; the rule reads only
 * `interfaceMember` and the record's identity fields, never the live
 * compiler views.
 * @param effectType The pair's canonical effect type — the signal's
 * `side_effect_type` identity field.
 * @returns The +30 `interface` signal when `evidence.interfaceMember` is
 * true — a class-member record a heritage interface declares — or
 * `undefined` otherwise, including every parse-only snapshot: neutral
 * absence, never an error (Constitution Principle II).
 */
export function interfaceSignal(
  evidence: RecordEvidence,
  effectType: SideEffectType,
): Signal | undefined {
  // FR-002's no-signal rows collapse onto one falsy arm at the seam: a
  // non-class member, an undeclared member, a class base through either
  // heritage token, an invalid extends-an-interface clause, and the
  // parse-only degradation all arrive as `interfaceMember: false`. The
  // class-membership invariant rides with it — evidence.ts only ever sets
  // the flag for a record with an enclosing class-like — so the rule never
  // re-derives a distinction the seam already made.
  if (!evidence.interfaceMember) {
    return undefined;
  }
  const { record } = evidence;
  return {
    function: record.name,
    package: derivePackage(record.relPath),
    side_effect_type: effectType,
    source: "interface",
    weight: 30,
    reasoning: `member '${record.name}' is declared in an interface of the enclosing class's heritage`,
  };
}
