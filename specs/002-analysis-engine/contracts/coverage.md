# Contract: `coverage` method (JSON-RPC)

**Feature Branch**: `002-analysis-engine`
**Protocol pin**: Gaze analyzer protocol v1.2.0
**Capability**: none — `coverage` is a core method, not gated by a
capability flag (FR-028)

The external interface is the `coverage` JSON-RPC method. Envelope,
error codes, and deterministic serialization are unchanged
(`openspec/specs/protocol/spec.md`).

---

## Request

```json
{"jsonrpc": "2.0", "id": 3, "method": "coverage",
 "params": {"root_path": "/abs/path/to/project", "patterns": ["src/..."]}}
```

The parameter surface is identical to `analyze`
([analyze.md](analyze.md)): `root_path` (string, required) and
`patterns` (string[], optional; same FR-001 prefix rules). The same
strict validation and error table apply (FR-027).

## Success response

```json
{"jsonrpc": "2.0", "id": 3, "result": {
  "functions": [
    {"file": "src/utils/math.ts", "function": "add", "start_line": 1,
     "end_line": 3, "covered_stmts": 2, "total_stmts": 2, "percentage": 100}
  ]
}}
```

| Field | Type | Rules |
|-------|------|-------|
| `file` | string | root-relative POSIX path (the coverage document's key, resolved under the analysis root) |
| `function` | string | fnMap name verbatim — including anonymous forms such as `(anonymous_0)` |
| `start_line` | number | fnMap declaration start line (1-based) |
| `end_line` | number | fnMap body end line |
| `covered_stmts` | number | integer ≥ 0 — attributed statements with execution count > 0 |
| `total_stmts` | number | integer ≥ 0 — all attributed statements |
| `percentage` | number | `(covered / total) * 100` at full floating-point precision; exactly `0.0` when `total_stmts` is 0 (never a division error) |

Entries carry exactly these seven fields, deterministically ordered by
`(file, start_line, function)` (FR-024). Repeated requests on the same
tree and artifact produce byte-identical serialized responses (SC-006).

## Artifact rules (FR-023, FR-025; Assumption 5)

**Source**: the Istanbul-format `coverage-final.json` at
`<root>/coverage/coverage-final.json` — the conventional output
location for both vitest's and jest's Istanbul JSON reporters. The
location is not configurable via params in v1; projects writing
coverage elsewhere report empty coverage (documented limitation).
Both emitters' documents are supported (US4 scenarios 1–2).

**Consumption, never production** (FR-025 — the constitution's required
conflict-resolution record): the analyzer never runs the analyzed
project's tests and never collects coverage itself. Reading-stone reads
the pre-existing artifact the project's own test run produced
(Constitution Principle V — analyzed code is never executed). When no
usable artifact exists, the result is empty, not an error:

| Condition | Result |
|-----------|--------|
| no `coverage/coverage-final.json` at the root | `{"functions": []}` |
| unreadable, unparseable, or structurally invalid document | `{"functions": []}` |
| empty document (`{}`) | `{"functions": []}` |

None of these is a JSON-RPC error. The artifact is read through the
bounded safe reader at the full 16 MiB cap (one stderr diagnostic line
on a read skip).

**Per-entry tolerance** (FR-026): within a parseable document, an
individual file entry that is non-conforming (missing or malformed
`statementMap`, `fnMap`, or `s`) is skipped deterministically while
conforming entries are reported — the document is never rejected
wholesale.

**Containment** (spec edge case): file keys that do not resolve under
the analysis root are skipped. `patterns` filters returned entries by
the same FR-001 prefix rules as `analyze`.

## Attribution rule (FR-023)

Per file entry: each statement in `statementMap` is attributed to the
**innermost** function in `fnMap` whose `loc` range contains the
statement's start position (compared as `(line, column)`; innermost =
smallest span; ties broken by fnMap key lexicographic order).
`covered_stmts` counts attributed statements whose execution count in
`s` is > 0; `total_stmts` counts all attributed statements; statements
inside a nested function's range count toward the innermost enclosing
function only (US4 scenario 7). See [data-model.md](../data-model.md)
for the parsed document model.

## Error responses

Identical to the `analyze` error table
([analyze.md](analyze.md#error-responses)): the shared `-32602`
surface for parameter and root validation (the root must still exist
and be a directory — the tree is not walked for coverage, but root
validation is unchanged), `-32601` for the remaining reserved methods,
`-32603` for analyzer-internal failures. All artifact-level conditions
degrade to empty results, never errors.
