# Research: Analysis Engine (analyze, complexity, coverage)

**Feature Branch**: `002-analysis-engine`
**Date**: 2026-10-27
**Status**: Complete — the spec is decision-complete (14 assumptions, 31
FRs); this document verifies the technical mechanics behind each pinned
decision and records the implementation-strategy choices the spec leaves
open, each with rationale and rejected alternatives.

Sources consulted: Gaze protocol v1.2.0 (pinned by the constitution), the
feature spec (`specs/002-analysis-engine/spec.md`), the reading-stone
codebase (`src/`, `tests/`, spec 001 artifacts — the foundation this
change builds on), the TypeScript compiler API (^7, the existing
devDependency), the snake-eyes reference implementation (local checkout;
its `analysis-methods` change is the direct precedent for detector/
complexity/coverage splitting and its coverage parser for artifact
consumption), the Istanbul coverage JSON format (as emitted by vitest and
jest), and Dewey prior learnings (snake-eyes analysis-methods and
classify-signals design decisions, transport hardening bounds, taxonomy
provenance).

---

## R1: Program bootstrap — tsconfig → `ts.Program`, and a bounded compiler host

**Decision**: `src/program.ts` exports
`buildProgramContext(realRoot, sourceFiles, stderr)` → `ProgramContext`.
When `tsconfig.json` exists at the resolved root and parses cleanly
(R3), bootstrap via:

1. `ts.readConfigFile(tsconfigPath, boundedRead)` — the config text is
   read through the bounded reader (16 MiB cap, strict UTF-8, one stderr
   diagnostic per skip); a skip or parse error triggers the parse-only
   fallback (FR-004).
2. `ts.parseJsonConfigFileContent(config.config, host, realRoot)` —
   extracts the compiler options; errors other than the ignorable
   no-inputs diagnostic trigger fallback (R3).
3. `ts.createProgram(rootNames, options, host)` with:
   - **`rootNames` = the in-scope discovered source files** (absolute
     paths), NOT the tsconfig's `include`/`files` output. This
     structurally guarantees FR-003's "every in-scope discovered file is
     covered by the program" regardless of the project's include/exclude
     patterns.
   - **Option adjustments** (the FR-006 "as needed" surface):
     `noEmit: true`, `incremental: false`, `composite: false`,
     `tsBuildInfoFile: undefined`, `skipLibCheck: true`,
     `allowJs: true`, `checkJs: false`. Everything else (paths, baseUrl,
     strict, target, module resolution, …) is used verbatim from the
     project's config — the project's code as it exists (US2 scenario 6).
   - **A custom `CompilerHost`** (built by wrapping
     `ts.createCompilerHost(options)`) whose `readFile` serves in-scope
     file texts from a pre-read cache (populated asynchronously through
     the existing `readBounded` before program construction) and applies
     a **synchronous bounded read** (new `safeio` helper:
     `lstatSync` regular-file check → 16 MiB size cap → bounded
     `readFileSync` → strict UTF-8 decode; one stderr diagnostic +
     `undefined` on skip) to every other path the compiler resolves.
     `getSourceFile` uses the host default over this `readFile`.

**Rationale**: FR-003/FR-006 mandate the compiler's own semantics, and
`ts.createProgram` with explicit `rootNames` is the documented public
API for constructing a program over a chosen file set. The option
adjustments are Constitution V load-bearing:

- **No writes**: `incremental`/`composite`/`tsBuildInfoFile` would write
  `.tsbuildinfo` state during program construction — force-disabled so
  analysis is strictly read-only.
- **Bounded reads everywhere**: without the custom host, the compiler's
  default host reads transitively-resolved files (the analyzed project's
  `node_modules` — untrusted analyzed-tree content) via unbounded
  `ts.sys.readFile`, bypassing the 16 MiB cap. The wrapper extends the
  safe-reader invariant to the whole program. Skipped transitive files
  resolve as absent modules; their types degrade to `any`, which FR-017
  reports as ambiguity — graceful degradation, never a crash.
