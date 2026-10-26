# Implementation Plan: Discovery and Shared Analysis Infrastructure (discover Method)

**Branch**: `001-discovery-shared-analysis` | **Date**: 2026-10-26 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `/specs/001-discovery-shared-analysis/spec.md`

## Summary

Implement the `discover` JSON-RPC method and the shared analysis
foundation every later issue builds on: the canonical 48-type
side-effect taxonomy with tiers and aliases, the shared record models
(`Effect`, `Classification`, `FunctionRecord`) with omit-unset
serialization and package derivation, a bounded traversal-safe file
reader (16 MiB cap, regular-file check, one stderr diagnostic per
skip), and deterministic project walking (extensions `.ts/.tsx/.js/
.jsx/.mjs/.cjs`, five pruned directories, test-file classification,
`.d.ts` and generated-marker exclusion, vitest/jest framework
detection). The `initialize` handshake flips `discover: true`; the
dispatch layer gains async handler support. See [research.md](research.md)
for decisions and [data-model.md](data-model.md),
[contracts/discover.md](contracts/discover.md), [quickstart.md](quickstart.md)
for the Phase 1 design.

## Technical Context

**Language/Version**: TypeScript (compiler `typescript` ^7 as a
devDependency), Node.js 22+ (`engines.node >=22`; CI matrix 22/24),
ES modules (`"type": "module"`, `module: NodeNext`).

**Primary Dependencies**: Runtime: none — Node.js stdlib only
(`node:fs/promises`, `node:path`, `node:stream`, `node:readline`).
Dev: `typescript`, `vitest` + `@vitest/coverage-v8`, `@biomejs/biome`.
Promoting `typescript` to a runtime dependency is deliberately
deferred to the AST-requiring change (research R6).

**Storage**: N/A (stateless subprocess; filesystem reads only).

**Testing**: vitest with `@vitest/coverage-v8`; injectable-stream
harness through `Server.run()`; `mkdtemp` fixture trees; conformance
suites assert canned JSON-RPC request/response pairs.

**Target Platform**: POSIX subprocess (stdin/stdout JSON-RPC) spawned
by Gaze; CI on ubuntu-latest, local dev on macOS.

**Project Type**: library/executable analyzer backend (`reading-stone`
npm package with `bin: dist/main.js`); no end-user CLI.

**Performance Goals**: Whole-tree discovery bounded by tree size;
per-file reads capped at 64 KiB prefix (markers) and 16 MiB whole-file
safety cap; no latency SLA in scope for this change.

**Constraints**: Determinism is absolute — byte-identical responses
for the same tree and analyzer version (Constitution I); stdout
reserved for JSON-RPC only; analyzed source is untrusted input
(static analysis only, no execution); 85% coverage thresholds,
`biome check`, and strict `tsc` are protected gates.

**Scale/Scope**: Arbitrary untrusted TypeScript/JavaScript projects;
resource bounds (16 MiB file cap, sorted bounded walks) prevent DoS.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

Pre-design evaluation against
[`.specify/memory/constitution.md`](../../.specify/memory/constitution.md)
(v1.0.1):

1. **Protocol Fidelity — PASS**. `discover` implements protocol
   v1.2.0 exactly: params `{root_path}`, result
   `{source_files, test_files, framework}`; capability negotiation via
   `initialize` (`discover: true`, five flags unchanged); deterministic
   sorted-key serialization already in place; no timestamps or
   environment-dependent data in responses.
