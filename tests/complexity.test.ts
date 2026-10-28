// Cyclomatic complexity decision-point closure fixtures for the complexity
// computation (T021; spec US3 scenarios 1-5; FR-021, FR-022; research R9;
// Constitution Principles I and IV).
//
// RED-FIRST: src/complexity.ts does not exist yet — T023 creates it over
// T014's shared prepareAnalysis pipeline — so this suite fails on module
// resolution by design (tasks.md: US3 tests are written first and observed
// to FAIL before the paired implementation lands).
//
// ENTRY CONTRACT — the reading of the feature artifacts, recorded per the
// task brief:
//
// - The import is `computeComplexity` from ../src/complexity.js. No
//   artifact spells the export name, so the reading follows the analyze
//   precedent task-for-task: T018's "the analyze entry over prepareAnalysis
//   output returning serialized FunctionRecord[]" landed as
//   analyze(rootPath, patterns, stderr) in src/analysis.ts — running the
//   pipeline internally and returning the wire-shaped array — and T019's
//   server handler wraps that array as {"functions": [...]}. T023 ("Create
//   src/complexity.ts ... consume T014's prepareAnalysis output ...
//   serialization through the existing sorted-key serializer") and T024
//   ("the handler runs the T014 pipeline + T023 computation and returns
//   {"functions": [...]}") mirror those two tasks, and plan.md's project
//   tree documents complexity.ts as "-> ComplexityEntry[]". The pinned
//   surface is therefore the analyze-shaped entry
//   computeComplexity(rootPath, patterns, stderr) returning the serialized
//   ComplexityEntry[].
// - Like tests/detector.test.ts's analyzeTree, complexityTree below
//   accepts BOTH documented result shapes — the bare serialized entry array
//   (the reading above) and the {"functions": [...]} payload that
//   data-model.md's ComplexityResult section documents — and fails loud on
//   anything else. The JSON-RPC envelope and dispatch wiring are pinned
//   end-to-end by tests/server.test.ts (T022).
//
// The counting rule pinned here (FR-021 / contracts/complexity.md /
// research R9): complexity = 1 + the count of `if` (each `else if` is a
// nested `if`), `for`, `for-of`, `for-in`, `while`, `do`, each `case`
// clause (`default` excluded), `catch`, conditional (ternary) expressions,
// and the binary logical operators `&&`, `||`, `??` in the function's own
// body. The list is closed: logical-assignment operators (`&&=`, `||=`,
// `??=`) are never counted (Assumption 10). An empty body scores 1. The
// per-record walk stops at nested extracted function-likes (they own their
// bodies — US3 scenario 3) while anonymous function-expression bodies (not
// in the extraction set) count toward the innermost enclosing extracted
// record (FR-009 attribution).
//
// Fixture style: every source is an array of lines joined with "\n" (the
// tests/extract.test.ts precedent), so each declaration's 1-based array
// index IS its line number and the expected tables below are auditable in
// place. Expected complexities are hand-computed from the closed list; the
// parity tree's grade/bump/reset/add values cross-check quickstart.md
// section 4's documented complexity projection.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { analyze } from "../src/analysis.js";
import { computeComplexity } from "../src/complexity.js";
import { derivePackage } from "../src/models.js";
import { createFixtureTree, memorySink } from "./helpers/fixtures.js";

/** One serialized complexity entry (name, package, file, line, complexity). */
interface WireEntry {
  readonly name: string;
  readonly package: string;
  readonly file: string;
  readonly line: number;
  readonly complexity: number;
}

// Narrows the entry's result through the two documented shapes (see the
// header's ENTRY CONTRACT note). A missing functions array is a malformed
// result, not a soft zero — fail loud rather than assert against [].
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
    "unexpected complexity result shape: expected the serialized ComplexityEntry[] payload or an object with a functions array",
  );
}

// Runs one complexity analysis with a fresh stderr sink; absent patterns
// mean the whole tree (FR-001's catch-all), exactly as analyzeTree drives
// the analyze surface in tests/detector.test.ts.
async function complexityTree(
  root: string,
  patterns?: string[],
): Promise<{ entries: readonly WireEntry[]; stderr: () => string }> {
  const sink = memorySink();
  const result: unknown = await computeComplexity(root, patterns, sink.stream);
  return { entries: extractEntries(result), stderr: sink.text };
}

