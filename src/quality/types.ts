import { resolveSideEffectType, type SideEffectType } from "../taxonomy.js";

/**
 * The test-mapping wire record (FR-001; research R1, R8; data-model.md
 * Section 2) — one row per (paired test, assertion): a test with three
 * assertions yields three rows sharing target fields with distinct
 * `assertion_location` values (US1-2).
 *
 * Field names are the wire spellings — snake_case per the protocol
 * payload contract, TypeScript identifiers identical to the wire names
 * (the `FunctionRecord.side_effects` precedent from src/models.ts and
 * src/signals/types.ts). Entities are immutable value records:
 * `readonly` fields, never mutated after construction (convention pack
 * AP-004).
 *
 * Serialization enforces the same Constitution Principle I rules as the
 * models.ts and signals/types.ts serializers, rather than trusting
 * call-site discipline — fail loud, never emit invalid protocol data:
 *
 * - `assertion_type` membership in the closed five-value kind set
 *   (including `""` — the unclassified convention; never `generic`,
 *   never `null`).
 * - `side_effect_type` CANONICAL membership through `resolveSideEffectType`
 *   — a canonical name passes, anything else throws. This is the one
 *   deliberate divergence from `serializeSignal`, which RESOLVES an
 *   alias input to its canonical target (aliases are legitimate detector
 *   spellings there). Here an alias is a construction-time bug that must
 *   not reach the wire (data-model Section 2; spec FR-001's "canonical
 *   type membership"): inference constructs canonical-typed values
 *   directly, so an alias spelling can only mean a broken construction
 *   path. Both routes go through the same resolver oracle — the
 *   mechanism is shared, the contract is stricter here.
 * - `confidence` an integer in [0, 100].
 * - Every string field type-checked (`test_function` possibly empty —
 *   non-static titles — but always a string).
 *
 * No protocol method consumes these records yet — by design: the
 * collection, pairing, assertion, and inference stages land in later
 * tasks of this feature (US1–US4), all emitting `MappingRow` values
 * through this one shape. Defining it once here is what keeps every
 * stage wire-shaped instead of inventing per-module ad-hoc structures.
 */

/**
 * The closed assertion-kind vocabulary (FR-001/FR-008; data-model.md
 * Section 3): exactly five values, the empty string being the
 * unclassified convention — never `generic` (the reference analyzer's
 * sixth value is deliberately dropped: the platform's
 * assertion-detection metric counts rows carrying a recognized type, so
 * `""` feeds it exactly), never `null`.
 */
export type AssertionKind =
  | ""
  | "equality"
  | "comparison"
  | "membership"
  | "error_check";

/**
 * One test-to-assertion mapping row (FR-001; data-model.md Section 2).
 *
 * `side_effect_type` must be canonical: the inference layer constructs
 * canonical-typed values through the taxonomy directly, and
 * `serializeMappingRow` enforces canonical membership again as defense
 * in depth — aliases never reach the wire.
 */
export interface MappingRow {
  /**
   * The describe-qualified test title (data-model Section 5.1): enclosing
   * describe titles joined `" > "`, then the test title. Possibly empty —
   * non-static titles collect as `""` — but always a string.
   */
  readonly test_function: string;
  /** Root-relative POSIX path of the test file. */
  readonly test_file: string;
  /** `"<relPath>:<line>"` — the expect/assert call's 1-based line; no column. */
  readonly assertion_location: string;
  /** The classified kind or `""` (Section 4's normative table). */
  readonly assertion_type: AssertionKind;
  /** The target record's declared name. */
  readonly target_function: string;
  /** `derivePackage(targetRecord.relPath)` — the dotted module path. */
  readonly target_package: string;
  /** One of the 48 canonical taxonomy names — aliases never emitted. */
  readonly side_effect_type: SideEffectType;
  /** Integer in [0, 100] — the pairing strategy's fixed value (90/70/80/75). */
  readonly confidence: number;
}

/**
 * The `test_mapping` result shape (FR-013; data-model.md Section 2): a
 * single `mappings` key holding the wire rows — exactly one key, with an
 * empty analysis a `{"mappings": []}` success rather than an error
 * (US1-8).
 *
 * Ordering is the emitter's responsibility (the pipeline, FR-013): the
 * stable key `(test_file, test_function, target_package, target_function,
 * assertion line, assertion character)`, UTF-16 code-unit comparison for
 * strings and numeric for line/character, with the deterministic
 * AST-walk collection order as the stable-sort final tie-break.
 *
 * The pin is load-bearing end to end: the pipeline entry
 * (src/quality/pipeline.ts) and the server handler construct their
 * result against this interface, so the wire shape is compile-time
 * enforced rather than merely declared (the ClassifySignalsResult
 * precedent).
 */
