// Cognitive-complexity wire-model, walk-domain, and increment/nesting
// core fixtures for the cognitive_complexity method (T012; spec 005
// FR-005, FR-006 structural clauses, FR-007, FR-009; US2 scenarios 1-4;
// research R1, R7-R10, R12; Constitution Principles I and IV). The
// implementation under test is src/cognitive.ts (T016, NOT landed).
//
// RED-FIRST: src/cognitive.ts does not exist yet — T016 creates it over
// the shared prepareAnalysis pipeline — so this suite fails on module
// resolution by design (tasks.md: US2 tests are written first and
// observed to FAIL before the paired implementation lands; T012 is
// T016's red pair). Do not stub the module to force a green run.
//
// ENTRY CONTRACT — the reading of the feature artifacts, recorded per the
// task brief (the tests/doc-coverage.test.ts precedent, task-for-task):
//
// - The import is `cognitiveComplexity` from ../src/cognitive.js, plus
//   `serializeCognitiveRow` and the `CognitiveRow` type for the
//   serializer's unit cases. T016's task text pins the analyze-shaped
//   entry cognitiveComplexity(rootPath, patterns, stderr) running the
//   pipeline internally and returning the serialized CognitiveRow[] —
//   the computeComplexity split — while T017's server handler wraps that
//   array into the {"functions": [...]} envelope.
// - Like tests/doc-coverage.test.ts's symbolsTree, rowsTree below
//   accepts BOTH documented result shapes — the bare serialized row array
//   (the landed reading) and the {"functions": [...]} envelope — and
//   fails loud on anything else. The JSON-RPC envelope and dispatch
//   wiring are pinned end-to-end by tests/server.test.ts (T013).
//
// The rules pinned here:
//
// - Row shape (FR-005): exactly package, function, file, line, and
//   integer cognitive_complexity >= 0 — no cyclomatic baseline +1. The
//   identity key is `function` (matching the coverage method), NEVER
//   `name` (Assumption 6 — the protocol document's schema is
//   authoritative over sibling-method symmetry); rows still ORDER by
//   (file, line, name) via the shared record comparator, with package
//   from derivePackage and root-relative POSIX file spellings.
// - The walk domain (FR-009): each record's score comes from a walk that
//   starts at the record's body node (the countDecisionPoints
//   discipline — the record's own node is never treated as a boundary),
//   stops at nested extracted function-likes (they carry their own
//   rows), and continues through anonymous function-likes with the
//   nesting level reset to 0 at the boundary (the xs.map((x) => ...)
//   folding shape). An empty body scores 0 with no baseline increment
//   (unlike cyclomatic's +1).
// - The increment/nesting core (FR-006 structural clauses + FR-007
//   nesting regions): if, for, for-of, for-in, while, do, switch,
//   catch, and a conditional (ternary) expression each add 1 plus the
//   current nesting level; else and else-if add 1 flat; try and finally
//   add nothing; case clauses never increment (the enclosing switch
//   takes the single increment). Nesting regions — the if consequent,
//   the else-if consequent, the else body, loop bodies, switch case
//   clauses, catch blocks, ternary branches — deepen constructs
//   lexically inside them, never the region's own statement (an else is
//   flat though it sits inside the if's region; a case clause is flat
//   though it sits inside the switch's). The pinned values are the
//   FR-010 entries computable from these two rules alone; FR-008
//   sequences, recursion, and labeled breaks are US4 work (T022/T024)
//   and are deliberately absent — every fixture condition is a single
//   comparison, with no &&, ||, ??, labeled break, or self-call, so the
//   pinned scores are purely structural.
// - Extraction parity (US2-2): cognitive_complexity and the existing
//   cyclomatic `complexity` method report equal (file, line, name)
//   identity sets over the same request — both walk the same extraction
//   table over the same source arm. Asserted by driving
//   cognitiveComplexity AND computeComplexity over the same fixture
//   root and diffing the identity sets, never assumed.
// - Pipeline invariants: two full cognitiveComplexity runs over fresh
//   prepareAnalysis walks reproduce byte-identical serialized output;
//   the same tree under a valid tsconfig (program mode) and without one
//   (parse-only) yields identical rows — scoring is syntax-only; a
//   match-nothing pattern set and a function-free discovery both yield
//   {"functions": []} (a valid success, never an error); module-level
//   statements outside any function-like produce no rows (no synthetic
//   module row); decorators carry no increments and are transparent to
//   the walk; skip diagnostics flow to the injected stderr sink, never
//   the result.
//
// Fixture style: every source is an array of lines joined with "\n" (the
// tests/complexity.test.ts precedent), so each declaration's 1-based line
// number is auditable in place against the expected tables below, and
// every expected score is hand-computed from FR-006 + FR-007 (the
// arithmetic noted per case).

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  type CognitiveRow,
  cognitiveComplexity,
  serializeCognitiveRow,
} from "../src/cognitive.js";
import { computeComplexity } from "../src/complexity.js";
import { derivePackage } from "../src/models.js";
import {
  createFixtureTree,
  drainCleanups,
  memorySink,
  registerCleanup,
} from "./helpers/fixtures.js";

// The stdout-spy case restores here so every case stays independent; the
// afterEach drain also releases any tree a test body registered (the
// tests/analysis.test.ts pattern — beforeAll-shared trees own their own
// afterAll cleanup instead and are never registered).
afterEach(async () => {
  vi.restoreAllMocks();
  await drainCleanups();
});

