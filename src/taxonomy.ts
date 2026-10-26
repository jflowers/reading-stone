/**
 * The canonical side-effect taxonomy (FR-011, FR-012; research R1) — the
 * protocol v1.2.0 vocabulary every reported effect must use.
 *
 * Constitution Principle I (Protocol Fidelity) requires response data to
 * use Gaze's universal side effect taxonomy; inventing local type names
 * that diverge from it is prohibited. This module is that vocabulary for
 * Reading Stone: the 48 canonical `SideEffectType` names with fixed tier
 * membership (P0=6, P1=11, P2=16, P3=9, P4=6), the `Tier` scale, and the
 * 11 language-neutral aliases (FR-012) — all transcribed verbatim, exact
 * casing and spelling, from the feature's authoritative data model
 * (specs/001-discovery-shared-analysis/data-model.md).
 *
 * Tier membership is fixed data, deliberately NOT configurable (FR-011):
 * an analyzer must never widen, narrow, or re-tier the platform's
 * taxonomy on its own authority.
 *
 * Compile-time exhaustiveness is the module's core safety mechanism
 * (research R1): `TIER_MAP` and `ALIAS_MAP` are `Record`s keyed by the
 * full literal unions, so the compiler rejects a missing key, an extra
 * key, or an out-of-union value — a taxonomy edit that drops, adds, or
 * misspells a member cannot build.
 */

/**
 * The priority level of a side-effect type: P0 fixes the detection
 * requirement level (P0 effects must be detected with zero false
 * negatives), P4 is the loosest. Fixed by protocol v1.2.0; see `TIER_MAP`
 * for each type's assignment.
 */
export type Tier = "P0" | "P1" | "P2" | "P3" | "P4";

/**
 * One of exactly 48 canonical side-effect type names — the only
 * vocabulary a reported effect may use (Constitution Principle I).
 * Members are listed tier by tier, P0 through P4, in data-model.md table
 * order; each member's tier assignment lives in `TIER_MAP`.
 */
export type SideEffectType =
  // P0
  | "ReturnValue"
  | "ErrorReturn"
  | "SentinelError"
  | "ReceiverMutation"
  | "PointerArgMutation"
  | "ErrorSignal"
  // P1
  | "SliceMutation"
  | "MapMutation"
  | "GlobalMutation"
  | "WriterOutput"
  | "HTTPResponseWrite"
  | "ChannelSend"
  | "ChannelClose"
  | "DeferredReturnMutation"
  | "GeneratorYield"
  | "ContainerMutation"
  | "StreamOutput"
  // P2
  | "FileSystemWrite"
  | "FileSystemDelete"
  | "FileSystemMeta"
  | "DatabaseWrite"
  | "DatabaseTransaction"
  | "GoroutineSpawn"
  | "Panic"
  | "CallbackInvocation"
  | "LogWrite"
  | "ContextCancellation"
  | "AsyncGeneratorYield"
  | "MetaprogrammingMutation"
  | "DescriptorEffect"
  | "ResourceManagement"
  | "ImportSideEffect"
  | "MonkeyPatch"
  // P3
  | "StdoutWrite"
  | "StderrWrite"
  | "EnvVarMutation"
  | "MutexOp"
  | "WaitGroupOp"
  | "AtomicOp"
  | "TimeDependency"
  | "ProcessExit"
  | "RecoverBehavior"
  // P4
  | "ReflectionMutation"
  | "UnsafeMutation"
  | "CgoCall"
  | "FinalizerRegistration"
  | "SyncPoolOp"
  | "ClosureCaptureMutation";

/**
 * Tier membership for every canonical type (FR-011) — fixed, NOT
 * configurable. Keyed by the full `SideEffectType` union, so the compiler
 * rejects any missing or extra entry (compile-time exhaustiveness); the
 * value type is `Tier`, so a misspelled tier is rejected too. Entries are
 * grouped P0→P4 in data-model.md table order: P0=6, P1=11, P2=16, P3=9,
 * P4=6 — 48 in total.
 */
