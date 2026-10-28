# Contract: classify_signals

**Feature Branch**: `003-classify-signals`

**Date**: 2026-10-28

**Status**: Complete — normative for implementation and conformance
testing. This contract specifies the `classify_signals` JSON-RPC method
end-to-end: parameter validation, success and error semantics,
capability gating, and the deterministic signal semantics. It follows
the format of [specs/002-analysis-engine/contracts/analyze.md](../002-analysis-engine/contracts/analyze.md)
and inherits that contract's shared rules verbatim wherever this
document says "shared".

Sources consulted: Gaze analyzer protocol v1.2.0 (JSON-RPC 2.0
envelope, analysis-params schema, capability and reserved-method
gating), the feature spec (FR-001, FR-008, FR-011, FR-014, FR-015,
Assumptions 1–3, 6–9, 12, 15, Clarifications Q1–Q3), the existing
handler and validator this contract mirrors (`src/server.ts` —
`validateAnalysisParams`, `mapRootPathError`, `handleLine`'s `-32602` /
`-32603` / reserved-method `-32601` paths; `src/analysis.ts` —
`prepareAnalysis`'s strict parameter semantics), the snake-eyes
reference implementation (method shape, error discipline, ordering), and
Dewey prior learnings (Gaze `mergeClassifications`/`ComputeScore`
consumption of the signal feed).

---

## 1. Method summary

| Property | Value |
|---|---|
| Method name | `classify_signals` |
| Gating | Server capability `classify_signals: true` in the `initialize` result |
| Params | `AnalysisParams` — identical schema to `analyze` (shared validator) |
| Result | `{"signals": Signal[]}` — raw classification signals |
| Positional params | Rejected (`-32602`, shared rule) |
| Idempotent | Yes — repeat requests return byte-identical responses |

`classify_signals` is a **read-only analysis method**: it runs the same
discovery and detection pipeline as `analyze` and emits the
classification **evidence** (raw signals) rather than classified
effects. It never mutates the input tree, never writes project files,
and never executes analyzed code (Constitution V).

## 2. Request

```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "method": "classify_signals",
  "params": {
    "root_path": "/abs/path/to/project",
    "patterns": ["src/**/*.ts"],
    "exclude": ["**/*.test.ts"]
  }
}
```

Parameter rules are the **shared analysis-params rules**, enforced by
the same `validateAnalysisParams` used by `analyze` — identical checks,
identical message strings, identical order (one validator, one error
table):

| Check | Failure |
|---|---|
| `params` is an object | `-32602` shared message |
| `root_path` present, string, absolute | `-32602` shared message |
| Root exists and is a directory | `-32602` shared root message (via `mapRootPathError`) |
| `patterns` absent or non-empty string array | `-32602` shared message |
| `exclude` absent or string array | `-32602` shared message |
| Unknown keys | `-32602` shared message |
| Positional params (`params` is an array) | `-32602` shared message |

There is **no** method-specific parameter: `classify_signals` takes no
options beyond the shared analysis params (FR-001). Anything else is an
unknown key.

## 3. Success response

```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "result": {
    "signals": [
      {
        "function": "writeBanner",
        "package": "src.banner",
        "side_effect_type": "StdoutWrite",
        "source": "docstring",
        "weight": -15,
        "reasoning": "incidental doc verb 'Logs' agrees with StdoutWrite"
      }
    ]
  }
}
```

- The result object has exactly one key, `signals` — an array of Signal
  records (shape in [data-model.md](../data-model.md) Section 2).
- Empty result is `{"signals": []}` — a tree with no detected effects,
  or none whose pairs yield signals, is a success, not an error.
- `side_effect_type` is always the canonical taxonomy name (aliases
  never emitted); `source` is always one of the six closed values
  (`interface`, `visibility`, `caller_count`, `naming_convention`,
  `docstring`, `contradiction`); `weight` is always an integer from the
  closed weight set; `reasoning` is present in practice and always
  non-empty when present.
- `contradiction` rows are ordinary signals — same identity fields,
  weight −20, fixed-template reasoning — emitted exactly once per
  (function, effect-type) pair whose extractor signals mix positive and
  negative weights (FR-011; Clarification Q1 option (a)).

### 3.1 Ordering and determinism

Signals are ordered by `(package, function, side_effect_type, source)`
using codepoint comparison — a total order with no tie-break rule
(pair keying keeps the key duplicate-free). Responses contain no
timestamps, no environment or host data, and no other nondeterministic
fields: two identical requests against the same tree return
byte-identical serialized responses (Constitution I; SC-005). Skip
diagnostics (oversized or binary files) are written to the server's
stderr, never the response and never stdout.

## 4. Error responses

| Code | Condition | Message |
|---|---|---|
| `-32602` | Any shared parameter-validation failure (Section 2) | Shared analysis-params message (identical strings to `analyze`) |
| `-32602` | Root missing or not a directory | Shared root message |
| `-32601` | Method not implemented (capability false — future servers) | Shared reserved-method message |
| `-32603` | Unexpected internal failure | Shared internal-error message via `handleLine` |

`classify_signals` adds **no** error codes and **no** method-specific
error strings: its error surface is exactly the shared analysis-method
surface. Analysis-safety failures (unreadable files, oversized files)
are skip diagnostics on stderr, never JSON-RPC errors (shared rule).
Detection ambiguity is expressed in the signal data itself, never as an
error.

## 5. Capability and dispatch gating

- The `initialize` result advertises `classify_signals: true`; the other
  five capability flags are unchanged (FR-015; SC-006).
- The server's reserved-method set (unknown-method `-32601` with the
  reserved-names hint) **shrinks** to exactly `test_mapping`,
  `analyze/stream`, `doc_coverage`, `cognitive_complexity` (FR-014).
