# Contract: test_mapping

**Feature Branch**: `004-test-mapping`

**Date**: 2026-10-29

**Status**: Normative wire contract. The server handler, the pipeline
entry, and the conformance suite implement and pin this contract
exactly; deviations are bugs (Constitution Principle I).

Sources: [spec.md](spec.md) FR-001, FR-013, FR-014; spec 002 FR-027
(the shared analysis-params error table — transcribed verbatim);
[data-model.md](data-model.md) Sections 2–4 and 8; the dispatch
precedent of `classify_signals` (spec 003
[contracts/classify-signals.md](../../003-classify-signals/contracts/classify-signals.md)).

---

## 1. Method summary

`test_mapping` maps each collected vitest/jest test function to the
production functions it exercises, emitting one mapping row per
assertion in each paired test — the evidence GazeCRAP and contract
coverage compute from for TypeScript projects. The method is
capability-gated (`capabilities.test_mapping`), accepts the shared
analysis-params surface, and returns `{"mappings": [...]}`.

The handler body (mirroring `classify_signals`'s registration — the
envelope boundary differs: `testMapping` returns the complete one-key
`TestMappingResult` itself, so the handler passes it through):

```typescript
dispatch.set("test_mapping", async (params) => {
  const { rootPath, patterns } = validateAnalysisParams(params);
  try {
    const result: TestMappingResult = await testMapping(
      rootPath,
      patterns,
      this.stderr,
    );
    return result;
  } catch (error) {
    throw mapRootPathError(error) ?? error;
  }
});
```

Skip diagnostics flow to the server's stderr — never stdout, which is
reserved for JSON-RPC responses. The entry's result is already the
serialized, wire-shaped `TestMappingResult` — `testMapping` assembles
the `{"mappings": [...]}` envelope and serializes its rows itself, and
the handler adds no wrapper (where `classifySignals` returns the bare
array and its handler wraps) — so the sorted-key envelope serializer
only re-orders keys — repeated requests stay byte-identical.

## 2. Request

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "test_mapping",
  "params": {
    "root_path": "/abs/or/relative/project/root",
    "patterns": ["src", "lib/..."]
  }
}
```

| Field | Type | Constraint |
|---|---|---|
| `root_path` | `string` | Required. Absolute or relative (resolved against the analyzer process working directory); symlinked roots are realpath-resolved once at the boundary |
| `patterns` | `string[] \| null` | Optional. Directory-prefix scoping of the TARGET (source) arm exactly as `analyze` applies it — `null`, absent, `[]`, and the singleton catch-alls `["./..."]` / `["..."]` mean the whole tree; the TEST arm is never narrowed by patterns |

`params` carries exactly the keys `root_path` and `patterns` — no
others (the shared analysis-params surface, spec 002 FR-027).

## 3. Success response

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "mappings": [
      {
        "test_function": "add",
        "test_file": "tests/math.test.ts",
        "assertion_location": "tests/math.test.ts:5",
        "assertion_type": "equality",
        "target_function": "add",
        "target_package": "src.math",
        "side_effect_type": "ReturnValue",
        "confidence": 90
      }
    ]
  }
}
```

The result object carries exactly one key, `mappings`. Each row
carries exactly the eight keys above (field constraints:
[data-model.md](data-model.md) Section 2). Empty inputs — no test
files, no production targets, a pattern set matching nothing, or no
pairs — yield `{"mappings": []}`, never an error.

### 3.1 Ordering and determinism

Rows are ordered by the stable key `(test_file, test_function,
target_package, target_function, assertion line, assertion character)`
— UTF-16 code-unit comparison (JavaScript's default `<`) for string
keys, numeric for line/character.
Serialization of the same tree with the same analyzer version and
protocol version is byte-identical across repeated requests (no
timestamps, random values, or environment-dependent data). Two
requests over the same tree — including two full pipeline runs —
produce identical response bytes.

## 4. Error responses

The shared analysis-params error table (spec 002 FR-027) — the same
validation order, codes, and message strings as
`analyze`/`complexity`/`coverage`/`classify_signals`:

| Condition | Code | Message |
|---|---|---|
| `params` absent, `null`, or an array | `-32602` | `Invalid params: params must be an object` |
| `root_path` missing or not a string | `-32602` | `Invalid params: root_path must be a string` |
| `patterns` present, non-null, not an array, or an array with a non-string element | `-32602` | `Invalid params: patterns must be an array of strings` |
| Any params key other than `root_path` / `patterns` | `-32602` | `Invalid params: params must contain only root_path and patterns` |
| Root does not exist, is not a directory, or cannot be accessed | `-32602` | `Invalid params: root_path is not a directory: <rootPath>` (the echoed cwd-resolved spelling) |
| Analyzer-internal failure | `-32603` | The error's message, with the stack trace on stderr |

Validation order is pinned: params-object shape, then `root_path`,
then `patterns`, then unknown keys — the first failing row answers.

## 5. Capability and dispatch gating

`test_mapping` is registered as a built-in dispatch handler and
advertised in the same change:

- `initialize` reports `capabilities.test_mapping: true`; the other
  five flags are unchanged (`discover` and `classify_signals` `true`;
  `streaming`, `doc_coverage`, `cognitive_complexity` `false`).
- The reserved `-32601` set shrinks to exactly `analyze/stream`,
  `doc_coverage`, `cognitive_complexity`.
- No commit advertises the capability without the dispatch handler
  (registration and flag flip are inseparable).

## 6. Row semantics (summary)

| Field | Semantics |
|---|---|
| `test_function` | Describe-qualified title: enclosing `describe` titles joined `" > "`, then the test title; bare title at top level; `""` for non-static titles |
| `test_file` | Root-relative POSIX path of the test file |
| `assertion_location` | `"<relPath>:<line>"` of the assertion's anchor — the outermost wrapper of the matcher/assert invocation (`await` and parenthesized wrappers unwrapped upward) — no column |
| `assertion_type` | `equality` \| `comparison` \| `membership` \| `error_check` \| `""` per the pinned matcher table ([data-model.md](data-model.md) Section 4) |
| `target_function` / `target_package` | The paired production function's declared name and `derivePackage` dotted module path — the same identity `analyze` reports |
| `side_effect_type` | The inferred canonical taxonomy name (provenance passes then the fallback chains — [data-model.md](data-model.md) Section 7); always present, never an alias |
| `confidence` | The pairing strategy's fixed integer: naming-exact `90`, naming-case-insensitive `70`, direct-calls `80`, import-graph `75` |

Unpaired tests and assertion-less paired tests emit no rows — never
confidence-0 rows. One row per (paired test, assertion).

## 7. Conformance requirements

The conformance suite (`tests/server.test.ts` additions, SC-005) MUST
pin:

1. The capability response: exactly six capability keys,
   `test_mapping`, `discover`, and `classify_signals` `true`; the
   other three `false`.
2. The reserved `-32601` set: exactly `analyze/stream`,
   `doc_coverage`, `cognitive_complexity`.
3. Every row of the Section 4 error table, in order, including the
   echoed root spelling.
4. The result shape: one `mappings` key; `{"mappings": []}` for empty
   inputs (no tests, no targets, match-nothing patterns).
5. A golden response over a known fixture tree — exact bytes,
   including row order.
6. Byte-identical repeat responses over a second request.
7. The eight-key row shape with the Section 6 semantics over
   strategy, assertion, provenance, and coverage fixtures (SC-001
   through SC-004, via the pipeline suites).