/** One serialized cognitive row — the wire shape FR-005 pins. */
interface WireRow {
  readonly package: string;
  readonly function: string;
  readonly file: string;
  readonly line: number;
  readonly cognitive_complexity: number;
}

// Narrows the entry's result through its two documented shapes (see the
// header's ENTRY CONTRACT note). A missing functions array is a malformed
// result, not a soft zero — fail loud rather than assert against [].
function isFunctionsContainer(
  value: unknown,
): value is { functions: readonly WireRow[] } {
  return (
    typeof value === "object" &&
    value !== null &&
    Array.isArray((value as { functions?: unknown }).functions)
  );
}

function extractRows(result: unknown): readonly WireRow[] {
  if (Array.isArray(result)) {
    return result as readonly WireRow[];
  }
  if (isFunctionsContainer(result)) {
    return result.functions;
  }
  throw new Error(
    "unexpected cognitive_complexity result shape: expected the serialized CognitiveRow[] payload or an object with a functions array",
  );
}

// Runs one cognitive_complexity analysis with a fresh stderr sink; absent
// patterns mean the whole tree (FR-005's catch-all through the shared
// analysis-params semantics), exactly as complexityTree drives the
// cyclomatic surface in tests/complexity.test.ts. The raw result rides
// along for the envelope-shape assertions.
async function rowsTree(
  root: string,
  patterns?: string[],
): Promise<{ rows: readonly WireRow[]; raw: unknown; stderr: () => string }> {
  const sink = memorySink();
  const raw: unknown = await cognitiveComplexity(root, patterns, sink.stream);
  return { rows: extractRows(raw), raw, stderr: sink.text };
}

// Drives the landed cyclomatic entry over the same root and projects its
// serialized ComplexityEntry[] to the identity tuple — the US2-2 parity
// diff's other side. computeComplexity's documented shape is the bare
// array (src/complexity.ts; pinned by tests/complexity.test.ts), so a
// non-array is a malformed result — fail loud, never a soft zero.
async function cyclomaticIdentities(
  root: string,
): Promise<Array<[string, number, string]>> {
  const sink = memorySink();
  const result = await computeComplexity(root, undefined, sink.stream);
  if (!Array.isArray(result)) {
    throw new Error(
      "unexpected complexity result shape: expected the serialized ComplexityEntry[] payload",
    );
  }
  return (result as readonly { file: string; line: number; name: string }[]).map(
    (entry) => [entry.file, entry.line, entry.name],
  );
}

// Finds the unique row for (function name, file) — the one-row-per-
// fixture invariant every rule case relies on; a miss or a duplicate is
// a walk or fixture bug, never a soft match.
function rowFor(rows: readonly WireRow[], name: string, file: string): WireRow {
  let found: WireRow | undefined;
  let count = 0;
  for (const row of rows) {
    if (row.function === name && row.file === file) {
      found = row;
      count += 1;
    }
  }
  if (count !== 1 || found === undefined) {
    throw new Error(
      `expected exactly one cognitive row named "${name}" in ${file}, found ${count}`,
    );
  }
  return found;
}

// The identity tuple every ordering and parity assertion projects onto —
// note the name component rides the `function` key (the identity key and
// the ORDER key are spelled differently, FR-005).
function rowTuples(rows: readonly WireRow[]): Array<[string, number, string]> {
  return rows.map((row) => [row.file, row.line, row.function]);
}

// (line, name, cognitive_complexity) for one file's rows — the per-file
// score tables.
function fileScores(
  rows: readonly WireRow[],
  file: string,
): Array<[number, string, number]> {
  return rows
    .filter((row) => row.file === file)
    .map((row) => [row.line, row.function, row.cognitive_complexity]);
}

// The full contract projection: identity plus the computed score (package
// is pinned separately through derivePackage in expectWireInvariants, so
// the tables stay one screen wide).
function rowProjection(
  rows: readonly WireRow[],
): ReadonlyArray<Record<string, unknown>> {
  return rows.map((row) => ({
    file: row.file,
    line: row.line,
    function: row.function,
    cognitive_complexity: row.cognitive_complexity,
  }));
}

// The FR-005 total order over identity tuples: (file, line, name),
// codepoint comparison for the string keys — the shared record
// comparator's order, re-derived here so the assertion is independent of
// the implementation under test (the tests/complexity.test.ts stance).
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

// The closed row key set — FR-005's "exactly package, function, file,
// line, integer cognitive_complexity"; anything beyond these five keys
// (a `name` key included) is a wire-shape violation.
const ROW_KEYS: readonly string[] = [
  "cognitive_complexity",
  "file",
  "function",
  "line",
  "package",
];

// FR-005 invariants over a whole result: exact five-field key sets,
// derivePackage derivation, integer cognitive_complexity >= 0 (no
// cyclomatic baseline), positive integer lines, root-relative POSIX file
// spellings, and the documented (file, line, name) total order.
function expectWireInvariants(rows: readonly WireRow[]): void {
  const tuples = rowTuples(rows);
  expect(tuples).toEqual([...tuples].sort(compareTuples));
  for (const row of rows) {
    expect(Object.keys(row).sort()).toEqual([...ROW_KEYS]);
    expect(row.package).toBe(derivePackage(row.file));
    expect(Number.isInteger(row.cognitive_complexity)).toBe(true);
    expect(row.cognitive_complexity).toBeGreaterThanOrEqual(0);
    expect(Number.isInteger(row.line)).toBe(true);
    expect(row.line).toBeGreaterThanOrEqual(1);
    expect(row.function).toBeTypeOf("string");
    expect(row.file).toBeTypeOf("string");
    expect(row.file.startsWith("/")).toBe(false);
    expect(row.file.includes("\\")).toBe(false);
  }
}

