# Contract: `complexity` method (JSON-RPC)

**Feature Branch**: `002-analysis-engine`
**Protocol pin**: Gaze analyzer protocol v1.2.0
**Capability**: none — `complexity` is a core method, not gated by a
capability flag (FR-028)

The external interface is the `complexity` JSON-RPC method. Envelope,
error codes, and deterministic serialization are unchanged
(`openspec/specs/protocol/spec.md`).

---

## Request

```json
{"jsonrpc": "2.0", "id": 2, "method": "complexity",
 "params": {"root_path": "/abs/path/to/project"}}
```

The parameter surface is identical to `analyze`
([analyze.md](analyze.md)): `root_path` (string, required) and
`patterns` (string[], optional; same prefix rules). The same strict
validation and error table apply (FR-027) — non-object `params`,
missing/non-string `root_path`, non-string-array `patterns`, extra
keys, and invalid roots all fail with `-32602`; the root-failure
message is shared with `discover`.

## Success response

```json
{"jsonrpc": "2.0", "id": 2, "result": {
  "functions": [
    {"name": "grade", "package": "src.score", "file": "src/score.ts",
     "line": 4, "complexity": 3}
  ]
}}
```

| Field | Type | Rules |
|-------|------|-------|
| `name` | string | extraction identity — identical to the `analyze` record for the same function |
| `package` | string | `derivePackage(file)` |
| `file` | string | root-relative POSIX path |
| `line` | number | 1-based declaration line |
| `complexity` | number | integer ≥ 1 |

Entries carry exactly these five fields. The extraction set, scope
(FR-002 — test and generated files excluded), pattern filtering
(FR-001), and ordering (sorted by `(file, line, name)`) are identical
to `analyze` over the same request — both methods share one extraction
pipeline (FR-022). Repeated requests on the same tree produce
byte-identical serialized responses (SC-006).

## Computation rule (FR-021)

Cyclomatic complexity = **1 + the number of decision points in the
function's own body**, where decision points are exactly:

- `if` statements (each `else if` is a nested `if` and counts),
- `for`, `for-of`, `for-in`, `while`, `do` statements,
- each `case` clause (`default` excluded),
- `catch` clauses,
- conditional (ternary) expressions,
- the binary logical operators `&&`, `||`, `??`.

The list is closed: logical-assignment operators (`&&=`, `||=`, `??=`)
are **not** counted (documented exclusion, Assumption 10). An empty
body scores 1. Decision points inside a nested extracted function count
toward that function's entry only, never the enclosing function's
(US3 scenario 3); bodies of anonymous function expressions (not in the
extraction set) count toward the innermost enclosing extracted function
(FR-009 attribution).

## Error responses

Identical to the `analyze` error table
([analyze.md](analyze.md#error-responses)): the shared `-32602`
surface for parameter and root validation, `-32601` for the remaining
reserved methods, `-32603` for analyzer-internal failures. Skip
conditions (oversized/unreadable/non-regular/pathologically nested
files) are never errors — the affected files simply contribute no
entries, with one stderr diagnostic line per skip.
