<!--
SYNC IMPACT REPORT
==================
Version change: none (initial ratification)

This is the initial Reading Stone constitution, adapted from the
Snake Eyes constitution (v1.1.0) for a TypeScript analyzer, aligned
with the unbound-force org constitution v1.3.1.

Adapted sections:
- Principle III renamed Python-Native Analysis → TypeScript-Native
  Analysis; parsing infrastructure references swapped from Python
  ast/symtable/astroid to the TypeScript compiler API and
  established TS analysis libraries.
- Principle V Analysis Safety: parse-level tool references adapted
  (typescript AST parsing instead of ast.parse).

Unchanged from Snake Eyes v1.1.0 (wording adapted only):
- I. Protocol Fidelity (includes determinism MUST rules)
- II. Detection Accuracy
- IV. Testability
- Development Workflow, Governance, protocol v1.1.0 pin

Org alignment check: ALIGNED
- All five principles are compatible with org v1.3.1
- Principle V derives from org Principle V (Security by Default)
  adapted for static analysis context
-->

# Reading Stone Constitution

**parent_constitution**: unbound-force/unbound-force v1.3.1

## Core Principles

### I. Protocol Fidelity

Reading Stone MUST implement Gaze's external analyzer protocol
precisely. The protocol is the contract between Gaze and every
language analyzer -- deviations break the platform.

- Every JSON-RPC response MUST conform to the analyzer protocol
  schema. Malformed responses are bugs, not edge cases.
- Response data MUST use Gaze's universal side effect taxonomy.
  Inventing local type names that diverge from the taxonomy is
  prohibited.
- When the protocol evolves (new methods, new fields), Reading
  Stone MUST maintain backward compatibility with older Gaze
  versions through capability negotiation.
- Analysis of the same input tree with the same Reading Stone
  version and the same protocol version MUST produce
  byte-identical JSON-RPC output. Responses MUST NOT contain
  timestamps, random values, hostnames, or any other
  environment-dependent data. JSON serialization MUST be
  deterministic (stable key ordering).

**Rationale**: Reading Stone is not a standalone tool. It is one
half of a two-process system. If the protocol contract is broken,
nothing downstream (classification, scoring, reports, TUI) can
function correctly. Protocol fidelity is the foundation on which
all other value depends.

### II. Detection Accuracy

Reading Stone MUST correctly identify all observable side effects
produced by TypeScript and JavaScript functions. An observable
side effect includes return values, thrown exceptions, mutations
to state, I/O operations, and any other externally detectable
change.

- Every reported side effect MUST correspond to a real observable
  effect in the analyzed code. False positives erode trust and
  MUST be treated as bugs.
- Every actual observable side effect that goes unreported is a
  false negative. False negatives MUST be tracked, measured, and
  driven toward zero.
- When analysis cannot determine an effect with confidence
  (dynamic dispatch, `eval`, `Function` constructor, higher-order
  gymnastics, etc.), the effect MUST be reported as ambiguous
  rather than omitted. Silent false negatives are worse than
  acknowledged uncertainty.
- Accuracy claims MUST be backed by automated regression tests
  covering known-good and known-bad detection scenarios.

**Rationale**: Gaze's entire value proposition depends on accurate
side effect data. Reading Stone is the source of truth for
TypeScript -- if it misses effects or fabricates them, every
metric Gaze computes is wrong.

### III. TypeScript-Native Analysis

Reading Stone MUST use TypeScript's own parsing and analysis
infrastructure to understand TypeScript code. Do not reimplement
TypeScript semantics from scratch.

- Primary analysis MUST use the TypeScript compiler API
  (`typescript` package: `ts.createSourceFile`, the AST, and the
  checker) -- the same parser and type system the compiler
  itself uses.
- Name resolution, symbol resolution, and cross-module import
  analysis SHOULD use the TypeScript `Program`/`TypeChecker`
  rather than custom implementations.
- Analysis MUST NOT require users to annotate, restructure, or
  configure their TypeScript code. Reading Stone works with what
  exists, in both strict and non-strict projects.
- TypeScript-specific idioms (decorators, generics, async/await,
  optional chaining, symbol-keyed members, module systems)
  MUST be treated as first-class analysis targets, not edge
  cases to handle later.
- Both TypeScript and plain JavaScript sources in a project are
  in scope; the analyzer MUST NOT silently skip `.js`/`.jsx`/
  `.mjs` files that participate in the analyzed project.

**Rationale**: TypeScript analyzing TypeScript is a natural
advantage. The compiler API produces the exact same abstract
syntax tree the compiler uses, with full type information. It is
the battle-tested, Microsoft-maintained source of truth.
Reimplementing these capabilities would be slower, less accurate,
and harder to maintain.

### IV. Testability

Every function Reading Stone analyzes, and every function within
Reading Stone itself, MUST be testable in isolation without
requiring external services or shared mutable state.

