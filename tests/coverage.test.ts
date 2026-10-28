// Coverage attribution and degradation fixtures for src/coverage.ts (T026;
// spec US4 scenarios 1-7; FR-023 through FR-026; SC-004; research R10;
// Assumption 14; Constitution Principles I, II, and V).
//
// RED-FIRST: src/coverage.ts does not exist yet — T028 creates it — so this
// suite fails on module resolution by design (tasks.md: US4 tests are
// written first and observed to FAIL before the paired implementation
// lands).
//
// ENTRY CONTRACT — the reading of the feature artifacts, recorded per the
// task brief and the complexity-suite precedent:
//
// - The import is `parseCoverage` from ../src/coverage.js. contracts/
//   coverage.md pins the external surface as the `coverage` method's
//   {"functions": [...]} payload, and research R10 names the module
//   src/coverage.ts reading <root>/coverage/coverage-final.json through the
//   bounded safe reader. The analyze/complexity precedent is task-for-task:
//   analyze(rootPath, patterns, stderr) and computeComplexity(rootPath,
//   patterns, stderr) return the serialized wire arrays while the server
//   handler wraps them as {"functions": [...]}. The pinned surface is
//   therefore parseCoverage(rootPath, patterns, stderr) returning the
//   serialized CoverageEntry[] (data-model.md), with absent/null patterns
//   meaning the whole tree (FR-001's catch-all).
// - Like tests/complexity.test.ts's complexityTree, coverageTree below
//   accepts BOTH documented result shapes — the bare serialized entry array
//   and the {"functions": [...]} payload — and fails loud on anything
//   else. The JSON-RPC envelope, parameter validation, and dispatch wiring
//   are pinned end-to-end by tests/server.test.ts.
//
// PERCENTAGE PRECISION: the pinned formula is `(covered / total) * 100`
// (FR-023, contracts/coverage.md, data-model.md, research R10), evaluated
// left-to-right, so the expected tables below carry the expression itself
// rather than a decimal literal: (2 / 3) * 100 is the double 66.6666666666666
// while the literal 66.66666666666667 is a different double — (2 * 100) / 3.
// Pinning the expression pins the formula bit-exactly. total_stmts 0 yields
// exactly 0.0 — never a division error (FR-023).
//
// ATTRIBUTION RULE (FR-023; contracts/coverage.md; research R10): each
// statementMap statement is attributed to the innermost fnMap function whose
// loc range contains the statement's start, compared as (line, column);
// innermost = smallest span; ties broken by fnMap key lexicographic order
// (smallest key wins). start_line is fnMap decl.start.line, end_line is
// fnMap loc.end.line, and function is the fnMap name verbatim, including
// (anonymous_N) forms.
//
// FIXTURE STYLE (Assumption 14): every coverage document is a hand-authored
// Istanbul JSON document — no test execution ever runs (Constitution
// Principle V: the pre-existing artifact is consumed, never produced;
// FR-025) — written into a temp fixture tree at
// <root>/coverage/coverage-final.json. Jest-shaped documents key files by
// absolute path (joined from the realpath-resolved root, the extract-suite
// precedent, so macOS's /var symlink can never break containment);
// vitest-shaped documents key by root-relative path. Both normalize to
// root-relative POSIX file values. The planted .ts sources mirror the
// documents' line numbers — each line's 1-based array index IS its line
// number, so the expected tables are auditable in place — though the
// coverage surface never reads them. src/ghost.ts is deliberately NOT
// planted: FR-024 pins root containment and patterns only (research R10
// rejects conforming entries to discovered sources), so a document entry
// with no on-disk file must still report.

import { realpathSync } from "node:fs";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Writable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { parseCoverage } from "../src/coverage.js";
import { createFixtureTree } from "./helpers/fixtures.js";

/** One serialized coverage entry (the seven FR-024 wire fields). */
interface WireEntry {
  readonly file: string;
  readonly function: string;
  readonly start_line: number;
  readonly end_line: number;
  readonly covered_stmts: number;
  readonly total_stmts: number;
  readonly percentage: number;
}

// In-memory stand-in for the Server's stderr (the established sink pattern,
// copied per-file — tasks.md pins the existing fixture/sink helpers rather
// than new shared test infrastructure).
function memorySink(): { stream: Writable; text: () => string } {
  const chunks: string[] = [];
  const stream = new Writable({
    decodeStrings: false,
    write(
      chunk: string | Uint8Array,
      _encoding: string,
      callback: (error?: Error | null) => void,
    ): void {
      const decoded =
        typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
      chunks.push(decoded);
      callback();
    },
  });
  return { stream, text: () => chunks.join("") };
}

// Narrows the result through the two documented shapes (see the header's
// ENTRY CONTRACT note). A missing functions array is a malformed result, not
// a soft zero — fail loud rather than assert against [].
function isEntriesContainer(
  value: unknown,
): value is { functions: readonly WireEntry[] } {
  return (
    typeof value === "object" &&
    value !== null &&
    Array.isArray((value as { functions?: unknown }).functions)
  );
}

function extractEntries(result: unknown): readonly WireEntry[] {
  if (Array.isArray(result)) {
    return result as readonly WireEntry[];
  }
  if (isEntriesContainer(result)) {
    return result.functions;
  }
  throw new Error(
    "unexpected coverage result shape: expected the serialized CoverageEntry[] payload or an object with a functions array",
  );
}

