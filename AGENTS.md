# AGENTS.md

## Project Overview

Reading Stone is a TypeScript/JavaScript code analyzer that implements
the [Gaze external analyzer
protocol](https://github.com/unbound-force/gaze/issues/95). It detects
observable side effects in TypeScript and JavaScript functions and
reports them to Gaze's universal scoring engine via JSON-RPC 2.0 over
stdin/stdout.

Reading Stone does not have its own CLI for end users. Gaze is the CLI
-- Reading Stone is invoked as a subprocess by Gaze when analyzing
TypeScript projects.

- **Language**: TypeScript (Node.js 22+)
- **Package**: `reading-stone`
- **License**: Apache 2.0
- **Parent project**: [Gaze](https://github.com/unbound-force/gaze)
  (unbound-force)
- **Organization**: [zero-dot-force](https://github.com/zero-dot-force)
  (labs incubator for unbound-force)
- **Reference implementation**:
  [snake-eyes](https://github.com/zero-dot-force/snake-eyes) (Python
  analyzer; the JSON-RPC protocol layer is ported from it, see NOTICE)

## Constitution (Highest Authority)

The Reading Stone constitution
(`.specify/memory/constitution.md`) is the highest-authority document
for this project. It extends the unbound-force org constitution and
pins Gaze protocol v1.2.0. Constitution violations are CRITICAL
severity and non-negotiable.

**Five principles:**

1. **Protocol Fidelity** -- implement the Gaze analyzer protocol
   precisely; deterministic output; deviations are bugs
2. **Detection Accuracy** -- correctly identify all observable side
   effects; ambiguity over omission; false positives and false
   negatives are bugs
3. **TypeScript-Native Analysis** -- use the TypeScript compiler API
   (`ts.createSourceFile`, `ts.Program`, `ts.TypeChecker`); do not
   reimplement TypeScript semantics
4. **Testability** -- every function testable in isolation; coverage
   strategy required in every spec; protocol conformance suites
   required
5. **Analysis Safety** -- analyzed source is untrusted input; static
   analysis only; never execute analyzed code; dependency necessity
   justified

## Architecture

Reading Stone is a JSON-RPC server that Gaze spawns as a subprocess.
The division of responsibility:

**Gaze (Go core) owns:**

- CLI, TUI, and report formatting
- Universal side effect taxonomy
- Classification scoring (contractual vs incidental)
- CRAP, GazeCRAP, and contract coverage computation
- AI report pipeline
- Analyzer lifecycle management

**Reading Stone (this project) owns:**

- TypeScript/JavaScript-specific side effect detection
- TypeScript/JavaScript-specific classification signals
- TypeScript/JavaScript test-to-assertion mapping for vitest and jest
  test suites (the `test_mapping` method)
- Coverage data parsing
- Cyclomatic complexity calculation
- File and project discovery

## Technology Stack

- **Parsing**: TypeScript compiler API (`typescript` package) for
  structural AST analysis -- both `.ts` and `.js` sources are in
  scope
- **Runtime**: Node.js stdlib plus one runtime dependency:
  `typescript` (the compiler package, consumed at runtime via
  `typescript/unstable/sync`; moved from devDependencies to
  dependencies — v0.1.0 shipped with zero runtime deps)
- **Project management**: npm
- **Testing**: [vitest](https://vitest.dev/) with
  `@vitest/coverage-v8`
- **Linting/formatting**: [Biome](https://biomejs.dev/) (replaces
  ESLint + Prettier; see `typescript-custom` pack rule CR-001)

## Project Structure

```
reading-stone/
├── src/
│   ├── index.ts             # Package entry point (VERSION)
│   ├── main.ts              # Entry point (reading-stone --stdio)
│   ├── server.ts            # JSON-RPC server (stdin/stdout)
│   ├── protocol.ts          # Request/response types
│   ├── taxonomy.ts          # Side-effect taxonomy (48 types, tiers, aliases)
│   ├── models.ts            # Effect/FunctionRecord/classification records, serializers, derivePackage
│   ├── internal.ts          # Shared internal primitives: (file, line, name) order, lexical path containment
│   ├── safeio.ts            # Bounded safe file reader with skip diagnostics
│   ├── discovery.ts         # Project walking, file classification, framework detection, discover()
│   ├── analysis.ts          # Pattern rules + shared prepareAnalysis pipeline; analyze() and classifySignals() method entries (assembly and signal-feed serialization)
│   ├── program.ts           # TypeScript analysis context (program mode with type checker; parse-only fallback)
│   ├── extract.ts           # Table-driven function extraction (ExtractionRecord set)
│   ├── detector.ts          # Side-effect detection rules + FunctionRecord assembly
│   ├── complexity.ts        # Cyclomatic complexity engine (ComplexityEntry)
│   ├── coverage.ts          # Istanbul coverage-final.json artifact parser (CoverageEntry)
│   ├── quality/             # Test-mapping pipeline (test_mapping method + analyze wiring)
│   │   ├── assertions.ts    # Assertion detection (vitest/jest expect chains, node:assert forms)
│   │   ├── collect.ts       # Test-function collection (it/test/describe walk, qualified titles)
│   │   ├── inference.ts     # Assertion-to-effect inference (fallback chains + four provenance passes)
│   │   ├── matchers.ts      # Normative matcher tables + classification lookups
│   │   ├── pairing.ts       # Test-target pairing strategies (naming 90/70, calls 80, imports 75)
│   │   ├── pipeline.ts      # testMapping() orchestration over the shared prepareAnalysis test arm
│   │   └── types.ts         # MappingRow wire record + serializer (closed assertion-kind set)
│   ├── signals/             # Classification signal pipeline (classify_signals method + analyze wiring)
│       ├── adapter.ts       # Pair fan-out core, contradiction synthesis, confidence formula (classifyPairs)
│       ├── caller-index.ts  # Import-graph caller index (distinct-module counts via the type checker)
│       ├── caller.ts        # caller_count bucket rule (+5 / +10 / +15 by distinct calling modules)
│       ├── evidence.ts      # RecordEvidence snapshot (exportedness, JSDoc, interface membership, callers)
│       ├── interface.ts     # interface signal (+30, declared interface members)
│       ├── jsdoc.ts         # docstring signal (+15 tags / +5 indirect / -15 incidental verbs)
│       ├── naming.ts        # naming_convention signal (prefix rules + Err sentinel special case)
│       ├── routing.ts       # Effect-type routing table (48 canonical types → agreeing vocabulary)
│       ├── types.ts         # Signal wire record + serializer (six-value closed source set)
│       └── visibility.ts    # visibility signal (exported components, clamped at +20)
├── tests/                   # Vitest suites (tests/signals/ and tests/quality/ mirror their src/ trees one-to-one)
├── docs/
│   └── effect-disposition.md  # 48-type disposition table (tier, disposition, TypeScript mapping, rationale)
├── .github/workflows/       # CI: biome, tsc, vitest gates
├── openspec/                # OpenSpec changes and specs
├── package.json
├── README.md
├── LICENSE
└── NOTICE
```

## Shell Commands

Commands are derived from `.github/workflows/ci.yml`. Do not rely on
memory -- check the workflow file for the current gates.

```bash
# Install dependencies (CI uses npm ci for lockfile integrity)
npm ci

# Linting and format check
npx biome check src/ tests/

# Type checking and build
npm run build

# Run tests with coverage (85% is the protected gate)
npx vitest run --coverage

# Run reading-stone in stdio mode (for testing with gaze)
node dist/main.js --stdio
```

**Protected gates** (agents MUST NOT lower these):

- 85% coverage thresholds (lines, statements, functions, branches) --
  minimum coverage percentages
- `biome check` -- lint and formatting must pass, not auto-fix
- `tsc` strict build -- type checking must pass
- `npm ci` -- lockfile integrity

## Core Mission

- **Protocol fidelity**: Reading Stone implements Gaze's analyzer
  protocol precisely. The protocol is the contract -- deviations are
  bugs.
- **TypeScript-native analysis**: Use the TypeScript compiler API to
  understand TypeScript and JavaScript code natively. Do not
  reimplement TypeScript semantics from scratch.
- **Platform pattern**: Snake Eyes established the pattern for
  language analyzers; Reading Stone is the second analyzer and
  validates the pattern's portability. Decisions here set precedent
  for future analyzers (Rust, etc.).

## Behavioral Constraints

- **Zero-Waste Mandate**: No orphaned code, unused dependencies, or
  feature bloat.
- **Neighborhood Rule**: Changes must be audited for impacts on the
  Gaze protocol contract.
- **Intent Drift Detection**: Implementation must stay aligned with
  the analyzer protocol spec and Gaze's universal taxonomy.

### Gatekeeping Value Protection

Agents MUST NOT modify values that serve as quality or governance
gates to make an implementation pass:

1. **Coverage thresholds** -- minimum coverage percentages, coverage
   ratchets
2. **Severity definitions** -- CRITICAL/HIGH/MEDIUM/LOW boundaries
3. **Convention pack rule classifications** -- MUST/SHOULD/MAY
   designations (downgrading MUST to SHOULD is prohibited)
4. **CI flags and linter configuration** -- biome rules, tsc
   strictness, vitest markers
5. **Constitution MUST rules** -- any MUST rule in
   `.specify/memory/constitution.md`

When an implementation cannot meet a gate, the agent MUST stop,
report which gate is blocking and why, and let the human decide.

### Workflow Phase Boundaries

Agents MUST NOT cross workflow phase boundaries:

- **Specify/Clarify/Plan/Tasks** phases: spec artifacts ONLY. No
  source code, test, or config changes.
- **Implement** phase: source code changes allowed, guided by spec
  artifacts.
- **Review** phase: findings and minor fixes only. No new features.

## Technical Guardrails

- **Protocol compliance**: All JSON-RPC responses MUST conform to the
  analyzer protocol schema. Invalid responses are bugs.
- **Graceful degradation**: When analysis cannot determine an effect
  with confidence (dynamic dispatch, `eval`, etc.), report it as
  ambiguous rather than omitting it. Silent false negatives violate
  the constitution.
- **CI Parity Gate**: Before marking any task complete, agents MUST
  run the same checks CI runs. Derive commands from workflow files,
  not memory.

## Spec Organization

Reading Stone uses two spec pipelines. Choose based on scope:

| Criterion | Speckit (`specs/NNN-*/`) | OpenSpec (`openspec/changes/`) |
|---|---|---|
| **Scope** | Strategic: ≥3 tasks or cross-cutting | Tactical: 1–2 tasks, focused |
| **Artifacts** | spec, plan, tasks, checklists | proposal, design, tasks |
| **When to use** | New analysis capabilities, protocol changes, architecture | Bug fixes, small features, docs |
| **Example** | `specs/001-jsonrpc-prototype/` | `openspec/changes/fix-parse-error/` |

**Ordering constraints**: spec artifacts MUST be committed before
implementation begins. Implementation commits MUST NOT be in the same
commit as spec changes.

**Task Completion Bookkeeping**: When completing a task from a tasks
file, mark the checkbox `- [x]` immediately -- not in a batch at the
end.

## Workflow Gates

### Constitution Check

Before implementation, verify alignment with all five constitution
principles. The check MUST name each principle and give a PASS/FAIL
verdict:

1. Protocol Fidelity
2. Detection Accuracy
3. TypeScript-Native Analysis
4. Testability
5. Analysis Safety

### Review Council Gate

Run `uf.review-council` before creating a PR. All reviewers MUST
APPROVE before the PR is eligible for merge. Exempt: constitution
amendments, docs-only changes, emergency hotfixes.

### CI Parity Gate

Before marking any task complete, agents MUST run the same checks CI
runs. Derive commands from `.github/workflows/ci.yml`, not from
memory.

<!-- SPECKIT START -->
For additional context about technologies to be used, project structure,
shell commands, and other important information, read the current plan
under `specs/` or `openspec/changes/`.
<!-- SPECKIT END -->

## Convention Packs

This repository uses convention packs scaffolded by unbound-force.
Agents MUST read the applicable pack(s) before writing or reviewing
code.

- `.opencode/uf/packs/default.md`
- `.opencode/uf/packs/default-custom.md`
- `.opencode/uf/packs/severity.md`
- `.opencode/uf/packs/content.md`
- `.opencode/uf/packs/content-custom.md`
- `.opencode/uf/packs/typescript.md`
- `.opencode/uf/packs/typescript-custom.md`
- `.opencode/uf/packs/review-voice.md`
- `.opencode/uf/packs/review-voice-custom.md`
- `.opencode/uf/packs/ci.md`
- `.opencode/uf/packs/ci-custom.md`