// The discover-level skip contract carried through prepareAnalysis
// (FR-017's one-diagnostic skip semantics; the tests/discovery.test.ts
// helper, mirrored locally): the whole sink text is exactly one
// newline-terminated `reading-stone: skipping <relPath>: <reason>` line.
function expectOneSkipLine(sinkText: string, relPath: string): void {
  const prefix = `reading-stone: skipping ${relPath}: `;
  expect(sinkText.endsWith("\n")).toBe(true);
  const line = sinkText.slice(0, -1);
  // Exactly one line: no embedded newline before the terminator.
  expect(line.includes("\n")).toBe(false);
  expect(line.startsWith(prefix)).toBe(true);
  // The reason is non-empty.
  expect(line.length).toBeGreaterThan(prefix.length);
}

// ---------------------------------------------------------------------------
// The increment/nesting core fixtures (FR-006 structural clauses + FR-007
// nesting regions): increments.ts holds one function per pinned value —
// the FR-010 entries computable from the structural clauses alone.
// ---------------------------------------------------------------------------

const INCREMENTS = [
  "// The increment/nesting core (FR-006 structural clauses + FR-007",
  "// nesting regions): one function per pinned value. Every condition is",
  "// a single comparison — FR-008 sequences, recursion, and labeled",
  "// breaks are US4 rules (T022/T024) and are deliberately absent here.",
  "export function emptyBody(): void {}",
  "",
  "export function loneIf(x: boolean): void {",
  "  if (x) {}",
  "}",
  "",
  "export function nestedIf(x: boolean, y: boolean): void {",
  "  if (x) {",
  "    if (y) {}",
  "  }",
  "}",
  "",
  "export function deepIfChain(",
  "  a: boolean,",
  "  b: boolean,",
  "  c: boolean,",
  "  d: boolean,",
  "): void {",
  "  if (a) {",
  "    if (b) {",
  "      if (c) {",
  "        if (d) {}",
  "      }",
  "    }",
  "  }",
  "}",
  "",
  "export function elseIfChain(a: boolean, b: boolean): number {",
  "  if (a) {",
  "    return 1;",
  "  } else if (b) {",
  "    return 2;",
  "  } else {",
  "    return 3;",
  "  }",
  "}",
  "",
  "export function elseNestedIf(x: boolean, y: boolean): void {",
  "  if (x) {",
  "    void x;",
  "  } else {",
  "    if (y) {}",
  "  }",
  "}",
  "",
  "export function elseIfNestedIf(a: boolean, b: boolean, c: boolean): void {",
  "  if (a) {",
  "    void a;",
  "  } else if (b) {",
  "    if (c) {}",
  "  }",
  "}",
  "",
  "export function forOfLoop(items: string[]): void {",
  "  for (const item of items) {",
  "    void item;",
  "  }",
  "}",
  "",
  "export function whileLoop(flag: boolean): void {",
  "  while (flag) {",
  "    void flag;",
  "  }",
  "}",
  "",
  "export function doLoop(flag: boolean): void {",
  "  do {",
  "    void flag;",
  "  } while (flag);",
  "}",
  "",
  "export function threeClauses(value: number): string {",
  "  switch (value) {",
  "    case 1:",
  '      return "one";',
  "    case 2:",
  '      return "two";',
  "    case 3:",
  '      return "three";',
  "  }",
  '  return "other";',
  "}",
  "",
  "export function switchCaseIf(value: number, flag: boolean): void {",
  "  switch (value) {",
  "    case 1:",
  "      if (flag) {}",
  "      void value;",
  "  }",
  "}",
  "",
  "export function forIfSwitch(items: number[]): string {",
  "  for (const item of items) {",
  "    if (item > 0) {",
  "      switch (item) {",
  "        case 1:",
  '          return "one";',
  "        case 2:",
  '          return "two";',
  "        default:",
  '          return "other";',
  "      }",
  "    }",
  "  }",
  '  return "none";',
  "}",
  "",
  "export function tryCatch(work: () => void): void {",
  "  try {",
  "    work();",
  "  } catch (error) {",
  "    void error;",
  "  }",
  "}",
  "",
  "export function tryFinally(work: () => void): void {",
  "  try {",
  "    work();",
  "  } finally {",
  "    void work;",
  "  }",
  "}",
  "",
  "export function catchNestedIf(work: () => void, flag: boolean): void {",
  "  try {",
  "    work();",
  "  } catch (error) {",
  "    if (flag) {}",
  "    void error;",
  "  }",
  "}",
  "",
  "export function loneTernary(flag: boolean): number {",
  "  return flag ? 1 : 0;",
  "}",
  "",
  "export function ternaryInIf(flag: boolean): number {",
  "  if (flag) {",
  "    return flag ? 1 : 0;",
  "  }",
  "  return 0;",
  "}",
  "",
  "export function nestedTernary(x: boolean, y: boolean): number {",
  "  return x ? (y ? 1 : 0) : 2;",
  "}",
  "",
  "export function whileDo(flag: boolean): void {",
  "  while (flag) {",
  "    do {",
  "      void flag;",
  "    } while (flag);",
  "  }",
  "}",
  "",
].join("\n");

