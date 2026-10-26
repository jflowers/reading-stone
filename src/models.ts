import { posix } from "node:path";

import { resolveSideEffectType, type SideEffectType } from "./taxonomy.js";

/**
 * Shared record models for analysis results (FR-013–FR-016; research R10)
 * — the immutable value records every later analysis method (side-effect
 * detection, complexity, coverage) constructs, the serializers that turn
 * them into wire-shaped JSON, and the package-name derivation that
 * populates `FunctionRecord.package`.
 *
 * No protocol method consumes these records yet — by design: `analyze`
 * lands in a later issue (spec US2). Defining the shapes once here is what
 * keeps every consumer protocol-shaped instead of inventing per-module
 * ad-hoc structures.
 *
 * Serialization enforces two Constitution Principle I rules rather than
 * trusting call-site discipline:
 *
 * - Omit-unset-optionals: an optional field that is absent or explicitly
 *   `undefined` is omitted from the serialized object — never emitted as
 *   `null` (the protocol forbids `null` for omitted fields; US2 scenario 3).
 * - Fail loud: invalid record content — a non-canonical side-effect type, a
 *   non-string description, an out-of-range confidence — throws instead of
 *   emitting invalid protocol data. A malformed record is an analyzer bug;
 *   silently shipping it would corrupt every score Gaze computes from it.
 *
 * Naming follows the wire/identifier split `DiscoveryResult` documents in
 * discovery.ts: wire-format fields are snake_case per the protocol payload
 * contract (`side_effects`), while TypeScript identifiers stay camelCase
 * (convention pack CS-006). Entities are immutable value records —
 * `readonly` fields, never mutated after construction (convention pack
 * AP-004).
 */

/**
 * The classification of an effect (FR-014): how confidently the analyzer
 * believes the effect belongs to the function's contract.
 *
 * `label` distinguishes the three protocol outcomes — the effect is
 * required by the function's contract (`contractual`), happens as a
 * byproduct (`incidental`), or cannot be determined with confidence
 * (`ambiguous`). Reporting ambiguity instead of dropping the effect is
 * what Constitution Principle II demands: an ambiguous classification is
 * a truthful signal; a silent omission is a false negative.
 *
 * `confidence` is an integer percentage 0–100. Out-of-range or fractional
 * values are programming errors: `serializeClassification` throws rather
 * than emit them (Constitution Principle I).
 */
export interface Classification {
  /** One of the three protocol labels; membership is validated at serialization. */
  readonly label: "contractual" | "incidental" | "ambiguous";
  /** Integer confidence percentage, 0–100 inclusive. */
  readonly confidence: number;
}

/**
 * A single observable side effect attributed to a function (FR-013).
 *
 * `type` must be a canonical `SideEffectType`: detection code resolves any
 * alias spelling through `resolveSideEffectType` before constructing an
 * `Effect`, and `serializeEffect` enforces canonical membership again as
 * defense in depth.
 *
 * Optional fields follow the omit-unset-optionals rule: absent (or
 * explicitly `undefined`) at construction, omitted from serialization —
 * never `null`.
 */
export interface Effect {
  /** The canonical side-effect type — the only vocabulary reportable on the wire. */
  readonly type: SideEffectType;
  /** Human-readable explanation of the observed effect. */
  readonly description: string;
  /** `"file:line:col"` location relative to the analysis root. */
  readonly location?: string;
  /** The attribute, parameter, or exception involved. */
  readonly target?: string;
  /** Opaque metadata passed through to Gaze without interpretation. */
  readonly detail?: Record<string, unknown>;
  /** The contractual/incidental classification, when one was determined. */
  readonly classification?: Classification;
}

/**
 * A function observed in the analyzed project (FR-015) — the unit every
 * analysis result is attributed to.
 *
 * Field names mirror the wire payload exactly: `side_effects` is snake_case
 * per the protocol contract, the same documented exception `DiscoveryResult`
 * uses in discovery.ts; every other name is identical in both worlds.
 * `file` is the path relative to `root_path` with POSIX separators, `line`
 * is the 1-based declaration line, and `package` is the dotted module path
 * `derivePackage` produces from `file`.
 */
export interface FunctionRecord {
  /** The function's declared name. */
  readonly name: string;
  /** Dotted module path derived by `derivePackage` from `file`. */
  readonly package: string;
  /** Root-relative POSIX path of the declaring file. */
  readonly file: string;
  /** 1-based line of the function declaration. */
  readonly line: number;
  /** The effects attributed to the function; serialized as the `side_effects` array. */
  readonly side_effects: readonly Effect[];
}

/**
 * The three classification labels (FR-014) — the serializer's membership
 * set. A `Set` (like taxonomy's `CANONICAL_NAMES`) so lookups consult own
 * data only, never the prototype chain.
 */
const CLASSIFICATION_LABELS: ReadonlySet<string> = new Set([
  "contractual",
  "incidental",
  "ambiguous",
]);

/**
 * Fail-loud guard for a required string field: throws when `value` is not
 * a string (Constitution Principle I — invalid record content never
 * reaches the wire). The field is named in the message for actionable
 * diagnostics.
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
 * Serializes a `Classification` to its wire shape (FR-014): both fields
 * are always present — `{ label, confidence }`.
 *
 * Validation fails loud (Constitution Principle I): a `label` outside the
 * three protocol literals, or a `confidence` that is not an integer within
 * 0–100, throws rather than emits invalid protocol data. These are
 * programming errors in detection code, not runtime conditions to absorb.
 *
 * @param classification The classification to serialize.
 * @returns A JSON-ready object with `label` and `confidence`.
 * @throws Error when `label` is not one of the three protocol literals, or
 * `confidence` is not an integer in 0–100.
 */
