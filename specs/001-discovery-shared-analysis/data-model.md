# Data Model: Discovery and Shared Analysis Infrastructure

**Feature Branch**: `001-discovery-shared-analysis`
**Date**: 2026-10-26

Entities extracted from the feature spec. Wire-format field names are
snake_case (protocol payload shape); TypeScript identifiers are camelCase
per convention pack CS-006. All taxonomy data below is transcribed from
Gaze protocol v1.2.0 and is normative.

---

## SideEffectType

One of exactly **48** canonical side-effect type names — the only
vocabulary a reported effect may use (Constitution Principle I).

- **Representation**: string-literal union
  (`"ReturnValue" | "ErrorReturn" | …`), exported as
  `type SideEffectType` from `src/taxonomy.ts`, plus a
  `SIDE_EFFECT_TYPES: readonly SideEffectType[]` enumeration constant.
- **Validation**: exactly 48 members; no duplicates (compiler-enforced
  by the union + tier map); tier membership fixed, NOT configurable
  (FR-011).

### Tier membership (authoritative)

| Tier | Count | Types |
|------|-------|-------|
| P0 | 6 | `ReturnValue`, `ErrorReturn`, `SentinelError`, `ReceiverMutation`, `PointerArgMutation`, `ErrorSignal` |
| P1 | 11 | `SliceMutation`, `MapMutation`, `GlobalMutation`, `WriterOutput`, `HTTPResponseWrite`, `ChannelSend`, `ChannelClose`, `DeferredReturnMutation`, `GeneratorYield`, `ContainerMutation`, `StreamOutput` |
| P2 | 16 | `FileSystemWrite`, `FileSystemDelete`, `FileSystemMeta`, `DatabaseWrite`, `DatabaseTransaction`, `GoroutineSpawn`, `Panic`, `CallbackInvocation`, `LogWrite`, `ContextCancellation`, `AsyncGeneratorYield`, `MetaprogrammingMutation`, `DescriptorEffect`, `ResourceManagement`, `ImportSideEffect`, `MonkeyPatch` |
| P3 | 9 | `StdoutWrite`, `StderrWrite`, `EnvVarMutation`, `MutexOp`, `WaitGroupOp`, `AtomicOp`, `TimeDependency`, `ProcessExit`, `RecoverBehavior` |
| P4 | 6 | `ReflectionMutation`, `UnsafeMutation`, `CgoCall`, `FinalizerRegistration`, `SyncPoolOp`, `ClosureCaptureMutation` |

## Tier

The priority level of a side-effect type: `"P0" | "P1" | "P2" | "P3" |
"P4"`. Fixes the detection requirement level (P0 = zero false
negatives). Exposed via `TIER_MAP: Readonly<Record<SideEffectType,
Tier>>` — the `Record` keyed by the 48-member union makes the compiler
reject any missing or extra assignment.

## SideEffectAlias

One of exactly **11** language-neutral aliases, each resolving to
exactly one canonical `SideEffectType` (FR-012). Representation:
literal union + `ALIAS_MAP: Readonly<Record<SideEffectAlias,
SideEffectType>>` in `src/taxonomy.ts`.

| Alias | Resolves To |
|-------|-------------|
| `AsyncTaskSpawn` | `GoroutineSpawn` |
| `AsyncMessageSend` | `ChannelSend` |
| `AsyncChannelClose` | `ChannelClose` |
| `BarrierOp` | `WaitGroupOp` |
| `PanicRecovery` | `RecoverBehavior` |
| `FFICall` | `CgoCall` |
| `ObjectPoolOp` | `SyncPoolOp` |
| `DeferredMutation` | `DeferredReturnMutation` |
| `ArgumentMutation` | `PointerArgMutation` |
| `ProcessTermination` | `Panic` |
| `SentinelErrorDecl` | `SentinelError` |

