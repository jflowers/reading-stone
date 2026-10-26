# Research: Discovery and Shared Analysis Infrastructure

**Feature Branch**: `001-discovery-shared-analysis`
**Date**: 2026-10-26
**Status**: Complete — all NEEDS CLARIFICATION items resolved

Sources consulted: Gaze protocol v1.2.0
(`unbound-force/gaze/docs/protocol.md`, local checkout), the snake-eyes
reference implementation (local checkout at
`zero-dot-force/snake-eyes`, its `taxonomy-and-discovery` change is the
direct precedent), the reading-stone codebase (`src/`, `tests/`,
`openspec/specs/`), and Dewey prior learnings (snake-eyes design
decisions D1–D13, transport hardening bounds).

---

## R1: Canonical side-effect taxonomy source of truth

**Decision**: Transcribe the 48 canonical types, tier membership
(P0=6, P1=11, P2=16, P3=9, P4=6), and the 11 language-neutral aliases
verbatim from Gaze protocol v1.2.0's "Side Effect Types" reference
table. Encode them as TypeScript string-literal unions so the compiler
enforces exhaustiveness of the tier map.

**Rationale**: The constitution pins protocol v1.2.0 and Principle I
forbids inventing local type names. A `Record<SideEffectType, Tier>`
keyed by a 48-member literal union is a compile-time exhaustiveness
check: omitting or duplicating a type is a type error, not a runtime
surprise. snake-eyes made the same choice (Python `StrEnum` + `TIER_MAP`)
and its `taxonomy-and-discovery` change is the proven precedent.

**Alternatives considered**:
- *Runtime-validated arrays*: rejected — moves taxonomy errors from
  compile time to a conformance test; weaker than type-level proof.
- *Importing Gaze's `internal/taxonomy/types.go`*: rejected —
  cross-language import is impossible; the protocol doc table is the
  published contract surface.

The full 48-type-by-tier table and the 11 alias mappings are recorded
in [data-model.md](data-model.md).

## R2: Tree walking mechanism

**Decision**: Recursive walk with `fs.promises.readdir(dir, {
withFileTypes: true })`. Dirents identify entry type without following
symlinks (a symlinked directory reports `isSymbolicLink() === true`,
`isDirectory() === false`). Descend only into entries that are
directories and not symlinks; never follow symlinks for files. Walk
visits entries in sorted (UTF-16 code-unit) order so stderr diagnostics
are deterministic too, not just the sorted response lists.

**Rationale**: `withFileTypes` gives lstat-equivalent type information
in the same syscall family as the listing — symlink safety is
structural (no separate `lstat` pass). Sorted traversal makes every
observable output (stdout AND stderr) deterministic, satisfying
Constitution Principle I beyond the letter of FR-008. The walk mirrors
snake-eyes' `os.walk(followlinks=False)` + prune pattern.

**Alternatives considered**:
- *`fs.glob` / `fs.promises.glob` (Node 22+)*: rejected — symlink and
  ordering semantics are under-documented for our determinism and
  containment guarantees; the explicit walk is auditable.
- *Synchronous `fs.readdirSync`*: rejected — blocks the event loop on
  large trees and forfeits the async dispatch requirement (FR-019).

Recursion depth: each directory level is a separate awaited async call,
so native stack does not grow with tree depth; no explicit depth budget
is needed for walking (unlike AST visitor recursion later).

## R3: Asynchronous dispatch support

**Decision**: Widen `Handler` in `src/server.ts` from
`(params: object | null) => object` to
`(params: object | null) => object | Promise<object>`. Make
`handleLine` async and have the `run()` loop await it. `discover` is
registered as an async built-in handler alongside `initialize` and
`shutdown`; sequential processing is preserved (one request awaited
before the next line is read).

**Rationale**: FR-019 mandates async-capable handlers; discovery uses
`fs/promises`. The change is a type widening — existing sync handlers
(initialize, shutdown) and every existing test keep working unchanged.
The snake-eyes server proved the sequential-read-handle-flush loop
scales to a full method set without concurrency.

**Alternatives considered**:
- *Keep sync dispatch, use `fs` sync APIs in discovery*: rejected —
  blocks the event loop during whole-tree walks (Gaze may stream other
  traffic) and violates FR-019's letter.
- *Worker-thread offload*: rejected — YAGNI; no performance requirement
  in scope.

