# Contract: `analyze` method (JSON-RPC)

**Feature Branch**: `002-analysis-engine`
**Protocol pin**: Gaze analyzer protocol v1.2.0
**Capability**: none — `analyze` is a core method, not gated by a
capability flag (FR-028; the `initialize` response is unchanged)

The external interface this change exposes is the `analyze` JSON-RPC
method. Envelope, error codes, and deterministic serialization are
unchanged and remain governed by `openspec/specs/protocol/spec.md` and
the server spec. Wire shapes below are field-for-field normative.

---

## Request

```json
{"jsonrpc": "2.0", "id": 1, "method": "analyze",
 "params": {"root_path": "/abs/path/to/project", "patterns": ["src/..."]}}
```

| Param | Type | Required | Rules |
|-------|------|----------|-------|
| `root_path` | string | yes | absolute or relative; relative paths resolve against the analyzer process working directory; a symlinked root is realpath-resolved once at the boundary |
| `patterns` | string[] | no | path prefixes relative to `root_path` (see Pattern rules); absent, `null`, empty, or the exact forms `["./..."]`/`["..."]` mean the whole tree |

**Strict parameter surface** (FR-027): `params` must be a JSON object
(not an array, not `null`/absent) containing only `root_path` and
`patterns`; `root_path` must be a string; `patterns`, when present,
must be an array of strings. Any violation fails with `-32602`.

## Success response

```json
{"jsonrpc": "2.0", "id": 1, "result": {
  "functions": [
    {"name": "add", "package": "src.utils.math", "file": "src/utils/math.ts",
     "line": 1, "side_effects": [
       {"type": "ReturnValue", "description": "returns a value",
        "location": "src/utils/math.ts:2:3"}
     ]}
  ]
}}
```

`functions` is an array of `FunctionRecord` objects (spec 001 models;
see [data-model.md](../data-model.md)):

| Field | Type | Rules |
|-------|------|-------|
| `name` | string | extraction identity per FR-007/FR-008 (declared / variable / property name, `"constructor"`, `"default"`) |
| `package` | string | dotted module path from `derivePackage(file)` |
| `file` | string | root-relative POSIX path |
| `line` | number | 1-based declaration line |
| `side_effects` | Effect[] | serialized effects; `[]` for pure functions |