- **Default lib files** (the `typescript` package's own `lib/*.d.ts`) are
  read through the same bounded wrapper (cap + regular-file check) but
  without root containment — they are the analyzer's dependency, not
  analyzed-tree content. Any other compiler-resolved path outside the
  analysis root returns `undefined` (one diagnostic): a tsconfig with
  `typeRoots` pointing outside the root degrades to `any` types rather
  than reading out-of-root trees.
- `skipLibCheck: true` is a pure win: diagnostics are ignored entirely
  (FR-005), so lib checking is wasted work.
- `allowJs: true` unconditionally guarantees FR-006 (JS-family files in
  the program) even when the project's config omits it; it changes
  nothing else observable because in-scope files are already decided by
  discovery.

**Type errors never abort** (FR-005): the bootstrap never consults
`program.getSyntacticDiagnostics()`/`getSemanticDiagnostics()` as a gate.
The `TypeChecker` (`program.getTypeChecker()`) is lazy — symbol and type
resolution happens on demand during detection, and errors surface as
`any`/error types that FR-017's ambiguity rules handle.

**Alternatives considered**:
- *Use the tsconfig's computed `fileNames` as rootNames*: rejected —
  include/exclude would then decide coverage, violating FR-003's
  every-in-scope-file mandate (a file outside `include` would silently
  lose type information).
- *`ts.createSolutionBuilder` for project references*: rejected — builds
  referenced projects (emit/write risk, Principle V) and adds failure
  modes the spec does not ask for; references' files enter only via our
  rootNames and module resolution.
- *Default compiler host (unbounded reads)*: rejected — violates the
  Constitution V resource-bound invariant for transitively-read
  analyzed-tree content.
- *`noResolve: true` to avoid transitive reads entirely*: rejected —
  breaks import symbol resolution across in-scope files, gutting the
  TypeChecker's value (FR-003's reason to exist).

## R2: Parse-only fallback mechanics

**Decision**: Without a usable tsconfig (missing, unreadable, or
unparseable — R3), each in-scope file is parsed independently with
`ts.createSourceFile(absPath, text, ts.ScriptTarget.Latest,
/*setParentNodes*/ true, scriptKind)` where `text` comes from
`readBounded` (16 MiB budget — a JSON-free whole-file read) and
`scriptKind` is derived from an explicit extension map (`.ts`→TS,
`.tsx`→TSX, `.js`/`.mjs`/`.cjs`→JS, `.jsx`→JSX). A `null` readBounded
result (skip diagnostic already written) excludes the file. A
`RangeError` escaping `createSourceFile` (pathological nesting) is
caught and treated as a skip with one diagnostic (see R15).

**Rationale**: FR-004 pins the fallback; `ScriptTarget.Latest` accepts
every current syntax (decorators, `using`, satisfy, …) — rejecting code
for target reasons would be a false negative. The explicit ScriptKind
map is deterministic and self-contained rather than relying on the
compiler's filename inference. The parser is error-tolerant: parse
diagnostics are ignored and analysis proceeds on the recovered tree (spec
edge case) — a file is never dropped for failing to parse.

**Alternatives considered**:
- *Rely on `createSourceFile`'s extension inference*: rejected —
  implicit behavior for `.mjs`/`.cjs` is version-dependent surface; the
  explicit map is auditable and testable.
- *Use the tsconfig's `target` when present but `Latest` in fallback*:
  the program mode gets target from the config verbatim (R1); fallback
  has no config, so `Latest` is the only non-arbitrary choice.

## R3: Broken-tsconfig boundary — what triggers fallback

**Decision**: The parse-only fallback triggers when (a) `tsconfig.json`
is absent at the resolved root, (b) the bounded read skips it, (c)
`ts.readConfigFile` reports a parse error, or (d)
`ts.parseJsonConfigFileContent` reports any error **except** the
no-inputs diagnostic (a config with empty `include` matching nothing —
irrelevant to us because we override `rootNames`). The fallback is never
an error (FR-004: a broken tsconfig degrades precision, never
availability) and is invisible on the wire.