// Runs one coverage parse with a fresh stderr sink; absent patterns mean
// the whole tree (FR-001's catch-all), exactly as the complexity suite
// drives computeComplexity.
async function coverageTree(
  root: string,
  patterns?: string[] | null,
): Promise<{ entries: readonly WireEntry[]; stderr: () => string }> {
  const sink = memorySink();
  const result: unknown = await parseCoverage(root, patterns, sink.stream);
  return { entries: extractEntries(result), stderr: sink.text };
}

// Fixture trees register their cleanup here so every test body stays linear;
// afterEach drains the queue in creation order (same pattern as
// tests/analysis.test.ts).
const pendingCleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  const cleanups = pendingCleanups.splice(0, pendingCleanups.length);
  for (const cleanup of cleanups) {
    await cleanup();
  }
});

async function makeTree(files: Readonly<Record<string, string>>): Promise<string> {
  const tree = await createFixtureTree(files);
  pendingCleanups.push(tree.cleanup);
  // The production caller passes a root that discovery's resolveRoot already
  // realpath-resolved; the fixture's mkdtemp path sits behind macOS's /var
  // symlink, so resolve it the same way before joining absolute file keys.
  return realpathSync(tree.root);
}

// chmod-based inaccessibility is meaningless for root, where mode bits do
// not restrict the owner.
const runningAsRoot = typeof process.getuid === "function" && process.getuid() === 0;

// Plants one coverage document at the conventional artifact location
// (FR-023: <root>/coverage/coverage-final.json — the only location read;
// the tree is never walked for coverage).
async function plantCoverageDocument(root: string, document: string): Promise<void> {
  const target = join(root, "coverage", "coverage-final.json");
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, document, "utf8");
}

// Finds the unique entry for (name, file) — the one-entry-per-fixture
// invariant every focused assertion relies on; a miss or a duplicate is an
// extraction or fixture bug, never a soft match.
function entryFor(
  entries: readonly WireEntry[],
  name: string,
  file: string,
): WireEntry {
  let found: WireEntry | undefined;
  let count = 0;
  for (const entry of entries) {
    if (entry.function === name && entry.file === file) {
      found = entry;
      count += 1;
    }
  }
  if (count !== 1 || found === undefined) {
    throw new Error(
      `expected exactly one coverage entry named "${name}" in ${file}, found ${count}`,
    );
  }
  return found;
}

// The identity tuple every ordering assertion projects onto: FR-024's
// (file, start_line, function).
function entryTuples(entries: readonly WireEntry[]): Array<[string, number, string]> {
  return entries.map((entry) => [entry.file, entry.start_line, entry.function]);
}

// The full contract projection: every field of the wire entry.
function entryProjection(
  entries: readonly WireEntry[],
): ReadonlyArray<Record<string, unknown>> {
  return entries.map((entry) => ({
    file: entry.file,
    function: entry.function,
    start_line: entry.start_line,
    end_line: entry.end_line,
    covered_stmts: entry.covered_stmts,
    total_stmts: entry.total_stmts,
    percentage: entry.percentage,
  }));
}

// The FR-024 total order over identity tuples: (file, start_line,
// function), codepoint comparison for the string keys.
function compareTuples(
  a: readonly [string, number, string],
  b: readonly [string, number, string],
): number {
  if (a[0] !== b[0]) {
    return a[0] < b[0] ? -1 : 1;
  }
  if (a[1] !== b[1]) {
    return a[1] - b[1];
  }
  if (a[2] !== b[2]) {
    return a[2] < b[2] ? -1 : 1;
  }
  return 0;
}

// The closed entry key set — FR-024's "exactly" seven fields; anything
// beyond these keys is a wire-shape violation.
const ENTRY_KEYS: readonly string[] = [
  "covered_stmts",
  "end_line",
  "file",
  "function",
  "percentage",
  "start_line",
  "total_stmts",
];

// FR-024 invariants over a whole result: exact seven-field key sets, the
// documented (file, start_line, function) total order, integer line and
// count fields, covered never exceeding total, and a numeric percentage.
function expectWireInvariants(entries: readonly WireEntry[]): void {
  const tuples = entryTuples(entries);
  expect(tuples).toEqual([...tuples].sort(compareTuples));
  for (const entry of entries) {
    expect(Object.keys(entry).sort()).toEqual([...ENTRY_KEYS]);
    expect(Number.isInteger(entry.start_line)).toBe(true);
    expect(entry.start_line).toBeGreaterThanOrEqual(1);
    expect(Number.isInteger(entry.end_line)).toBe(true);
    expect(entry.end_line).toBeGreaterThanOrEqual(entry.start_line);
    expect(Number.isInteger(entry.covered_stmts)).toBe(true);
    expect(entry.covered_stmts).toBeGreaterThanOrEqual(0);
    expect(Number.isInteger(entry.total_stmts)).toBe(true);
    expect(entry.total_stmts).toBeGreaterThanOrEqual(0);
    expect(entry.covered_stmts).toBeLessThanOrEqual(entry.total_stmts);
    expect(entry.percentage).toBeTypeOf("number");
  }
}

// ---------------------------------------------------------------------------
// Istanbul fixture vocabulary (research R10's document model): 1-based
// lines, 0-based columns. The helpers keep every hand-authored document
// below positional and auditable.
// ---------------------------------------------------------------------------