export interface TestMappingResult {
  /** The rows in FR-013's stable-key order; `[]` for empty inputs — never an error. */
  readonly mappings: readonly MappingRow[];
}

/**
 * The five closed kind values — the serializer's membership set. A `Set`
 * (like models.ts's `CLASSIFICATION_LABELS` and signals/types.ts's
 * `SIGNAL_SOURCES`) so lookups consult own data only, never the
 * prototype chain. Constructed with the `AssertionKind` element type so
 * a misspelled member is a compile error.
 */
const ASSERTION_KINDS: ReadonlySet<string> = new Set<AssertionKind>([
  "",
  "equality",
  "comparison",
  "membership",
  "error_check",
]);

/**
 * Fail-loud guard for a required string field: throws when `value` is not
 * a string (Constitution Principle I — invalid record content never
 * reaches the wire). The field is named in the message for actionable
 * diagnostics.
 *
 * A module-private twin of models.ts's and signals/types.ts's guards
 * rather than a shared export: the serializers keep their validation
 * helpers private (the house pattern), and this module's scope is the
 * mapping row alone.
 *
 * @param value The field value to type-check.
 * @param field Human-readable field description for the error message.
 */
function requireString(value: unknown, field: string): void {
  if (typeof value !== "string") {
    throw new Error(`Invalid ${field}: expected a string, got ${typeof value}`);
  }
}

/**
 * Serializes a `MappingRow` to its wire shape (FR-001): all eight fields
 * are always present, emitted in the wire order data-model Section 2's
 * field table lists.
 *
 * The return is typed `MappingRow` — the validated wire-shaped value —
 * so the pipeline's payload and the server handler's `TestMappingResult`
 * wrapper are compile-time pinned to this shape (FR-013's wire contract,
 * enforced rather than asserted).
 *
 * Validation fails loud (Constitution Principle I): `assertion_type`
 * outside the closed five-value kind set, a `side_effect_type` that is
 * not a canonical taxonomy name (aliases included — they are
 * construction-time bugs here, unlike `serializeSignal`'s resolve
 * behavior), a `confidence` that is not an integer in [0, 100], or a
 * non-string value in any string field. These are programming errors in
 * the mapping pipeline, not runtime conditions to absorb.
 *
 * @param row The mapping row to serialize.
 * @returns The validated wire-shaped `MappingRow`: the eight fields in
 * wire order.
 * @throws Error when any field fails its closed-set, canonical-membership,
 * integer-bound, or string-type check.
 */
export function serializeMappingRow(row: MappingRow): MappingRow {
  requireString(row.test_function, "mapping test_function");
  requireString(row.test_file, "mapping test_file");
  requireString(row.assertion_location, "mapping assertion_location");
  requireString(row.target_function, "mapping target_function");
  requireString(row.target_package, "mapping target_package");
  if (!ASSERTION_KINDS.has(row.assertion_type)) {
    throw new Error(`Invalid assertion type: ${row.assertion_type}`);
  }
  // Canonical membership through the shared resolver oracle: a canonical
  // name resolves to itself and passes; an alias resolves to a DIFFERENT
  // canonical target and fails; an unknown string resolves to undefined
  // and fails. Aliases are construction-time bugs that must not reach the
  // wire (data-model Section 2) — the deliberate divergence from
  // serializeSignal's resolve-and-emit behavior, which stays correct for
  // signals because detector spellings there may legitimately be aliases.
  if (resolveSideEffectType(row.side_effect_type) !== row.side_effect_type) {
    throw new Error(`Invalid side effect type: ${row.side_effect_type}`);
  }
  if (!Number.isInteger(row.confidence) || row.confidence < 0 || row.confidence > 100) {
    throw new Error(
      `Invalid mapping confidence: ${row.confidence} (must be an integer in the range 0-100)`,
    );
  }
  return {
    test_function: row.test_function,
    test_file: row.test_file,
    assertion_location: row.assertion_location,
    assertion_type: row.assertion_type,
    target_function: row.target_function,
    target_package: row.target_package,
    side_effect_type: row.side_effect_type,
    confidence: row.confidence,
  };
}
