import { resolveSideEffectType, type SideEffectType } from "../taxonomy.js";

/**
 * The classification-signal wire record (FR-001; research R1; data-model.md
 * Section 2) — the raw evidence unit the `classify_signals` method emits and
 * Gaze's `mergeClassifications` → `ComputeScore` pipeline sums back into the
 * reported confidence (the FR-011 sum-invariant): one signal attributes a
 * single piece of classification evidence to one (function record, canonical
 * effect type) pair.
 *
 * The record is deliberately label-free (FR-001): raw signals never carry a
 * classification — `contractual`/`incidental`/`ambiguous` verdicts live on
 * `analyze` effects' `Classification` values only (src/models.ts). A signal
 * says why an effect leans one way; the label is the pipeline's conclusion.
 *
 * Serialization enforces the same Constitution Principle I rules as
 * models.ts, rather than trusting call-site discipline:
 *
 * - Fail loud: a `source` outside the six closed values, a
 *   `side_effect_type` that is neither canonical nor alias, a non-integer
 *   `weight`, or a present-but-empty `reasoning` throws instead of emitting
 *   invalid protocol data. A malformed signal is an analyzer bug; silently
 *   shipping it would corrupt every score Gaze computes from the feed.
 * - Omit-unset-optionals: `reasoning` absent or explicitly `undefined` is
 *   omitted from the serialized object — never emitted as `null`.
 *
 * No protocol method consumes these records yet — by design: the extractors,
 * the adapter, and the `classify_signals` handler land in later tasks of
 * this feature (US1/US2). Defining the shape once here is what keeps every
 * extractor protocol-shaped instead of inventing per-module ad-hoc
 * structures.
 *
 * Naming follows the wire/identifier split models.ts documents: wire-format
 * fields are snake_case per the protocol payload contract
 * (`side_effect_type`), and the identity field is `function` — the
 * unqualified record name, never `name` (FR-001). Entities are immutable
 * value records — `readonly` fields, never mutated after construction
 * (convention pack AP-004).
 */

/**
 * One of exactly six closed source values (FR-001) — the rule family a
 * signal's evidence came from: `interface` (a declared interface member),
 * `visibility` (exportedness components), `caller_count` (distinct calling
 * modules), `naming_convention` (name prefixes and the `Err` sentinel
 * special case), `docstring` (JSDoc tags and prose verbs — the protocol's
 * established documentation-source string, never `jsdoc`; Clarification
 * Q2), and `contradiction` (the synthesized mixed-polarity penalty,
 * FR-011). No other source value may appear on the wire.
 */
export type SignalSource =
  | "interface"
  | "visibility"
  | "caller_count"
  | "naming_convention"
  | "docstring"
  | "contradiction";

/**
 * A single raw classification signal on one (function record, canonical
 * effect type) pair (FR-001).
 *
 * `side_effect_type` must be canonical: extractor code resolves any alias
 * spelling through `resolveSideEffectType` before constructing a `Signal`,
 * and `serializeSignal` enforces canonical membership again as defense in
 * depth — aliases never reach the wire.
 *
 * `reasoning` follows the omit-unset-optionals rule: absent (or explicitly
 * `undefined`) at construction, omitted from serialization — never `null`.
 * Unlike models.ts's pass-through optionals it is content-validated when
 * present, because FR-001 pins non-emptiness as wire contract rather than
 * a construction-time convention.
 */
export interface Signal {
  /**
   * The unqualified function record name — the wire identity field, never
   * `name` (FR-001; spec assumption 9).
   */
  readonly function: string;
  /** Dotted module path derived by `derivePackage` from the record's file. */
  readonly package: string;
  /** The canonical side-effect type — the only vocabulary reportable on the wire. */
  readonly side_effect_type: SideEffectType;
  /**
   * The rule that produced this signal; membership in the closed source
   * set is validated at serialization.
   */
  readonly source: SignalSource;
  /**
   * Signed integer weight from the closed weight set (data-model.md
   * Section 7). Integer-ness is serializer-checked; the closed set itself
   * is enforced by the extractors' pinned rules rather than a runtime
   * membership test — visibility's clamped component sums (e.g. +14) make
   * the set arithmetic, not enumerable.
   */
  readonly weight: number;
  /**
   * Deterministic fixed-template explanation naming the matched rule and
   * token; non-empty when present (spec assumption 8).
   */
  readonly reasoning?: string;
}

