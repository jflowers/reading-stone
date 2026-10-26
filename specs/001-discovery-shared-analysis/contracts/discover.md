# Contract: `discover` method (JSON-RPC)

**Feature Branch**: `001-discovery-shared-analysis`
**Protocol pin**: Gaze analyzer protocol v1.2.0
**Capability**: `discover`

The external interface this change exposes is the `discover` JSON-RPC
method plus one capability-flag change in the existing `initialize`
handshake. Envelope, error codes, and deterministic serialization are
unchanged and remain governed by `openspec/specs/protocol/spec.md`.

---

## Capability negotiation

The `initialize` result's `capabilities` object changes exactly one
flag:

```json
"capabilities": {
  "discover": true,
  "test_mapping": false,
  "classify_signals": false,
  "streaming": false,
  "doc_coverage": false,
  "cognitive_complexity": false
}
```

All other capability flags remain `false`. The reserved-but-
unimplemented methods (`analyze`, `complexity`, `coverage`,
`test_mapping`, `classify_signals`, `analyze/stream`, `doc_coverage`,
`cognitive_complexity`) continue to answer `-32601` method-not-found.
Only `discover` is added to the built-in dispatch table (alongside
`initialize` and `shutdown`).

## Request

```json
{"jsonrpc": "2.0", "id": 1, "method": "discover",
 "params": {"root_path": "/abs/path/to/project"}}
```

| Param | Type | Required | Rules |
|-------|------|----------|-------|
| `root_path` | string | yes | absolute or relative path; relative paths resolve against the analyzer process working directory; a symlinked root is realpath-resolved before walking |

**Strict parameter surface** (FR-009): `params` must be a JSON object
(not an array, not `null`/absent) containing exactly the `root_path`
key. Any extra key, a missing or non-string `root_path`, or non-object
`params` fails with `-32602`.

## Success response

```json
{"jsonrpc": "2.0", "id": 1, "result": {
  "source_files": ["src/a.ts", "src/b.tsx"],
  "test_files": ["src/a.test.ts"],
  "framework": "vitest"
}}
```

| Field | Type | Rules |
|-------|------|-------|
| `source_files` | string[] | sorted lexicographically (UTF-16 code-unit), root-relative POSIX-separator paths |
| `test_files` | string[] | sorted lexicographically; disjoint from `source_files` |
| `framework` | string | `"vitest"`, `"jest"`, or `"unknown"` — always present |

Determinism (FR-008 / SC-003): repeated discovery of the same tree by
the same analyzer version produces byte-identical serialized
responses (sorted keys via the existing serializer; no timestamps,
environment, or locale-dependent data).

## Error responses

All errors use the standard JSON-RPC codes with the request `id`
echoed.

| Condition | Code | Message |
|-----------|------|---------|
| `params` absent, `null`, or an array | `-32602` | `Invalid params: params must be an object` |
| `root_path` missing or not a string | `-32602` | `Invalid params: root_path must be a string` |
| `params` carries any key other than `root_path` | `-32602` | `Invalid params: params must contain only root_path` |
| `root_path` does not exist | `-32602` | `Invalid params: root_path is not a directory: <path>` |
| `root_path` is not a directory | `-32602` | `Invalid params: root_path is not a directory: <path>` |
| `root_path` cannot be accessed | `-32602` | `Invalid params: root_path is not a directory: <path>` |
| Any other reserved method name | `-32601` | `Method not found: <method>` (echo truncated to 64 chars) |

Skip conditions during analysis (oversized, non-regular, unreadable
files) are **never** errors: the request completes normally with the
affected files omitted and exactly one stderr diagnostic line per
skipped file. stdout carries nothing but the JSON-RPC response
(FR-017).

## File discovery rules

**Extensions considered** (FR-002): `.ts`, `.tsx`, `.js`, `.jsx`,
`.mjs`, `.cjs`. JavaScript-family sources are never silently skipped.

**Pruned directories** (FR-003): `node_modules`, `dist`, `build`,
`coverage`, `.git` — exactly these five; never descended into. All
other directories (including dot-directories such as `.github`) are
walked.

**Excluded from both lists** (documented policies, silent — no
diagnostic):

- `.d.ts` declaration files (trailing `.d.ts` extension; FR-004).
- Files whose leading comment block carries a case-sensitive
  `@generated` or `Code generated` marker, detected within a bounded
  64 KiB prefix read (FR-007).

**Test classification** (FR-005): a file is a test file when either

- its basename contains a dot-delimited segment equal to `test` or
  `spec` that is neither the first nor the last segment (the precise
  semantics of `*.test.*` / `*.spec.*` for files with a walked
  extension), or
- any directory component of its path is exactly `__tests__`,
  `tests`, or `test`.

Any test signal classifies the file into `test_files` (test wins over
source); the two lists are disjoint.

**Precedence chain**: safety skip (omit + one stderr diagnostic) →
`.d.ts` exclusion → generated-marker exclusion → test classification
→ source. A test-named file with a generated marker appears in
neither list; a `.d.ts` file is excluded regardless of name or
markers.

**Symlinks** (FR-018): never followed during tree walking — symlinked
directories are not descended, symlinked files are not read. A
symlinked `root_path` is resolved once before walking; containment is
enforced against the resolved root, and any candidate path that would
escape it is rejected unread.

**Safety skips** (FR-017, one stderr line each, request never aborts):
files larger than 16 MiB, non-regular files (FIFO, device, socket),
and unreadable files (permission denied).

## Framework detection rules (FR-006)

Detection is configuration presence at the resolved project root only,
independent of file contents and environment:

1. `vitest` when any of `vitest.config.ts`, `vitest.config.js`,
   `vitest.config.mts`, `vitest.config.mjs` exists at the root.
2. Otherwise `jest` when any of `jest.config.ts`, `jest.config.js`,
   `jest.config.mjs`, `jest.config.cjs`, `jest.config.json` exists at
   the root, or the root `package.json` contains a `jest` key.
3. Otherwise `unknown`.

When both vitest and jest configurations are present, `vitest` wins.
An unreadable or malformed `package.json` writes one stderr diagnostic
and is treated as having no `jest` key. Framework strings are
lowercase `"vitest"` and `"jest"`.

## Empty tree

A tree with no matching files yields both lists empty and `framework`
still reported per configuration presence.

## Shared analysis models (defined, not yet on the wire)

This change also defines the side-effect taxonomy (48 types, tiers,
11 aliases), the `Effect` / `Classification` / `FunctionRecord`
models, and package derivation — see [data-model.md](../data-model.md).
No protocol method consumes them yet; they are exported package API
surface consumed by the `analyze` method in a later change.
