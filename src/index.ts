/**
 * Package entry point (T018; research R9) — the public Reading Stone
 * surface: `VERSION`, the canonical side-effect taxonomy, the shared
 * record models, and the analysis engine's public surface — the analyze,
 * complexity, and coverage method entries, the detector's effect
 * computations, the pattern helpers, and the pipeline's context and
 * record types — re-exported from their modules.
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