/** One Istanbul position (1-based line, 0-based column). */
interface Position {
  readonly line: number;
  readonly column: number;
}

/** One Istanbul location range. */
interface Loc {
  readonly start: Position;
  readonly end: Position;
}

/** One Istanbul fnMap record. */
interface FnRecord {
  readonly name: string;
  readonly decl: Loc;
  readonly loc: Loc;
}

function pos(line: number, column: number): Position {
  return { line, column };
}

function loc(
  startLine: number,
  startColumn: number,
  endLine: number,
  endColumn: number,
): Loc {
  return { start: pos(startLine, startColumn), end: pos(endLine, endColumn) };
}

function fnRecord(name: string, decl: Loc, body: Loc): FnRecord {
  return { name, decl, loc: body };
}

// ---------------------------------------------------------------------------
// The attribution project (FR-023/FR-024; US4 scenarios 1-2, 7): five files
// whose planted sources mirror the documents' positions. math.ts pins
// full and partial coverage; noop.ts pins the zero-statement function;
// nested.ts pins innermost attribution; callbacks.ts pins the verbatim
// (anonymous_0) name; ghost.ts (unplanted) pins document-derived entries.
// ---------------------------------------------------------------------------

const MATH_SOURCE = [
  "export function add(a: number, b: number): number {",
  "  return a + b;",
  "}",
  "",
  "export function divide(a: number, b: number): number {",
  "  if (b === 0) {",
  "    return 0;",
  "  }",
  "  return a / b;",
  "}",
  "",
].join("\n");

const NOOP_SOURCE = ["export function noop(): void {}", ""].join("\n");

const NESTED_SOURCE = [
  "export function outer(value: number): number {",
  "  function inner(input: number): number {",
  "    return input * 2;",
  "  }",
  "  if (value > 0) {",
  "    return inner(value);",
  "  }",
  "  return 0;",
  "}",
  "",
].join("\n");

const CALLBACKS_SOURCE = [
  "export function applyEach(values: number[]): number[] {",
  "  return values.map(function (value: number): number {",
  "    return value * 2;",
  "  });",
  "}",
  "",
].join("\n");

// add runs fully (1/1); divide's then-branch never runs (2 of 3 covered).
const MATH_COVERAGE = {
  statementMap: {
    "0": loc(2, 2, 2, 15), // return a + b;
    "1": loc(6, 2, 8, 3), // if (b === 0) { ... }
    "2": loc(7, 4, 7, 13), // return 0; (never taken)
    "3": loc(9, 2, 9, 14), // return a / b;
  },
  fnMap: {
    "0": fnRecord("add", loc(1, 16, 1, 19), loc(1, 7, 3, 2)),
    "1": fnRecord("divide", loc(5, 16, 5, 22), loc(5, 7, 10, 2)),
  },
  s: { "0": 1, "1": 1, "2": 0, "3": 1 },
  // Documented-ignored Istanbul noise (data-model.md: branchMap/b/f may be
  // present and are ignored). The values contradict s on purpose — an
  // implementation consulting f would report add as uncovered and flip the
  // expected tables below.
  branchMap: {
    "0": {
      loc: loc(6, 2, 6, 15),
      type: "if",
      locations: [loc(6, 2, 6, 15), loc(7, 4, 7, 13)],
    },
  },
  b: { "0": [0, 0] },
  f: { "0": 0, "1": 0 },
};

// An empty body: no statements to attribute, so total_stmts is 0 and
// percentage is exactly 0.0 — never a division error (FR-023).
const NOOP_COVERAGE = {
  statementMap: {},
  fnMap: {
    "0": fnRecord("noop", loc(1, 16, 1, 20), loc(1, 7, 1, 31)),
  },
  s: {},
};

// One call outer(-1): the if evaluates, the positive branch and inner never
// run, return 0 does. inner's body statement attributes to inner alone
// (US4 scenario 7); outer totals exactly its three own statements.
const NESTED_COVERAGE = {
  statementMap: {
    "0": loc(3, 4, 3, 19), // return input * 2; (inner only)
    "1": loc(5, 2, 7, 3), // if (value > 0) { ... }
    "2": loc(6, 4, 6, 21), // return inner(value); (never taken)
    "3": loc(8, 2, 8, 10), // return 0;
  },
  fnMap: {
    "0": fnRecord("outer", loc(1, 16, 1, 21), loc(1, 7, 9, 2)),
    "1": fnRecord("inner", loc(2, 11, 2, 16), loc(2, 4, 4, 5)),
  },
  s: { "0": 0, "1": 1, "2": 0, "3": 1 },
};

// applyEach called once over four values: the map statement (start column 2,
// before the anonymous loc begins at column 20) attributes to applyEach;
// the callback body statement attributes to the innermost (anonymous_0).
const CALLBACKS_COVERAGE = {
  statementMap: {
    "0": loc(2, 2, 4, 6), // return values.map(...);
    "1": loc(3, 6, 3, 21), // return value * 2; (runs four times)
  },
  fnMap: {
    "0": fnRecord("applyEach", loc(1, 16, 1, 25), loc(1, 7, 5, 2)),
    "1": fnRecord("(anonymous_0)", loc(2, 20, 2, 28), loc(2, 20, 4, 5)),
  },
  s: { "0": 1, "1": 4 },
};

