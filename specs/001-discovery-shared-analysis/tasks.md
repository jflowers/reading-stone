---
description: "Task list for Discovery and Shared Analysis Infrastructure (discover Method) implementation"
---

# Tasks: Discovery and Shared Analysis Infrastructure (discover Method)

**Input**: Design documents from `/specs/001-discovery-shared-analysis/`

**Prerequisites**: plan.md ✓, spec.md ✓, research.md ✓, data-model.md ✓, contracts/discover.md ✓, quickstart.md ✓ — all present in this feature directory.

**Tests**: REQUIRED — the feature specification mandates them (Constitution Principle IV: protocol conformance suites; SC-001, SC-004, SC-006 at the protected 85% coverage thresholds; research R11 test strategy). Test tasks are listed FIRST within each story and MUST be written and observed to FAIL before the paired implementation lands.

**Organization**: Tasks grouped by user story (US1–US4 from spec.md, priority order P1 → P2 → P2 → P3) so each story is independently implementable, testable, and deliverable as an increment.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies on incomplete tasks)
- **[Story]**: Which user story this task belongs to (US1–US4); setup/foundational/polish tasks carry no story label
- Every task names its exact file path(s); constraints are quoted from data-model.md / contracts/discover.md so no implementation-time discretion is required

## Path Conventions

Single project: `src/` and `tests/` at the repository root (per plan.md Project Structure). Tests mirror source modules one-to-one; `tests/helpers/` holds shared (non-test) helpers.

---

## Phase 1: Setup