export function serializeClassification(
  classification: Classification,
): Record<string, unknown> {
  const { label, confidence } = classification;
  if (!CLASSIFICATION_LABELS.has(label)) {
    throw new Error(`Invalid classification label: ${label}`);
  }
  if (!Number.isInteger(confidence) || confidence < 0 || confidence > 100) {
    throw new Error(
      `Invalid classification confidence: ${confidence} (must be an integer in the range 0-100)`,
    );
  }
  return { label, confidence };
}

/**
 * Serializes an `Effect` to its wire shape (FR-013): required `type` and
 * `description` are always emitted; each optional field (`location`,
 * `target`, `detail`, `classification`) appears only when set — omitted,
 * never `null`, when absent or explicitly `undefined` (US2 scenario 3).
 * `classification` serializes recursively through
 * `serializeClassification`.
 *
 * Validation fails loud (Constitution Principle I). `type` is checked
 * through the same resolver detection code uses: a canonical name passes
 * through, an alias spelling that slipped past construction resolves to
 * its canonical target (aliases never reach the wire), and a string that
 * is neither canonical nor alias throws. `description` must be a string.
 *
 * @param effect The effect to serialize.
 * @returns A JSON-ready object with `type` and `description`, plus each
 * optional field that is set.
 * @throws Error when `type` is neither a canonical side-effect type nor an
 * alias, or `description` is not a string.
 */
export function serializeEffect(effect: Effect): Record<string, unknown> {
  const type = resolveSideEffectType(effect.type);
  if (type === undefined) {
    throw new Error(`Invalid side effect type: ${effect.type}`);
  }
  requireString(effect.description, "effect description");
  const serialized: Record<string, unknown> = {
    type,
    description: effect.description,
  };
  if (effect.location !== undefined) {
    serialized.location = effect.location;
  }
  if (effect.target !== undefined) {
    serialized.target = effect.target;
  }
  if (effect.detail !== undefined) {
    serialized.detail = effect.detail;
  }
  if (effect.classification !== undefined) {
    serialized.classification = serializeClassification(effect.classification);
  }
  return serialized;
}

/**
 * Serializes a `FunctionRecord` to its wire shape (FR-015): `name`,
 * `package`, `file`, and `line` are always emitted, and `side_effects` is
 * emitted as a JSON array of `serializeEffect` outputs under its
 * snake_case wire name.
 *
 * Validation fails loud (Constitution Principle I): `name`, `package`, and
 * `file` must be strings, and `line` must be a positive (1-based)
 * integer. Each effect in `side_effects` is validated by `serializeEffect`
 * as it is mapped.
 *
 * @param record The function record to serialize.
 * @returns A JSON-ready object with `name`, `package`, `file`, `line`, and
 * `side_effects`.
 * @throws Error when any of `name`/`package`/`file` is not a string, when
 * `line` is not a positive integer, or when any effect fails
 * `serializeEffect`'s validation.
 */
export function serializeFunctionRecord(
  record: FunctionRecord,
): Record<string, unknown> {
  requireString(record.name, "function record name");
  requireString(record.package, "function record package");
  requireString(record.file, "function record file");
  if (!Number.isInteger(record.line) || record.line < 1) {
    throw new Error(
      `Invalid function record line: ${record.line} (must be a positive integer)`,
    );
  }
  return {
    name: record.name,
    package: record.package,
    file: record.file,
    line: record.line,
    side_effects: record.side_effects.map((effect) => serializeEffect(effect)),
  };
}

/**
 * Derives the dotted package path from a root-relative POSIX source path
 * (FR-016; research R10): strip the final extension, join the remaining
 * segments with dots, then drop a trailing `.index` segment — an index
 * module represents its directory.
 *
 * Exact behavior (data-model.md table):
 *
 * | Input | Output |
 * |-------|--------|
 * | `pkg/mod.ts` | `pkg.mod` |
 * | `pkg/index.ts` | `pkg` |
 * | `src/deep/thing.ts` | `src.deep.thing` |
 * | `index.ts` | `index` |
 * | `a.b.ts` | `a.b` |
 *
 * A top-level `index.ts` derives to `"index"`: the join produces no dotted
 * `.index` suffix to strip, mirroring the reference analyzer's top-level
 * `__init__.py` handling (research R10).
 *
 * Path splitting uses `node:path`'s `posix` namespace deliberately: the
 * input is a wire-format POSIX-separator string (as discovery produces),
 * not a host-filesystem path, so parsing must not vary with the host
 * platform the way the `win32`-flavored default helpers would on Windows.
 *
 * @param relPath Root-relative POSIX path of a source file.
 * @returns The dotted module path, with a trailing `index` segment dropped.
 */
export function derivePackage(relPath: string): string {
  // parse() splits the basename into stem + final extension with correct
  // leading-dot handling (".gitignore" has no extension), and reports "."
  // as the directory of a top-level file.
  const { dir, name } = posix.parse(relPath);
  const segments = dir === "" || dir === "." ? [name] : [...dir.split("/"), name];
  const dotted = segments.join(".");
  // Drop one trailing ".index" segment; a bare top-level "index" has no
  // preceding dot, so it survives (the documented edge case).
  if (dotted.endsWith(".index")) {
    return dotted.slice(0, -".index".length);
  }
  return dotted;
}