**Rationale**: The spec pins "unparseable" as the trigger; the no-inputs
exclusion is the one config-level error that cannot affect our
bootstrap (rootNames are ours). Everything else (invalid option values,
malformed JSON, unreadable file) conservatively degrades to parse-only.

**Alternatives considered**:
- *Fallback on every `parseJsonConfigFileContent` error*: rejected — the
  no-inputs error is common in configs designed to be extended
  (`"files": []`), and falling back there would silently discard type
  information for specious reasons.
- *Attempt to salvage partial options from an erroring config*: rejected
  — unpredictable surface; fallback is the documented, deterministic
  degradation.

## R4: Function extraction — node kinds, identity, attribution

**Decision**: `src/extract.ts` walks each in-scope source file once and
collects **extracted function-likes** (FR-007):

| Form | Node shape | Record name |
|------|-----------|-------------|
| Function declaration | `FunctionDeclaration` with `body` | declared name |
| Class method | `MethodDeclaration` with `body`, parent class-like | method name |
| Object-literal method | `MethodDeclaration` with `body`, parent `ObjectLiteralExpression` | method name |
| Constructor | `ConstructorDeclaration` with `body` | `"constructor"` |
| Getter/setter | `Get/SetAccessorDeclaration` | property name |
| Variable-assigned function | `VariableDeclaration` whose initializer is `ArrowFunction`/`FunctionExpression` | variable name |
| Object-literal function property | `PropertyAssignment` whose initializer is `ArrowFunction`/`FunctionExpression` | property name |
| Class-property initializer | `PropertyDeclaration` whose initializer is `ArrowFunction`/`FunctionExpression` | property name |
| Default export | `FunctionDeclaration` without a name under `export default`, or `ExportAssignment` whose expression is `ArrowFunction`/`FunctionExpression` | `"default"` |

Excluded: body-less overload signatures (only the implementation
declaration is extracted — spec edge case), `declare function`, abstract
methods, interface method signatures, and unassigned function
expressions (IIFEs, call-argument callbacks — their bodies scan into the
innermost enclosing extracted function per FR-009). Nested
function-likes inside another extracted function's body are separate
records. The declaration line is the 1-based line of the node's start
(`sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))`).

**Attribution (FR-009)**: each record's effect/decision-point walk
starts at its own body and **stops descending at nested extracted
function-likes** (they own their bodies); anonymous function-expression
bodies (not in the extraction set) are traversed as part of the
enclosing record, with a deferral flag set inside callbacks passed to
scheduling constructs (R6, DeferredReturnMutation).

**Ordering (FR-008/FR-020)**: records are sorted by `(file, line,
name)` with the platform-default stable sort over deterministic
source-order emission — ties (a getter/setter pair on one line, same
name) resolve by AST position through sort stability.

**Rationale**: The table is the closed, auditable reading of FR-007/008
plus the spec's edge-case list; a table-driven extractor is trivially
conformance-testable per row. The stop-at-nested-boundary rule makes
innermost-enclosing attribution structural rather than a post-hoc
reassignment.

**Alternatives considered**:
- *Extract IIFEs and inline callbacks as records*: rejected — the spec
  pins the FR-009 convention (reference-analyzer lambda handling) and
  the unreported-at-module-level edge case.
- *Two-pass extraction (collect then attribute)*: rejected — the
  single-walk boundary rule is simpler and produces the same result.

## R5: Lexical scope tracking for write classification

**Decision**: `extract.ts` maintains a lightweight scope tracker per
file: a stack of scopes, each mapping binding names to their declaration
kind (module-scope declarations from `SourceFile`-level statements —
variable declarations, functions, classes, imports — versus
function-scope parameters and locals). Write classification (FR-014)
resolves the written identifier against this stack:

- binding declared at module scope, written from inside a function →
  `GlobalMutation`;