2. **Detection Accuracy — PASS (vacuous for this change)**. No
   side-effect detection ships here (issue #3); the vocabulary and
   models are defined but not yet consumed by a protocol method. No
   silent omissions are introduced: `.d.ts` and generated-file
   exclusions are documented policies recorded in the spec and
   contract, not silent skips.
3. **TypeScript-Native Analysis — PASS with documented tradeoff**.
   Discovery is filesystem/lexical classification, not semantic
   analysis; the compiler API is not required for it. The
   generated-marker scanner is bounded lexical-trivia scanning, not a
   reimplementation of TypeScript semantics (research R6); the
   AST-requiring work in issue #3 will use the compiler API.
   JavaScript-family sources are included (FR-002), satisfying the
   inclusion mandate.
4. **Testability — PASS**. Coverage strategy specified (research R11):
   unit (taxonomy, models, classification, marker scanner, package
   derivation), safety fixtures (oversized/FIFO/unreadable/symlink),
   and protocol conformance (canned JSON-RPC exchanges through
   `Server.run()`) at the protected 85% thresholds.
5. **Analysis Safety — PASS**. Strictly static (no execution, import,
   or require of analyzed code); bounded reads; traversal-safe
   resolution with defense-in-depth containment; symlinks never
   followed during walking; no new dependencies (typescript stays a
   devDependency in this change).

**Post-design re-evaluation (after Phase 1)**: All five verdicts
stand. The Phase 1 artifacts add no new tension: the data model pins
the taxonomy exactly as the protocol table specifies; the discover
contract derives its wire shapes, error codes, and determinism rules
directly from protocol v1.2.0; the safety design (stat-before-open
ordering, containment checks, one-diagnostic-per-skip) satisfies
Principle V with the residual TOCTOU race explicitly documented and
accepted (research R4). No principle conflicts were found; no
Complexity Tracking entries are required.

## Project Structure

### Documentation (this feature)

```text
specs/001-discovery-shared-analysis/
├── plan.md              # This file (/speckit.plan command output)
├── research.md          # Phase 0 output (/speckit.plan command)
├── data-model.md        # Phase 1 output (/speckit.plan command)
├── quickstart.md        # Phase 1 output (/speckit.plan command)
├── contracts/           # Phase 1 output (/speckit.plan command)
│   └── discover.md      # discover JSON-RPC contract
└── tasks.md             # Phase 2 output (/speckit.tasks command - NOT created by /speckit.plan)
```

### Source Code (repository root)

```text
src/
├── index.ts             # (edit) VERSION + re-export public model/taxonomy surface
├── main.ts              # (unchanged) CLI entry: reading-stone --stdio
├── protocol.ts          # (edit) initializeResult flips discover: true
├── server.ts            # (edit) async-capable Handler, discover handler registration
├── taxonomy.ts          # (new) Tier, SideEffectType (48), TIER_MAP, 11 aliases, resolver
├── models.ts            # (new) Effect, Classification, FunctionRecord, serializers, derivePackage
├── safeio.ts            # (new) bounded traversal-safe file reader + stderr diagnostics
└── discovery.ts         # (new) walk, classification, framework detection, markers, discover()

tests/
├── protocol.test.ts     # (edit) discover capability + discover result-shape assertions
├── server.test.ts       # (edit) discover dispatch, param validation, reserved -32601 set (discover removed)
├── taxonomy.test.ts     # (new) vocabulary conformance: 48 types, tier sizes, 11 aliases
├── models.test.ts       # (new) record serialization, omit-unset optionals, derivePackage
├── safeio.test.ts       # (new) safety fixtures: oversize, FIFO, unreadable, containment
└── discovery.test.ts    # (new) walk/classify/framework/marker fixtures + discover() unit tests
```

Implementation must also update, in the same change (Assumption 12,
research R12):

```text
openspec/specs/protocol/spec.md   # initialize result: discover: true, five flags false
openspec/specs/server/spec.md     # dispatch scope: initialize/shutdown/discover; -32601 list drops discover
```

**Structure Decision**: Single-project layout (existing flat `src/`
style). Four new modules map 1:1 to the originating issue's four
foundation pieces (taxonomy, models, safe file access, project
walking); dependency direction `server → discovery → safeio` with
`taxonomy`/`models` as leaves and `discovery` throwing
`InvalidRootPathError` for the server to map to `-32602` (no layering
inversion). Test files mirror source modules one-to-one, extending
the existing vitest suites rather than introducing a new harness.

## Complexity Tracking

> **Fill ONLY if Constitution Check has violations that must be justified**

No violations. All five constitution principles PASS pre- and
post-design; the documented tradeoffs (hand-rolled trivia scanner
deferring the `typescript` runtime dependency; accepted stat-to-open
TOCTOU residual) are recorded in research.md R4/R6 as decisions with
rejected alternatives, not principle violations.