const INCREMENT_FILES: Readonly<Record<string, string>> = {
  "increments.ts": INCREMENTS,
};

// The pinned structural values, one case per function (FR-006 structural
// clauses + FR-007; the FR-010 entries computable from them alone).
const CORE_CASES: ReadonlyArray<{
  expected: number;
  name: string;
  rule: string;
}> = [
  {
    expected: 0,
    name: "emptyBody",
    rule: "an empty body — no baseline increment, unlike cyclomatic's +1",
  },
  { expected: 1, name: "loneIf", rule: "if (x) {}" },
  { expected: 3, name: "nestedIf", rule: "if (x) { if (y) {} } (1 + 2)" },
  { expected: 10, name: "deepIfChain", rule: "a 4-deep if chain (1+2+3+4)" },
  {
    expected: 3,
    name: "elseIfChain",
    rule: "if/else-if/else — else-if and else are flat",
  },
  {
    expected: 4,
    name: "elseNestedIf",
    rule: "if (x) {} else { if (y) {} } (1 + 1 + 2)",
  },
  {
    expected: 4,
    name: "elseIfNestedIf",
    rule: "an if inside an else-if consequent (1 + 1 + 2)",
  },
  { expected: 1, name: "forOfLoop", rule: "a for-of loop at top level" },
  { expected: 1, name: "whileLoop", rule: "a while loop at top level" },
  { expected: 1, name: "doLoop", rule: "a do loop at top level" },
  {
    expected: 1,
    name: "threeClauses",
    rule: "a switch with three clauses — case clauses never increment",
  },
  {
    expected: 3,
    name: "switchCaseIf",
    rule: "an if inside a case clause — the region deepens, the clause itself is flat (1 + 2)",
  },
  { expected: 6, name: "forIfSwitch", rule: "for > if > switch (1+2+3)" },
  { expected: 1, name: "tryCatch", rule: "try/catch — catch increments, try does not" },
  { expected: 0, name: "tryFinally", rule: "try/finally — neither increments" },
  { expected: 3, name: "catchNestedIf", rule: "an if inside a catch block (1 + 2)" },
  { expected: 1, name: "loneTernary", rule: "a conditional (ternary) expression" },
  {
    expected: 3,
    name: "ternaryInIf",
    rule: "a conditional inside an if consequent (1 + 2)",
  },
  {
    expected: 3,
    name: "nestedTernary",
    rule: "a conditional inside a conditional branch (1 + 2)",
  },
  { expected: 3, name: "whileDo", rule: "while > do (1 + 2)" },
];

// The exact core-tree rows, (line, name, cognitive_complexity) in the
// documented order — every score hand-computed from FR-006 + FR-007.
const INCREMENT_EXPECTED: ReadonlyArray<[number, string, number]> = [
  [5, "emptyBody", 0],
  [7, "loneIf", 1],
  [11, "nestedIf", 3],
  [17, "deepIfChain", 10],
  [32, "elseIfChain", 3],
  [42, "elseNestedIf", 4],
  [50, "elseIfNestedIf", 4],
  [58, "forOfLoop", 1],
  [64, "whileLoop", 1],
  [70, "doLoop", 1],
  [76, "threeClauses", 1],
  [88, "switchCaseIf", 3],
  [96, "forIfSwitch", 6],
  [112, "tryCatch", 1],
  [120, "tryFinally", 0],
  [128, "catchNestedIf", 3],
  [137, "loneTernary", 1],
  [141, "ternaryInIf", 3],
  [148, "nestedTernary", 3],
  [152, "whileDo", 3],
];

// ---------------------------------------------------------------------------
// The walk-domain fixtures (FR-009): folding.ts pins the per-record
// boundary — start at the body, stop at nested extracted function-likes,
// continue through anonymous function-likes with nesting reset to 0.
// ---------------------------------------------------------------------------

const FOLDING = [
  "// The walk domain (FR-009): each record's walk starts at the record's",
  "// body, stops at nested extracted function-likes (they carry their",
  "// own rows), and continues through anonymous function-likes with the",
  "// nesting level reset to 0 at the boundary — the xs.map((x) => ...)",
  "// folding shape.",
  "export function emptyBlock(): void {}",
  "",
  "export function emptyStatements(): void {",
  "}",
  "",
  "export const emptyArrow = (): void => {};",
  "",
  "export function outerNested(value: number): number {",
  "  if (value > 0) {",
  "    return 1;",
  "  }",
  "  function innerNested(inner: number): number {",
  "    if (inner > 0) {",
  "      return inner;",
  "    }",
  "    return 0 - inner;",
  "  }",
  "  return innerNested(0 - value);",
  "}",
  "",
  "export function outerArrow(value: number): number {",
  "  const innerArrow = (input: number): number => (input > 0 ? input : 0 - input);",
  "  if (innerArrow(value) > 0) {",
  "    return 1;",
  "  }",
  "  return 0;",
  "}",
  "",
  "export function scoreAll(xs: boolean[]): number[] {",
  "  return xs.map((x) => (x ? 1 : 0));",
  "}",
  "",
  "export function foldInsideIf(xs: number[]): number[] {",
  "  if (xs.length > 0) {",
  "    return xs.map((x) => (x > 0 ? x : 0 - x));",
  "  }",
  "  return [];",
  "}",
  "",
  "export function withAnonymousFunction(values: number[]): number {",
  "  const filtered = values.filter(function (value: number): boolean {",
  "    if (value > 0) {",
  "      return true;",
  "    }",
  "    return false;",
  "  });",
  "  return filtered.length;",
  "}",
  "",
  "export function outerMixed(items: number[]): number {",
  "  let total = 0;",
  "  items.forEach((item: number): void => {",
  "    if (item < 0) {",
  "      return;",
  "    }",
  "    const clamp = (value: number): number => (value > 10 ? 10 : value);",
  "    total += clamp(item);",
  "  });",
  "  return total;",
  "}",
  "",
].join("\n");