- binding declared in an enclosing *function* scope, written from a
  nested function/callback → `ClosureCaptureMutation` (P4) or
  `DeferredReturnMutation` (P1, when the write sits inside a deferred
  callback — R6);
- binding declared in the writing function's own scope → no effect
  (local state).

The tracker is purely lexical (name → declaration scope), used in both
program and parse-only modes. In program mode the TypeChecker is still
the authority for *types* (FR-015 param kinds, FR-017 any-receivers) —
the tracker never re-implements type semantics, only scope addresses.

**Rationale**: FR-014's GlobalMutation/closure distinction is a scope
question, not a type question; lexical resolution is deterministic,
works identically in parse-only mode (where no checker exists), and
handles imports naturally (import statements declare module-scope
bindings). This is a scope-address calculation over the AST the compiler
produced — not a reimplementation of TypeScript semantics (Principle
III).

**Alternatives considered**:
- *Checker-only resolution (`checker.getSymbolAtLocation`)*: rejected as
  the primary mechanism — unavailable in parse-only mode and
  cross-file-heavy; kept as the type authority where types (not scopes)
  are the question.
- *No closure distinction (report all enclosing-scope writes as
  GlobalMutation)*: rejected — explicitly forbidden by FR-014's letter.

## R6: Effect detection rule set (FR-010–FR-019)

**Decision**: `src/detector.ts` implements one deterministic rule table
over the extraction walk; the full construct→type mapping (including
dual emissions, precedence, and every P1–P4 name-form list) is the
normative disposition table in [data-model.md](data-model.md). The
load-bearing decisions beyond the spec's pinned rules:

1. **Dual emission order and dedup**: `throw` emits `ErrorSignal` +
   `ErrorReturn` at one construct; `process.exit` emits `ProcessExit` +
   `ErrorSignal` (never `ErrorReturn`, FR-012). Within a record, effects
   are finally sorted by `(line, column, canonical type name)` — a
   total, documented order (R8).
2. **Sentinel attachment (FR-013)**: module-scope Error-subclass class
   declarations and Error-instance constants are detected at
   `SourceFile` level and attached (with their own declaration location)
   to the file's first record by source order — identified before the
   global sort, by minimal `(line, position)`; a file with no records
   carries no sentinel.
3. **Write-form boundary**: FR-014's receiver/global rules are the
   assignment forms (simple, compound, increment/decrement, `delete`);
   method-call mutations are classified by FR-015's param split and the
   ContainerMutation rule (membership methods on non-parameter
   receivers). Method-form mutations of `this`/module state outside
   those closed lists are a documented boundary (disposition table).
4. **Precedence among overlapping name-form rules**: receiver-specific
   rules win over generic ones — `console.*`/`process.stdout.write` →
   StdoutWrite/StderrWrite (not WriterOutput); fs write APIs →
   FileSystemWrite (not WriterOutput); `MessagePort`-family `.close()` →
   ChannelClose (not ResourceManagement); prototype writes and imported
   namespace property writes → MonkeyPatch (not GlobalMutation).
5. **Deferred callbacks (DeferredReturnMutation, P1)**: the deferral
   boundary is the closed scheduling set `setTimeout`, `setInterval`,
   `queueMicrotask`, `process.nextTick`, `.then`/`.catch`/`.finally`,
   `addEventListener` — writes to enclosing function-scope bindings
   inside their callbacks are deferred mutations; the same writes in
   non-deferred immediate closures are `ClosureCaptureMutation` (P4).
   This is also Assumption 8's documented deferred-callback
   false-positive caveat: effects inside scheduled callbacks are
   attributed to the enclosing extracted function (FR-009) even though
   they execute later.
6. **`target` fields**: the written path as written (`this.x`, `p.x`,
   the base identifier for element writes, the binding name for
   identifier writes); `throw` targets the constructor name for
   `new X(...)` and is omitted otherwise. `location` is always the
   construct's `file:line:col` (root-relative). Description strings are
   fixed deterministic templates (implementation-defined wording,
   version-stable — pinned by golden tests, not by the contract).

