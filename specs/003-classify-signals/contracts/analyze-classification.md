# Contract: analyze — classification attachment

**Feature Branch**: `003-classify-signals`

**Date**: 2026-10-28

**Status**: Complete — normative for implementation and conformance
testing. This contract specifies the classification fields the
`classify_signals` feature adds to every effect in `analyze` responses.
It is an **amendment** to
[specs/002-analysis-engine/contracts/analyze.md](../002-analysis-engine/contracts/analyze.md):
every rule of that contract not amended here is unchanged. It follows
the same format.

Sources consulted: Gaze analyzer protocol v1.2.0 (effect schema,
classification consumption by the scoring engine), the feature spec
(FR-009 through FR-013, FR-016, Assumptions 8, 10, 14, Clarification
Q3), the existing records this amendment populates (`src/models.ts` —
`Classification` and its fail-loud serializer, already shipped unused;
`src/analysis.ts` — the `analyze` pipeline; `src/detector.ts` — effect
production), the snake-eyes reference implementation (classification
attachment semantics), and Dewey prior learnings (Gaze
`mergeClassifications`/`ComputeScore`; the ~28%-vs-60–70% contract
coverage failure this change exists to fix).

---

## 1. What changes

Every effect object in every `analyze` response carries a
`classification` object. There are no other changes to the `analyze`
contract: request params, error surface, effect ordering, detection
rules, ambiguity markers, and skip diagnostics are exactly as specified
in the 002 contract.

| Property | 002 value | 003 value |
|---|---|---|
| Effect `classification` | Absent | `{label, confidence}` on every effect |
| Detection output | Effects with `type`, `description`, `evidence` | Unchanged — detection is untouched |
| Ambiguity marker (`evidence` "unable to determine…") | Present when detection is ambiguous | Unchanged — orthogonal to classification |
| Method params / errors / ordering | — | Unchanged |

## 2. Classification shape

```json
{
  "type": "ReturnValue",
  "description": "…",
  "evidence": "…",
  "classification": {
    "label": "contractual",
    "confidence": 85
  }
}
```

- `label` ∈ `{"contractual", "ambiguous", "incidental"}`.
- `confidence` is an integer in [0, 100].
- Both fields are required on every effect — there is no
  partially-classified or unclassified effect in any `analyze`
  response (FR-012; SC-004). A missing or invalid classification is a
  serializer failure (fail-loud, existing `serializeClassification`).
- Values are computed per (function record, canonical effect type)
  pair: every same-type effect on a record carries the **identical**
  classification (data-model Section 5.4).

## 3. Semantics

- **Formula** (data-model Section 4):
  `clamp(0, 100, 50 + tierBoost + Σ(extractor weights) − 20·contradiction)`,
  with labels `contractual` ≥ 80, `ambiguous` [50, 80), `incidental`
  < 50. The tier boost comes from the taxonomy's tier map — the
  analyzer never re-tiers effects (FR-009).
- **Consistency with `classify_signals`** (FR-013): both methods run
  one shared pipeline over one shared file set. For every pair, the
  `classify_signals` feed for that (function, effect type) sums —
  together with the base and tier boost — to the reported confidence
  (the FR-011 sum-invariant). Tests derive labels from the feed and
  compare.
- **Detection independence**: classification is attached after
  detection and never alters effect type, description, evidence, or the
  ambiguity marker (Assumption 14 — the marker and the classification
  answer different questions and coexist on the same effect).
- **Supersession**: spec 002 FR-019 ("effects carry no classification")
  is superseded by FR-012 at the wiring layer — the detector still
  produces unclassified effects; the assembly attaches classification
  (research R10).

## 4. Determinism

Classifications inherit the effect ordering of the 002 contract
(`(line, column, type)` within records; records ordered `(file, line,
name)`). The pipeline adds no reordering and no nondeterministic data;
repeat requests return byte-identical responses including
classifications (Constitution I; SC-005).

## 5. Mode degradation

Parse-only analysis still classifies every effect — degradation reduces
precision, never availability (Assumption 10): the `interface` and
`caller_count` signals and the exported-return-type visibility
component are absent, so classifications drift toward `ambiguous`, but
no effect loses its `classification` object.

## 6. Conformance requirements

1. Every effect in every fixture `analyze` response carries a
   serializer-valid classification (SC-004).
2. Controlled-signal-profile fixtures assert exact `{label, confidence}`
   values through the full pipeline (SC-001; the quickstart tree is the
   canonical fixture).
3. The sum-invariant derivation check holds for every pair (FR-011,
   FR-013).
4. Golden byte-identical repeat responses including classification
   fields (SC-005).