export const TIER_MAP: Readonly<Record<SideEffectType, Tier>> = {
  // P0
  ReturnValue: "P0",
  ErrorReturn: "P0",
  SentinelError: "P0",
  ReceiverMutation: "P0",
  PointerArgMutation: "P0",
  ErrorSignal: "P0",
  // P1
  SliceMutation: "P1",
  MapMutation: "P1",
  GlobalMutation: "P1",
  WriterOutput: "P1",
  HTTPResponseWrite: "P1",
  ChannelSend: "P1",
  ChannelClose: "P1",
  DeferredReturnMutation: "P1",
  GeneratorYield: "P1",
  ContainerMutation: "P1",
  StreamOutput: "P1",
  // P2
  FileSystemWrite: "P2",
  FileSystemDelete: "P2",
  FileSystemMeta: "P2",
  DatabaseWrite: "P2",
  DatabaseTransaction: "P2",
  GoroutineSpawn: "P2",
  Panic: "P2",
  CallbackInvocation: "P2",
  LogWrite: "P2",
  ContextCancellation: "P2",
  AsyncGeneratorYield: "P2",
  MetaprogrammingMutation: "P2",
  DescriptorEffect: "P2",
  ResourceManagement: "P2",
  ImportSideEffect: "P2",
  MonkeyPatch: "P2",
  // P3
  StdoutWrite: "P3",
  StderrWrite: "P3",
  EnvVarMutation: "P3",
  MutexOp: "P3",
  WaitGroupOp: "P3",
  AtomicOp: "P3",
  TimeDependency: "P3",
  ProcessExit: "P3",
  RecoverBehavior: "P3",
  // P4
  ReflectionMutation: "P4",
  UnsafeMutation: "P4",
  CgoCall: "P4",
  FinalizerRegistration: "P4",
  SyncPoolOp: "P4",
  ClosureCaptureMutation: "P4",
};

/**
 * All 48 canonical type names, grouped by tier P0→P4 and in
 * data-model.md table order within each tier. The literal's element type
 * is `SideEffectType`, so only union members may appear — misspellings
 * are rejected at compile time. The sibling conformance suite
 * (tests/taxonomy.test.ts, T014) asserts the 48-member count and tier
 * sizes against data-model.md.
 */
export const SIDE_EFFECT_TYPES: readonly SideEffectType[] = [
  // P0
  "ReturnValue",
  "ErrorReturn",
  "SentinelError",
  "ReceiverMutation",
  "PointerArgMutation",
  "ErrorSignal",
  // P1
  "SliceMutation",
  "MapMutation",
  "GlobalMutation",
  "WriterOutput",
  "HTTPResponseWrite",
  "ChannelSend",
  "ChannelClose",
  "DeferredReturnMutation",
  "GeneratorYield",
  "ContainerMutation",
  "StreamOutput",
  // P2
  "FileSystemWrite",
  "FileSystemDelete",
  "FileSystemMeta",
  "DatabaseWrite",
  "DatabaseTransaction",
  "GoroutineSpawn",
  "Panic",
  "CallbackInvocation",
  "LogWrite",
  "ContextCancellation",
  "AsyncGeneratorYield",
  "MetaprogrammingMutation",
  "DescriptorEffect",
  "ResourceManagement",
  "ImportSideEffect",
  "MonkeyPatch",
  // P3
  "StdoutWrite",
  "StderrWrite",
  "EnvVarMutation",
  "MutexOp",
  "WaitGroupOp",
  "AtomicOp",
  "TimeDependency",
  "ProcessExit",
  "RecoverBehavior",
  // P4
  "ReflectionMutation",
  "UnsafeMutation",
  "CgoCall",
  "FinalizerRegistration",
  "SyncPoolOp",
  "ClosureCaptureMutation",
];