**Rationale**: Each rule is a closed, fixture-testable set; the
precedence list removes double-counting; the P1 name-form FP surfaces
are the documented imprecision FR-010 accepts at P1. Canonical types are
constructed through `resolveSideEffectType` (FR-018) with
`serializeEffect`'s existing validation as defense in depth; no effect
sets `classification` (FR-019 — the field is omitted, wire-equivalent to
the protocol's null fallback per Assumption 4).

**Alternatives considered**:
- *Interprocedural effect propagation (caller inherits callee effects)*:
  rejected — the protocol attributes effects to the declaring function
  (single source of truth, snake-eyes precedent); callers duplicating
  callees' effects would multiply-count across records.
- *Sort effects by emission order only*: rejected — dual emissions and
  sentinel attachment make pure emission order under-specified; the
  `(line, column, type)` key is total.

## R7: Ambiguity rules and the parse-only boundary (FR-017)

**Decision**: Ambiguous effects (carrier `CallbackInvocation`,
`detail: {"confidence": "ambiguous"}`, description naming the
unresolved construct) are emitted for:

- **Always (syntactic forms, both modes)**: `eval(...)` calls;
  `new Function(...)`; calls through computed members (`obj[key]()`);
  calls on receivers that are lexically unresolvable identifiers.
- **Program mode only (type-based)**: calls on `any`/error-typed
  receivers; calls whose callee resolves to no declaration (unknown
  globals).

Calls that resolve to declarations (locally-defined functions, imported
project symbols, name-form-known APIs matched by a detection rule) are
never reported as ambiguous — the zero-false-positive carve-out; their
effects belong to their own records. In parse-only mode, type-based
ambiguity does not apply (there are no types): name-form rules still
match by construct, and calls on lexically-resolvable receivers are
treated as resolved (attributed to their own definitions, not
re-reported) — the documented parse-only FP/FN boundary in the
disposition table's CallbackInvocation row.

**Rationale**: FR-017's mandate is ambiguity over omission; flooding
parse-only output with an ambiguous effect for every method call would
make the mode useless (every call is "unresolved" without types), so the
syntactic/type-based split keeps the mandate's letter (the four listed
forms always reported) while documenting the mode boundary.

