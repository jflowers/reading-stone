# Requirements Quality Checklist: doc_coverage and cognitive_complexity methods

**Purpose**: Requirements-quality review of `specs/005-doc-cognitive-methods/spec.md` before clarification and planning.

**Created**: 2026-10-30

**Feature**: [spec.md](../spec.md)

**Review Ownership**: This checklist is a reviewer-owned requirements-quality review artifact. Mark an item `[x]` only when the reviewer determines the requirements-quality criterion is satisfied.

**Marker Semantics**: `[x]` means the criterion has been reviewed and satisfied for requirements quality. It does not mean implementation work is complete.

## Completeness

- [x] CHK001 Every functional requirement (FR-001 through FR-015) is traceable to at least one user story's acceptance scenarios or the shared-pipeline section that the existing methods already established.
- [x] CHK002 All user stories have at least 5 acceptance scenarios each (US1: 6, US2: 4, US3: 5, US4: 6), written in Given/When/Then form or the normative-fixture form US4 requires.
- [x] CHK003 Edge cases are identified and each maps to a requirement or assumption (parse-only mode, empty arrays, tags-only JSDoc, overloads, getter/setter, `??` mixing, anonymous folding, module-level statements, decorators).
- [x] CHK004 The spec covers both P1 protocol surfaces (wire contracts, capabilities, error parity) and both P2 data-source surfaces (symbol surface, algorithm) — no orphaned scope from issue #6.
- [x] CHK005 Non-functional requirements are pinned: determinism (byte-identical), file-set parity, mode parity, zero new runtime dependencies, protected CI gates (FR-012, FR-004, FR-015, Assumption 13).

## Consistency

- [x] CHK006 No two requirements conflict: the increment table (FR-006), nesting regions (FR-007), and fixture values (FR-010) were cross-checked value-by-value; every fixture value is recomputable from FR-006/FR-007/FR-008/FR-009.
- [x] CHK007 Terminology is consistent with prior specs: "source arm", "extraction table", "record order", "shared analysis-params validation" all carry their spec 002/003 meanings; cross-references (spec 001 FR-013, spec 002 FR-004/007/008/009/021/027, spec 003 parity) verified against those specs.
- [x] CHK008 The two methods' row models are internally consistent with the protocol document: `symbols`/`name` for doc_coverage vs `functions`/`function` for cognitive_complexity — the asymmetry is pinned (Assumption 6) rather than silently normalized.

## Clarity

- [x] CHK009 Each requirement is verifiable and unambiguous: FR-002 is a complete routing table, FR-003 defines the snippet rule operationally, FR-006/007/008 enumerate rules, FR-010 is a normative value table.
- [x] CHK010 Ambiguities were resolved with documented defaults in Assumptions (divergences from the Gaze Go port, SonarJS carve-outs, `case` interpretation, `function` key, exported-surface scope, overload handling) rather than left open.
- [x] CHK011 No `[NEEDS CLARIFICATION]` markers remain in spec.md.
- [x] CHK012 Domain constructs (TS AST kinds, JSDoc forms) appear as the feature's subject matter, matching the house style of specs 002/004; no file paths, function signatures, or module layouts are prescribed beyond the collision constraint the issue itself raised (FR-011, Assumption 15).

## Testability

- [x] CHK013 Every user story is independently testable — each has an "Independent Test" runnable against a built server or as a golden fixture comparison, without requiring the other stories.
- [x] CHK014 Acceptance scenarios are concrete enough for test derivation: fixture inputs and expected outputs are named, and US4's values are normative numbers.
- [x] CHK015 The coverage-strategy requirement (FR-015, Constitution P4) directs the plan to specify suites for kind routing, snippet extraction, every algorithm rule, folding, the fixture table, and wire-level dispatch tests.

## Notes

- Mark items `[x]` only after review confirms the requirement-quality criterion is satisfied
- Leave items unchecked when they still require clarification, correction, or reviewer evaluation
- `/speckit.implement` reads checklist checkbox state as a gate and must not modify markers
- `checklists/requirements.md` has a separate built-in lifecycle maintained by `/speckit.specify` and `/speckit.clarify`
- US4's scenario 5 pins `if (n <= 1) { return 1 } return n * factorial(n-1)` → 2 — verify the plan's fixture files reproduce these shapes exactly
- Add comments or findings inline
- Link to relevant resources or documentation
- Items are numbered sequentially for easy reference