const WALK_FILES: Readonly<Record<string, string>> = {
  "folding.ts": FOLDING,
};

// The walk-domain cases: the record-ownership and folding boundaries.
const WALK_CASES: ReadonlyArray<{
  expected: number;
  name: string;
  rule: string;
}> = [
  { expected: 0, name: "emptyBlock", rule: "an empty block body" },
  { expected: 0, name: "emptyStatements", rule: "a statementless block" },
  { expected: 0, name: "emptyArrow", rule: "an arrow with an empty block body" },
  { expected: 1, name: "outerNested", rule: "the enclosing record's own if only" },
  { expected: 1, name: "innerNested", rule: "the nested declared function's own if" },
  { expected: 1, name: "outerArrow", rule: "the enclosing record's own if only" },
  {
    expected: 1,
    name: "innerArrow",
    rule: "the variable-assigned arrow's own ternary",
  },
  {
    expected: 1,
    name: "scoreAll",
    rule: "the xs.map((x) => ...) folding shape — the anonymous arrow's ternary at reset nesting",
  },
  {
    expected: 2,
    name: "foldInsideIf",
    rule: "an anonymous arrow inside an if consequent folds at RESET nesting (1 + 1, not 1 + 2)",
  },
  {
    expected: 1,
    name: "withAnonymousFunction",
    rule: "an anonymous function expression's if, folded into the enclosing record",
  },
  {
    expected: 1,
    name: "outerMixed",
    rule: "the anonymous arrow's if folded in; the nested extracted arrow stops the walk",
  },
  {
    expected: 1,
    name: "clamp",
    rule: "the extracted arrow inside an anonymous body carries its own row",
  },
];

// The exact walk-domain rows, (line, name, cognitive_complexity) in the
// documented order: the nested extracted forms carry their own rows, and
// no anonymous function-like ever appears as a row of its own.
const WALK_EXPECTED: ReadonlyArray<[number, string, number]> = [
  [6, "emptyBlock", 0],
  [8, "emptyStatements", 0],
  [11, "emptyArrow", 0],
  [13, "outerNested", 1],
  [17, "innerNested", 1],
  [26, "outerArrow", 1],
  [27, "innerArrow", 1],
  [34, "scoreAll", 1],
  [38, "foldInsideIf", 2],
  [45, "withAnonymousFunction", 1],
  [55, "outerMixed", 1],
  [61, "clamp", 1],
];

// ---------------------------------------------------------------------------
// The boundary fixtures (edge cases): decorators.ts pins decorator
// transparency; module-level.ts pins the no-synthetic-module-row rule.
// ---------------------------------------------------------------------------

const DECORATORS = [
  "// Decorators carry no increments and are transparent to the walk: the",
  "// conditional expression inside the decorator argument never counts",
  "// toward the decorated method, and the method's own constructs count",
  "// to the method alone.",
  "const audit = true;",
  "",
  "function register(severity: string): (target: object) => object {",
  "  void severity;",
  "  return (target: object) => target;",
  "}",
  "",
  "export class DecoratedService {",
  '  @register(audit ? "strict" : "lenient")',
  "  run(value: number): number {",
  "    if (value > 0) {",
  "      return 1;",
  "    }",
  "    return 0;",
  "  }",
  "}",
  "",
].join("\n");

const MODULE_LEVEL = [
  "// Module-level statements outside any function-like produce no rows",
  "// (edge case): the extraction table has no record to host them — no",
  "// synthetic module row — so the module-level if, for loop, and",
  "// conditional expression attribute to nothing.",
  "const moduleConstant = 42;",
  "",
  "if (moduleConstant > 0) {",
  "  void moduleConstant;",
  "}",
  "",
  "for (let index = 0; index < 3; index++) {",
  "  void index;",
  "}",
  "",
  "const moduleTernary = moduleConstant > 0 ? 1 : 0;",
  "void moduleTernary;",
  "",
  "export function onlyFunction(): void {}",
  "",
].join("\n");

const BOUNDARY_FILES: Readonly<Record<string, string>> = {
  "decorators.ts": DECORATORS,
  "module-level.ts": MODULE_LEVEL,
};

// ---------------------------------------------------------------------------
// The parity tree (FR-005; US2 scenarios 1-2): a multi-file project
// mixing declaration, method, and arrow forms with nesting, plus a test
// file that must contribute nothing on either surface — the root both
// cognitiveComplexity and computeComplexity are driven over for the
// identity diff.
// ---------------------------------------------------------------------------