// Finds the unique entry for (name, file) — the one-entry-per-fixture
// invariant every table case relies on; a miss or a duplicate is an
// extraction or fixture bug, never a soft match.
function entryFor(
  entries: readonly WireEntry[],
  name: string,
  file: string,
): WireEntry {
  let found: WireEntry | undefined;
  let count = 0;
  for (const entry of entries) {
    if (entry.name === name && entry.file === file) {
      found = entry;
      count += 1;
    }
  }
  if (count !== 1 || found === undefined) {
    throw new Error(
      `expected exactly one complexity entry named "${name}" in ${file}, found ${count}`,
    );
  }
  return found;
}

// The identity tuple every ordering and parity assertion projects onto.
function entryTuples(entries: readonly WireEntry[]): Array<[string, number, string]> {
  return entries.map((entry) => [entry.file, entry.line, entry.name]);
}

// (line, name) for one file's entries — the per-file set tables.
function fileTuples(
  entries: readonly WireEntry[],
  file: string,
): Array<[number, string]> {
  return entries
    .filter((entry) => entry.file === file)
    .map((entry) => [entry.line, entry.name]);
}

// The full contract projection: identity plus the computed complexity.
function entryProjection(
  entries: readonly WireEntry[],
): ReadonlyArray<Record<string, unknown>> {
  return entries.map((entry) => ({
    file: entry.file,
    line: entry.line,
    name: entry.name,
    complexity: entry.complexity,
  }));
}

// analyze's serialized records projected to the same identity tuple.
function analyzeTuples(
  records: readonly Record<string, unknown>[],
): Array<[string, number, string]> {
  return records.map((record) => {
    const typed = record as { file: string; line: number; name: string };
    return [typed.file, typed.line, typed.name];
  });
}

// The FR-008/FR-022 total order over identity tuples: (file, line, name),
// codepoint comparison for the string keys.
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

// The closed entry key set — FR-022's "exactly name, package, file, line,
// complexity"; anything beyond these five keys is a wire-shape violation.
const ENTRY_KEYS: readonly string[] = ["complexity", "file", "line", "name", "package"];

// FR-021/FR-022 invariants over a whole result: exact five-field key sets,
// package derivation, integer complexity >= 1, positive integer lines, and
// the documented (file, line, name) total order.
function expectWireInvariants(entries: readonly WireEntry[]): void {
  const tuples = entryTuples(entries);
  expect(tuples).toEqual([...tuples].sort(compareTuples));
  for (const entry of entries) {
    expect(Object.keys(entry).sort()).toEqual([...ENTRY_KEYS]);
    expect(entry.package).toBe(derivePackage(entry.file));
    expect(Number.isInteger(entry.complexity)).toBe(true);
    expect(entry.complexity).toBeGreaterThanOrEqual(1);
    expect(Number.isInteger(entry.line)).toBe(true);
    expect(entry.line).toBeGreaterThanOrEqual(1);
    expect(entry.name).toBeTypeOf("string");
    expect(entry.file).toBeTypeOf("string");
  }
}

// ---------------------------------------------------------------------------
// The decision-point closure fixtures (FR-021). kinds.ts holds exactly one
// decision point per function; the neighboring files pin the rule's shape
// boundaries: else-if chains, case-not-default counting, the
// logical-assignment exclusion, empty bodies, and combined bodies.
// ---------------------------------------------------------------------------

const KINDS = [
  "// One decision point per function (FR-021): each kind counts exactly",
  "// once per occurrence, so every function in this file scores 2.",
  "export function ifKind(flag: boolean): void {",
  "  if (flag) {",
  "    return;",
  "  }",
  "}",
  "",
  "export function forKind(): void {",
  "  for (let i = 0; i < 3; i++) {",
  "    continue;",
  "  }",
  "}",
  "",
  "export function forOfKind(items: string[]): void {",
  "  for (const item of items) {",
  "    void item;",
  "  }",
  "}",
  "",
  "export function forInKind(record: Record<string, number>): void {",
  "  for (const key in record) {",
  "    void key;",
  "  }",
  "}",
  "",
  "export function whileKind(flag: boolean): void {",
  "  while (flag) {",
  "    break;",
  "  }",
  "}",
  "",
  "export function doKind(flag: boolean): void {",
  "  do {",
  "    break;",
  "  } while (flag);",
  "}",
  "",
  "export function catchKind(work: () => void): void {",
  "  try {",
  "    work();",
  "  } catch (error) {",
  "    void error;",
  "  }",
  "}",
  "",
  "export function ternaryKind(flag: boolean): string {",
  '  return flag ? "yes" : "no";',
  "}",
  "",
  "export function andKind(a: boolean, b: boolean): boolean {",
  "  return a && b;",
  "}",
  "",
  "export function orKind(a: boolean, b: boolean): boolean {",
  "  return a || b;",
  "}",
  "",
  "export function coalesceKind(a: boolean | null, b: boolean): boolean {",
  "  return a ?? b;",
  "}",
  "",
].join("\n");