// No on-disk counterpart is planted for this entry (see the header): the
// document alone must report it. One of two statements covered.
const PHANTOM_COVERAGE = {
  statementMap: {
    "0": loc(2, 2, 2, 26), // const doubled = step * 2;
    "1": loc(3, 2, 3, 16), // return doubled; (never taken)
  },
  fnMap: {
    "0": fnRecord("phantom", loc(1, 16, 1, 23), loc(1, 7, 4, 2)),
  },
  s: { "0": 1, "1": 0 },
};

const PROJECT_SOURCES: Readonly<Record<string, string>> = {
  "src/callbacks.ts": CALLBACKS_SOURCE,
  "src/nested.ts": NESTED_SOURCE,
  "src/utils/math.ts": MATH_SOURCE,
  "src/utils/noop.ts": NOOP_SOURCE,
  // src/ghost.ts is deliberately absent — see the header's fixture note.
};

const PROJECT_FILES: Readonly<Record<string, Record<string, unknown>>> = {
  "src/callbacks.ts": CALLBACKS_COVERAGE,
  "src/ghost.ts": PHANTOM_COVERAGE,
  "src/nested.ts": NESTED_COVERAGE,
  "src/utils/math.ts": MATH_COVERAGE,
  "src/utils/noop.ts": NOOP_COVERAGE,
};

// One project document in either emitter shape: vitest-shaped keys the
// files root-relatively; jest-shaped keys them absolutely (joined from the
// resolved root). Both must normalize to the same root-relative POSIX
// file values (US4 scenarios 1-2).
function projectDocument(root: string, absoluteKeys: boolean): string {
  const doc: Record<string, unknown> = {};
  for (const [relativePath, fileCoverage] of Object.entries(PROJECT_FILES)) {
    doc[absoluteKeys ? join(root, relativePath) : relativePath] = fileCoverage;
  }
  return JSON.stringify(doc);
}

async function vitestShapedProjectTree(): Promise<string> {
  const root = await makeTree(PROJECT_SOURCES);
  await plantCoverageDocument(root, projectDocument(root, false));
  return root;
}

async function jestShapedProjectTree(): Promise<string> {
  const root = await makeTree(PROJECT_SOURCES);
  await plantCoverageDocument(root, projectDocument(root, true));
  return root;
}

// The exact entries over the attribution project, ordered by
// (file, start_line, function): callbacks < ghost < nested < utils/math <
// utils/noop; same-file ties by start_line. Percentages carry the pinned
// formula's expression (see the header's PERCENTAGE PRECISION note).
const PROJECT_EXPECTED: ReadonlyArray<Record<string, unknown>> = [
  {
    file: "src/callbacks.ts",
    function: "applyEach",
    start_line: 1,
    end_line: 5,
    covered_stmts: 1,
    total_stmts: 1,
    percentage: 100,
  },
  {
    file: "src/callbacks.ts",
    function: "(anonymous_0)",
    start_line: 2,
    end_line: 4,
    covered_stmts: 1,
    total_stmts: 1,
    percentage: 100,
  },
  {
    file: "src/ghost.ts",
    function: "phantom",
    start_line: 1,
    end_line: 4,
    covered_stmts: 1,
    total_stmts: 2,
    percentage: 50,
  },
  {
    file: "src/nested.ts",
    function: "outer",
    start_line: 1,
    end_line: 9,
    covered_stmts: 2,
    total_stmts: 3,
    percentage: (2 / 3) * 100,
  },
  {
    file: "src/nested.ts",
    function: "inner",
    start_line: 2,
    end_line: 4,
    covered_stmts: 0,
    total_stmts: 1,
    percentage: 0,
  },
  {
    file: "src/utils/math.ts",
    function: "add",
    start_line: 1,
    end_line: 3,
    covered_stmts: 1,
    total_stmts: 1,
    percentage: 100,
  },
  {
    file: "src/utils/math.ts",
    function: "divide",
    start_line: 5,
    end_line: 10,
    covered_stmts: 2,
    total_stmts: 3,
    percentage: (2 / 3) * 100,
  },
  {
    file: "src/utils/noop.ts",
    function: "noop",
    start_line: 1,
    end_line: 1,
    covered_stmts: 0,
    total_stmts: 0,
    percentage: 0,
  },
];

// ---------------------------------------------------------------------------
// The pattern-scoping tree (FR-001/FR-024; US4 scenario 6): nested.ts and
// math.ts reuse the attribution bodies; utils-extra/edge.ts sits behind the
// "/-boundary that separates the src/utils prefix from src/utils-extra.
// No sources are planted — the coverage surface never walks the tree.
// ---------------------------------------------------------------------------

const EDGE_COVERAGE = {
  statementMap: {
    "0": loc(2, 2, 2, 14), // return flag;
  },
  fnMap: {
    "0": fnRecord("edge", loc(1, 16, 1, 20), loc(1, 7, 3, 2)),
  },
  s: { "0": 1 },
};

function patternsDocument(): string {
  return JSON.stringify({
    "src/nested.ts": NESTED_COVERAGE,
    "src/utils-extra/edge.ts": EDGE_COVERAGE,
    "src/utils/math.ts": MATH_COVERAGE,
  });
}

async function patternsTree(): Promise<string> {
  const root = await makeTree({});
  await plantCoverageDocument(root, patternsDocument());
  return root;
}