- Test contracts MUST verify observable side effects (return
  values, detected effects, JSON-RPC responses), not
  implementation details.
- Coverage strategy (unit vs. integration, with targets) MUST be
  specified in the implementation plan for all new code.
- Missing coverage strategy in a spec or plan is a
  CRITICAL-severity finding and MUST be resolved before
  implementation begins.
- The JSON-RPC protocol is inherently testable: mock analyzers,
  canned request/response pairs, and protocol conformance suites
  MUST be used to verify correctness.

**Rationale**: Reading Stone is a component of a test quality
tool. If its own tests are poorly structured, it undermines the
credibility of the entire system. Testability is also a practical
necessity: the JSON-RPC boundary provides a clean seam for
integration testing without requiring a running Gaze process.

### V. Analysis Safety

Reading Stone analyzes arbitrary TypeScript and JavaScript
codebases. Analyzed source code is untrusted input and MUST be
treated as such.

- Analysis MUST be strictly static. Reading Stone MUST NOT
  execute, import, require, or otherwise run analyzed code. All
  inspection MUST use parse-level tools (the TypeScript
  compiler's AST and checker) that do not trigger code
  execution.
- Inputs MUST be validated and bounded. File paths MUST be
  resolved and checked for traversal. Resource limits (file
  size, AST depth, recursion budget) MUST prevent analyzed code
  from causing denial of service.
- Every dependency is attack surface. The default answer to
  adding a dependency is "do not add." New dependencies MUST be
  justified against the org constitution's Dependency Necessity
  standard.
- CI actions MUST be pinned by commit SHA, not by mutable tag.
  Supply-chain integrity is a structural property, not a
  per-change review item.

**Rationale**: Reading Stone runs in developer and CI
environments on codebases it does not control. A compromised or
malicious project must not achieve code execution through the
analyzer. Static-only analysis is not a limitation -- it is the
security boundary.

## Development Workflow

- **Spec-First Development**: All changes that modify production
  code, test code, or configuration MUST be preceded by a spec
  workflow (either the Speckit pipeline under `specs/` or the
  OpenSpec pipeline under `openspec/changes/`). The spec
  artifacts (proposal, design, tasks at minimum) MUST exist
  before implementation begins. Exempt from this requirement:
    - Constitution amendments (governed by the Governance
      section below)
    - Trivial fixes: typo corrections, comment-only changes,
      and single-line formatting fixes that do not alter
      behavior
    - Emergency hotfixes: critical bugs where the fix is a
      single well-understood correction (must be retroactively
      documented)
- **Branching**: All work MUST occur on feature branches. Direct
  commits to the main branch are prohibited except for trivial
  documentation fixes.
- **Code Review**: Every pull request MUST receive at least one
  approving review before merge.
- **Continuous Integration**: The CI pipeline MUST pass (build,
  lint, type check, tests) before a pull request is eligible for
  merge.
- **Releases**: Follow semantic versioning (MAJOR.MINOR.PATCH).
  Breaking changes to the JSON-RPC protocol require a MAJOR bump.
- **Commit Messages**: Use conventional commit format
  (`type: description`).

## Governance

This constitution extends the unbound-force org constitution
(v1.3.1). On matters where this document and the org
constitution conflict, the org constitution prevails and this
constitution MUST be amended to resolve the conflict.

This constitution is the highest-authority document for the
Reading Stone project. All development practices, pull request
reviews, and architectural decisions MUST be consistent with the
principles defined above.

- **Amendments**: Any change to this constitution MUST be
  proposed via pull request, reviewed, and approved before
  merge. The amendment MUST include a migration plan if it
  alters or removes existing principles.
- **Versioning**: The constitution follows semantic versioning:
  - MAJOR: Principle removal or incompatible redefinition.
  - MINOR: New principle or materially expanded guidance.
  - PATCH: Clarifications, wording, or non-semantic refinements.
- **Compliance Review**: At each planning phase (spec, plan,
  tasks), the Constitution Check gate MUST verify that the
  proposed work aligns with all active principles.
- **Upstream Alignment**: This constitution is subordinate to
  Gaze's analyzer protocol specification. Reading Stone
  implements **protocol v1.2.0** (defined at
  `unbound-force/gaze/docs/protocol.md`). Protocol conformance
  MUST be verified by an automated conformance suite (canned
  request/response pairs validated against the protocol schema).
  When Gaze bumps the protocol version, Reading Stone MUST open
  an alignment issue within one release cycle. (The pin moved
  from v1.1.0 to v1.2.0 via zero-dot-force/reading-stone#1,
  opened ahead of the v1.1.0 deadline.)
- **Conflict Resolution**: When two principles appear to conflict
  in a specific scenario, the tradeoff MUST be explicitly
  documented in the relevant spec or plan. No principle has
  implicit priority over another; resolution is context-dependent
  and requires written justification.

**Version**: 1.0.1 | **Ratified**: 2026-10-22
