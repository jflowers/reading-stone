# Feature Specification: Documentation Coverage and Cognitive Complexity (doc_coverage, cognitive_complexity)

**Feature Branch**: `005-doc-cognitive-methods`

**Created**: 2026-10-30

**Status**: Draft

**Input**: User description: "Implement the two methods added by protocol v1.2.0: `doc_coverage` and `cognitive_complexity`."

**Originating issue**: [zero-dot-force/reading-stone#6](https://github.com/zero-dot-force/reading-stone/issues/6) — doc_coverage and cognitive_complexity methods. Depends on #3 (shared analysis infrastructure — closed and landed; local `main` already carries the shared `prepareAnalysis` pipeline, the TypeScript analysis context, discovery, and the JSON-RPC dispatch this change wires into). The issue's proposed module layout is realized at plan time; this spec pins capabilities and wire contracts, not file paths — the one constraint being that new module names must not collide with the existing flat modules (`src/complexity.ts` is the cyclomatic engine, `src/coverage.ts` the Istanbul parser).

## User Scenarios & Testing *(mandatory)*

### User Story 1 — Documentation coverage rows over the `doc_coverage` method (Priority: P1)

As Gaze (the consuming platform), when I send a `doc_coverage` request carrying a project root and optional path patterns, I receive one row per public symbol — name, package, kind, file, declaration line, whether it is documented, and the first summary line of its documentation when one exists — so that documentation coverage reflects real declaration-level evidence (language-convention JSDoc) instead of heuristic backtick scanning over source text. Today reading-stone advertises `doc_coverage: false` and answers `-32601`, so Gaze's documentation insight falls back to the heuristic for TypeScript projects (the reference Python analyzer, snake-eyes, is the precedent this ports).

**Why this priority**: The method is the protocol-visible feature; without the wire contract and the capability flip there is nothing for the symbol surface (US3) to feed. P1 mirrors the platform value: heuristic doc coverage is the documented degrade path, so this closes the last doc-coverage gap in the analyzer fleet.

**Independent Test**: A fresh integration script spawns `node dist/main.js --stdio`, completes `initialize`, and issues `doc_coverage` with a fixture root. The response result contains a `symbols` array whose rows carry the six required fields and whose kind values all belong to the closed set. With the capability absent (pre-change build), the same request yields `-32601`.

**Acceptance Scenarios**:

1. **Documented and undocumented functions** — Given a fixture file exporting one function carrying a JSDoc comment (`/** Divide two numbers, raising an error for a zero divisor. */`) and one with none, when `doc_coverage` is requested, then the response contains exactly two `symbols` rows: the documented one with `documented: true` and `doc_snippet` equal to `Divide two numbers, raising an error for a zero divisor.`, the undocumented one with `documented: false` and no `doc_snippet` key.
2. **Symbols envelope and request parity** — Given any analyzable root, when `doc_coverage` is requested with and without a `patterns` array, then the result envelope is exactly `{"symbols": [...]}` (sorted keys, no additional fields), and the `patterns` semantics match the shared analysis-params validation of the existing methods (spec 002 FR-027): omitted means all discovered sources; present means the union of pattern matches; malformed shapes (`root_path` missing or non-string, `patterns` not a string array) yield the shared `-32602` error table verbatim.
3. **Row ordering and determinism** — Given a fixture root with several documented symbols across files, when `doc_coverage` is requested twice, then both responses are byte-identical and rows are ordered by `(file, line, name)` — the order shared with every other per-symbol row in this analyzer.
4. **File-set parity with analyze** — Given a project containing test files and generated directories alongside source files, when `doc_coverage` is requested, then the symbol rows cover exactly the source files `analyze` reports for the same root (test and generated arms excluded — spec 003 file-set parity), and no row references a file outside that set.
5. **Mode parity** — Given the same fixture root analyzed under a valid `tsconfig.json` (program mode) and without one (parse-only mode), when `doc_coverage` is requested, then the two symbol row sets are identical: detection is syntax-only and never depends on the type checker.
6. **Empty result is a valid result** — Given a root whose discovery yields source files but no exported declarations, when `doc_coverage` is requested, then the response is a success with `"symbols": []` — an empty project is never an error.

### User Story 2 — Cognitive complexity rows over the `cognitive_complexity` method (Priority: P1)

As Gaze, when I send a `cognitive_complexity` request carrying a project root and optional patterns, I receive one row per analyzed function — `package`, `function`, `file`, `line`, `cognitive_complexity` — so that GazeCRAP-CC and the `--max-cognitive-complexity` gate compute for TypeScript projects from native analysis. Today reading-stone advertises `cognitive_complexity: false` and answers `-32601`; the platform then reports no cognitive complexity and a set gate fails with "unavailable" (documented degrade path).

**Why this priority**: The method is the second protocol-visible feature; the algorithm (US4) only matters once rows flow over the wire. P1 mirrors the parity bar: snake-eyes already serves this method, so this restores analyzer-fleet parity for GazeCRAP-CC.

**Independent Test**: A fresh integration script spawns the server, completes `initialize`, and issues `cognitive_complexity` over a fixture root. The response result contains a `functions` array whose rows carry the five required fields; the identity key for the function is `function` (as in the coverage method), not `name` (as in the cyclomatic `complexity` method). With the capability absent (pre-change build), the same request yields `-32601`.

**Acceptance Scenarios**:

1. **Row model and envelope** — Given a fixture with several functions of varying complexity, when `cognitive_complexity` is requested, then the result envelope is exactly `{"functions": [...]}` (sorted keys), each row carries `package` (dotted module path via the shared derivation), `function`, `file`, `line`, and integer `cognitive_complexity`, rows are ordered by `(file, line, name)`, and repeated requests are byte-identical.
2. **Extraction parity with the cyclomatic complexity method** — Given the same request, when the row sets of `cognitive_complexity` and the existing `complexity` method are compared, then their `(file, line, name)` identities are equal: both walk the same extraction table over the same source arm (spec 002 FR-007/FR-008), so a function has a cognitive score if and only if it has a cyclomatic score.
3. **Request and error parity** — Given malformed requests (`root_path` missing or non-string; `patterns` not a string array), when `cognitive_complexity` is dispatched, then the responses match the shared `-32602` error table (spec 002 FR-027) verbatim, and an empty discovery yields a success with `"functions": []`.
4. **Mode parity** — Given the same fixture root analyzed in program mode and parse-only mode, when `cognitive_complexity` is requested, then the two row sets are identical: scoring is syntax-only.

### User Story 3 — The public symbol surface with kind classification (Priority: P2)

As the doc_coverage data source, I need the symbol surface — which declarations count as public symbols and how each maps to the protocol's closed kind set — defined once, so that documentation coverage is measured over the same public surface a consumer would import, and not over incidental internals.

**Why this priority**: The surface rules determine row *correctness* but are invisible at the wire-contract layer; they slot behind US1 and can be validated with focused fixtures. P2 mirrors how the classification vocabulary in spec 003 was prioritized behind its method.

**Independent Test**: A fixture project exporting one of each kind — `export function`, `export const` (value and function-like initializer), `export let`, `export class` with public methods and private members, `export interface`, `export type`, `export enum` — is scanned; the emitted rows and their `kind` values match the routing table in FR-002 exactly, and no row exists for non-exported declarations, private class members, re-exports, or namespace members.

**Acceptance Scenarios**:

1. **Kind routing** — Given the fixture above, when `doc_coverage` is requested, then each exported symbol's `kind` follows the routing table: `export function` → `function`; `export const` with a function-like initializer → `function`; other `export const` → `constant`; `export let`/`export var` → `variable`; `export class` → `class`; public methods, constructors, and accessors of an exported class → `method`; `export type`, `export interface`, `export enum` → `type`.
2. **Excluded surface** — Given a fixture containing non-exported declarations, `private`/`protected`/`#private` class members, re-exports (`export { x } from ...`, `export * from ...`), and namespace contents, when `doc_coverage` is requested, then none of these produce rows: only the exported module surface and the public members of exported classes count.
3. **Default exports** — Given `export default function divide(...)` and `export default divide`, when `doc_coverage` is requested, then the row's `name` follows the shared extraction identity (the declared name when one exists, else the literal `default`), and `kind` follows the declaration shape.
4. **Getter/setter pairs** — Given an exported class with a getter and setter for the same property, when `doc_coverage` is requested, then two `method` rows are emitted (one per accessor declaration line), each independently documented or not.
5. **Interface members are not symbols** — Given `export interface Shape { area(): number }`, when `doc_coverage` is requested, then one `type` row exists for `Shape` and no row exists for `area` — interface members are part of the type's documentation, not separately documented symbols.

### User Story 4 — The SonarSource algorithm on the TypeScript AST (Priority: P2)

As the cognitive_complexity data source, I need the SonarSource cognitive complexity rules — increments, nesting, and structural flow breaks — applied to the TypeScript AST exactly as SonarSource's own TypeScript implementation applies them, so that scores are comparable across analyzers and defensible against the spec the protocol field cites.

**Why this priority**: The algorithm determines score *correctness* but is invisible at the wire layer; the method (US2) ships it. Pinning it as normative fixtures (rather than prose alone) is what keeps it testable — the same approach spec 002 took for cyclomatic parity.

**Independent Test**: The normative fixture table in FR-010 is run as a golden test: each fixture function is scored and compared against its pinned value. Any mismatch is a spec failure — the values are normative, not illustrative.

**Acceptance Scenarios** *(values are normative; see FR-010 for the full table)*:

1. **Basic control flow** — `if (x) {}` scores **1**; `if (x) { if (y) {} }` scores **3**; a 4-deep if chain scores **10** (1+2+3+4); `if (a) {} else if (b) {} else {}` scores **3** (1+1+1 — else-if and else are flat); `if (x) {} else { if (y) {} }` scores **4** (if 1, else 1, nested if 2).
2. **Loops and switch** — each of `for`, `for-of`, `for-in`, `while`, `do` scores 1 at top level; a `switch` with three clauses scores **1** (case clauses never increment); `for > if > switch` scores **6** (1+2+3).
3. **Try/catch** — `try { g() } catch (e) { g() }` scores **1** (catch increments, try and finally do not); `try { g() } finally { g() }` scores **0**.
4. **Logical sequences** — `a && b` scores **1**; `a && b && c` scores **1** (one run of `&&`); `a && b || c` scores **2**; `a && b || c && d` scores **3**; `a ?? b` scores **1**; `if (a && b && c && d) {}` scores **2** — conditions of control structures are walked.
5. **Ternary and recursion** — `x ? 1 : 0` scores **1**; a ternary inside `if` scores **3** (1 + 2); `n <= 1 ? 1 : n * f(n - 1)` scores **2** (ternary + direct recursion); `if (n <= 1) { return 1 } return n * factorial(n - 1)` scores **2`; a direct `this.m(...)` self-call inside method `m` counts as recursion; mutual recursion does not count.
6. **Breaks and folding** — `outer: for (...) { if (x) { break outer } }` scores **4** (for 1 + nested if 2 + labeled break 1); a plain `break` adds nothing; an anonymous arrow inside a function (`xs.map((x) => (x ? 1 : 0))`) contributes its ternary at reset nesting → the enclosing function scores **1**.

### Edge Cases

- **Parse-only mode**: both methods are syntax-only and produce identical results in program and parse-only modes (Constitution P3 honored: the type checker is not needed for either feature).
- **Empty arrays**: a discovery yielding files but no matching symbols (US1 scenario 6) or no functions (US2 scenario 3) returns a success with an empty array — never an error.
- **Tags-only JSDoc**: a comment containing only block tags (`@param`, `@returns`, ...) marks the symbol `documented: true` (a JSDoc comment is attached) but emits no `doc_snippet` — the snippet is the first non-empty, non-tag line of the comment body, so a comment with no summary text has no snippet to show. The snippet key is omitted, never an empty string (spec 001 FR-013).
- **Overload signatures**: for overloaded declarations, documentation on the implementation signature counts; documentation on an overload signature alone does not — the implementation declaration is the symbol's documentation site (conservative, avoids double-counting).
- **Getter and setter**: two `method` rows, each judged independently (US3 scenario 4).
- **`??` cannot mix unparenthesized**: TypeScript grammar requires parentheses to mix `??` with `&&`/`||`; the run rule needs no special case for it.
- **IIFE and anonymous folding**: anonymous function-likes nested in a record fold into the record with nesting reset (spec 002 FR-009 and FR-010 fixture `xs.map(...)`), while named nested function-likes stop the walk — they carry their own rows.
- **Module-level statements**: statements outside any function-likes produce no cognitive rows (the extraction table has no record to host them); there is no synthetic module row.
- **Decorators**: decorators carry no increments and are transparent to the walk.

## Requirements *(mandatory)*

Requirements are numbered FR-001 through FR-015 and must be referenced by ID in tasks and checklists. Group headers organize the numbering.

**Functional Requirements — doc_coverage**

- **FR-001**: The `doc_coverage` method accepts a request of `{root_path: string, patterns?: string[]}` and returns `{"symbols": [...]}` with one row per public symbol. Each row carries `name`, `package`, `kind`, `file`, `line`, `documented`, and — when documentation exists — `doc_snippet`. `name` is the symbol's declaration name (the literal `default` for anonymous default exports); `package` is the dotted module path derived by the shared package derivation; `kind` belongs to the closed set `function | type | constant | variable | class | method`; `file` is root-relative with forward slashes; `line` is the 1-based declaration line; `documented` is a boolean; `doc_snippet` is a string, present if and only if a snippet exists (omitted otherwise, never empty — spec 001 FR-013). Rows are ordered by `(file, line, name)` via the shared record comparator.
- **FR-002**: The symbol surface is the exported module surface plus the public members of exported classes. Kind routing: `export function` → `function`; `export const` with a function-like initializer (function, arrow, generator) → `function`; other `export const` → `constant`; `export let`/`export var` → `variable`; `export class` (including abstract) → `class`; public methods, constructors, and accessors of an exported class (including abstract methods) → `method`; `export type`, `export interface`, `export enum` → `type`. Excluded: non-exported declarations, `private`/`protected`/`#private` class members, re-exports (`export { x } from ...`, `export * from ...`), and namespace members. Type-only exports surface only the named type symbol (its members are not separate symbols).
- **FR-003**: `documented` is true if and only if a JSDoc comment (`/** ... */`) is attached to the implementation declaration of the symbol. `doc_snippet` is the first non-empty line of the comment body that is not a block-tag line (a line whose first token begins with `@`), trimmed of the leading `*` and surrounding whitespace. A tags-only comment yields `documented: true` with no `doc_snippet`.
- **FR-004**: The file set analyzed by `doc_coverage` is identical to the source arm `analyze` reports for the same request (spec 003 file-set parity: test and generated arms excluded). `patterns` follows the shared analysis-params semantics (spec 002 FR-027).

**Functional Requirements — cognitive_complexity**

- **FR-005**: The `cognitive_complexity` method accepts a request of `{root_path: string, patterns?: string[]}` and returns `{"functions": [...]}` with one row per analyzed function. Each row carries `package`, `function`, `file`, `line`, and integer `cognitive_complexity`. The function identity key is `function` (matching the coverage method's row shape), not `name`. Rows are ordered by `(file, line, name)`; requests are otherwise processed with the same shared analysis-params validation and `-32602` error table as every other method (spec 002 FR-027).
- **FR-006**: Increments. `if`, `for`, `for-of`, `for-in`, `while`, `do`, `switch`, `catch`, and a conditional (ternary) expression each add 1 plus the current nesting level. `else` and `else if` add 1 flat. A `break` or `continue` referencing a label adds 1 flat (plain `break`/`continue` add nothing). A direct recursive call — a call to the enclosing function's own name, bare (`f(...)`) or via `this` (`this.m(...)`) within a class method — adds 1 per call site; mutual recursion adds nothing. `try` and `finally` add nothing. Case clauses never increment (the enclosing `switch` takes the single increment).
- **FR-007**: Nesting regions. The interior of each of the following is one level deeper than the structure itself: the `if` consequent, the `else-if` consequent, the `else` body, loop bodies, `switch` case clauses, `catch` blocks, and ternary branches. Nesting increments apply to constructs *lexically inside* the region, not to the region's own statement (an `else` is flat even though it sits inside the `if`'s region; a `case` clause is flat even though it sits inside the `switch`'s).
- **FR-008**: Logical sequences. A sequence of `&&`, `||`, `??` operators adds 1 for each maximal run of the same operator in the flattened chain: a single operator is a run of one (+1); each operator change starts a new run (+1). Parenthesized subexpressions are transparent to the flattening. Sequences anywhere in the record's walk (including control-structure conditions, which are walked) count.
- **FR-009**: Per-record domain. Each record's score is computed by a walk that starts at the record's body, stops at nested *extracted* function-likes (they carry their own records — spec 002 FR-009 folding), and continues through *anonymous* function-likes with the nesting level reset to 0 at the boundary. An empty body scores 0; there is no baseline increment (unlike cyclomatic complexity).
- **FR-010**: The following fixture values are normative (function shape → score): empty body → 0; `if (x) {}` → 1; `if (x) { if (y) {} }` → 3; 4-deep if chain → 10; `if/else-if/else` → 3; `if (x) {} else { if (y) {} }` → 4; `for-of` loop → 1; `while` → 1; `do` → 1; `switch` with 3 clauses → 1; `for > if > switch` → 6; `try/catch` → 1; `try/finally` → 0; `a && b` → 1; `a && b && c` → 1; `a && b || c` → 2; `a && b || c && d` → 3; `a ?? b` → 1; `if (a && b && c && d) {}` → 2; ternary → 1; ternary inside `if` → 3; `n <= 1 ? 1 : n * f(n-1)` → 2; `if (n <= 1) { return 1 } return n * factorial(n-1)` → 2; labeled `break` in `for > if` → 4; plain `break` in a loop → +0; `xs.map((x) => (x ? 1 : 0))` as a record's body → 1; `this.m(...)` self-call inside `m` with ternary → 2; `while > do` → 3.

**Functional Requirements — shared pipeline and server wiring**

- **FR-011**: Both methods are served by the shared analysis pipeline (`prepareAnalysis`): discovery reuses the shared walk, the request arm is the source arm, the extraction table reuses the shared extraction pass, and the program context's lifetime is owned by the handler and closed in its `finally` block — the pattern every existing method follows. New modules integrate with the flat `src/` layout without colliding with `src/complexity.ts` or `src/coverage.ts` (naming realized at plan time).
- **FR-012**: Server dispatch adds `doc_coverage` and `cognitive_complexity` to the method table with the shared unknown-method `-32601` behavior preserved for everything else; the reserved set shrinks to exactly `{analyze, stream}`. Both methods emit deterministic, byte-identical responses for identical requests (sorted JSON keys, stable row order — Constitution P1), and malformed params yield the shared `-32602` error table verbatim.
- **FR-013**: The `initialize` response's capabilities object flips `doc_coverage` and `cognitive_complexity` to `true`; `streaming` remains `false`; the other capabilities are unchanged. The capabilities object is the single source of truth for method availability.

**Bookkeeping and Quality**

- **FR-014**: The change updates the README method status table for both methods and materializes the OpenSpec spec deltas (protocol methods, capabilities, and the analyzer-porting contract impact) so the docs reflect the shipped capabilities. Spec artifacts and implementation land in separate commits (spec-first ordering).
- **FR-015**: CI gates must pass unchanged: `npx biome check src/ tests/`, `npm run build`, and `npx vitest run --coverage` at the protected 85% thresholds (lines, statements, functions, branches). The plan MUST specify a coverage strategy for the new modules (Constitution P4): unit suites for kind routing, snippet extraction, every increment/nesting/sequence rule, folding, and the normative fixture table; wire-level dispatch tests for both methods (envelope, ordering, determinism, error parity); the US1/US2 independent-test integration scripts are runnable against a built server.

## Key Entities

- **SymbolRow** — the `doc_coverage` wire record: `{name, package, kind, file, line, documented, doc_snippet?}` with the closed `kind` set (FR-001) and the (file, line, name) record order shared across the analyzer.
- **CognitiveRow** — the `cognitive_complexity` wire record: `{package, function, file, line, cognitive_complexity}` (FR-005).
- **Symbol surface** — the exported module declarations plus public members of exported classes, routed to kinds by declaration shape (FR-002).
- **Walk state** — the per-record scoring state: an increment accumulator, the current nesting level, and the enclosing function name (for recursion detection); reset at anonymous-function boundaries (FR-009).

## Success Criteria

- **Protocol fidelity**: responses to `doc_coverage` and `cognitive_complexity` conform to the analyzer protocol v1.2.0 schemas — field names (including `function` vs `name`), closed kind set, optional `doc_snippet` omitted-never-empty, and the capabilities handshake (FR-001, FR-005, FR-013). Deviations are bugs.
- **Detection accuracy**: the symbol surface and cognitive scores match the normative fixtures and routing table exactly (FR-002, FR-003, FR-010); ambiguity resolves toward the documented default, never toward omission.
- **Parity**: extraction identity matches the cyclomatic complexity method row-for-row; file sets match `analyze`'s source arm; mode parity holds (syntax-only).
- **Quality gates**: the protected CI gates pass unchanged (FR-015), with the coverage strategy the plan is required to specify.

## Assumptions

1. **Protocol pin**: Gaze analyzer protocol v1.2.0 as pinned in the constitution; schemas and capability names are read from the protocol document, not inferred.
2. **SonarSource semantics are the algorithm**: the protocol field is defined as the SonarSource cognitive complexity score, and SonarSource's own TypeScript implementation (eslint-plugin-sonarjs) is the normative TS/JS reference — cross-validated against Gaze's Go port for the constructs both languages share.
3. **Divergences from the Gaze Go port are intentional and documented** (the Go port is a language-port simplification, not the TS norm): reading-stone walks `if`/`loop`/`switch` conditions (Gaze does not), scores ternaries (Go has none), counts labeled `break`/`continue` (Gaze counts only `goto`), and resets nesting at anonymous function boundaries (Gaze carries nesting through function literals).
4. **SonarJS lint refinements are not adopted**: the default-value-pattern carve-out (`x = x || {}`) and the JSX short-circuit carve-out stay out of scope — they are lint-rule policy, not the complexity spec. May be revisited via a future change.
5. **Issue #6's construct list** (`if/for/while/do/catch/case`) is interpreted as the cyclomatic decision-point family (spec 002 FR-021), with `case` mapping to the enclosing `switch`'s single increment — per-case counting would break SonarSource conformance.
6. **Cognitive rows use the `function` key** (matching the coverage method), not `name` (matching the cyclomatic `complexity` method) — the protocol document's schema is authoritative over sibling-method symmetry.
7. **The symbol surface is the exported surface**: non-exported declarations, private members, re-exports, and namespaces are out of scope for documentation coverage; this matches the platform's intent (documentation of the importable surface) and snake-eyes' module-level surface.
8. **`export const` with function-like initializer routes to `function`**: the symbol's public contract is callable. Arrow consts and function consts are indistinguishable to consumers.
9. **`documented` requires an attached JSDoc comment on the implementation declaration**: line comments (`//`) and overload-signature-only docs do not count; the conservative reading avoids over-reporting coverage.
10. **`doc_snippet` is the summary line**: first non-empty, non-tag line of the comment body — a tags-only comment is documentation but has no summary to surface. Snippet is omitted when absent, never an empty string (spec 001 FR-013).
11. **Default exports** are named per the shared extraction identity: declared name when one exists, else the literal `default` — consistent with the `analyze`/`complexity` extraction table (spec 002 FR-007/FR-008).
12. **Syntax-only**: both features run identically in program and parse-only modes — the type checker is not consulted (a doc/JSDoc and control-flow walk needs only the bound AST). This keeps the optional-program degrade path (spec 002 FR-004) whole for both methods.
13. **No new runtime dependencies**: the features use the TypeScript compiler API and existing shared modules only (Constitution P5 — dependency necessity).
14. **Timeouts are platform-side**: the 5-minute soft timeouts in the protocol document are Gaze's enforcement; reading-stone only needs deterministic, bounded per-request work (Constitution P1).
15. **Module layout is a plan-time decision**; the spec pins contracts and surfaces, not file paths. The only constraint carried forward: new flat `src/` module names must not collide with `src/complexity.ts` (cyclomatic) or `src/coverage.ts` (Istanbul coverage parser).
16. **README status table** is the user-facing surface for capability flips and is updated in the same change as the implementation (FR-014).

## Change Log

| Date | Version | Description | Author |
|------|---------|-------------|--------|
| 2026-10-30 | 1.0 | Initial draft | speckit.specify (AI) |