Each `Effect`: `type` (canonical taxonomy name — never an alias),
`description` (deterministic template), optional `location`
(`file:line:col`, root-relative), optional `target`, optional `detail`
(present only on ambiguity effects as `{"confidence": "ambiguous"}`).
The `classification` field is **never emitted** (FR-019; omitted ≠
`null` — the consumer's documented null-fallback applies identically).

**Ordering** (FR-020): records sorted by `(file, line, name)`; effects
within a record sorted by `(line, column, type)`. Both orders are total
(stable sort over source-order emission for same-line ties).

**Determinism** (Constitution I / SC-006): repeated analysis of the same
tree by the same analyzer version produces byte-identical serialized
responses — no timestamps, environment, host, or locale-dependent data.

## Error responses

All errors use the standard JSON-RPC codes with the request `id`
echoed (FR-027):

| Condition | Code | Message |
|-----------|------|---------|
| `params` absent, `null`, or an array | `-32602` | `Invalid params: params must be an object` |
| `root_path` missing or not a string | `-32602` | `Invalid params: root_path must be a string` |
| `patterns` present but not an array of strings | `-32602` | `Invalid params: patterns must be an array of strings` |
| `params` carries any key other than `root_path`/`patterns` | `-32602` | `Invalid params: params must contain only root_path and patterns` |
| `root_path` does not exist, is not a directory, or cannot be accessed | `-32602` | `Invalid params: root_path is not a directory: <path>` (shared message with `discover`; `<path>` is the cwd-resolved root) |
| Any other reserved method name | `-32601` | `Method not found: <method>` (echo truncated to 64 chars) |
| Analyzer-internal failure | `-32603` | error message; stack trace to stderr |

Analyzer-internal failures are bugs, not client errors; everything the
analyzed tree can cause (oversized, unreadable, non-regular,
undecodable, pathologically nested files) degrades per the skip rules
below and never surfaces as `-32603`.

## Scope rules (FR-001, FR-002)

**In-scope file set**: produced by the existing discovery walk and
exclusion chain (pruned directories `node_modules`/`dist`/`build`/
`coverage`/`.git`; `.d.ts` exclusion; generated-marker exclusion;
safe-read skips), then **test files are additionally excluded** — test
files and generated files are never analyzed. In-scope extensions:
`.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`, `.cjs` — JavaScript-family files
are never silently skipped (FR-006).

**Pattern rules**: each element is normalized by stripping one leading
`./` and one trailing `/...` into a directory prefix; a file is in
scope when its root-relative POSIX path equals a prefix or begins with
`prefix + "/"`; patterns union. A pattern set matching nothing yields
`{"functions": []}`, never an error. Edge cases: empty-string and `"."`
patterns match nothing; a lone `"..."` element inside a larger array
matches nothing (only the exact singleton forms `["./..."]`/`["..."]`
are catch-alls).

## Program bootstrap rules (FR-003–FR-006)

- A valid `tsconfig.json` at the resolved root bootstraps a `ts.Program`
  with `ts.TypeChecker` whose root file set is exactly the in-scope
  discovered files, with compiler options from the project's config
  (emit/incremental/composite state force-disabled; `allowJs`
  guaranteed; all compiler reads bounded by the 16 MiB safe-read cap
  with one stderr diagnostic per skip).
- No `tsconfig.json`, or an unparseable one → parse-only analysis
  (per-file `ts.createSourceFile`); the fallback is never an error and
  is invisible on the wire.
- Type errors in analyzed code never abort the request; semantic
  diagnostics are ignored and analysis proceeds on syntactic structure.
- Projects are analyzed as they exist — no annotation, restructuring,
  or analyzer-specific configuration is required.

## Function extraction rules (FR-007–FR-009)

Extracted: function declarations (with bodies); class methods,
constructors, and accessors; object-literal methods and
function-valued properties; arrow/function expressions assigned to
variables or class properties; default-export anonymous functions
(named `"default"`). Nested extracted function-likes are separate
records. Not extracted: body-less overload signatures (only the
implementation), `declare function`, abstract methods, interface method
signatures, and unassigned function expressions (IIFEs, inline
callbacks — their bodies scan into the innermost enclosing extracted
function). A getter/setter pair yields two records named by the
property. Module-level statements produce no records in v1; only
module-scope sentinel declarations attach (to the file's first function
record in source order).

## Detection rules (FR-010–FR-018)

The full construct→type mapping — all 48 taxonomy types with tier,
disposition, TypeScript mapping, and N/A rationale — is the normative
disposition table in [data-model.md](../data-model.md), rendered as
`docs/effect-disposition.md`. Contract-level guarantees:

- The six P0 types are detected with zero false negatives and zero
  false positives on the conformance fixtures (SC-001); pure functions
  carry empty `side_effects` (SC-002).
- `throw`, `Promise.reject(...)`, and async `throw` dual-emit
  `ErrorSignal` + `ErrorReturn`; `process.exit(...)` emits
  `ProcessExit` + `ErrorSignal` and never `ErrorReturn` (FR-012).
- Parameter writes follow the FR-015 split (dot → `PointerArgMutation`;
  element/array-method on array-typed → `SliceMutation` including
  `p.length = 0`; computed-key/`Map.set` → `MapMutation`; remaining
  membership methods → `ContainerMutation`; parse-only computed-key
  writes default to `MapMutation`).
- Unresolvable constructs (`eval`, `new Function`, computed-member
  calls, `any`-typed/unresolvable receivers) report ambiguity-marked
  `CallbackInvocation` effects — never silently omitted (FR-017).
- Every reported `type` is one of the 48 canonical names (aliases
  resolve before construction; FR-018).

## Skip conditions (never errors)

Files skipped by the bounded safe reader (oversized > 16 MiB,
non-regular, unreadable, undecodable, symlink, containment escape,
pathological AST depth) are excluded from results with exactly one
stderr diagnostic line each — the request completes normally. stdout
carries nothing but the JSON-RPC response.

## Reserved set after this change (FR-028)

`test_mapping`, `classify_signals`, `analyze/stream`, `doc_coverage`,
and `cognitive_complexity` continue to answer `-32601`. The `initialize`
capability response is unchanged: `discover: true`, the other five
flags `false`.