## R4: Safe, bounded file reader (Constitution V)

**Decision**: A shared `src/safeio.ts` module exporting a
`readBounded(root, relPath, budget, stderr)` function that:

1. Resolves the absolute path by joining the resolved root with the
   walk-built relative path, then verifies containment (see R5).
2. `lstat`s the path — non-regular files (FIFO, device, socket) and
   symlinks are skipped with one stderr diagnostic line each.
3. Checks `size > 16 MiB` (`MAX_FILE_BYTES`, pre-open) — skipped with
   one diagnostic line.
4. Opens and reads at most `budget` bytes — I/O and decode errors are
   skipped with one diagnostic line.
5. Never throws for skip conditions; returns `null` and the caller
   continues. Nothing is written to stdout.

Diagnostics format: `reading-stone: skipping <relPath>: <reason>\n` —
exactly one line per skipped file, injected `Writable` stderr sink
(testable; the Server passes its own `stderr`).

**Rationale**: Mirrors snake-eyes `is_analyzable_file` /
`iter_source_files` (design D13: centralized guard so no caller
re-implements the stat + regular + cap sequence). The stat-before-open
order is essential: opening a FIFO for reading blocks until a writer
appears — the pre-open regular-file check is the FIFO DoS defense.
TOCTOU residual: a file could be swapped for a FIFO between `lstat`
and `open`. This race is accepted and documented (same acceptance as
the reference analyzer; it requires an active attacker racing the walk
against a static analyzed tree).

**Alternatives considered**:
- *`open` + `fstat` on the handle (TOCTOU-free)*: rejected — the open
  itself blocks on a FIFO before `fstat` can run; the pre-open `lstat`
  guard is the actual defense.
- *`O_NONBLOCK` open*: rejected — not portable through Node's `fs.open`
  flags surface on all supported platforms; complexity outweighs the
  residual race.

## R5: Traversal containment

**Decision**: Containment is enforced in two layers:

1. **Structural**: every path handed to the safe reader is built from
   the resolved root plus segments collected during the walk — `..`
   cannot appear and symlinks are never followed (R2), so no walked
   path can escape.
2. **Defense in depth**: the safe reader independently resolves the
   candidate and verifies it stays inside the resolved root
   (`path.relative(root, candidate)` is non-absolute and does not begin
   with `..`); a violation rejects the path unread (FR-018).

The `root_path` itself is `fs.realpath`-resolved before walking
(Assumption 7), so a symlinked root is followed exactly once at the
boundary and containment is enforced against the resolved root.