/**
 * The `classify_signals` result shape (FR-014; data-model.md Section 2): a
 * single `signals` key holding the wire records — exactly one key, with an
 * empty analysis a `{"signals": []}` success rather than an error.
 * `analyze` never emits `Signal` values: its effects carry classifications
 * only (FR-012).
 *
 * Ordering is the emitter's responsibility (the adapter, FR-014):
 * `(package, function, side_effect_type, source)` codepoint comparison — a
 * total order with no tie-break rule, because pair keying keeps the
 * ordering key duplicate-free.
 *
 * The pin is load-bearing end to end: the `classify_signals` entry
 * (src/analysis.ts) returns `ClassifySignalsResult["signals"]` and the
 * server handler constructs its wrapper against this interface, so the
 * wire shape is compile-time enforced rather than merely declared
 * (FR-014).
 */
export interface ClassifySignalsResult {
  /** The raw signals in `(package, function, side_effect_type, source)` order. */
  readonly signals: readonly Signal[];
}

/**
 * The six closed source values (FR-001) — the serializer's membership set.
 * A `Set` (like models.ts's `CLASSIFICATION_LABELS` and taxonomy's
 * `CANONICAL_NAMES`) so lookups consult own data only, never the prototype
 * chain. Constructed with the `SignalSource` element type so a misspelled
 * member is a compile error — the same compile-time check taxonomy gets by
 * building its set from the `SideEffectType[]` literal.
 */
const SIGNAL_SOURCES: ReadonlySet<string> = new Set<SignalSource>([
  "interface",
  "visibility",
  "caller_count",
  "naming_convention",
  "docstring",
  "contradiction",
]);

/**
 * Fail-loud guard for a required string field: throws when `value` is not
 * a string (Constitution Principle I — invalid record content never
 * reaches the wire). The field is named in the message for actionable
 * diagnostics.
 *
 * A module-private twin of models.ts's guard rather than a shared export:
 * the serializers keep their validation helpers private (the house
 * pattern), and T004's scope is this one new file — promoting the guard to
 * a shared module is a cross-cutting refactor the plan does not ask for.
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
 * Serializes a `Signal` to its wire shape (FR-001): required `function`,
 * `package`, `side_effect_type`, `source`, and `weight` are always
 * emitted; `reasoning` appears only when set — omitted, never `null`, when
 * absent or explicitly `undefined`.
 *
 * The return is typed `Signal` — the validated wire-shaped value, its
 * alias (if any) resolved to the canonical type — so the
 * `classify_signals` entry's payload and the server handler's
 * `ClassifySignalsResult` wrapper are compile-time pinned to this shape
 * (FR-014's wire contract, enforced rather than asserted).
 *
 * Validation fails loud (Constitution Principle I). `side_effect_type` is
 * checked through the same resolver detection code uses: a canonical name
 * passes through, an alias spelling that slipped past construction
 * resolves to its canonical target (aliases never reach the wire), and a
 * string that is neither canonical nor alias throws. `source` must be one
 * of the six closed values, `weight` a signed integer, and a present
 * `reasoning` a non-empty string — the one optional field whose content is
 * validated, because FR-001 pins non-emptiness as wire contract rather
 * than a construction-time convention.
 *
 * @param signal The signal to serialize.
 * @returns The validated wire-shaped `Signal`: `function`, `package`,
 * `side_effect_type`, `source`, and `weight`, plus `reasoning` when set.
 * @throws Error when `function` or `package` is not a string,
 * `side_effect_type` is neither a canonical side-effect type nor an alias,
 * `source` is outside the closed set, `weight` is not an integer, or
 * `reasoning` is present but not a non-empty string.
 */
export function serializeSignal(signal: Signal): Signal {
  requireString(signal.function, "signal function");
  requireString(signal.package, "signal package");
  const type = resolveSideEffectType(signal.side_effect_type);
  if (type === undefined) {
    throw new Error(`Invalid side effect type: ${signal.side_effect_type}`);
  }
  if (!SIGNAL_SOURCES.has(signal.source)) {
    throw new Error(`Invalid signal source: ${signal.source}`);
  }
  if (!Number.isInteger(signal.weight)) {
    throw new Error(`Invalid signal weight: ${signal.weight} (must be an integer)`);
  }
  const serialized: Signal = {
    function: signal.function,
    package: signal.package,
    side_effect_type: type,
    source: signal.source,
    weight: signal.weight,
  };
  if (signal.reasoning !== undefined) {
    requireString(signal.reasoning, "signal reasoning");
    if (signal.reasoning.length === 0) {
      throw new Error(
        "Invalid signal reasoning: must be a non-empty string when present",
      );
    }
    // Spread rather than mutate: Signal is an immutable value record
    // (AP-004), so the optional field joins as a new value — the same
    // key order the wire has always had, `reasoning` last.
    return { ...serialized, reasoning: signal.reasoning };
  }
  return serialized;
}