**Resolution rule** (`resolveSideEffectType(name: string):
SideEffectType | undefined`): an alias maps to its canonical type; a
canonical name maps to itself; anything else maps to `undefined`.
Detection code (issue #3) constructs canonical-typed records through
this resolver regardless of which spelling it matched.

## Classification

A contractual / incidental / ambiguous label with a confidence score,
attached to an effect (FR-014).

| Field | Type | Required | Validation |
|-------|------|----------|------------|
| `label` | `"contractual" \| "incidental" \| "ambiguous"` | yes | must be one of the three literals |
| `confidence` | `number` | yes | integer, 0 ≤ confidence ≤ 100 |

Serialization: both fields always present when the classification is
attached. Out-of-range confidence is a programming error — the
serializer fails loud (throws) rather than emit invalid protocol data
(Constitution Principle I).

## Effect

A single observable side effect attributed to a function (FR-013).

| Field | Type | Required | Serialization |
|-------|------|----------|---------------|
| `type` | `SideEffectType` | yes | always emitted |
| `description` | `string` | yes | always emitted |
| `location` | `string` | no | omitted when unset |
| `target` | `string` | no | omitted when unset |
| `detail` | `Record<string, unknown>` | no | omitted when unset |
| `classification` | `Classification` | no | omitted when unset |

- `location` is a `"file:line:col"` string relative to the analysis
  root; `target` names the attribute/parameter/exception involved;
  `detail` is opaque metadata passed through to Gaze without
  interpretation.
- Serialization rule: optional fields are **omitted** (not `null`)
  when unset — the protocol forbids emitting `null` for omitted
  fields (US2 scenario 3).

## FunctionRecord

A function observed in the analyzed project (FR-015).

| Field | Type | Required | Serialization |
|-------|------|----------|---------------|
| `name` | `string` | yes | always emitted |
| `package` | `string` | yes | always emitted |
| `file` | `string` | yes | always emitted |
| `line` | `number` | yes | always emitted (1-based declaration line) |
| `side_effects` | `readonly Effect[]` | yes | emitted as a JSON array (effects serialized per above) |

`file` is the path relative to `root_path` with POSIX separators;
`package` is derived per **Package derivation** below. Serialized via
`serializeFunctionRecord` in `src/models.ts` with the same
omit-unset-optionals rule.

## Package derivation (derived value)

`derivePackage(relPath: string): string` in `src/models.ts` (FR-016):

1. Strip the final extension: `pkg/mod.ts` → `pkg/mod`.
2. Join segments with dots: `pkg/mod` → `pkg.mod`.
3. Drop a trailing `.index` segment: `pkg/index` → `pkg`.
4. A top-level `index.ts` derives to `"index"` (no dotted `.index`
   suffix exists to strip — mirrors the reference analyzer's top-level
   `__init__.py` handling).

| Input | Output |
|-------|--------|
| `pkg/mod.ts` | `pkg.mod` |
| `pkg/index.ts` | `pkg` |
| `src/deep/thing.ts` | `src.deep.thing` |
| `index.ts` | `index` |
| `a.b.ts` | `a.b` |

## DiscoveryResult

The `discover` response payload (FR-001) — see
[contracts/discover.md](contracts/discover.md) for the full wire
contract.

| Field | Type | Required | Validation |
|-------|------|----------|------------|
| `source_files` | `readonly string[]` | yes | sorted lexicographically (UTF-16 code-unit); root-relative POSIX paths; disjoint from `test_files` |
| `test_files` | `readonly string[]` | yes | sorted lexicographically; disjoint from `source_files` |
| `framework` | `"vitest" \| "jest" \| "unknown"` | yes | always present; `"unknown"` when undetected |

## Internal support types (not protocol-visible)

- **`InvalidRootPathError`** (`src/discovery.ts`): thrown by
  `discover()` when `root_path` does not exist, is not a directory, or
  cannot be accessed. The server handler maps it to
  `RpcError(INVALID_PARAMS, -32602)`.
- **Safe-read outcome** (`src/safeio.ts`): `readBounded` returns the
  read content or `null` after emitting exactly one stderr diagnostic
  line; it never throws for skip conditions and never aborts the
  enclosing request.

## Entity relationships

```text
FunctionRecord 1 ── * Effect          (side_effects array)
Effect          0..1 ── 1 Classification (optional field)
SideEffectType  1 ── 1 Tier            (TIER_MAP, fixed)
SideEffectAlias 11 ── 11 SideEffectType (ALIAS_MAP, fixed)
DiscoveryResult    (standalone; produced by discover())
```

No state transitions: all entities are immutable value records
(frozen at construction by convention — `readonly` fields per AP-004).

## Validation rules from requirements (traceability)

- FR-011 → SideEffectType count/tier table above (conformance test
  asserts 48 / 6-11-16-9-6).
- FR-012 → ALIAS_MAP (conformance test asserts 11 resolutions).
- FR-013/FR-014/FR-015 → Effect, Classification, FunctionRecord
  field tables and omit-unset serialization.
- FR-016 → Package derivation table.
- FR-001–FR-010 → DiscoveryResult and the discover contract.