**Rationale**: FR-018 requires belt-and-suspenders: the walk cannot
produce escapes, and the reader would refuse one anyway. The
independent check protects future callers (issue #3's analyze) that
receive paths from other sources.

**Alternatives considered**:
- *Rely on walk-structural safety alone*: rejected — FR-018 explicitly
  demands resolution-level enforcement for every read.
- *`fs.realpath` every candidate*: rejected — doubles syscalls; the
  join-plus-`relative` check is equivalent for never-symlinked paths.

## R6: Generated-code marker detection without a runtime dependency

**Decision**: Hand-roll a leading-comment-block trivia scanner over a
bounded 64 KiB prefix read (via the safe reader): strip UTF-8 BOM and a
leading shebang line, skip whitespace, then consume consecutive `//`
line comments and `/* */` block comments, stopping at the first
non-comment content. If any consumed comment text contains the
case-sensitive marker `@generated` or `Code generated`, the file is
excluded from both lists (silently — a documented policy exclusion like
`.d.ts`, not a safety skip with a diagnostic).

**Rationale**: Discover does not need the TypeScript AST — it needs
lexical trivia. The `typescript` package is currently a devDependency
and the package has zero runtime dependencies; promoting a ~40 MB
compiler to a runtime dependency belongs to the change that first
requires the AST (issue #3, side-effect detection), where Principle III
makes it mandatory. Comment trivia scanning is not "reimplementing
TypeScript semantics" (Principle III's target) — comments are
`//`-and-`/* */` in all TS/JS dialects. The 64 KiB budget is a
plan-level decision (Assumption 5): large enough for stacked license
headers before a marker, small enough that per-file I/O stays trivial;
truncation at the budget is deterministic (same input → same output).

**Alternatives considered**:
- *`ts.getLeadingCommentRanges` at runtime*: rejected for this change —
  forces promoting `typescript` to `dependencies` one issue early,
  against the Dependency Necessity default (Principle V).
- *4 KiB prefix budget*: rejected — stacked license headers can exceed
  it, silently missing markers.
- *Regex over the raw prefix (no comment-structure awareness)*:
  rejected — would match markers inside strings or code after the
  leading comment block, producing false exclusions.

## R7: Test-framework detection

**Decision**: Detect configuration presence at the **resolved project
root only** (non-recursive), checked independently of file-list
walking:

- **vitest**: any of `vitest.config.ts`, `vitest.config.js`,
  `vitest.config.mts`, `vitest.config.mjs` exists at the root.
- **jest**: any of `jest.config.ts`, `jest.config.js`, `jest.config.mjs`,
  `jest.config.cjs`, `jest.config.json` exists at the root, OR the
  root `package.json` (read via the safe reader, parsed as JSON)
  contains a `jest` key.
- Precedence: vitest when both are present; `"unknown"` when neither.
- An unreadable or malformed `package.json` writes one stderr
  diagnostic and is treated as having no `jest` key.

**Rationale**: Configuration presence is deterministic (FR-006 /
Assumption 2) and independent of file contents and environment.
Root-only detection is the overwhelmingly common layout and keeps the
check O(1) per call. The config files themselves are walked and
classified like any other file (spec edge case: no special casing — a
root `vitest.config.ts` also appears in `source_files`).

**Alternatives considered**:
- *Recursive config search (monorepo `packages/*/vitest.config.ts`)*:
  rejected — YAGNI; no requirement, and it complicates determinism
  stories. Extensible in a later change.
- *Inspecting imports in test files to infer the framework*: rejected —
  Assumption 2 pins detection to configuration presence only.

## R8: Determinism guarantees

**Decision**: Reuse the existing deterministic serializer (`serialize`
sorts keys recursively) and sort both file lists with the default
UTF-16 code-unit lexicographic comparator (`Array.prototype.sort()`),
which is stable, locale-independent, and Node-version-stable. Walk
order is sorted (R2), so stderr diagnostics are deterministic as well.

**Rationale**: FR-008 and SC-003 require byte-identical responses.
`localeCompare` is locale- and ICU-dependent — rejected. A
code-point comparator differs from UTF-16 ordering only for astral vs
surrogate-pair cases and buys nothing measurable; the code-unit order
is the documented deterministic order for both ASCII and non-ASCII
names (spec edge cases: case-distinct files and non-ASCII filenames
are preserved verbatim and sorted deterministically).

## R9: Module layout and layering

**Decision**: Four new modules map 1:1 to the four foundation pieces
the originating issue names, plus edits to the two existing protocol
files:

```text
src/
├── taxonomy.ts    # Tier, SideEffectType (48), TIER_MAP, 11 aliases, resolver
├── models.ts      # Effect, Classification, FunctionRecord, serializers, derivePackage
├── safeio.ts      # bounded traversal-safe reader + stderr diagnostics
├── discovery.ts   # walk, classification, framework detection, markers, discover()
├── server.ts      # (edit) async Handler, discover registration
├── protocol.ts    # (edit) initializeResult flips discover: true
├── main.ts        # (unchanged)
└── index.ts       # (edit) re-export the public model/taxonomy surface
```

Dependency direction: `server → discovery → safeio`, with `taxonomy`
and `models` as leaves; `discovery` throws a dedicated
`InvalidRootPathError` that the server handler maps to
`RpcError(INVALID_PARAMS)` — discovery never imports from server (no
layering inversion). `derivePackage` lives in `models.ts` because it
derives the `package` field of a `FunctionRecord`.

**Rationale**: Mirrors snake-eyes' decomposition (discovery.py /
analysis/_shared.py / analysis/models.py / server.py) which survived
three subsequent analysis changes unchanged. The public surface is
re-exported from `index.ts` so the vocabulary is consumable and
tested as package API (not orphaned code — Zero-Waste satisfied by
conformance tests).

**Alternatives considered**:
- *One `analysis/` directory*: rejected — premature structure for four
  leaf modules; the flat layout matches the existing `src/` style.
- *`derivePackage` in `discovery.ts`*: rejected — the function serves
  `FunctionRecord` construction (analyze phase), not discovery.

## R10: Package derivation shape

**Decision**: `derivePackage(relPath)`: strip the final extension,
join path segments with dots, then drop a trailing `.index` segment.
A top-level `index.ts` derives to `"index"` (no `.` precedes the
segment to strip) — mirroring snake-eyes' top-level `__init__.py` →
`__init__`.

Examples: `pkg/mod.ts` → `pkg.mod`; `pkg/index.ts` → `pkg`;
`src/deep/thing.ts` → `src.deep.thing`.

**Rationale**: Assumption 9 pins the shape; the top-level edge case
must be decided somewhere deterministic, and the reference analyzer's
precedent is the least-surprising resolution.

**Alternatives considered**:
- *Empty string for top-level `index.ts`*: rejected — an empty package
  is not a usable identifier downstream; the reference analyzer keeps
  the module name.

## R11: Test and fixture strategy (Constitution IV)

**Decision**: Fixture trees built per-test in `os.tmpdir()` via
`fs.mkdtemp`, torn down in `afterEach`. Safety fixtures:
oversized files via `fs.truncate` to 16 MiB + 1 (instant sparse file),
FIFOs via `execFileSync("mkfifo", [path])` (POSIX; CI is ubuntu-latest
and local dev is macOS), unreadable files via `fs.chmod(path, 0o000)`,
symlink escapes via `fs.symlink` pointing outside the root. Integration
tests drive the full `Server.run()` over injected streams (existing
`drive()` harness) with canned JSON-RPC lines; determinism tests
byte-compare two full responses.

**Rationale**: The existing test suite already established the
injectable-stream harness and vitest conventions; extending it keeps
the conformance suite in one style. The constitution requires protocol
conformance suites (canned request/response pairs) and observable-
behavior assertions (response JSON, stderr text), not implementation
details. CI parity commands (from `.github/workflows/ci.yml`):
`npm ci`, `npx biome check src/ tests/`, `npm run build`,
`npx vitest run --coverage` — 85% thresholds are protected gates.

**Alternatives considered**:
- *Checked-in fixture directory*: rejected — mutation risk across
  runs, parallel-test interference, and cross-platform permission
  semantics; temp dirs are isolated per test.
- *Mocking `fs`*: rejected — the safety behaviors ARE the filesystem
  interactions; mocking them would test the mock.

## R12: Cross-pipeline bookkeeping (Assumption 12)

**Decision**: The implementation change must update the materialized
OpenSpec assertions in the same PR:
`openspec/specs/protocol/spec.md` (initialize result: `discover: true`,
five flags `false`) and `openspec/specs/server/spec.md` (dispatch-table
scope registers `initialize`, `shutdown`, `discover`; the reserved
`-32601` list drops `discover`). The existing
`tests/server.test.ts` reserved-methods case and
`tests/protocol.test.ts` capability assertions are updated in the same
change.

**Rationale**: The materialized specs assert current behavior; leaving
them stale after shipping `discover` would make the OpenSpec pipeline
lie about the system. The spec records the impact; the plan carries it
as an implementation-phase task (this command writes only
`specs/001-*/` artifacts).

**Alternatives considered**:
- *A separate openspec/changes/ entry for the spec sync*: rejected —
  the reading-stone AGENTS.md treats the materialized specs as
  living documents updated in the same change as the behavior they
  assert; a second pipeline entry for a flag flip is process overhead.

## R13: `.d.ts` and classification precedence

**Decision**: `.d.ts` exclusion is name-based (trailing `.d.ts`
extension) and happens before any read — same silent-policy tier as
generated-marker exclusion. Test classification is evaluated on the
walked path: a file is a test when its basename contains a dot-delimited
`test` or `spec` segment (neither first nor last segment — equivalent
to the `*.test.*` / `*.spec.*` patterns) or any directory component is
exactly `__tests__`, `tests`, or `test`. Any test signal wins over
source; generated-marker exclusion wins over test classification; safety
skips remove the file from both lists and emit exactly one stderr line.

**Rationale**: The precedence chain is fully specified by the spec's
acceptance scenarios and edge cases; recording it once here prevents
divergent re-interpretations during task breakdown and review.

**Alternatives considered**:
- *Glob-matching library for `*.test.*`*: rejected — segment equality
  is the precise semantics of the pattern for walked files (which
  always have a known final extension) with zero dependencies.