const PARITY_DECIDE = [
  "export function classify(values: number[]): string {",
  "  let positive = 0;",
  "  for (const value of values) {",
  "    if (value > 0) {",
  "      positive += 1;",
  "    }",
  "  }",
  '  const describe = (count: number): string => (count > 5 ? "many" : "few");',
  "  return describe(positive);",
  "}",
  "",
].join("\n");

const PARITY_HANDLERS = [
  "export const handlers = {",
  "  onSave(event: string): boolean {",
  '    if (event === "save") {',
  "      return true;",
  "    }",
  "    return false;",
  "  },",
  "  onLoad(event: string): boolean {",
  '    return event === "load";',
  "  },",
  "};",
  "",
].join("\n");

const PARITY_MUTATE = [
  "export class Counter {",
  "  count = 0;",
  "",
  "  bump(): void {",
  "    this.count = this.count + 1;",
  "  }",
  "}",
  "",
  "export function reset(counter: Counter): void {",
  "  counter.count = 0;",
  "}",
  "",
].join("\n");

const PARITY_MATH = [
  "export function add(a: number, b: number): number {",
  "  return a + b;",
  "}",
  "",
].join("\n");

const PARITY_TEST = [
  'import { expect, it } from "vitest";',
  'import { add } from "../src/utils/math.js";',
  "",
  'it("adds", () => {',
  "  expect(add(1, 2)).toBe(3);",
  "});",
  "",
].join("\n");

const PARITY_FILES: Readonly<Record<string, string>> = {
  "src/decide.ts": PARITY_DECIDE,
  "src/handlers.ts": PARITY_HANDLERS,
  "src/mutate.ts": PARITY_MUTATE,
  "src/utils/math.ts": PARITY_MATH,
  "tests/math.test.ts": PARITY_TEST,
};

// The exact parity-tree rows, (file, line, function, cognitive_
// complexity) in the documented order: classify = for-of 1 + if 2;
// describe = ternary 1; onSave = if 1; onLoad, bump, reset, and add have
// no structural constructs.
const PARITY_EXPECTED: ReadonlyArray<Record<string, unknown>> = [
  { file: "src/decide.ts", line: 1, function: "classify", cognitive_complexity: 3 },
  { file: "src/decide.ts", line: 8, function: "describe", cognitive_complexity: 1 },
  { file: "src/handlers.ts", line: 2, function: "onSave", cognitive_complexity: 1 },
  { file: "src/handlers.ts", line: 8, function: "onLoad", cognitive_complexity: 0 },
  { file: "src/mutate.ts", line: 4, function: "bump", cognitive_complexity: 0 },
  { file: "src/mutate.ts", line: 9, function: "reset", cognitive_complexity: 0 },
  { file: "src/utils/math.ts", line: 1, function: "add", cognitive_complexity: 0 },
];

// The protocol document's cognitive_complexity example row (protocol.md
// v1.2.0, the sibling clone at .uf/sibling-clones/gaze/), transcribed as
// the serializer's base fixture.
const SERIALIZER_BASE: CognitiveRow = {
  package: "math_utils",
  function: "divide",
  file: "math_utils/ops.ts",
  line: 20,
  cognitive_complexity: 14,
};

describe("serializeCognitiveRow: the CognitiveRow wire shape (FR-005)", () => {
  it("serializes a row with exactly the five required fields, keyed function — never name (Assumption 6)", () => {
    const serialized = serializeCognitiveRow(SERIALIZER_BASE);
    expect(serialized.cognitive_complexity).toBe(14);
    expect(serialized.function).toBe("divide");
    // Keys in the canonical sorted order the protocol layer's code-unit
    // key sort produces, so that pass is a structural no-op.
    expect(Object.keys(serialized)).toEqual([...ROW_KEYS]);
    expect("name" in serialized).toBe(false);
  });

  it("preserves the identity fields and the integer score verbatim — a zero score survives (no cyclomatic baseline)", () => {
    const serialized = serializeCognitiveRow({
      ...SERIALIZER_BASE,
      cognitive_complexity: 0,
    });
    expect(serialized.cognitive_complexity).toBe(0);
    expect(Number.isInteger(serialized.cognitive_complexity)).toBe(true);
    expect(serialized.file).toBe("math_utils/ops.ts");
    expect(serialized.line).toBe(20);
    expect(serialized.package).toBe("math_utils");
  });
});

describe("the increment/nesting core (FR-006 structural clauses, FR-007; US2 scenarios 1-2)", () => {
  let rows: readonly WireRow[] = [];
  let stderr: () => string = () => "";
  let cleanup: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    const tree = await createFixtureTree(INCREMENT_FILES);
    cleanup = tree.cleanup;
    const run = await rowsTree(tree.root);
    rows = run.rows;
    stderr = run.stderr;
  }, 120_000);

  afterAll(async () => {
    await cleanup?.();
  });

  it.each(CORE_CASES)("$name: $rule — scores $expected", ({ name, expected }) => {
    expect(rowFor(rows, name, "increments.ts").cognitive_complexity).toBe(expected);
  });

  it("the exact row set and order with every hand-computed score (US2 scenario 1)", () => {
    expect(fileScores(rows, "increments.ts")).toEqual(INCREMENT_EXPECTED);
    expectWireInvariants(rows);
    expect(rows).toHaveLength(20);
  });

  it("a clean tree writes no stderr diagnostics", () => {
    expect(stderr()).toBe("");
  });
});