const EMPTY = [
  "// An empty body scores exactly 1 (US3 scenario 2): no decision points,",
  "// for the empty-block, statementless-block, and arrow forms alike.",
  "export function emptyBody(): void {}",
  "",
  "export function emptyStatements(): void {",
  "}",
  "",
  "export const emptyArrow = (): void => {};",
  "",
].join("\n");

const ELSEIF = [
  "// Each else-if is a nested if and counts (FR-021): one if plus two",
  "// else-ifs is three if statements — complexity 4.",
  "export function gradeChain(score: number): string {",
  "  if (score >= 90) {",
  '    return "A";',
  "  } else if (score >= 80) {",
  '    return "B";',
  "  } else if (score >= 70) {",
  '    return "C";',
  "  } else {",
  '    return "F";',
  "  }",
  "}",
  "",
  "export function loneIf(score: number): string {",
  "  if (score > 0) {",
  '    return "positive";',
  "  }",
  '  return "other";',
  "}",
  "",
].join("\n");

const SWITCHES = [
  "// Each case clause counts once and default never counts (FR-021).",
  "export function sizeClass(count: number): string {",
  "  switch (count) {",
  "    case 0:",
  '      return "empty";',
  "    case 1:",
  '      return "one";',
  "    case 2:",
  '      return "couple";',
  "    case 3:",
  '      return "few";',
  "    default:",
  '      return "many";',
  "  }",
  "}",
  "",
  "export function noDefault(value: number): string {",
  "  switch (value) {",
  "    case 1:",
  '      return "one";',
  "    case 2:",
  '      return "two";',
  "  }",
  '  return "other";',
  "}",
  "",
  "export function onlyDefault(value: number): string {",
  "  switch (value) {",
  "    default:",
  '      return "single";',
  "  }",
  "}",
  "",
].join("\n");

const LOGICAL_ASSIGN = [
  "// Logical-assignment operators are excluded from the closed decision-",
  "// point list (Assumption 10): all three together still score 1.",
  "export function pureLogicalAssignment(",
  "  and: { v?: boolean },",
  "  or: { v?: boolean },",
  "  coalesce: { v?: number | null },",
  "): void {",
  "  and.v &&= true;",
  "  or.v ||= true;",
  "  coalesce.v ??= 3;",
  "}",
  "",
  "// Mixed with one counted operator: only the || counts.",
  "export function mixedLogicalAssignment(",
  "  and: { v?: boolean },",
  "  value: number | null,",
  "): boolean {",
  "  and.v &&= true;",
  "  value ??= 7;",
  "  return and.v || false;",
  "}",
  "",
].join("\n");

const COMBINED = [
  "// Every counted kind in one body: for-of, if, &&, catch, ||, while, and",
  "// a ternary — seven decision points, complexity 8.",
  "export function combined(",
  "  flag: boolean,",
  "  items: string[],",
  "  work: () => void,",
  "): string {",
  "  for (const item of items) {",
  "    if (item.length > 0 && flag) {",
  "      continue;",
  "    }",
  "    try {",
  "      work();",
  "    } catch (error) {",
  '      return item || "fallback";',
  "    }",
  "  }",
  "  while (flag) {",
  "    break;",
  "  }",
  '  return flag ? "yes" : "no";',
  "}",
  "",
  "// A left-associative chain: two && plus one ||, complexity 4.",
  "export function operatorChain(",
  "  a: boolean,",
  "  b: boolean,",
  "  c: boolean,",
  "  d: boolean,",
  "): boolean {",
  "  return (a && b && c) || d;",
  "}",
  "",
  "// Each ternary occurrence counts: two conditionals, complexity 3.",
  "export function nestedTernary(value: number): string {",
  '  return value > 0 ? (value > 10 ? "big" : "small") : "negative";',
  "}",
  "",
  "// Each catch clause counts once: two try/catch pairs, complexity 3.",
  "export function doubleCatch(a: () => void, b: () => void): void {",
  "  try {",
  "    a();",
  "  } catch (error) {",
  "    void error;",
  "  }",
  "  try {",
  "    b();",
  "  } catch (error) {",
  "    void error;",
  "  }",
  "}",
  "",
].join("\n");