// The whole-tree table: nested < utils-extra/edge < utils/math ("-" sorts
// before "/" at the eighth character), so the boundary file also pins
// result ordering across a directory edge.
const PATTERNS_EXPECTED: ReadonlyArray<Record<string, unknown>> = [
  {
    file: "src/nested.ts",
    function: "outer",
    start_line: 1,
    end_line: 9,
    covered_stmts: 2,
    total_stmts: 3,
    percentage: (2 / 3) * 100,
  },
  {
    file: "src/nested.ts",
    function: "inner",
    start_line: 2,
    end_line: 4,
    covered_stmts: 0,
    total_stmts: 1,
    percentage: 0,
  },
  {
    file: "src/utils-extra/edge.ts",
    function: "edge",
    start_line: 1,
    end_line: 3,
    covered_stmts: 1,
    total_stmts: 1,
    percentage: 100,
  },
  {
    file: "src/utils/math.ts",
    function: "add",
    start_line: 1,
    end_line: 3,
    covered_stmts: 1,
    total_stmts: 1,
    percentage: 100,
  },
  {
    file: "src/utils/math.ts",
    function: "divide",
    start_line: 5,
    end_line: 10,
    covered_stmts: 2,
    total_stmts: 3,
    percentage: (2 / 3) * 100,
  },
];

// ["src/utils"] keeps exactly the math entries (add, divide).
const PATTERNS_UTILS_EXPECTED: ReadonlyArray<Record<string, unknown>> = [
  PROJECT_EXPECTED[5],
  PROJECT_EXPECTED[6],
];

// ["src/nested.ts"] — an exact-file pattern — keeps exactly outer, inner.
const PATTERNS_NESTED_EXPECTED: ReadonlyArray<Record<string, unknown>> = [
  PROJECT_EXPECTED[3],
  PROJECT_EXPECTED[4],
];

// ---------------------------------------------------------------------------
// The per-entry-tolerance tree (FR-026; US4 scenario 5): two conforming
// entries plus one non-conforming entry per failure kind — statementMap
// missing, fnMap not an object, s missing, an fnMap record missing its loc
// (the referenced shape does not hold), and a file entry that is not an
// object at all.
// ---------------------------------------------------------------------------

const STEADY_COVERAGE = {
  statementMap: {
    "0": loc(2, 2, 2, 14), // return flag;
  },
  fnMap: {
    "0": fnRecord("steady", loc(1, 16, 1, 22), loc(1, 7, 3, 2)),
  },
  s: { "0": 1 },
};

const BRIGHT_COVERAGE = {
  statementMap: {
    "0": loc(2, 2, 2, 26), // const doubled = step * 2;
    "1": loc(3, 2, 3, 16), // return doubled; (never taken)
  },
  fnMap: {
    "0": fnRecord("bright", loc(1, 16, 1, 22), loc(1, 7, 4, 2)),
  },
  s: { "0": 1, "1": 0 },
};

// statementMap absent entirely.
const MISSING_STATEMENT_MAP = {
  fnMap: {
    "0": fnRecord("omitted", loc(1, 16, 1, 23), loc(1, 7, 3, 2)),
  },
  s: { "0": 1 },
};

// fnMap present but not an object.
const SCALAR_FN_MAP = {
  statementMap: { "0": loc(2, 2, 2, 14) },
  fnMap: "not-a-map",
  s: { "0": 1 },
};

// s absent entirely.
const MISSING_S = {
  statementMap: { "0": loc(2, 2, 2, 14) },
  fnMap: {
    "0": fnRecord("countless", loc(1, 16, 1, 25), loc(1, 7, 3, 2)),
  },
};

// fnMap's referenced shape does not hold: loc is missing from the record.
const SHAPELESS_FN = {
  statementMap: { "0": loc(2, 2, 2, 14) },
  fnMap: {
    "0": { name: "shapeless", decl: loc(1, 16, 1, 26) },
  },
  s: { "0": 1 },
};

function toleranceDocument(): string {
  return JSON.stringify({
    "src/alpha.ts": STEADY_COVERAGE,
    "src/zulu.ts": BRIGHT_COVERAGE,
    "src/missing-statement-map.ts": MISSING_STATEMENT_MAP,
    "src/scalar-fn-map.ts": SCALAR_FN_MAP,
    "src/missing-s.ts": MISSING_S,
    "src/shapeless-fn.ts": SHAPELESS_FN,
    // A file entry that is not an object at all.
    "src/scalar-entry.ts": 3,
  });
}

const TOLERANCE_EXPECTED: ReadonlyArray<Record<string, unknown>> = [
  {
    file: "src/alpha.ts",
    function: "steady",
    start_line: 1,
    end_line: 3,
    covered_stmts: 1,
    total_stmts: 1,
    percentage: 100,
  },
  {
    file: "src/zulu.ts",
    function: "bright",
    start_line: 1,
    end_line: 4,
    covered_stmts: 1,
    total_stmts: 2,
    percentage: 50,
  },
];

// ---------------------------------------------------------------------------
// The attribution-rule edge cases: an equal-span tie decided by fnMap key
// lexicographic order ("10" < "2" — discriminated from insertion order,
// which enumerates "2" first), an overlapping pair where the smallest span
// starts EARLIER than the larger (discriminated from latest-start), and a
// record whose decl.start.line differs from its loc.start.line (pinning
// start_line's source). Identical loc ranges cannot arise from real code,
// but the pinned rule is total: Assumption 14's hand-authored documents
// probe exactly what FR-023 says.
// ---------------------------------------------------------------------------