describe("the walk domain (FR-009; US2 scenario 1)", () => {
  let rows: readonly WireRow[] = [];
  let stderr: () => string = () => "";
  let cleanup: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    const tree = await createFixtureTree(WALK_FILES);
    cleanup = tree.cleanup;
    const run = await rowsTree(tree.root);
    rows = run.rows;
    stderr = run.stderr;
  }, 120_000);

  afterAll(async () => {
    await cleanup?.();
  });

  it.each(WALK_CASES)("$name: $rule — scores $expected", ({ name, expected }) => {
    expect(rowFor(rows, name, "folding.ts").cognitive_complexity).toBe(expected);
  });

  it("the exact row set and order: nested extracted forms carry their own rows, anonymous forms never appear as rows", () => {
    expect(fileScores(rows, "folding.ts")).toEqual(WALK_EXPECTED);
    expectWireInvariants(rows);
    expect(rows).toHaveLength(12);
  });

  it("a clean tree writes no stderr diagnostics", () => {
    expect(stderr()).toBe("");
  });
});

describe("module-level statements and decorators (edge cases)", () => {
  let rows: readonly WireRow[] = [];
  let stderr: () => string = () => "";
  let cleanup: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    const tree = await createFixtureTree(BOUNDARY_FILES);
    cleanup = tree.cleanup;
    const run = await rowsTree(tree.root);
    rows = run.rows;
    stderr = run.stderr;
  }, 120_000);

  afterAll(async () => {
    await cleanup?.();
  });

  it("module-level statements outside any function-like produce no rows — no synthetic module row", () => {
    // The module-level if, for loop, and conditional expression have no
    // record to host them; the only module-level.ts row is the tree's
    // single function.
    expect(rowProjection(rows.filter((row) => row.file === "module-level.ts"))).toEqual(
      [
        {
          file: "module-level.ts",
          line: 18,
          function: "onlyFunction",
          cognitive_complexity: 0,
        },
      ],
    );
  });

  it("decorators carry no increments and are transparent to the walk", () => {
    // The conditional expression inside the decorator argument would add
    // 1 to run if the walk entered the decorator subtree; transparency
    // keeps run at its own if alone. register's returned arrow is an
    // anonymous function-like with nothing inside — 0.
    expect(rowFor(rows, "register", "decorators.ts").cognitive_complexity).toBe(0);
    expect(rowFor(rows, "run", "decorators.ts").cognitive_complexity).toBe(1);
  });

  it("wire shape over the boundary tree (FR-005)", () => {
    expectWireInvariants(rows);
    expect(rows).toHaveLength(3);
  });

  it("a clean tree writes no stderr diagnostics", () => {
    expect(stderr()).toBe("");
  });
});

describe("extraction parity, ordering, and determinism (FR-005; US2 scenarios 1-2)", () => {
  let root = "";
  let rows: readonly WireRow[] = [];
  let raw: unknown;
  let stderr: () => string = () => "";
  let cyclomatic: Array<[string, number, string]> = [];
  let cleanup: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    const tree = await createFixtureTree(PARITY_FILES);
    cleanup = tree.cleanup;
    root = tree.root;
    const run = await rowsTree(root);
    rows = run.rows;
    raw = run.raw;
    stderr = run.stderr;
    cyclomatic = await cyclomaticIdentities(root);
  }, 120_000);

  afterAll(async () => {
    await cleanup?.();
  });

  it("the exact rows over the mixed tree, ordered by (file, line, name) (US2 scenario 1)", () => {
    expect(rowProjection(rows)).toEqual(PARITY_EXPECTED);
    expectWireInvariants(rows);
  });

  it("the identity key is `function`, never `name` (FR-005, Assumption 6)", () => {
    // The exact-key check in expectWireInvariants fails any row carrying
    // a `name` key; this case pins the spelling by content: every
    // identity value rides the `function` key — the coverage method's
    // row shape, the protocol document's schema over sibling symmetry.
    for (const row of rows) {
      expect("name" in row).toBe(false);
      expect(row.function.length).toBeGreaterThan(0);
    }
  });

  it("the (file, line, name) identity sets match the cyclomatic complexity method over the same request (US2 scenario 2)", () => {
    // Parity is asserted, not assumed: both entries are driven over the
    // same fixture root and the identity tuples are diffed directly — a
    // function has a cognitive score if and only if it has a cyclomatic
    // one, over the same source arm and extraction table.
    expect(rowTuples(rows)).toEqual(cyclomatic);
  });

  it("the parity is non-vacuous: seven rows over four source files, the test file excluded from both surfaces", () => {
    expect(rows).toHaveLength(7);
    expect(cyclomatic).toHaveLength(7);
    expect([...new Set(rows.map((row) => row.file))].sort()).toEqual([
      "src/decide.ts",
      "src/handlers.ts",
      "src/mutate.ts",
      "src/utils/math.ts",
    ]);
    expect(rows.filter((row) => row.file === "tests/math.test.ts")).toEqual([]);
  });

  it("the result is the one-key functions envelope — no additional fields (US2 scenario 1)", () => {
    // Whichever documented shape the entry returns (the header's ENTRY
    // CONTRACT), the wire result the server hands the protocol layer is
    // exactly one `functions` key: the bare array wrapped as the T017
    // handler wraps it, or the envelope itself — anything beyond the one
    // key is a wire-shape violation.
    const envelope: Record<string, unknown> = Array.isArray(raw)
      ? { functions: raw }
      : (raw as Record<string, unknown>);
    expect(Object.keys(envelope)).toEqual(["functions"]);
    expect(Array.isArray(envelope.functions)).toBe(true);
  });

  it("repeat responses over fresh prepareAnalysis walks are byte-identical (US2 scenario 1)", {
    timeout: 120_000,
  }, async () => {
    const again = await rowsTree(root);
    expect(JSON.stringify(again.rows)).toBe(JSON.stringify(rows));
    expect(JSON.stringify(again.raw)).toBe(JSON.stringify(raw));
  });

  it("a clean tree writes no stderr diagnostics", () => {
    expect(stderr()).toBe("");
  });
});

