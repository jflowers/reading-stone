# Feature Specification: Discovery and Shared Analysis Infrastructure (discover Method)

**Feature Branch**: `001-discovery-shared-analysis`

**Created**: 2026-10-26

**Status**: Draft

**Input**: User description: "Implement the `discover` method and the shared analysis foundation every later issue builds on: the side-effect taxonomy, shared models, safe file access, and project walking."

**Originating issue**: [zero-dot-force/reading-stone#2](https://github.com/zero-dot-force/reading-stone/issues/2) — Discovery and shared analysis infrastructure (discover method). Depends on #1 (protocol alignment to Gaze analyzer protocol v1.2.0, complete); unblocks #3 (side-effect detection).

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Discover project files over JSON-RPC (Priority: P1)

As Gaze (the consuming platform), when I send a `discover` request carrying a project root path, I receive exact, sorted lists of the project's source files and test files plus its detected test framework, so that test functions can be excluded from CRAP scoring and downstream analysis knows which files exist.

**Why this priority**: The `discover` response is the only externally visible behavior this change adds, and every later analysis method builds on its file lists. It is the minimum viable slice: demonstrable end-to-end with canned JSON-RPC exchanges against a fixture project tree.

**Independent Test**: Can be fully tested by sending a `discover` request against a fixture project tree and comparing the complete response — `source_files`, `test_files`, and `framework` — to the expected exact, sorted result, with no other feature required.

**Acceptance Scenarios**:

1. **Given** a fixture tree containing `.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`, and `.cjs` files, **When** `discover` is called with the tree's root path, **Then** the response lists every discoverable file, sorted lexicographically, as root-relative POSIX-style paths, split into disjoint `source_files` and `test_files` lists, and reports the detected `framework`.
2. **Given** a tree that also contains `node_modules/`, `dist/`, `build/`, `coverage/`, and `.git/` directories, **When** `discover` is called, **Then** no file from those directories appears in either list.
3. **Given** files matching the test-file patterns (`*.test.*`, `*.spec.*`, or located under `__tests__/`, `tests/`, or `test/`), **When** `discover` is called, **Then** they are classified into `test_files`; any test signal classifies the file as a test, even when the file also looks like a source file (test classification wins).
4. **Given** the same input tree analyzed twice by the same analyzer version, **When** both responses are compared byte-for-byte, **Then** they are identical.
5. **Given** an `initialize` request, **When** the response is returned, **Then** capabilities report `discover: true` while the other five capability flags remain `false`.

### User Story 2 - Shared side-effect vocabulary and record models (Priority: P2)

As the analysis methods that later issues add (side-effect detection, complexity, coverage), I consume one canonical side-effect taxonomy, shared record models, and package-name derivation, so that detection code never invents type names, every module shares protocol-shaped data structures, and reported effects always use the platform's universal vocabulary.

**Why this priority**: The vocabulary and models are the contract foundation for every subsequent issue; defining them once here prevents divergence later. No protocol method consumes them yet, so they rank below the discoverable behavior itself.

**Independent Test**: Can be fully tested by unit-testing the vocabulary (exact type count, tier membership, alias resolution) and the record serialization shape, with no filesystem or JSON-RPC involvement.

**Acceptance Scenarios**:

1. **Given** the side-effect vocabulary, **When** inspected, **Then** it contains exactly the 48 canonical side effect types defined by the platform's universal taxonomy, each belonging to exactly one priority tier, with tier sizes P0=6, P1=11, P2=16, P3=9, P4=6.
2. **Given** any of the 11 language-neutral aliases, **When** resolved, **Then** it maps to its canonical side effect type.
3. **Given** an effect record with optional fields unset, **When** serialized, **Then** the optional fields are omitted and the required fields (`type`, `description`) are present.
4. **Given** a function record, **When** serialized, **Then** it carries `name`, `package`, `file`, `line`, and `side_effects` in the platform payload shape.
5. **Given** a root-relative source path, **When** the package name is derived, **Then** the result is the dotted module path, with an index module representing its directory.

### User Story 3 - Safe, bounded file access (Priority: P2)

As the operator running reading-stone against arbitrary, untrusted codebases, I need file access to be bounded and contained — oversized, unreadable, and non-regular files are skipped with a one-line diagnostic, and no read may escape the analysis root — so that a malicious project cannot deny service or trick the analyzer into touching files outside the analyzed tree.

**Why this priority**: Analysis safety is a constitutional guarantee (Principle V), and this change introduces the first file-touching behavior. The safe-access foundation is shared by every later analysis method, so a weakness here is a weakness everywhere.

**Independent Test**: Can be fully tested with fixture trees containing oversized files, non-regular files, unreadable files, and symlink escape attempts, asserting skip-and-continue behavior, containment, and request completion.

**Acceptance Scenarios**:

1. **Given** a candidate file larger than the 16 MiB read cap, **When** discovery processes the tree, **Then** the file is skipped from the output lists, exactly one diagnostic line is written to stderr, and the request completes normally.
2. **Given** a non-regular file (FIFO, device, or socket) in the tree, **When** discovery processes it, **Then** it is skipped with one stderr diagnostic line and the request completes.
3. **Given** an unreadable file (permission denied), **When** discovery processes it, **Then** it is skipped with one stderr diagnostic line and the request completes.
4. **Given** a symlinked directory or a symlinked file inside the tree, **When** the tree is walked, **Then** the symlink is not followed and no path outside the root is read or reported.
5. **Given** any candidate path whose resolved location escapes the analysis root, **When** file access is attempted, **Then** the path is rejected without being read.
6. **Given** any skip condition, **When** it occurs, **Then** nothing is written to stdout other than the JSON-RPC response, and the enclosing request is never aborted.

### User Story 4 - Framework and generated-file awareness (Priority: P3)

As Gaze, I receive the project's detected test framework (vitest, jest, or unknown) and I do not receive machine-generated files in either list, so that scoring reflects the project's real test setup and is not polluted by generated code.

**Why this priority**: These refine the discover response beyond raw enumeration — valuable for downstream interpretation but not required for the core discovery value.

**Independent Test**: Can be fully tested with fixture trees containing vitest configuration, jest configuration, both, neither, and files carrying generated-code markers, asserting the exact framework string and generated-file exclusion.

**Acceptance Scenarios**:

1. **Given** a tree with vitest configuration present, **When** `discover` responds, **Then** `framework` is `"vitest"`; with jest configuration present, `"jest"`; with both, `"vitest"`; with neither, `"unknown"`.
2. **Given** a file whose leading comment block carries a generated-code marker (`@generated` or `Code generated`), **When** discovery classifies files, **Then** the file is excluded from both lists.
3. **Given** framework detection, **When** the same tree is analyzed repeatedly, **Then** the reported framework is identical — detection depends only on configuration presence, not on file contents or environment.

### Edge Cases

- What happens when `params` is not an object, `root_path` is missing or not a string, or `params` carries keys other than `root_path`? The request fails with invalid params (`-32602`).
- What happens when `root_path` does not exist, is not a directory, or cannot be accessed? The request fails with `-32602`.
- What happens when the analyzed tree contains no matching files? Both lists are empty and the framework is still reported per configuration presence.
- What happens when a `.d.ts` declaration file is present? It is excluded from both lists as a documented policy (declaration-only artifacts carry no function bodies); this exclusion is deliberate and recorded, not a silent skip.
- What happens when a configuration file itself matches a walked extension (for example, a test-framework configuration written in TypeScript)? It is classified like any other file by the standard rules — no special casing.
- What happens when `root_path` is relative? It is resolved against the analyzer process's working directory.
- What happens when `root_path` itself is a symlink? It is resolved before walking; containment is enforced against the resolved root.
- What happens when two files differ only by case? They are distinct entries, ordered by the deterministic sort.
- What happens when filenames contain non-ASCII characters? They are preserved verbatim and sorted deterministically.
- What happens when a test-named file also carries a generated-code marker? Generated-file exclusion wins — the file appears in neither list.
- What happens when other reserved analysis methods (`analyze`, `complexity`, `coverage`, `test_mapping`, `classify_signals`, `analyze/stream`, `doc_coverage`, `cognitive_complexity`) are requested? They still fail with method-not-found (`-32601`); only `discover` is added by this change.

---

## Requirements *(mandatory)*

### Functional Requirements

**Discovery (`discover` method)**

- **FR-001**: The system MUST implement the `discover` method accepting exactly one parameter — `root_path`, a string — and returning a result with exactly three fields: `source_files` (array of strings), `test_files` (array of strings), and `framework` (string).
- **FR-002**: Discovery MUST consider files with the extensions `.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`, and `.cjs`; JavaScript-family sources (`.js`, `.jsx`, `.mjs`, `.cjs`) MUST NOT be silently skipped (Constitution Principle III).
- **FR-003**: Discovery MUST NOT descend into directories named `node_modules`, `dist`, `build`, `coverage`, or `.git`.
- **FR-004**: Discovery MUST exclude `.d.ts` declaration files from both lists (documented policy; see Assumptions).
- **FR-005**: Discovery MUST classify a file as a test file when its name matches `*.test.*` or `*.spec.*`, or when any directory component of its path is `__tests__`, `tests`, or `test`; any test signal MUST classify the file into `test_files`, and the two lists MUST be disjoint.
- **FR-006**: Discovery MUST report `framework` as `"vitest"` when vitest configuration is present, `"jest"` when jest configuration is present (vitest taking precedence when both are present), and `"unknown"` when neither is present.
- **FR-007**: Discovery MUST exclude from both lists files whose leading comment block carries a generated-code marker (`@generated` or `Code generated`).
- **FR-008**: Discovery output MUST be deterministic: both lists sorted lexicographically by root-relative POSIX-style path, and the serialized response byte-identical across repeated analyses of the same tree by the same analyzer version (Constitution Principle I).
- **FR-009**: The `discover` method MUST reject invalid parameters with `-32602`: non-object `params`, missing or non-string `root_path`, or `params` carrying any key other than `root_path`.
- **FR-010**: The `discover` method MUST reject a `root_path` that does not exist, is not a directory, or cannot be accessed, with `-32602`.

**Shared analysis foundation**

- **FR-011**: The system MUST define the canonical side-effect vocabulary of exactly 48 types with fixed tier membership — P0 (6 types), P1 (11), P2 (16), P3 (9), P4 (6) — matching the platform's universal taxonomy as pinned by protocol v1.2.0; tier membership MUST NOT be configurable.
- **FR-012**: The system MUST define the 11 language-neutral aliases, each resolving to exactly one canonical side effect type.
- **FR-013**: The system MUST define an effect record model with required `type` and `description` fields and optional `location`, `target`, `detail`, and `classification` fields; optional fields MUST be omitted from serialization when unset.
- **FR-014**: The system MUST define a classification model with a `label` of `contractual`, `incidental`, or `ambiguous` and an integer `confidence` in the range 0–100.
- **FR-015**: The system MUST define a function record model carrying `name`, `package`, `file`, `line`, and `side_effects`.
- **FR-016**: The system MUST derive a dotted package path from a root-relative source path, with an index module representing its directory.
- **FR-017**: The system MUST provide a shared safe file reader used by all file-touching analysis: files larger than 16 MiB, non-regular files, and unreadable files are skipped with exactly one one-line diagnostic written to stderr per skipped file; a skip MUST NEVER abort the enclosing request; stdout MUST remain reserved for protocol responses.
- **FR-018**: The system MUST resolve every file path it reads traversal-safely: each resolved path MUST remain within the resolved analysis root; symlinks MUST NOT be followed during tree walking; a path that would escape the root MUST be rejected without being read (Constitution Principle V).

**Server wiring**

- **FR-019**: The dispatch layer MUST support handlers that perform asynchronous work; the `discover` method MUST be registered as a built-in handler alongside `initialize` and `shutdown`; the `initialize` capability response MUST report `discover: true` with the other five capability flags unchanged (`false`); all other reserved analysis method names MUST continue to return `-32601`.

### Key Entities

- **SideEffectType**: One of the 48 canonical side effect types in the platform's universal taxonomy; the only vocabulary a reported effect may use.
- **Tier**: The priority level of a side effect type (P0–P4), fixing its detection requirement level (P0 = zero false negatives).
- **Effect**: A single observable side effect attributed to a function — its taxonomy type, a human-readable description, and optional location, target, opaque detail metadata, and classification.
- **Classification**: A contractual / incidental / ambiguous label with a 0–100 confidence score attached to an effect.
- **FunctionRecord**: A function observed in the analyzed project — its name, package, file, declaration line, and the effects observed for it.
- **DiscoveryResult**: The `discover` response payload — sorted source file paths, sorted test file paths, and the detected test framework.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A `discover` request against the canonical fixture project tree returns the exact expected response — all three fields, exact list membership and ordering — verified by an automated protocol conformance test.
- **SC-002**: Every safety fixture (oversized, non-regular, unreadable, path-traversal, symlink-escape) results in skip-and-continue with exactly one stderr diagnostic line each, a completed request, and no path outside the fixture root read or reported — 100% of safety scenarios pass.
- **SC-003**: Two `discover` calls against the same tree produce byte-identical serialized responses.
- **SC-004**: The vocabulary conformance test confirms exactly 48 canonical types with tier sizes 6/11/16/9/6 and 11 alias resolutions.
- **SC-005**: The `initialize` handshake advertises `discover: true` with the remaining five capabilities `false`.
- **SC-006**: All protected project quality gates pass — lint, type check, build, and the test suite at its protected coverage thresholds (lines, statements, functions, branches).
- **SC-007**: All reserved-but-unimplemented analysis methods still answer `-32601` (no accidental capability exposure).

## Assumptions

1. **Framework value when undetected**: `"unknown"` — the `framework` field is always present and always a string; the platform's result schema declares it as a plain string, so a sentinel value is required rather than omission.
2. **Framework detection basis**: configuration presence only — a vitest configuration file, or a jest configuration file or a `jest` key in `package.json`. Projects using a framework with zero configuration files report `"unknown"` (documented limitation, extensible in a later change). When both are present, vitest wins.
3. **Strict parameter surface**: `params` carrying any key beyond `root_path` fails with `-32602`, per the originating issue's "`discover` takes `{root_path}` only". The platform sends only `root_path` for `discover` in protocol v1.2.0, and a `discover` error degrades gracefully on the platform side, so strictness carries no interoperability risk and fails loud rather than silently ignoring a caller's intent.
4. **`.d.ts` exclusion**: declaration files are excluded from both lists because they contain no function bodies to analyze; this mirrors the reference analyzer's exclusion of Python stub files and is recorded here so it is not a silent skip (Principle III's inclusion mandate covers `.js`/`.jsx`/`.mjs`, which are walked).
5. **Generated-marker scope**: markers are recognized in the file's leading comment block; the read is bounded and deterministic. The exact prefix-read budget is a plan-level decision.
6. **Diagnostics channel**: skip diagnostics are one line each on stderr only; stdout carries nothing but JSON-RPC responses.
7. **Symlinks**: never followed during tree walking; a symlinked `root_path` is resolved before walking, and containment is enforced against the resolved root.
8. **Relative `root_path`**: resolved against the analyzer process's working directory.
9. **Package derivation shape**: strip the extension, join path segments with dots, and drop a trailing `index` segment (an index module represents its directory).
10. **Pruned-directory set**: exactly the five directories named in FR-003; other directories — including dot-directories such as `.github` — are walked.
11. **Framework strings**: lowercase `"vitest"` and `"jest"`, per the originating issue's wording.
12. **Cross-pipeline bookkeeping**: the materialized OpenSpec specifications currently assert that all six capabilities are `false` and that only `initialize`/`shutdown` are registered handlers; the implementation of this feature must update those assertions in the same change. This specification records the impact but does not modify those files.
13. **No `patterns` parameter**: unlike the reference Python analyzer's earlier `discover`, this method does not accept a `patterns` parameter — protocol v1.2.0 defines `discover` params as `{root_path}` only, and whole-tree walking is the specified behavior.