const CLOSURE_FILES: Readonly<Record<string, string>> = {
  "combined.ts": COMBINED,
  "elseif.ts": ELSEIF,
  "empty.ts": EMPTY,
  "kinds.ts": KINDS,
  "logical-assign.ts": LOGICAL_ASSIGN,
  "switches.ts": SWITCHES,
};

// The closed decision-point kinds, one kinds.ts row each: every function
// holds exactly one occurrence, so every expected complexity is 2.
const CLOSURE_KINDS: ReadonlyArray<{
  file: string;
  kind: string;
  name: string;
}> = [
  { file: "kinds.ts", kind: "an if statement", name: "ifKind" },
  { file: "kinds.ts", kind: "a for statement", name: "forKind" },
  { file: "kinds.ts", kind: "a for-of statement", name: "forOfKind" },
  { file: "kinds.ts", kind: "a for-in statement", name: "forInKind" },
  { file: "kinds.ts", kind: "a while statement", name: "whileKind" },
  { file: "kinds.ts", kind: "a do statement", name: "doKind" },
  { file: "kinds.ts", kind: "a catch clause", name: "catchKind" },
  {
    file: "kinds.ts",
    kind: "a conditional (ternary) expression",
    name: "ternaryKind",
  },
  { file: "kinds.ts", kind: "a && operator", name: "andKind" },
  { file: "kinds.ts", kind: "a || operator", name: "orKind" },
  { file: "kinds.ts", kind: "a ?? operator", name: "coalesceKind" },
];

// ---------------------------------------------------------------------------
// The attribution fixtures (FR-009; US3 scenario 3). nested.ts pins the
// stop-at-nested-extracted boundary for declared functions and
// variable-assigned arrows at three depths; anonymous.ts pins the
// innermost-enclosing rule for unassigned function expressions (call
// arguments, returns, callbacks) — including a nested extracted arrow
// inside an anonymous body.
// ---------------------------------------------------------------------------

const NESTED = [
  "// Nested extracted function-likes own their bodies (US3 scenario 3):",
  "// each record's walk stops at the nested boundary.",
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
  "export function outerDeep(flag: boolean): number {",
  "  function middleDeep(): number {",
  "    function innerDeep(input: number): number {",
  "      return input > 0 && input < 10 ? input : 0;",
  "    }",
  "    return innerDeep(5);",
  "  }",
  "  while (flag) {",
  "    break;",
  "  }",
  "  return middleDeep();",
  "}",
  "",
].join("\n");