const TIE_COVERAGE = {
  statementMap: {
    "0": loc(2, 2, 2, 14),
  },
  fnMap: {
    // Insertion order enumerates "2" before "10", but the tiebreak is
    // lexicographic: "10" < "2", so the statement attributes to tieTen.
    "2": fnRecord("tieTwo", loc(1, 16, 1, 22), loc(1, 7, 3, 2)),
    "10": fnRecord("tieTen", loc(1, 16, 1, 22), loc(1, 7, 3, 2)),
  },
  s: { "0": 1 },
};

const OVERLAP_COVERAGE = {
  statementMap: {
    // Contained in BOTH ranges: earlyNarrow (lines 2-4) has the smaller
    // span even though lateBroad (lines 3-20) starts later — smallest span
    // wins, not latest start.
    "0": loc(3, 5, 3, 19),
    // Contained in lateBroad only.
    "1": loc(15, 2, 15, 16),
  },
  fnMap: {
    "0": fnRecord("earlyNarrow", loc(2, 4, 2, 15), loc(2, 0, 4, 10)),
    "1": fnRecord("lateBroad", loc(3, 4, 3, 14), loc(3, 0, 20, 1)),
  },
  s: { "0": 1, "1": 0 },
};

const DECL_LINE_COVERAGE = {
  statementMap: {
    "0": loc(5, 2, 5, 14),
  },
  fnMap: {
    // decl.start.line (4) deliberately differs from loc.start.line (2):
    // start_line must come from the declaration, end_line from loc.end.
    "0": fnRecord("declaredLate", loc(4, 9, 4, 21), loc(2, 2, 6, 3)),
  },
  s: { "0": 1 },
};

function edgeCasesDocument(): string {
  return JSON.stringify({
    "src/decl-line.ts": DECL_LINE_COVERAGE,
    "src/overlap.ts": OVERLAP_COVERAGE,
    "src/tie.ts": TIE_COVERAGE,
  });
}

async function edgeCasesTree(): Promise<string> {
  const root = await makeTree({});
  await plantCoverageDocument(root, edgeCasesDocument());
  return root;
}

const EDGE_CASES_EXPECTED: ReadonlyArray<Record<string, unknown>> = [
  {
    file: "src/decl-line.ts",
    function: "declaredLate",
    start_line: 4,
    end_line: 6,
    covered_stmts: 1,
    total_stmts: 1,
    percentage: 100,
  },
  {
    file: "src/overlap.ts",
    function: "earlyNarrow",
    start_line: 2,
    end_line: 4,
    covered_stmts: 1,
    total_stmts: 1,
    percentage: 100,
  },
  {
    file: "src/overlap.ts",
    function: "lateBroad",
    start_line: 3,
    end_line: 20,
    covered_stmts: 0,
    total_stmts: 1,
    percentage: 0,
  },
  {
    file: "src/tie.ts",
    function: "tieTen",
    start_line: 1,
    end_line: 3,
    covered_stmts: 1,
    total_stmts: 1,
    percentage: 100,
  },
  {
    file: "src/tie.ts",
    function: "tieTwo",
    start_line: 1,
    end_line: 3,
    covered_stmts: 0,
    total_stmts: 0,
    percentage: 0,
  },
];

// ---------------------------------------------------------------------------
// The containment tree (FR-024; spec edge case): one absolute key under the
// resolved root plus three escapes — an absolute sibling that shares the
// root's leading string (a startsWith check would wrongly keep it), an
// absolute path elsewhere entirely, and a relative key that resolves above
// the root.
// ---------------------------------------------------------------------------

const INSIDE_COVERAGE = {
  statementMap: {
    "0": loc(2, 2, 2, 14),
  },
  fnMap: {
    "0": fnRecord("inside", loc(1, 16, 1, 22), loc(1, 7, 3, 2)),
  },
  s: { "0": 1 },
};

const TRAP_COVERAGE = {
  statementMap: {
    "0": loc(2, 2, 2, 14),
  },
  fnMap: {
    "0": fnRecord("prefixTrap", loc(1, 16, 1, 26), loc(1, 7, 3, 2)),
  },
  s: { "0": 1 },
};

const STRANGER_COVERAGE = {
  statementMap: {
    "0": loc(2, 2, 2, 14),
  },
  fnMap: {
    "0": fnRecord("stranger", loc(1, 16, 1, 24), loc(1, 7, 3, 2)),
  },
  s: { "0": 1 },
};

const ESCAPE_COVERAGE = {
  statementMap: {
    "0": loc(2, 2, 2, 14),
  },
  fnMap: {
    "0": fnRecord("escape", loc(1, 16, 1, 22), loc(1, 7, 3, 2)),
  },
  s: { "0": 1 },
};

function containmentDocument(root: string): string {
  return JSON.stringify({
    [join(root, "src/inside.ts")]: INSIDE_COVERAGE,
    // Shares the root's leading string but sits beside it, not under it —
    // lexical containment (path.relative) skips it; startsWith would not.
    [`${root}-trap/src/prefix.ts`]: TRAP_COVERAGE,
    "/definitely/elsewhere/src/stranger.ts": STRANGER_COVERAGE,
    // A relative key resolving above the root is an escape, not a file.
    "../escape.ts": ESCAPE_COVERAGE,
  });
}