describe("empty results (US2 scenario 3)", () => {
  it("a match-nothing pattern set yields the empty functions success — never an error", {
    timeout: 120_000,
  }, async () => {
    const tree = await createFixtureTree(PARITY_FILES);
    registerCleanup(tree.cleanup);
    const empty = await rowsTree(tree.root, [""]);
    expect(empty.rows).toEqual([]);
    // The envelope form of the empty success is {"functions": []} — the
    // empty array here, wrapped by the handler exactly as the populated
    // one is.
    const payload = Array.isArray(empty.raw)
      ? empty.raw
      : (empty.raw as { functions: readonly WireRow[] }).functions;
    expect(payload).toEqual([]);
    expect(JSON.stringify({ functions: payload })).toBe('{"functions":[]}');
  });

  it("a function-free discovery yields the empty functions success — never an error", {
    timeout: 120_000,
  }, async () => {
    const tree = await createFixtureTree({
      "module-scope.ts": ["const value = 42;", "void value;", ""].join("\n"),
    });
    registerCleanup(tree.cleanup);
    const empty = await rowsTree(tree.root);
    expect(empty.rows).toEqual([]);
    const payload = Array.isArray(empty.raw)
      ? empty.raw
      : (empty.raw as { functions: readonly WireRow[] }).functions;
    expect(payload).toEqual([]);
    expect(JSON.stringify({ functions: payload })).toBe('{"functions":[]}');
  });
});

describe("program mode parity (FR-005; US2 scenario 4, edge case)", () => {
  // The same strict-config shape tests/complexity.test.ts plants to
  // exercise the program bootstrap. Scoring is purely lexical, so the
  // identical rows across both modes is the parity pin; the bootstrap's
  // valid-config-implies-program-mode behavior itself is pinned by
  // tests/program.test.ts. Decorators and module-level statements parse
  // identically in both modes — their type-check errors are never a gate
  // (program mode's documented diagnostic policy).
  const TSCONFIG_STRICT =
    '{"compilerOptions": {"strict": true, "target": "ES2022", "module": "commonjs"}}';

  it("a valid tsconfig yields the identical serialized rows as parse-only over the same sources", {
    timeout: 120_000,
  }, async () => {
    const files = { ...BOUNDARY_FILES, ...INCREMENT_FILES, ...WALK_FILES };
    const parseOnly = await createFixtureTree(files);
    const program = await createFixtureTree({
      ...files,
      "tsconfig.json": TSCONFIG_STRICT,
    });
    try {
      const loose = await rowsTree(parseOnly.root);
      const compiled = await rowsTree(program.root);
      // Non-vacuous parity: the union of the increment, walk-domain, and
      // boundary trees is 35 rows spanning every pinned construct.
      expect(loose.rows).toHaveLength(35);
      expect(JSON.stringify(compiled.rows)).toBe(JSON.stringify(loose.rows));
      expect(compiled.stderr()).toBe("");
    } finally {
      await parseOnly.cleanup();
      await program.cleanup();
    }
  });
});

describe("skip diagnostics (FR-011; the injected stderr sink)", () => {
  // mkfifo ships with macOS and every Linux CI image; the PATH scan keeps
  // the FIFO fixture honest on a platform without it (skipped, never
  // failed) — the tests/discovery.test.ts guard.
  const mkfifoAvailable = (process.env.PATH ?? "")
    .split(delimiter)
    .some((directory) => existsSync(join(directory, "mkfifo")));

  it.skipIf(!mkfifoAvailable)(
    "routes a skipped candidate's one diagnostic to stderr, never the result",
    { timeout: 120_000 },
    async () => {
      const tree = await createFixtureTree({
        "clean.ts": "export function kept(): void {}\n",
      });
      registerCleanup(tree.cleanup);
      // The walker deliberately keeps a FIFO named like a source file as
      // a walk candidate so the safe reader can diagnose it; the pipeline
      // excludes it with one skip line.
      execFileSync("mkfifo", [join(tree.root, "pipe.ts")]);
      const sink = memorySink();
      const stdout = vi.spyOn(process.stdout, "write");
      const raw: unknown = await cognitiveComplexity(tree.root, undefined, sink.stream);
      const rows = extractRows(raw);
      // The result carries exactly the readable source's row — the FIFO
      // contributed nothing to the rows.
      expect(rowProjection(rows)).toEqual([
        {
          file: "clean.ts",
          line: 1,
          function: "kept",
          cognitive_complexity: 0,
        },
      ]);
      // ...and the skip is exactly one newline-terminated stderr line,
      // with stdout untouched (it is reserved for JSON-RPC responses).
      expectOneSkipLine(sink.text(), "pipe.ts");
      expect(stdout).not.toHaveBeenCalled();
    },
  );
});