const ANONYMOUS = [
  "// Anonymous function expressions are not in the extraction set; their",
  "// bodies count toward the innermost enclosing extracted function (FR-009).",
  "export function withCallback(values: number[]): number {",
  "  const filtered = values.filter(function (value: number): boolean {",
  "    return value > 0 && value < 10;",
  "  });",
  "  return filtered.length;",
  "}",
  "",
  "export function makeValidator(): (value: number) => boolean {",
  "  return function (value: number): boolean {",
  "    return value > 0 || value < 0;",
  "  };",
  "}",
  "",
  "export function withAnonymousArrow(items: string[]): number {",
  "  let total = 0;",
  "  items.forEach((item: string): void => {",
  "    if (item.length > 3) {",
  "      total += 1;",
  "    }",
  "  });",
  "  for (const item of items) {",
  "    total += 1;",
  "  }",
  "  return total;",
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

const ATTRIBUTION_FILES: Readonly<Record<string, string>> = {
  "anonymous.ts": ANONYMOUS,
  "nested.ts": NESTED,
};

// nested.ts's exact entry set, (line, name) in the documented order: the
// seven records with their hand-computed complexities asserted per case
// below (outerNested 2, innerNested 2, outerArrow 2, innerArrow 2,
// outerDeep 2, middleDeep 1, innerDeep 3).
const NESTED_EXPECTED: ReadonlyArray<[number, string]> = [
  [3, "outerNested"],
  [7, "innerNested"],
  [16, "outerArrow"],
  [17, "innerArrow"],
  [24, "outerDeep"],
  [25, "middleDeep"],
  [26, "innerDeep"],
];

// anonymous.ts's exact entry set, (line, name): the four enclosing records
// plus clamp — and nothing for the three anonymous bodies (complexities:
// withCallback 2, makeValidator 2, withAnonymousArrow 3, outerMixed 2,
// clamp 2).
const ANONYMOUS_EXPECTED: ReadonlyArray<[number, string]> = [
  [3, "withCallback"],
  [10, "makeValidator"],
  [16, "withAnonymousArrow"],
  [29, "outerMixed"],
  [35, "clamp"],
];

// ---------------------------------------------------------------------------
// The parity tree (FR-022; US3 scenarios 4-5): a multi-file project mixing
// declaration, method, arrow, and object-literal-method forms with nesting,
// plus a test file that must contribute nothing on either surface. The
// grade/bump/reset/add rows are quickstart.md section 4's documented
// complexity projection, cross-checked here end-to-end.
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
  "export function retry(operation: () => void, attempts: number): void {",
  "  let done = false;",
  "  do {",
  "    try {",
  "      operation();",
  "      done = true;",
  "    } catch (error) {",
  "      void error;",
  "    }",
  "  } while (!done && attempts > 0);",
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
  '    return event === "load" || event === "load-force";',
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

const PARITY_SCORE = [
  "export function grade(score: number): string {",
  "  if (score >= 90) {",
  '    return "A";',
  "  }",
  '  return "F";',
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
  "src/score.ts": PARITY_SCORE,
  "src/utils/math.ts": PARITY_MATH,
  "tests/math.test.ts": PARITY_TEST,
};

// The exact parity-tree entries, (file, line, name, complexity) in the
// documented order: classify = 1 + for-of + if; describe = 1 + ternary;
// retry = 1 + do + catch + &&; onSave = 1 + if; onLoad = 1 + ||; bump and
// reset and add have no decision points; grade = 1 + if (quickstart's 2).
const PARITY_EXPECTED: ReadonlyArray<Record<string, unknown>> = [
  { file: "src/decide.ts", line: 1, name: "classify", complexity: 3 },
  { file: "src/decide.ts", line: 8, name: "describe", complexity: 2 },
  { file: "src/decide.ts", line: 12, name: "retry", complexity: 4 },
  { file: "src/handlers.ts", line: 2, name: "onSave", complexity: 2 },
  { file: "src/handlers.ts", line: 8, name: "onLoad", complexity: 2 },
  { file: "src/mutate.ts", line: 4, name: "bump", complexity: 1 },
  { file: "src/mutate.ts", line: 9, name: "reset", complexity: 1 },
  { file: "src/score.ts", line: 1, name: "grade", complexity: 2 },
  { file: "src/utils/math.ts", line: 1, name: "add", complexity: 1 },
];

// The pattern-scoped projection (FR-001 narrows within the analyzable set):
// ["src/mutate.ts", "src/utils"] — one exact file pattern, one directory
// pattern — keeps exactly bump, reset, and add (the prefix "src/mutate"
// alone would match nothing: prefixes scope at path equality or a "/"
// segment boundary, and src/mutate.ts sits behind neither).
const PARITY_SCOPED_EXPECTED: ReadonlyArray<Record<string, unknown>> = [
  { file: "src/mutate.ts", line: 4, name: "bump", complexity: 1 },
  { file: "src/mutate.ts", line: 9, name: "reset", complexity: 1 },
  { file: "src/utils/math.ts", line: 1, name: "add", complexity: 1 },
];

describe("decision-point closure (FR-021; US3 scenarios 1-2)", () => {
  let entries: readonly WireEntry[] = [];
  let stderr: () => string = () => "";
  let cleanup: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    const tree = await createFixtureTree(CLOSURE_FILES);
    cleanup = tree.cleanup;
    const run = await complexityTree(tree.root);
    entries = run.entries;
    stderr = run.stderr;
  }, 120_000);

  afterAll(async () => {
    await cleanup?.();
  });

  it.each(CLOSURE_KINDS)(
    "$name: exactly one $kind in the body scores complexity 2 (US3 scenario 1)",
    ({ file, name }) => {
      expect(entryFor(entries, name, file).complexity).toBe(2);
    },
  );

  it.each([
    { kind: "a declaration with an empty block", name: "emptyBody" },
    {
      kind: "a declaration whose block spans lines but holds nothing",
      name: "emptyStatements",
    },
    { kind: "an arrow with an empty block body", name: "emptyArrow" },
  ])("$name: $kind scores exactly 1 (US3 scenario 2)", ({ name }) => {
    expect(entryFor(entries, name, "empty.ts").complexity).toBe(1);
  });

  it("each else-if is a nested if and counts: one if plus two else-ifs scores 4, a lone if scores 2", () => {
    expect(entryFor(entries, "gradeChain", "elseif.ts").complexity).toBe(4);
    expect(entryFor(entries, "loneIf", "elseif.ts").complexity).toBe(2);
  });

  it("each case clause counts and default never does: four cases score 5, two cases score 3, default-only scores 1", () => {
    expect(entryFor(entries, "sizeClass", "switches.ts").complexity).toBe(5);
    expect(entryFor(entries, "noDefault", "switches.ts").complexity).toBe(3);
    expect(entryFor(entries, "onlyDefault", "switches.ts").complexity).toBe(1);
  });

  it("logical-assignment operators are never counted (Assumption 10): three score 1, mixed with one || scores 2", () => {
    expect(
      entryFor(entries, "pureLogicalAssignment", "logical-assign.ts").complexity,
    ).toBe(1);
    expect(
      entryFor(entries, "mixedLogicalAssignment", "logical-assign.ts").complexity,
    ).toBe(2);
  });

  it("combined bodies, operator chains, nested ternaries, and double catches count per occurrence", () => {
    // for-of + if + && + catch + || + while + ternary = 7 decision points.
    expect(entryFor(entries, "combined", "combined.ts").complexity).toBe(8);
    // (a && b && c) || d: two && plus one ||.
    expect(entryFor(entries, "operatorChain", "combined.ts").complexity).toBe(4);
    // Two conditional expressions.
    expect(entryFor(entries, "nestedTernary", "combined.ts").complexity).toBe(3);
    // Two catch clauses.
    expect(entryFor(entries, "doubleCatch", "combined.ts").complexity).toBe(3);
  });

  it("wire shape: exactly the five fields, derivePackage, integer complexity >= 1, (file, line, name) order (FR-022)", () => {
    expectWireInvariants(entries);
    expect(entries).toHaveLength(25);
  });

  it("a clean tree writes no stderr diagnostics", () => {
    expect(stderr()).toBe("");
  });
});