**Alternatives considered**:
- *Emit ambiguity for every unresolved call in parse-only mode*:
  rejected — turns parse-only analysis into noise; the boundary is
  documented instead (Principle II's documented-boundary pattern).
- *Omit ambiguity entirely in parse-only*: rejected — the syntactic
  forms (eval, computed members) are exactly the dynamic constructs
  Principle II names.

## R8: Determinism rules (Constitution I)

**Decision**: All outputs are pure functions of the input tree and
analyzer version:

- Records/entries: `analyze` and `complexity` sorted by `(file, line,
  name)` (stable sort over source-order emission — R4); `coverage`
  sorted by `(file, start_line, function)` (FR-024).
- Effects within a record: sorted by `(line, column, canonical type
  name)` (R6).
- Serialization: the existing sorted-key recursive serializer
  (`protocol.serialize`) already produces byte-identical output;
  percentage values serialize at full float precision with no rounding
  (Assumption 6 — deliberately differing from the reference analyzer's
  1-decimal rounding; the spec is authoritative).
- No timestamps, environment, host, or locale data anywhere in results;
  stderr diagnostics are fixed-template functions of the tree.

**Rationale**: Constitution I mandates byte-identical repeat responses;
every ordering is a documented total order, and golden tests (SC-003/
SC-006) pin them.

**Alternatives considered**: none — the rules are the spec's FR-020/
FR-022/FR-024 made structural.

## R9: Cyclomatic complexity counting (FR-021/FR-022)

**Decision**: `src/complexity.ts` counts, over the same extraction set
and attribution walk as `analyze` (R4 — one shared extraction surface):
1 + the occurrences of `IfStatement`, `ForStatement`, `ForOfStatement`,
`ForInStatement`, `WhileStatement`, `DoStatement`, `CaseClause`
(`DefaultClause` excluded), `CatchClause`, `ConditionalExpression`
(ternary), and `BinaryExpression` nodes whose operator is `&&`, `||`, or
`??`. Each `else if` is a nested `IfStatement` and counts naturally.
Logical-assignment operators (`&&=`, `||=`, `??=`) are not counted
(closed list, Assumption 10). An empty body scores 1. Entries carry
exactly `name`, `package`, `file`, `line`, `complexity`.

**Rationale**: The list is the spec's closed list verbatim; sharing the
extraction walk structurally guarantees FR-022's "same extraction set,
scope, and ordering" — there is no second extraction path to drift.

**Alternatives considered**:
- *Count logical assignments*: rejected — Assumption 10 pins the closed
  list; adding operators is a spec change, not an implementation choice.

## R10: Istanbul coverage document model and attribution (FR-023–FR-026)

**Decision**: `src/coverage.ts` reads `<root>/coverage/coverage-final.json`
through `readBounded` at the full 16 MiB budget (JSON cannot parse from
a truncated prefix — the `package.json` precedent), then parses the
Istanbul shape: a top-level object keyed by **absolute file paths**,
each value carrying `statementMap` (id → `{start:{line,column}, end:
{line,column}}`), `fnMap` (id → `{name, decl:{start,end}, loc:{start,
end}}`), and `s` (statement id → execution count). Attribution per file
entry: each statement in `statementMap` is assigned to the **innermost**
`fnMap` function whose `loc` range contains the statement's start
(positions compared as `(line, column)`; innermost = smallest span;
ties broken by fnMap key lexicographic order). `covered_stmts` counts
attributed statements with `s[id] > 0`; `total_stmts` counts all
attributed; `percentage = (covered / total) * 100`, exactly `0.0` when
`total_stmts` is 0 (never a division error). Entries carry `file`
(root-relative POSIX), `function` (fnMap name verbatim, including
`(anonymous_N)`), `start_line` (`decl.start.line`), `end_line`
(`loc.end.line`), `covered_stmts`, `total_stmts`, `percentage`.

Degradation ladder (all produce `{"functions": []}`, never a JSON-RPC
error — FR-025): absent file, skipped read, JSON parse failure,
non-object top level. Per-entry tolerance (FR-026): within a parseable
document, a file entry missing/malforming `statementMap`, `fnMap`, or
`s` is skipped silently (documented policy, mirroring the `.d.ts`
exclusion precedent) while conforming entries are reported. File keys
not under the resolved root (lexical containment via
`path.relative`) are skipped (spec edge case). `patterns` filter
entries by the FR-001 prefix rules (same helpers as analyze — R11).

**Rationale**: The Istanbul shape is what vitest's and jest's
JSON reporters emit; the innermost-container rule is FR-023's pinned
algorithm and handles nesting (spec scenario US4-7). The empty-result
fallback resolves the protocol's "analyzer runs tests" wording against
Principle V (FR-025 — the constitution's required conflict-resolution
record): reading-stone consumes the pre-existing artifact, never
executing analyzed code.

**Alternatives considered**:
- *Run the project's tests to produce coverage*: rejected — violates
  Principle V (analyzed code is untrusted and must never execute).
- *Round percentage to one decimal (reference-analyzer parity)*:
  rejected — Assumption 6 pins full precision; the spec is authoritative
  over the precedent.
- *Conform coverage entries to discovered source files*: rejected —
  FR-024 pins root containment + patterns only; discovery confinement
  would silently drop entries the spec requires reporting.

## R11: `patterns` semantics (FR-001)

**Decision**: `src/analysis.ts` owns pattern handling. Normalization:
absent, `null`, empty array, or the array being exactly `["./..."]` or
`["..."]` → whole tree (a `null` prefix set). Otherwise each element is
normalized by stripping one leading `./` and one trailing `/...` into a
directory prefix. A file is in scope when its root-relative POSIX path
equals a prefix or begins with `prefix + "/"`; patterns union. A
pattern set matching nothing yields empty results, never an error.
Edge cases documented: an empty-string or `"."` pattern matches nothing
(no path equals it or begins `"./"`); a lone `"..."` element inside a
larger array normalizes to the prefix `"..."` and matches nothing (only
the exact singleton forms are catch-alls).

**Rationale**: FR-001's letter, made total and deterministic. The
helpers are shared by analyze/complexity scope filtering and coverage
entry filtering (FR-024), so "the same path-prefix rules" is structural.

**Alternatives considered**:
- *Glob/regex interpretation of patterns*: rejected — FR-001 pins
  prefix semantics (Go-style package patterns, minus recursion
  semantics which collapse into prefixes).

## R12: Module layout and layering

**Decision** (full tree in [plan.md](plan.md)): `analysis.ts` composes
the per-request pipeline — `resolveRoot` (newly exported from
`discovery.ts`; identical `-32602` semantics) → walk/screen/classify →
test files excluded from analysis (FR-002) → pattern filter →
`buildProgramContext` → `extractFunctions` — exposing
`prepareAnalysis(rootPath, patterns, stderr)` for the `analyze` and
`complexity` handlers and a narrower scope/`resolveRoot` surface for
`coverage` (which walks nothing). `detector.ts`, `complexity.ts`, and
`coverage.ts` are independent computations over the extraction/context
surfaces. Dependency direction:
`server → {analysis, detector, complexity, coverage} → {extract,
program, discovery, safeio, taxonomy, models}` — acyclic; discovery
keeps throwing `InvalidRootPathError` for the server to map (no
layering inversion, mirroring 001's research R9 decision).

**Rationale**: One pipeline guarantees analyze/complexity parity
(FR-022) structurally; per-method modules mirror the reference
analyzer's proven split and keep each computation independently
testable (Constitution IV). Server-side param validation
(`root_path`/`patterns`, FR-027) is a shared helper in `server.ts`,
mirroring how `discover` validates at the dispatch layer.

**Alternatives considered**:
- *One `analyze.ts` monolith*: rejected — SRP and testability; the
  complexity/coverage methods would drag detector code along.
- *Handlers composing the pipeline inline*: rejected — duplicates the
  composition in two handlers and opens drift between analyze and
  complexity extraction sets.

## R13: Testing and coverage strategy (Constitution IV)

**Decision**: New suites mirror modules one-to-one (tree in
[plan.md](plan.md)):

- **Unit** (`analysis`, `program`, `extract`, `detector`, `complexity`,
  `coverage` test files): pattern normalization table tests; bootstrap
  fixtures (valid tsconfig → program+checker covering every in-scope
  file; absent → parse-only; unparseable/invalid → parse-only; type
  errors → completes; `.js`/`.mjs` analyzed); extraction identity per
  R4 row plus the spec edge cases (overloads, accessors, default
  export, class-property initializers, IIFE attribution, anonymous
  module-level effects unreported); detector rule fixtures — **one
  fixture per P0 type** asserting exact type/location/target with zero
  extras (SC-001), purity fixtures (SC-002), P1 rule fixtures,
  ambiguity fixtures, sentinel attribution; complexity decision-point
  fixtures (closed list, nesting exclusion, empty body); coverage
  attribution fixtures (innermost, zero-statement, anonymous names,
  per-entry tolerance, out-of-root keys, patterns filter, vitest- and
  jest-shaped documents — SC-004).
- **Protocol conformance** (`server.test.ts` edits): canned
  request/response pairs through `Server.run()` for all three methods;
  the full `-32602` error table; the shrunk reserved `-32601` set.
- **Golden determinism** (SC-003/SC-006): repeat canned requests,
  byte-compare serialized responses for all three methods.
- **Disposition conformance** (`disposition.test.ts`): the table in
  `docs/effect-disposition.md` covers the 48 canonical names exactly
  once, dispositions come from the closed set, every N/A row carries
  non-empty rationale, P1 rows carry detect mappings (SC-008).
- **Strategy**: fixtures are `mkdtemp` trees written in-test and
  hand-authored Istanbul JSON documents (Assumption 14) — hermetic, no
  network, no execution of analyzed code, no test runs during analysis.
  Per-module coverage targets ≥ 85%, matching the protected project
  gate (SC-007); the gate is never lowered.

**Rationale**: Constitution IV requires the strategy in the plan and
conformance suites for the protocol; the P0 fixture-per-type suite is
the spec's own SC-001 definition.

**Alternatives considered**:
- *Snapshot tests instead of explicit assertions*: rejected for records
  (TC-004: behavioral assertions on types/locations/targets are the
  contract); golden byte-comparison covers serialization stability
  separately.

## R14: Dependency promotion and cross-pipeline bookkeeping (FR-029/FR-031)

**Decision**: `package.json` moves `typescript` (^7.0.2, unchanged
range) from `devDependencies` to `dependencies` — the runtime promotion
the spec pins, justified by Principle III (the compiler API is the
mandated analysis infrastructure; no smaller-surface alternative
provides TypeScript semantics) and adding no new supply-chain surface
(same package, same version, already in the lockfile). In the same
change: `openspec/specs/server/spec.md`'s dispatch requirement is
updated to the six built-in handlers with the reserved list shrunk to
`test_mapping`, `classify_signals`, `analyze/stream`, `doc_coverage`,
`cognitive_complexity`; `openspec/specs/protocol/spec.md`'s
reserved-list/capability assertions are updated where they name the
core methods; `README.md`'s method table flips the three rows to
Implemented; `AGENTS.md` records the runtime dependency and new module
layout.

**Rationale**: FR-029/FR-031 pin this; mirroring spec 001 Assumption 12,
the materialized specs must not contradict the shipped dispatch table.

**Alternatives considered**:
- *A bundler or API-surface reduction to keep typescript a devDependency*:
  rejected — FR-029 explicitly ratifies the promotion; the analyzer is
  spawned with the compiler API on its runtime path.

## R15: Resource bounds for AST work (Constitution V)

**Decision**: Two guards beyond the existing safe-read bounds:

1. **AST visit depth budget** (a fixed constant, e.g. 2000 — far beyond
   real-world nesting): the extraction/detection walk tracks depth; on
   exceed, the walk aborts for that file, one stderr diagnostic is
   written (`reading-stone: skipping <relPath>: ast depth exceeds
   budget`), and the file contributes no records — the same diagnosed
   file-level degradation pattern as safe-read skips, never a silent
   omission and never a crash.
2. **Parser stack-overflow guard**: a `RangeError` escaping
   `ts.createSourceFile` on pathological nesting is caught and treated
   as the same skip-with-diagnostic.

**Rationale**: The constitution requires AST depth and recursion
budgets; 16 MiB of adversarial nesting could otherwise exhaust the
native stack. Diagnosed degradation (one stderr line, file excluded)
honors Principle II's "acknowledged uncertainty" pattern — the
alternative (silently truncated walks) would be a silent false
negative.

**Alternatives considered**:
- *Iterative (explicit-stack) visitors*: rejected — complexity for a
  pathological-only path; the budget + diagnostic is simpler and
  honest.
- *Unbounded recursion with a global try/catch*: rejected — a
  mid-request crash would abort the whole analysis; the per-file guard
   isolates the damage.

---

## Summary of resolved items

The Technical Context in [plan.md](plan.md) contains no NEEDS
CLARIFICATION entries: the spec pinned the product semantics (FR-001
through FR-031, Assumptions 1–14), and R1–R15 above resolve the
implementation mechanics (bootstrap, extraction, detection rules,
ambiguity boundary, determinism, coverage parsing, patterns, layout,
testing, promotion, resource bounds) with rationale and rejected
alternatives for each. The normative detection mapping — all 48
taxonomy types with tier, disposition, TypeScript mapping, and N/A
rationale — is the disposition table in [data-model.md](data-model.md),
which `docs/effect-disposition.md` and its conformance test are built
from.
