/**
 * Package entry point (T018, T033; research R9) — the public Reading Stone
 * surface: `VERSION`, the canonical side-effect taxonomy, the shared
 * record models, and the analysis engine's public surface — the analyze,
 * complexity, and coverage method entries, the detector's effect
 * computations, the pattern helpers, and the pipeline's context and
 * record types — re-exported from their modules.
 *
 * The classification signal pipeline (T033) rides the same barrel: the
 * `classify_signals` entry with the fan-out core it shares with `analyze`,
 * the `Signal` wire record and its serializer, the `RecordEvidence`
 * evidence-snapshot type, the five extractor rules, and the normative
 * routing table with its closed vocabulary lists.
 *
 * An explicit, exhaustive barrel (convention pack AP-001) makes the
 * vocabulary consumable package API instead of orphaned code (Zero-Waste
 * Mandate): later analysis methods and downstream consumers import from
 * the package root rather than reaching into module internals. Type-only
 * names use `export type` clauses so the split between runtime values and
 * compile-time types stays explicit.
 */

export const VERSION = "0.1.0";

export type {
  PatternSet,
  PreparedAnalysis,
} from "./analysis.js";
export {
  analyze,
  normalizePatterns,
  pathInScope,
} from "./analysis.js";
export { computeComplexity } from "./complexity.js";
export { parseCoverage } from "./coverage.js";
export {
  assembleFunctionRecords,
  detectEffects,
} from "./detector.js";
export type { ExtractionRecord } from "./extract.js";
export type {
  Classification,
  Effect,
  FunctionRecord,
} from "./models.js";
export {
  derivePackage,
  serializeClassification,
  serializeEffect,
  serializeFunctionRecord,
} from "./models.js";
export type { ProgramContext } from "./program.js";
export {
  classifyPairs,
  classifySignals,
} from "./signals/adapter.js";
export { callerSignal } from "./signals/caller.js";
export type { RecordEvidence } from "./signals/evidence.js";
export { interfaceSignal } from "./signals/interface.js";
export { docstringSignal } from "./signals/jsdoc.js";
export { namingSignal } from "./signals/naming.js";
export {
  CONTRACTUAL_PREFIXES,
  DIRECT_TAGS,
  INCIDENTAL_PREFIXES,
  INCIDENTAL_VERBS,
  INDIRECT_VERBS,
  ROUTING_TABLE,
} from "./signals/routing.js";
export type { Signal } from "./signals/types.js";
export { serializeSignal } from "./signals/types.js";
export { visibilitySignal } from "./signals/visibility.js";
export type {
  SideEffectAlias,
  SideEffectType,
  Tier,
} from "./taxonomy.js";
export {
  ALIAS_MAP,
  resolveSideEffectType,
  SIDE_EFFECT_TYPES,
  TIER_MAP,
} from "./taxonomy.js";