describe("nested and anonymous attribution (FR-009; US3 scenario 3)", () => {
  let entries: readonly WireEntry[] = [];
  let cleanup: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    const tree = await createFixtureTree(ATTRIBUTION_FILES);
    cleanup = tree.cleanup;
    const run = await complexityTree(tree.root);
    entries = run.entries;
  }, 120_000);

  afterAll(async () => {
    await cleanup?.();
  });

  it("a nested declared function owns its body: the outer if and the inner if each count once, to their own entries", () => {
    expect(entryFor(entries, "outerNested", "nested.ts").complexity).toBe(2);
    expect(entryFor(entries, "innerNested", "nested.ts").complexity).toBe(2);
  });

  it("a variable-assigned nested arrow owns its body: the ternary counts to the arrow, the if to the enclosing function", () => {
    expect(entryFor(entries, "outerArrow", "nested.ts").complexity).toBe(2);
    expect(entryFor(entries, "innerArrow", "nested.ts").complexity).toBe(2);
  });

  it("three levels deep: the while counts to the outermost, nothing to the middle, the && and ternary to the innermost", () => {
    expect(entryFor(entries, "outerDeep", "nested.ts").complexity).toBe(2);
    expect(entryFor(entries, "middleDeep", "nested.ts").complexity).toBe(1);
    expect(entryFor(entries, "innerDeep", "nested.ts").complexity).toBe(3);
  });

  it("an anonymous function-expression argument counts toward the enclosing entry and never produces its own", () => {
    expect(entryFor(entries, "withCallback", "anonymous.ts").complexity).toBe(2);
  });

  it("a returned function expression counts toward the enclosing entry", () => {
    expect(entryFor(entries, "makeValidator", "anonymous.ts").complexity).toBe(2);
  });

  it("an anonymous arrow callback counts toward the enclosing entry alongside the body's own for-of", () => {
    expect(entryFor(entries, "withAnonymousArrow", "anonymous.ts").complexity).toBe(3);
  });

  it("inside an anonymous body, a nested extracted arrow still owns its own body (FR-009 plus US3 scenario 3)", () => {
    expect(entryFor(entries, "outerMixed", "anonymous.ts").complexity).toBe(2);
    expect(entryFor(entries, "clamp", "anonymous.ts").complexity).toBe(2);
  });

  it("nested.ts's exact entry set and order: (line, name) per record", () => {
    expect(fileTuples(entries, "nested.ts")).toEqual(NESTED_EXPECTED);
  });

  it("anonymous.ts's exact entry set and order: the three anonymous bodies never appear as entries", () => {
    expect(fileTuples(entries, "anonymous.ts")).toEqual(ANONYMOUS_EXPECTED);
  });

  it("wire shape over the attribution tree (FR-022)", () => {
    expectWireInvariants(entries);
    expect(entries).toHaveLength(12);
  });
});