const CONTAINMENT_EXPECTED: ReadonlyArray<Record<string, unknown>> = [
  {
    file: "src/inside.ts",
    function: "inside",
    start_line: 1,
    end_line: 3,
    covered_stmts: 1,
    total_stmts: 1,
    percentage: 100,
  },
];

// ---------------------------------------------------------------------------
// The suites.
// ---------------------------------------------------------------------------

describe("emitter parity and attribution (FR-023/FR-024; US4 scenarios 1-2, 7)", () => {
  it("a vitest-shaped document (root-relative file keys) produces the exact expected entries (US4 scenario 1)", async () => {
    const root = await vitestShapedProjectTree();
    const run = await coverageTree(root);
    expect(entryProjection(run.entries)).toEqual(PROJECT_EXPECTED);
    expectWireInvariants(run.entries);
    expect(run.stderr()).toBe("");
  });

  it("a jest-shaped document (absolute file keys) produces the identical expected entries (US4 scenario 2)", async () => {
    const root = await jestShapedProjectTree();
    const run = await coverageTree(root);
    expect(entryProjection(run.entries)).toEqual(PROJECT_EXPECTED);
    expectWireInvariants(run.entries);
  });

  it("statements inside a nested function's range count toward the innermost enclosing function only (US4 scenario 7)", async () => {
    const root = await vitestShapedProjectTree();
    const run = await coverageTree(root);
    const inner = entryFor(run.entries, "inner", "src/nested.ts");
    const outer = entryFor(run.entries, "outer", "src/nested.ts");
    // inner's body statement (line 3) attributes to inner alone...
    expect(inner.total_stmts).toBe(1);
    // ...while outer totals exactly its three own statements (lines 5-8):
    // the nested statement never double-counts to the enclosing function.
    expect(outer.total_stmts).toBe(3);
  });

  it("fnMap names pass through verbatim, including the (anonymous_0) form (FR-024)", async () => {
    const root = await vitestShapedProjectTree();
    const run = await coverageTree(root);
    const anonymous = entryFor(run.entries, "(anonymous_0)", "src/callbacks.ts");
    expect(anonymous.covered_stmts).toBe(1);
    expect(anonymous.total_stmts).toBe(1);
  });

  it("percentage is (covered / total) * 100 at full float precision, and exactly 0.0 when total_stmts is 0", async () => {
    const root = await vitestShapedProjectTree();
    const run = await coverageTree(root);
    // The pinned formula, evaluated left-to-right: (2 / 3) * 100 is the
    // double 66.6666666666666 — NOT the literal 66.66666666666667, which
    // is the different double (2 * 100) / 3.
    expect(entryFor(run.entries, "divide", "src/utils/math.ts").percentage).toBe(
      (2 / 3) * 100,
    );
    // total_stmts 0 (noop) and covered 0 of a nonzero total (inner) both
    // yield exactly 0.0 — never a division error.
    expect(entryFor(run.entries, "noop", "src/utils/noop.ts").percentage).toBe(0);
    expect(entryFor(run.entries, "inner", "src/nested.ts").percentage).toBe(0);
  });

  it("a document entry with no on-disk source still reports (FR-024 pins containment and patterns only)", async () => {
    const root = await vitestShapedProjectTree();
    const run = await coverageTree(root);
    const phantom = entryFor(run.entries, "phantom", "src/ghost.ts");
    expect(phantom.covered_stmts).toBe(1);
    expect(phantom.total_stmts).toBe(2);
  });

  it("repeat responses over the same tree and artifact are byte-identical (SC-006)", async () => {
    const root = await vitestShapedProjectTree();
    const first = await coverageTree(root);
    const second = await coverageTree(root);
    expect(JSON.stringify(second.entries)).toBe(JSON.stringify(first.entries));
  });
});

describe("pattern scoping (FR-001/FR-024; US4 scenario 6)", () => {
  it("absent patterns mean the whole tree (FR-001's catch-all)", async () => {
    const root = await patternsTree();
    const run = await coverageTree(root);
    expect(entryProjection(run.entries)).toEqual(PATTERNS_EXPECTED);
    expectWireInvariants(run.entries);
  });

  it("a directory pattern keeps files at or under the prefix: src/utils does not match src/utils-extra", async () => {
    const root = await patternsTree();
    const run = await coverageTree(root, ["src/utils"]);
    expect(entryProjection(run.entries)).toEqual(PATTERNS_UTILS_EXPECTED);
  });

  it("pattern normalization strips one leading ./ and one trailing /... (FR-001)", async () => {
    const root = await patternsTree();
    const run = await coverageTree(root, ["./src/utils/..."]);
    expect(entryProjection(run.entries)).toEqual(PATTERNS_UTILS_EXPECTED);
  });

  it("an exact-file pattern matches that file alone", async () => {
    const root = await patternsTree();
    const run = await coverageTree(root, ["src/nested.ts"]);
    expect(entryProjection(run.entries)).toEqual(PATTERNS_NESTED_EXPECTED);
  });

  it("patterns union across directory and exact-file forms", async () => {
    const root = await patternsTree();
    const run = await coverageTree(root, ["src/utils", "src/nested.ts"]);
    expect(entryProjection(run.entries)).toEqual([
      ...PATTERNS_NESTED_EXPECTED,
      ...PATTERNS_UTILS_EXPECTED,
    ]);
  });

  it("a pattern set matching nothing yields empty results, never an error", async () => {
    const root = await patternsTree();
    const run = await coverageTree(root, ["docs"]);
    expect(run.entries).toEqual([]);
  });

  it("null, empty-array, ./..., and ... patterns all mean the whole tree (FR-001 catch-alls)", async () => {
    const root = await patternsTree();
    for (const patterns of [null, [], ["./..."], ["..."]]) {
      const run = await coverageTree(root, patterns);
      expect(entryProjection(run.entries)).toEqual(PATTERNS_EXPECTED);
    }
  });
});