**Purpose**: Verify the starting state — the repository is already scaffolded (issue #1 complete); no project initialization is needed.

- [x] T001 Verify the baseline before any change: from the repository root run `npm ci`, `npx biome check src/ tests/`, `npm run build`, and `npx vitest run --coverage`, and confirm all four protected gates pass (CI parity gate, AGENTS.md / .github/workflows/ci.yml)

**Checkpoint**: Clean baseline confirmed — all existing suites and gates green.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Shared infrastructure that MUST be complete before the protocol-touching stories (US1, US4) and the filesystem test suites (US1, US3, US4) can proceed. US2 (taxonomy/models) needs neither and may start immediately.

**⚠️ CRITICAL**: US1 and US4 cannot begin until T002 lands; the US1/US3/US4 test suites cannot be written as written until T003 lands.

- [x] T002 [P] Widen the dispatch layer for async handlers in src/server.ts (FR-019 clause 1; research R3): change `export type Handler` from `(params: object | null) => object` to `(params: object | null) => object | Promise<object>`, make `handleLine` async with the handler invocation awaited inside the existing try/catch (so `RpcError` and unexpected errors still map to `-32602`/`-32603` correctly), and await `handleLine` in the `run()` loop — sequential request processing is preserved (one request fully handled before the next line is read). This is a pure type widening: the existing sync handlers (`initialize`, `shutdown`) and every existing test keep passing unchanged; add no new behavior.
- [x] T003 [P] Create the shared fixture-tree test helper tests/helpers/fixtures.ts (research R11): build isolated trees under `os.tmpdir()` via `fs.mkdtemp` from a files map (`Record<string, string>` of root-relative path → file contents, creating intermediate directories), returning the root path plus a cleanup callback for `afterEach` teardown. Consumed by tests/discovery.test.ts, tests/safeio.test.ts, and the discover integration cases in tests/server.test.ts; special entries (FIFO, oversized, unreadable, symlinks) are created by the tests themselves via `mkfifo`/`truncate`/`chmod`/`symlink`. Named without a `.test.ts` suffix so vitest does not collect it as a suite.

**Checkpoint**: Foundation ready — async dispatch proven by the unchanged green suite; fixture helper available. US2 may run in parallel with this entire phase.

---

## Phase 3: User Story 1 — Discover project files over JSON-RPC (Priority: P1) 🎯 MVP

**Goal**: Gaze sends a `discover` request carrying a project root and receives exact, sorted, root-relative POSIX `source_files` and `test_files` lists plus a `framework` field, deterministically, over the existing JSON-RPC server; `initialize` advertises `discover: true`.

**Independent Test**: Send a `discover` request against a fixture project tree and compare the complete response — `source_files`, `test_files`, and `framework` — to the expected exact, sorted result; assert capability negotiation and the `-32602`/`-32601` error surfaces. No other feature is required. (In this increment `framework` is reported as `"unknown"` — framework detection is US4; the spec's US4 priority rationale explicitly frames it as a refinement of US1's raw enumeration.)

### Tests for User Story 1 (write FIRST; must FAIL before implementation)

- [x] T004 [P] [US1] Create tests/discovery.test.ts — `discover()` unit tests against mkdtemp fixture trees via tests/helpers/fixtures.ts (SC-001, SC-003): a tree containing all six extensions (`.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`, `.cjs`) returns the exact expected `source_files`/`test_files`, sorted lexicographically (default UTF-16 code-unit comparator), as root-relative POSIX-separator paths, lists disjoint; files under `node_modules/`, `dist/`, `build/`, `coverage/`, `.git/` appear in neither list while dot-directories such as `.github/` ARE walked; `.d.ts` files are excluded from both lists; test classification — basenames with a dot-delimited `test`/`spec` segment (neither first nor last segment, i.e. `*.test.*`/`*.spec.*`) and files under `__tests__`/`tests`/`test` directory components land in `test_files`, any test signal wins, a `tests/` file matching no name pattern is still a test; non-ASCII filenames are preserved verbatim and case-distinct names are distinct entries; a root `vitest.config.ts` is classified as a source file (no special casing); empty tree → both lists empty and `framework: "unknown"`; two `discover()` calls on the same tree produce byte-identical output when serialized with `serialize` from src/protocol.ts; a symlinked `root_path` is resolved once before walking and the tree's files are still reported; nonexistent path, file-as-root, and inaccessible root reject with `InvalidRootPathError`; a relative `root_path` resolves against `process.cwd()`
- [x] T005 [P] [US1] Extend tests/server.test.ts with discover dispatch cases through the existing `drive()` harness (FR-009, FR-010, SC-007; research R12): a canned discover request against a fixture tree returns the exact three-field result `{source_files, test_files, framework}` with the request id echoed; the param-validation matrix answers `-32602` with the exact contract messages — params absent/`null`/array → `Invalid params: params must be an object`, `root_path` missing or non-string → `Invalid params: root_path must be a string`, any extra key (e.g. `patterns`) → `Invalid params: params must contain only root_path`; nonexistent / not-a-directory / inaccessible `root_path` → `-32602` `Invalid params: root_path is not a directory: <path>`; the reserved methods (`analyze`, `complexity`, `coverage`, `test_mapping`, `classify_signals`, `analyze/stream`, `doc_coverage`, `cognitive_complexity`) still answer `-32601` — remove `discover` from the existing unimplemented-methods list at tests/server.test.ts:200
- [x] T006 [P] [US1] Update tests/protocol.test.ts capability assertions (US1 scenario 5, SC-005): the initialize result reports `discover: true` with the other five flags (`test_mapping`, `classify_signals`, `streaming`, `doc_coverage`, `cognitive_complexity`) `false` — update the all-false loop, the key-set assertion, and the hardcoded serialized-capabilities string (currently `"discover":false` at tests/protocol.test.ts:163)

### Implementation for User Story 1

- [x] T007 [US1] Create the deterministic tree walker in src/discovery.ts (FR-002, FR-003; research R2): async recursive descent using `fs.promises.readdir(dir, { withFileTypes: true })`, visiting entries in sorted (UTF-16 code-unit) order so stderr diagnostics are deterministic too; descend only into entries that are directories and not symlinks (`dirent.isSymbolicLink()` — symlinked directories are not descended, symlinked files are not read); prune exactly the five directories `node_modules`, `dist`, `build`, `coverage`, `.git` (all other directories, including dot-directories such as `.github`, are walked); consider files with extensions `.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`, `.cjs` — JavaScript-family sources are never silently skipped (Constitution Principle III)
- [x] T008 [US1] Implement file classification in src/discovery.ts (FR-004, FR-005, FR-008; research R8, R13): `.d.ts` exclusion (trailing `.d.ts` — a silent documented policy, no diagnostic); test classification — a basename dot-delimited segment equal to `test` or `spec` that is neither the first nor the last segment, OR any directory component of the path exactly `__tests__`, `tests`, or `test`; any test signal classifies the file into `test_files` (test wins over source); emit disjoint `source_files`/`test_files` as root-relative POSIX-separator paths sorted with the default `Array.prototype.sort()` comparator (stable, locale-independent, Node-version-stable — never `localeCompare`)
- [x] T009 [US1] Implement `discover(rootPath: string): Promise<DiscoveryResult>` and export `InvalidRootPathError` in src/discovery.ts (FR-001, FR-010; research R5): resolve a relative `root_path` against the analyzer process working directory, `fs.realpath` the root once before walking (a symlinked root is followed exactly once at the boundary; containment is enforced against the resolved root); throw `InvalidRootPathError` when the root does not exist, is not a directory, or cannot be accessed; run the walk + classification and return the `DiscoveryResult` `{ source_files, test_files, framework }` with `framework` reported as the literal `"unknown"` in this story — detection is added by US4 (T022–T024); document this incremental placeholder in a code comment citing spec.md US4's priority rationale
- [x] T010 [US1] Register the discover handler in src/server.ts `createDefaultDispatch` (FR-009, FR-019; contracts/discover.md error table): validate that params is an object (else `-32602` `Invalid params: params must be an object`), that `root_path` is a string (else `-32602` `Invalid params: root_path must be a string`), and that params carries exactly the `root_path` key and nothing else (else `-32602` `Invalid params: params must contain only root_path`); call `discover()` and map `InvalidRootPathError` to `RpcError(INVALID_PARAMS, `Invalid params: root_path is not a directory: <path>`)`; register alongside `initialize` and `shutdown`
- [x] T011 [P] [US1] Flip the discover capability in src/protocol.ts `initializeResult()` (FR-019, US1 scenario 5): `capabilities.discover` becomes `true`; `test_mapping`, `classify_signals`, `streaming`, `doc_coverage`, `cognitive_complexity` remain `false`
- [x] T012 [P] [US1] Update openspec/specs/protocol/spec.md (research R12, spec Assumption 12): the initialize-result requirement now asserts `discover: true` with the other five capability flags `false`
- [x] T013 [P] [US1] Update openspec/specs/server/spec.md (research R12, spec Assumption 12): the dispatch-table scope registers `initialize`, `shutdown`, and `discover`; the reserved `-32601` method list drops `discover` (`analyze`, `complexity`, `coverage`, `test_mapping`, `classify_signals`, `analyze/stream`, `doc_coverage`, `cognitive_complexity` remain reserved)

**Checkpoint**: User Story 1 is fully functional and independently testable — `discover` answers end-to-end over stdio with deterministic sorted lists (framework `"unknown"` until US4), the handshake advertises the capability, and the error surfaces match the contract exactly.

---

## Phase 4: User Story 2 — Shared side-effect vocabulary and record models (Priority: P2)

**Goal**: One canonical side-effect taxonomy (48 types, fixed tiers, 11 aliases), shared record models (`Effect`, `Classification`, `FunctionRecord`) with omit-unset serialization, and package-name derivation — exported as package API so later analysis methods never invent type names.

**Independent Test**: Pure unit testing with no filesystem or JSON-RPC involvement — exact type count, tier membership, alias resolution, record serialization shape, and the derivePackage table.

### Tests for User Story 2 (write FIRST; must FAIL before implementation)

- [x] T014 [P] [US2] Create tests/taxonomy.test.ts — vocabulary conformance (SC-004, FR-011, FR-012): `SIDE_EFFECT_TYPES` contains exactly 48 unique members; `TIER_MAP` assigns every type to exactly one tier with sizes P0=6, P1=11, P2=16, P3=9, P4=6, matching the data-model.md tier table verbatim; each of the 11 aliases resolves per the data-model.md alias table (`AsyncTaskSpawn`→`GoroutineSpawn`, `AsyncMessageSend`→`ChannelSend`, `AsyncChannelClose`→`ChannelClose`, `BarrierOp`→`WaitGroupOp`, `PanicRecovery`→`RecoverBehavior`, `FFICall`→`CgoCall`, `ObjectPoolOp`→`SyncPoolOp`, `DeferredMutation`→`DeferredReturnMutation`, `ArgumentMutation`→`PointerArgMutation`, `ProcessTermination`→`Panic`, `SentinelErrorDecl`→`SentinelError`); `resolveSideEffectType` maps a canonical name to itself and any other string to `undefined`
- [x] T015 [P] [US2] Create tests/models.test.ts — record model conformance (US2 scenarios 3–5, FR-013–FR-016): `serializeEffect` always emits required `type` and `description` and omits optional `location`, `target`, `detail`, `classification` when unset (omitted, never `null`); `serializeClassification` emits `label` and `confidence` and throws on out-of-range confidence (non-integer, `<0`, or `>100`); `serializeFunctionRecord` emits `name`, `package`, `file`, `line` (1-based), and `side_effects` as a JSON array of serialized effects; `derivePackage` satisfies the data-model.md table exactly: `pkg/mod.ts`→`pkg.mod`, `pkg/index.ts`→`pkg`, `src/deep/thing.ts`→`src.deep.thing`, `index.ts`→`index`, `a.b.ts`→`a.b`

### Implementation for User Story 2

- [x] T016 [P] [US2] Create src/taxonomy.ts (FR-011, FR-012; research R1): `export type Tier = "P0" | "P1" | "P2" | "P3" | "P4"`; `export type SideEffectType` as the 48-member string-literal union; `export const TIER_MAP: Readonly<Record<SideEffectType, Tier>>` — the `Record` keyed by the 48-member union makes the compiler reject any missing or extra assignment (compile-time exhaustiveness); `export const SIDE_EFFECT_TYPES: readonly SideEffectType[]`; `export type SideEffectAlias` as the 11-member literal union; `export const ALIAS_MAP: Readonly<Record<SideEffectAlias, SideEffectType>>`; `export function resolveSideEffectType(name: string): SideEffectType | undefined` (canonical → itself, alias → canonical, anything else → `undefined`). Transcribe the 48 types by tier and the 11 aliases verbatim from specs/001-discovery-shared-analysis/data-model.md (protocol v1.2.0 taxonomy); tier membership is fixed and NOT configurable.
- [x] T017 [US2] Create src/models.ts (FR-013–FR-016; research R10), importing `SideEffectType` from src/taxonomy.ts: `Classification` interface `{ label: "contractual" | "incidental" | "ambiguous"; confidence: number }` — the serializer fails loud (throws) on non-integer or out-of-0–100 confidence rather than emit invalid protocol data (Constitution Principle I); `Effect` interface `{ type: SideEffectType; description: string; location?: string; target?: string; detail?: Record<string, unknown>; classification?: Classification }` — optional fields are omitted (never `null`) when unset; `FunctionRecord` interface `{ name: string; package: string; file: string; line: number; side_effects: readonly Effect[] }` (`file` is the root-relative POSIX path; `line` is the 1-based declaration line); `serializeEffect`, `serializeClassification`, `serializeFunctionRecord` implementing the omit-unset-optionals rule; `derivePackage(relPath: string): string` — strip the final extension, join path segments with dots, drop a trailing `.index` segment (top-level `index.ts` derives to `"index"`). Wire-format field names are snake_case (`side_effects`); TypeScript identifiers stay camelCase (convention pack CS-006); entities are immutable value records (`readonly` fields, convention pack AP-004).
- [x] T018 [US2] Re-export the public model/taxonomy surface from src/index.ts alongside the existing `VERSION` export (research R9 — consumable package API, not orphaned code): `SideEffectType`, `Tier`, `TIER_MAP`, `SIDE_EFFECT_TYPES`, `SideEffectAlias`, `ALIAS_MAP`, `resolveSideEffectType`, `Effect`, `Classification`, `FunctionRecord`, `serializeEffect`, `serializeClassification`, `serializeFunctionRecord`, `derivePackage`

**Checkpoint**: User Story 2 complete — the vocabulary and record models are defined, exported, and conformance-tested in isolation. No protocol method consumes them yet (by design; `analyze` lands in issue #3).

---

## Phase 5: User Story 3 — Safe, bounded file access (Priority: P2)

**Goal**: A shared safe file reader used by all file-touching analysis: oversized, non-regular, and unreadable files are skipped with exactly one one-line stderr diagnostic each, no read escapes the analysis root, and a skip never aborts the enclosing request.

**Independent Test**: Fixture trees containing oversized files, non-regular files, unreadable files, and symlink escape attempts — assert skip-and-continue behavior, containment, and request completion against `readBounded` directly.

### Tests for User Story 3 (write FIRST; must FAIL before implementation)

- [ ] T019 [P] [US3] Create tests/safeio.test.ts — safety fixtures (US3 scenarios 1–6, SC-002; research R11), each asserting skip-and-continue (`readBounded` resolves `null`), exactly one `reading-stone: skipping <relPath>: <reason>` line on the injected stderr sink, no thrown error, and nothing written to any stdout stream: an oversized file created via `fs.truncate` to 16 MiB + 1 byte (instant sparse file); a non-regular file created via `execFileSync("mkfifo", [path])`; an unreadable file created via `fs.chmod(path, 0o000)`; a symlinked file and a symlinked directory inside the tree (never followed or read); and a traversal-escape candidate (relPath such as `../outside.txt`) rejected unread

### Implementation for User Story 3

- [ ] T020 [US3] Create src/safeio.ts (FR-017, FR-018; research R4, R5): `export const MAX_FILE_BYTES = 16 * 1024 * 1024` and `export function readBounded(root: string, relPath: string, budget: number, stderr: Writable): Promise<string | null>` implementing, in order: (1) containment — build the candidate by joining the resolved root with the walk-built relPath and verify `path.relative(root, candidate)` is non-absolute and does not begin with `..`; a violation rejects the path unread (defense in depth — the walk itself can never produce escapes, this protects future callers); (2) `lstat` — non-regular files (FIFO, device, socket) and symlinks are skipped (the pre-open regular-file check is the FIFO DoS defense: opening a FIFO blocks until a writer appears); (3) size check — `size > MAX_FILE_BYTES` is skipped before open; (4) open and read at most `budget` bytes — I/O and decode errors skip. Every skip writes exactly one diagnostic line `reading-stone: skipping <relPath>: <reason>\n` to the injected stderr sink and resolves `null`; `readBounded` never throws for skip conditions and never aborts the enclosing request; stdout is never touched. Document the accepted stat-to-open TOCTOU residual in a code comment (research R4).

**Checkpoint**: User Story 3 complete — the safe reader is proven against every safety fixture. US4 (which reads file prefixes and `package.json`) can now build on it.

---

## Phase 6: User Story 4 — Framework and generated-file awareness (Priority: P3)

**Goal**: `discover` reports the project's detected test framework (`vitest`, `jest`, or `unknown`) from configuration presence, and files carrying generated-code markers in their leading comment block are excluded from both lists — refining US1's raw enumeration so scoring reflects the project's real test setup and is not polluted by generated code.

**Independent Test**: Fixture trees containing vitest configuration, jest configuration, both, neither, and files carrying generated-code markers — assert the exact framework string and generated-file exclusion. Depends on US1 (src/discovery.ts and tests/discovery.test.ts exist) and US3 (readBounded exists).

### Tests for User Story 4 (write FIRST; must FAIL before implementation)

- [ ] T021 [US4] Extend tests/discovery.test.ts with framework and generated-marker cases (US4 scenarios 1–3, FR-006, FR-007): framework — a tree with vitest configuration reports `"vitest"`, with jest configuration reports `"jest"`, with both reports `"vitest"`, with neither reports `"unknown"`, and a root `package.json` containing a `jest` key (with no `jest.config.*`) reports `"jest"`; a malformed or unreadable `package.json` writes exactly one stderr diagnostic and is treated as having no `jest` key; repeated runs report an identical framework. Generated markers — `@generated` or `Code generated` (case-sensitive) inside the leading comment block excludes the file from both lists; the same text after code begins or inside a string literal does NOT exclude it; a test-named file carrying a marker appears in neither list (generated exclusion wins over test classification); a UTF-8 BOM and a leading shebang line before the marker comment are still detected. Precedence — safety skip → `.d.ts` exclusion → generated-marker exclusion → test classification → source

### Implementation for User Story 4

- [ ] T022 [US4] Implement framework detection in src/discovery.ts (FR-006; research R7): `detectFramework(resolvedRoot, stderr)` checks configuration presence at the resolved project root only (non-recursive), independent of file contents and environment: `"vitest"` when any of `vitest.config.ts`, `vitest.config.js`, `vitest.config.mts`, `vitest.config.mjs` exists at the root; otherwise `"jest"` when any of `jest.config.ts`, `jest.config.js`, `jest.config.mjs`, `jest.config.cjs`, `jest.config.json` exists at the root OR the root `package.json` contains a `jest` key — `package.json` is read through the shared safe reader (`readBounded` from src/safeio.ts, so the 16 MiB cap and one-diagnostic rules apply) and parsed as JSON, with an unreadable or malformed file writing one stderr diagnostic and treated as having no `jest` key; otherwise `"unknown"`. vitest wins when both are present; framework strings are lowercase `"vitest"`/`"jest"`; detection depends only on configuration presence (identical across repeated runs).
- [ ] T023 [US4] Implement the leading-comment generated-marker scanner in src/discovery.ts (FR-007; research R6): read a bounded 64 KiB prefix of the file via `readBounded`; strip a UTF-8 BOM and a leading shebang line, skip whitespace, then consume consecutive `//` line comments and `/* */` block comments, stopping at the first non-comment content; if any consumed comment text contains the case-sensitive marker `@generated` or `Code generated`, the file is excluded from both lists — a silent documented-policy exclusion like `.d.ts`, NOT a safety skip (no diagnostic). Truncation at the 64 KiB budget is deterministic (same input → same output); the scanner is bounded lexical-trivia scanning, not a reimplementation of TypeScript semantics (research R6).
- [ ] T024 [US4] Wire framework detection and marker exclusion into `discover()` in src/discovery.ts: replace the US1 `"unknown"` framework placeholder with `detectFramework(resolvedRoot, stderr)` — add the stderr sink parameter to `discover()` and update the discover handler call site in src/server.ts to pass the server's `stderr` so skip diagnostics reach the process stderr; apply marker exclusion in the classification precedence chain (safety skip → `.d.ts` → generated marker → test → source); remove or update the US1 placeholder comment

**Checkpoint**: All four user stories complete — `discover` returns the full specified response including detected framework and generated-file exclusion. The quickstart.md expected outputs are now fully achievable.

---

## Phase 7: Polish & Cross-Cutting Concerns

**Purpose**: Documentation truthfulness and final validation across all stories.

- [ ] T025 [P] Update repository docs to match shipped behavior: in README.md move `discover` in the method table from "Not implemented (`-32601`)" to implemented (params `{root_path}`; result `{source_files, test_files, framework}`), and add `src/taxonomy.ts`, `src/models.ts`, `src/safeio.ts`, `src/discovery.ts` to the project-structure sections of README.md and AGENTS.md
- [ ] T026 Run the full manual end-to-end validation from specs/001-discovery-shared-analysis/quickstart.md against a fresh `npm run build`: the stdio demo (initialize → discover → shutdown with the expected exact three responses, including `framework: "vitest"` for the demo tree), the determinism byte-compare (two identical discover response lines), the error-surface checks (`-32602` nonexistent root, `-32602` extra param key, `-32601` reserved method), and the safety-skip check (oversized + unreadable files → exactly two stderr diagnostics and a success response with empty lists and `framework: "unknown"`). Record that every observed output matches quickstart.md exactly.
- [ ] T027 Run the final CI parity gate from the repository root and confirm all protected gates pass (SC-006; AGENTS.md; .github/workflows/ci.yml): `npx biome check src/ tests/`, `npm run build`, and `npx vitest run --coverage` with lines, statements, functions, and branches coverage each at or above the protected 85% thresholds. Never modify a gate to make it pass — if a gate fails, fix the implementation and re-run.

**Checkpoint**: Feature complete — docs truthful, quickstart validated end-to-end, all protected gates green.

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — start immediately.
- **Foundational (Phase 2)**: After Phase 1. T002 (async Handler) blocks US1/US4 handler registration; T003 (fixture helper) blocks the US1/US3/US4 test suites. US2 needs neither.
- **User Story 1 (Phase 3)**: After Phase 2 (T002, T003). No dependencies on other stories.
- **User Story 2 (Phase 4)**: NO dependencies at all — pure leaf modules plus unit tests; may run before, during, or after any other phase.
- **User Story 3 (Phase 5)**: After Phase 2 (T003 fixture helper). Independent of US1 and US2.
- **User Story 4 (Phase 6)**: After US1 (T009's `discover()` and T004's tests/discovery.test.ts) AND US3 (T020's `readBounded`).
- **Polish (Phase 7)**: After all user stories are complete.

### User Story Dependencies

- **US1 (P1)**: After Foundational. No story dependencies.
- **US2 (P2)**: None — fully independent; parallelizable with everything.
- **US3 (P2)**: After Foundational (test helper only). Independent of US1/US2.
- **US4 (P3)**: Depends on US1 + US3 (wires `detectFramework` and the marker scanner into `discover()` and reads through `readBounded`).

### Within Each User Story

- Test tasks are written first and observed to FAIL, then implementation lands and turns them green.
- Within src/discovery.ts: walker (T007) → classification (T008) → `discover()` (T009) → registration (T010, src/server.ts); US4: detection (T022) → scanner (T023) → wiring (T024).
- Within US2: taxonomy (T016) → models (T017, imports taxonomy types) → index re-exports (T018).
- Run the CI parity commands (`npx biome check src/ tests/`, `npm run build`, `npx vitest run --coverage`) before marking any task complete (AGENTS.md CI Parity Gate), and mark each task `- [x]` immediately upon completion — never in a batch.

### Parallel Opportunities

- Phase 2: T002 ∥ T003 (src/server.ts vs tests/helpers/fixtures.ts).
- US1: T004 ∥ T005 ∥ T006 (three distinct test files); later T011 ∥ T012 ∥ T013 (src/protocol.ts and the two openspec specs).
- US2: T014 ∥ T015 ∥ T016 (two test files plus src/taxonomy.ts), then T017 → T018.
- US3: T019 ∥ (US2 work) — tests/safeio.test.ts is disjoint from every US2 file.
- Cross-story after Phase 2: US1 ∥ US2 ∥ US3 touch disjoint files (src/discovery.ts + src/server.ts + src/protocol.ts vs src/taxonomy.ts + src/models.ts + src/index.ts vs src/safeio.ts).
- US4 is sequential within src/discovery.ts but T021 can be written while US3 finishes.

---

## Parallel Execution Examples

### User Story 1

```bash
# Launch the three US1 test tasks together (distinct files):
Task: "Create tests/discovery.test.ts"          # T004
Task: "Extend tests/server.test.ts"             # T005
Task: "Update tests/protocol.test.ts"           # T006

# After T007–T010 land, launch together:
Task: "Flip capability in src/protocol.ts"      # T011
Task: "Update openspec/specs/protocol/spec.md"  # T012
Task: "Update openspec/specs/server/spec.md"    # T013
```

### User Story 2

```bash
# Launch together (distinct files; T017 follows T016 because models imports taxonomy types):
Task: "Create tests/taxonomy.test.ts"           # T014
Task: "Create tests/models.test.ts"             # T015
Task: "Create src/taxonomy.ts"                  # T016
# Then: T017 (src/models.ts) -> T018 (src/index.ts)
```

### User Story 3

```bash
# Safeio is disjoint from all US1/US2 files — runs in parallel with either:
Task: "Create tests/safeio.test.ts"             # T019
Task: "Create src/safeio.ts"                    # T020 (after T019 is written red)
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 1: Setup (baseline green).
2. Complete Phase 2: Foundational (T002 async dispatch, T003 fixture helper).
3. Complete Phase 3: User Story 1.
4. **STOP and VALIDATE**: `discover` answers end-to-end over stdio with exact sorted lists, capability negotiation, and contract error surfaces — `framework` reports `"unknown"` (detection is US4, per the spec's own priority framing of US4 as a refinement).
5. Demo with a config-less fixture tree; the full quickstart.md expected output (including `framework: "vitest"`) requires US4.

### Incremental Delivery

1. Setup + Foundational → foundation ready.
2. Add User Story 1 → test independently → **MVP** (discover over JSON-RPC).
3. Add User Story 2 (any time — independent) → vocabulary/models conformance-tested.
4. Add User Story 3 (any time after Foundational — independent) → safe reader proven.
5. Add User Story 4 → full discover response (framework detection, generated-file exclusion).
6. Polish → docs truthful, quickstart validated, all protected gates green.

### Parallel Team Strategy

With multiple implementers after Phase 2 completes:

- Implementer A: User Story 1 (src/discovery.ts, src/server.ts, src/protocol.ts)
- Implementer B: User Story 2 (src/taxonomy.ts, src/models.ts, src/index.ts)
- Implementer C: User Story 3 (src/safeio.ts)
- Then one implementer takes User Story 4 (depends on A + C), another starts Polish docs (T025).

---

## Notes

- [P] tasks = different files, no dependencies on incomplete tasks.
- [Story] labels map tasks to spec.md user stories for traceability: US1 = discover over JSON-RPC (FR-001–FR-010, FR-019), US2 = vocabulary/models (FR-011–FR-016), US3 = safe file access (FR-017–FR-018), US4 = framework/markers (FR-006–FR-007 in depth).
- The `framework: "unknown"` placeholder in US1 is a deliberate incremental-delivery decision, not an omission — spec.md US4's priority rationale frames framework detection as a refinement of US1's raw enumeration, and US1's acceptance scenarios are satisfiable with a config-less fixture tree.
- Verify tests fail before implementing; commit after each task or logical group; mark `- [x]` immediately upon completion (AGENTS.md Task Completion Bookkeeping).
- Protected gates (85% coverage thresholds, `biome check`, strict `tsc`) must never be lowered to make an implementation pass — report blockers instead.
- Stop at any checkpoint to validate a story independently.
- Design decisions behind these tasks: research.md R1–R13 (walk mechanism, async dispatch, safe reader, containment, marker scanner, framework detection, determinism, layout, package derivation, test strategy, openspec bookkeeping, precedence chain).

## Requirement Traceability

| Requirement | Tasks |
|---|---|
| FR-001 discover method/result shape | T009, T010 |
| FR-002 walked extensions | T007 |
| FR-003 pruned directories | T007 |
| FR-004 `.d.ts` exclusion | T008 |
| FR-005 test classification | T008 |
| FR-006 framework detection | T022, T024 |
| FR-007 generated-marker exclusion | T023, T024 |
| FR-008 deterministic output | T007, T008 |
| FR-009 strict param validation | T010 |
| FR-010 root path validation | T009 |
| FR-011 48-type taxonomy, fixed tiers | T016 |
| FR-012 11 aliases | T016 |
| FR-013 Effect model | T017 |
| FR-014 Classification model | T017 |
| FR-015 FunctionRecord model | T017 |
| FR-016 package derivation | T017 |
| FR-017 safe bounded reader | T020 |
| FR-018 traversal containment | T020 |
| FR-019 async dispatch, registration, capability | T002, T010, T011 |