- Gaze calls `classify_signals` when and only when the capability flag
  is true; the method is registered unconditionally in this server (no
  runtime toggle).

## 6. Signal semantics (summary)

Full semantics live in [data-model.md](../data-model.md) and
[research.md](../research.md); the contract-level statements:

| Source | Fires when | Weight |
|---|---|---|
| `interface` | Class-member record declared by an interface in the enclosing class's heritage (program mode only) | +30 |
| `visibility` | Exported function (+8) / exported return type (+6, program) / exported receiver (+6), summed and clamped to +20 | ≤ +20 |
| `caller_count` | 1 / 2–3 / ≥4 distinct in-scope modules call the record (program mode only; self-recursion excluded) | +5 / +10 / +15 |
| `naming_convention` | Longest closed-list prefix matches the record name and the routing table lists it for the effect type; `Err`+`SentinelError` special case | +10 / −10 / +30 |
| `docstring` | JSDoc tag or prose verb matches and routes to the effect type; strongest agreeing tier only | +15 / +5 / −15 |
| `contradiction` | The pair's extractor signals mix positive and negative weights | −20 |

The signal set is computed per (function record, canonical effect type)
pair over the same `prepareAnalysis` file set as `analyze` — the two
methods share one pipeline and can never disagree about which functions
or effects exist (FR-013). The FR-011 sum-invariant holds: a consumer
summing all emitted signals matched to an effect reproduces the
confidence that `analyze` reports for it.

## 7. Conformance requirements

Conformance tests drive these rules through the full JSON-RPC server
(`Server.run()` on canned stdin lines), asserting exact serialized
responses:

1. Valid request → `{"signals": [...]}` with FR-014 ordering (canned
   golden, byte-identical on repeat).
2. Every shared `-32602` check fires with the identical message string
   `analyze` produces for the same input.
3. Missing/invalid root → shared root message.
4. Unknown method / reserved-name hint lists the four remaining
   reserved names.
5. `initialize` → `classify_signals: true`, other five flags unchanged.
6. Empty tree (no in-scope effects) → `{"signals": []}` success.