describe("per-entry tolerance (FR-026; US4 scenario 5)", () => {
  it("non-conforming file entries skip while the conforming entries report", async () => {
    const root = await makeTree({});
    await plantCoverageDocument(root, toleranceDocument());
    const run = await coverageTree(root);
    expect(entryProjection(run.entries)).toEqual(TOLERANCE_EXPECTED);
    expectWireInvariants(run.entries);
  });

  it("the skip set is deterministic: repeat responses are byte-identical", async () => {
    const root = await makeTree({});
    await plantCoverageDocument(root, toleranceDocument());
    const first = await coverageTree(root);
    const second = await coverageTree(root);
    expect(JSON.stringify(second.entries)).toBe(JSON.stringify(first.entries));
  });
});

describe("attribution-rule edge cases (FR-023; research R10)", () => {
  it('equal spans tie to the lexicographically smallest fnMap key: "10" before "2"', async () => {
    const root = await edgeCasesTree();
    const run = await coverageTree(root);
    expect(entryFor(run.entries, "tieTen", "src/tie.ts").total_stmts).toBe(1);
    expect(entryFor(run.entries, "tieTwo", "src/tie.ts").total_stmts).toBe(0);
  });

  it("smallest span wins over latest start when ranges overlap", async () => {
    const root = await edgeCasesTree();
    const run = await coverageTree(root);
    expect(entryFor(run.entries, "earlyNarrow", "src/overlap.ts").total_stmts).toBe(1);
    expect(entryFor(run.entries, "lateBroad", "src/overlap.ts").total_stmts).toBe(1);
    expect(entryFor(run.entries, "earlyNarrow", "src/overlap.ts").covered_stmts).toBe(
      1,
    );
    expect(entryFor(run.entries, "lateBroad", "src/overlap.ts").covered_stmts).toBe(0);
  });

  it("start_line comes from decl.start.line and end_line from loc.end.line", async () => {
    const root = await edgeCasesTree();
    const run = await coverageTree(root);
    const declared = entryFor(run.entries, "declaredLate", "src/decl-line.ts");
    expect(declared.start_line).toBe(4);
    expect(declared.end_line).toBe(6);
  });

  it("the exact edge-case entries, ordered by (file, start_line, function) — same-line ties by name", async () => {
    const root = await edgeCasesTree();
    const run = await coverageTree(root);
    expect(entryProjection(run.entries)).toEqual(EDGE_CASES_EXPECTED);
    expectWireInvariants(run.entries);
  });
});

describe("root containment (FR-024; spec edge case)", () => {
  it("file keys not under the resolved root are skipped — including a prefix-sharing sibling", async () => {
    const root = await makeTree({});
    await plantCoverageDocument(root, containmentDocument(root));
    const run = await coverageTree(root);
    expect(entryProjection(run.entries)).toEqual(CONTAINMENT_EXPECTED);
    expectWireInvariants(run.entries);
  });
});

describe("degradation ladder (FR-025; US4 scenarios 3-4)", () => {
  it("a root with no coverage/coverage-final.json reports empty coverage (US4 scenario 3)", async () => {
    const root = await makeTree({ "src/utils/math.ts": MATH_SOURCE });
    const run = await coverageTree(root);
    expect(run.entries).toEqual([]);
  });

  it.each([
    { condition: "an unparseable document", contents: '{"statementMap": ' },
    { condition: "a top-level JSON array", contents: "[]" },
    { condition: "a top-level JSON scalar", contents: "42" },
    { condition: "a top-level JSON null", contents: "null" },
  ])(
    "$condition reports empty coverage, never an error (US4 scenario 4)",
    async ({ contents }) => {
      const root = await makeTree({});
      await plantCoverageDocument(root, contents);
      const run = await coverageTree(root);
      expect(run.entries).toEqual([]);
    },
  );

  it("an empty document ({}) reports empty coverage", async () => {
    const root = await makeTree({});
    await plantCoverageDocument(root, "{}");
    const run = await coverageTree(root);
    expect(run.entries).toEqual([]);
  });

  it.skipIf(runningAsRoot)(
    "an unreadable document (chmod 000) is a bounded-reader skip: empty coverage plus one stderr diagnostic line",
    async () => {
      const root = await makeTree({});
      await plantCoverageDocument(root, "{}");
      const target = join(root, "coverage", "coverage-final.json");
      await chmod(target, 0o000);
      try {
        const run = await coverageTree(root);
        expect(run.entries).toEqual([]);
        // The artifact is read through the bounded safe reader (research
        // R10, contracts/coverage.md): a skipped read writes exactly one
        // diagnostic line to stderr.
        expect(run.stderr().trim().length).toBeGreaterThan(0);
      } finally {
        // Restore readability so afterEach teardown can never be blocked
        // by the mode bits.
        await chmod(target, 0o600);
      }
    },
  );
});