describe("parity with analyze, scoping, and determinism (FR-022; US3 scenarios 4-5, SC-006)", () => {
  let root = "";
  let entries: readonly WireEntry[] = [];
  let analyzed: readonly Record<string, unknown>[] = [];
  let cleanup: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    const tree = await createFixtureTree(PARITY_FILES);
    cleanup = tree.cleanup;
    root = tree.root;
    const run = await complexityTree(root);
    entries = run.entries;
    const sink = memorySink();
    analyzed = await analyze(root, undefined, sink.stream);
  }, 120_000);

  afterAll(async () => {
    await cleanup?.();
  });

  it("the exact entries over the mixed tree, ordered by (file, line, name), with quickstart's documented values", () => {
    expect(entryProjection(entries)).toEqual(PARITY_EXPECTED);
    expectWireInvariants(entries);
  });

  it("the identical extraction set and (file, line, name) ordering as analyze over the same request (FR-022)", () => {
    expect(entryTuples(entries)).toEqual(analyzeTuples(analyzed));
  });

  it("test files are excluded from the complexity surface exactly as from analyze (FR-002/FR-022)", () => {
    expect(entries.filter((entry) => entry.file === "tests/math.test.ts")).toEqual([]);
    expect(
      analyzed.filter(
        (record) => (record as { file: string }).file === "tests/math.test.ts",
      ),
    ).toEqual([]);
  });

  it("pattern scoping narrows the complexity surface identically to analyze (FR-001/FR-022)", {
    timeout: 120_000,
  }, async () => {
    const scoped = await complexityTree(root, ["src/mutate.ts", "src/utils"]);
    expect(entryProjection(scoped.entries)).toEqual(PARITY_SCOPED_EXPECTED);
    const sink = memorySink();
    const scopedAnalyzed = await analyze(
      root,
      ["src/mutate.ts", "src/utils"],
      sink.stream,
    );
    expect(entryTuples(scoped.entries)).toEqual(analyzeTuples(scopedAnalyzed));
  });

  it("repeat responses are byte-identical (US3 scenario 5, SC-006)", {
    timeout: 120_000,
  }, async () => {
    const again = await complexityTree(root);
    expect(JSON.stringify(again.entries)).toBe(JSON.stringify(entries));
  });
});

describe("program mode parity (FR-003/FR-004; research R5)", () => {
  // The same strict-config shape tests/detector.test.ts plants to exercise
  // the program bootstrap. Counting is purely lexical, so the identical
  // entries across both modes is the parity pin; the bootstrap's
  // valid-config-implies-program-mode behavior itself is pinned by
  // tests/program.test.ts.
  const TSCONFIG_STRICT =
    '{"compilerOptions": {"strict": true, "target": "ES2022", "module": "commonjs"}}';

  it("a valid tsconfig yields the identical serialized entries as parse-only over the same sources", {
    timeout: 120_000,
  }, async () => {
    const files = { ...CLOSURE_FILES, ...ATTRIBUTION_FILES };
    const parseOnly = await createFixtureTree(files);
    const program = await createFixtureTree({
      ...files,
      "tsconfig.json": TSCONFIG_STRICT,
    });
    try {
      const loose = await complexityTree(parseOnly.root);
      const compiled = await complexityTree(program.root);
      // Non-vacuous parity: the union of the closure and attribution trees
      // is 37 entries, so equality is over a set spanning every kind.
      expect(loose.entries).toHaveLength(37);
      expect(JSON.stringify(compiled.entries)).toBe(JSON.stringify(loose.entries));
      expect(compiled.stderr()).toBe("");
    } finally {
      await parseOnly.cleanup();
      await program.cleanup();
    }
  });
});