/**
 * One of exactly 11 language-neutral aliases (FR-012): alternate
 * spellings detection code may match in source, each resolving to exactly
 * one canonical `SideEffectType` via `ALIAS_MAP`. Aliases are never
 * emitted — detection code resolves them to canonical names through
 * `resolveSideEffectType` before constructing records.
 */
export type SideEffectAlias =
  | "AsyncTaskSpawn"
  | "AsyncMessageSend"
  | "AsyncChannelClose"
  | "BarrierOp"
  | "PanicRecovery"
  | "FFICall"
  | "ObjectPoolOp"
  | "DeferredMutation"
  | "ArgumentMutation"
  | "ProcessTermination"
  | "SentinelErrorDecl";

/**
 * Alias resolution (FR-012): each of the 11 aliases maps to exactly one
 * canonical `SideEffectType`. Keyed by the full `SideEffectAlias` union
 * (compile-time exhaustiveness) with canonical-only values. Transcribed
 * verbatim from the data-model.md alias table.
 */
export const ALIAS_MAP: Readonly<Record<SideEffectAlias, SideEffectType>> = {
  AsyncTaskSpawn: "GoroutineSpawn",
  AsyncMessageSend: "ChannelSend",
  AsyncChannelClose: "ChannelClose",
  BarrierOp: "WaitGroupOp",
  PanicRecovery: "RecoverBehavior",
  FFICall: "CgoCall",
  ObjectPoolOp: "SyncPoolOp",
  DeferredMutation: "DeferredReturnMutation",
  ArgumentMutation: "PointerArgMutation",
  ProcessTermination: "Panic",
  SentinelErrorDecl: "SentinelError",
};

/**
 * Canonical-name membership set derived from `SIDE_EFFECT_TYPES` — an O(1),
 * prototype-safe backing store for the type guard below. Deliberately NOT
 * the `in` operator: `in` consults the prototype chain, so
 * `"toString" in TIER_MAP` is `true` and would misresolve
 * `Object.prototype` property names as canonical types.
 */
const CANONICAL_NAMES: ReadonlySet<string> = new Set(SIDE_EFFECT_TYPES);

/**
 * Type guard: reports whether `name` is one of the 48 canonical
 * `SideEffectType` names. Sound because `CANONICAL_NAMES` holds exactly
 * the members of `SIDE_EFFECT_TYPES`, whose elements the compiler has
 * already verified against the `SideEffectType` union.
 */
function isSideEffectType(name: string): name is SideEffectType {
  return CANONICAL_NAMES.has(name);
}

/**
 * Alias-name → canonical-type lookup derived from `ALIAS_MAP`, so the
 * resolver reads as one total function over arbitrary strings. Like the
 * set above, `Map` lookups are own-data only — no prototype chain is
 * consulted — keeping resolution exact for inputs like `"toString"`.
 */
const ALIAS_TARGETS: ReadonlyMap<string, SideEffectType> = new Map(
  Object.entries<SideEffectType>(ALIAS_MAP),
);

/**
 * Resolves a side-effect name to its canonical `SideEffectType`
 * (FR-012 resolution rule): a canonical name maps to itself, an alias
 * maps to its canonical target, and any other string maps to
 * `undefined`.
 *
 * Detection code constructs canonical-typed records through this
 * resolver regardless of which spelling it matched, so aliases never
 * leak into reported effects. Matching is exact and case-sensitive —
 * protocol names carry exact casing, and a near-miss string must resolve
 * to `undefined`, not to a guessed canonical type (silent misresolution
 * would violate Constitution Principle I).
 *
 * @param name The side-effect name to resolve: a canonical name, an
 * alias, or any other string.
 * @returns The canonical `SideEffectType` for canonical names and
 * aliases; `undefined` for anything else.
 */
export function resolveSideEffectType(name: string): SideEffectType | undefined {
  if (isSideEffectType(name)) {
    return name;
  }
  return ALIAS_TARGETS.get(name);
}
