// Documentation-coverage wire-model and pipeline fixtures for the
// doc_coverage method's US1 slice (T004; spec 005 FR-001, FR-003, FR-004,
// FR-011; US1 scenarios 1-6; research R1-R4; Constitution Principles I
// and IV). The implementation under test is src/doc-coverage.ts (T008,
// landed): the SymbolRow record, its fail-loud serializer, and the
// docCoverage entry over the shared prepareAnalysis pipeline.
//
// ENTRY CONTRACT — the reading of the feature artifacts, recorded per the
// task brief (the tests/complexity.test.ts precedent, task-for-task):
//
// - The import is `docCoverage` from ../src/doc-coverage.js, plus
//   `serializeSymbolRow` and the `SymbolRow`/`SymbolKind` types for the
//   serializer's unit cases. T008's task text pins the analyze-shaped
//   entry docCoverage(rootPath, patterns, stderr) running the pipeline
//   internally and returning the serialized SymbolRow[] — the
//   computeComplexity split — while T009's server handler wraps that
//   array into the {"symbols": [...]} envelope.
// - Like tests/complexity.test.ts's complexityTree, symbolsTree below
//   accepts BOTH documented result shapes — the bare serialized row array
//   (the landed reading) and the {"symbols": [...]} envelope — and fails
//   loud on anything else. The JSON-RPC envelope and dispatch wiring are
//   pinned end-to-end by tests/server.test.ts (T005).
//
// The rules pinned here:
//
// - Row shape (FR-001): exactly name, package, kind, file, line,
//   documented — plus doc_snippet if and only if a summary line exists,
//   omitted otherwise and NEVER an empty string (spec 001 FR-013). kind
//   belongs to the closed set function | type | constant | variable |
//   class | method; the serializer fails loud on any other value.
// - The documented rule (FR-003): documented is true if and only if a
//   JSDoc comment (/** ... */) is attached to the implementation
//   declaration — a // line comment never counts, a plain /* */ block
//   comment is not JSDoc, and body-less overload signatures never count
//   (only body-bearing declarations are symbols; the implementation
//   signature is the documentation site).
// - The snippet rule (FR-003): doc_snippet is the first non-empty line of
//   the comment body that is not a block-tag line (a line whose first
//   token begins with @), trimmed of the leading * and surrounding
//   whitespace. The leading-* trim is discharged by the compiler's own
//   getTextOfJSDocComment rendering (verified against typescript 7.0.2:
//   it strips the ` * ` decoration and preserves content asterisks, so a
//   **bold** summary survives verbatim). A tags-only comment yields
//   documented: true with no doc_snippet key. Prose on lines after a
//   block tag is that tag's continuation text, not the comment body —
//   the compiler's own tag association (Constitution III: no custom doc
//   parser), so such a comment has no summary line to surface.
// - Pipeline invariants (FR-004/FR-011): rows cover exactly the source
//   files analyze reports for the same request (test and generated arms
//   excluded), ordered by the shared (file, line, name) total order,
//   with package from derivePackage, root-relative POSIX file
//   spellings, and 1-based declaration lines (the first token — export —
//   never the JSDoc). Two full docCoverage runs over fresh
//   prepareAnalysis walks reproduce byte-identical serialized output.
//   The same tree under a valid tsconfig (program mode) and without one
//   (parse-only) yields identical rows — detection is syntax-only.
//   Omitted patterns mean all discovered sources; a present set means
//   the union of matches; a match-nothing set yields empty symbols, a
//   valid success (US1 scenario 6). Skip diagnostics flow to the
//   injected stderr sink, never the result.
//
// Fixture style: every source is an array of lines joined with "\n" (the
// tests/complexity.test.ts precedent), so each declaration's 1-based line
// number is auditable in place against the expected tables below.

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { analyze } from "../src/analysis.js";
import {
  docCoverage,
  type SymbolKind,
  type SymbolRow,
  serializeSymbolRow,
} from "../src/doc-coverage.js";
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

/** One serialized symbol row — the wire shape FR-001 pins. */
interface WireRow {
  readonly name: string;
  readonly package: string;
  readonly kind: string;
  readonly file: string;
  readonly line: number;
  readonly documented: boolean;
  readonly doc_snippet?: string;
}

// Narrows the entry's result through its two documented shapes (see the
// header's ENTRY CONTRACT note). A missing symbols array is a malformed
// result, not a soft zero — fail loud rather than assert against [].
function isSymbolsContainer(value: unknown): value is { symbols: readonly WireRow[] } {
  return (
    typeof value === "object" &&
    value !== null &&
    Array.isArray((value as { symbols?: unknown }).symbols)
  );
}

function extractRows(result: unknown): readonly WireRow[] {
  if (Array.isArray(result)) {
    return result as readonly WireRow[];
  }
  if (isSymbolsContainer(result)) {
    return result.symbols;
  }
  throw new Error(
    "unexpected doc_coverage result shape: expected the serialized SymbolRow[] payload or an object with a symbols array",
  );
}

// Runs one doc_coverage analysis with a fresh stderr sink; absent
// patterns mean the whole tree (FR-001's catch-all through the shared
// analysis-params semantics), exactly as complexityTree drives the
// complexity surface in tests/complexity.test.ts. The raw result rides
// along for the envelope-shape assertions.
async function symbolsTree(
  root: string,
  patterns?: string[],
): Promise<{ rows: readonly WireRow[]; raw: unknown; stderr: () => string }> {
  const sink = memorySink();
  const raw: unknown = await docCoverage(root, patterns, sink.stream);
  return { rows: extractRows(raw), raw, stderr: sink.text };
}

// Finds the unique row for (name, file) — the one-row-per-fixture
// invariant every rule case relies on; a miss or a duplicate is a walk or
// fixture bug, never a soft match.
function rowFor(rows: readonly WireRow[], name: string, file: string): WireRow {
  let found: WireRow | undefined;
  let count = 0;
  for (const row of rows) {
    if (row.name === name && row.file === file) {
      found = row;
      count += 1;
    }
  }
  if (count !== 1 || found === undefined) {
    throw new Error(
      `expected exactly one symbol row named "${name}" in ${file}, found ${count}`,
    );
  }
  return found;
}

// The full contract projection: identity, kind, and the documentation
// fact (package is pinned separately through derivePackage in
// expectWireInvariants, so the tables stay one screen wide).
function rowProjection(
  rows: readonly WireRow[],
): ReadonlyArray<Record<string, unknown>> {
  return rows.map((row) => ({
    file: row.file,
    line: row.line,
    name: row.name,
    kind: row.kind,
    documented: row.documented,
    ...(row.doc_snippet !== undefined ? { doc_snippet: row.doc_snippet } : {}),
  }));
}

// The identity tuple every ordering assertion projects onto.
function rowTuples(rows: readonly WireRow[]): Array<[string, number, string]> {
  return rows.map((row) => [row.file, row.line, row.name]);
}

// The FR-001 total order over identity tuples: (file, line, name),
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

// The closed kind set (FR-001) — the gaze protocol's doc_coverage schema
// enumeration, mirrored here so the wire helper validates the same six
// values the serializer enforces (the tests/helpers/wire.ts stance).
const SYMBOL_KINDS: readonly string[] = [
  "class",
  "constant",
  "function",
  "method",
  "type",
  "variable",
];

// FR-001 invariants over a whole result: exact six-field key sets (seven
// with doc_snippet), closed-set kind membership, boolean documented,
// derivePackage derivation, positive integer lines, root-relative POSIX
// file spellings, a non-empty doc_snippet whenever the key exists, and
// the documented (file, line, name) total order.
function expectWireInvariants(rows: readonly WireRow[]): void {
  const tuples = rowTuples(rows);
  expect(tuples).toEqual([...tuples].sort(compareTuples));
  for (const row of rows) {
    expect(SYMBOL_KINDS).toContain(row.kind);
    expect(row.documented).toBeTypeOf("boolean");
    expect(row.package).toBe(derivePackage(row.file));
    expect(Number.isInteger(row.line)).toBe(true);
    expect(row.line).toBeGreaterThanOrEqual(1);
    expect(row.name).toBeTypeOf("string");
    expect(row.file).toBeTypeOf("string");
    expect(row.file.startsWith("/")).toBe(false);
    expect(row.file.includes("\\")).toBe(false);
    if (row.doc_snippet === undefined) {
      expect(Object.keys(row).sort()).toEqual([
        "documented",
        "file",
        "kind",
        "line",
        "name",
        "package",
      ]);
    } else {
      expect(Object.keys(row).sort()).toEqual([
        "doc_snippet",
        "documented",
        "file",
        "kind",
        "line",
        "name",
        "package",
      ]);
      expect(row.doc_snippet).toBeTypeOf("string");
      expect(row.doc_snippet.length).toBeGreaterThan(0);
    }
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
// The documented/snippet-rule fixtures (FR-003). us1.ts is the spec's
// exact US1-1 fixture; rules.ts pins every boundary of the documented and
// snippet rules; overloads.ts pins the implementation-signature rule.
// ---------------------------------------------------------------------------

const US1_EXACT = [
  "/** Divide two numbers, raising an error for a zero divisor. */",
  "export function divide(dividend: number, divisor: number): number {",
  "  if (divisor === 0) {",
  '    throw new Error("zero divisor");',
  "  }",
  "  return dividend / divisor;",
  "}",
  "",
  "export function add(left: number, right: number): number {",
  "  return left + right;",
  "}",
  "",
].join("\n");

const RULES = [
  "// A line comment never counts as documentation.",
  "export function lineComment(): void {}",
  "",
  "/* A plain block comment is not a JSDoc comment. */",
  "export function plainBlock(): void {}",
  "",
  "/**",
  " * @param value The value to ignore.",
  " * @returns Nothing at all.",
  " */",
  "export function tagsOnly(value: number): void {}",
  "",
  "/**",
  " * Computes the answer to everything.",
  " * @param value The value to answer with.",
  " * @returns The answer.",
  " */",
  "export function summaryThenTags(value: number): number {",
  "  return value;",
  "}",
  "",
  "/**",
  " *",
  " * Skips the leading empty line.",
  " */",
  "export function emptyFirstLine(): void {}",
  "",
  "/** **bold** summary. */",
  "export function boldSummary(): void {}",
  "",
  "/**",
  " * @param value The value to fold into the tag.",
  " * Prose after a block tag is the tag's continuation text.",
  " */",
  "export function proseAfterTag(value: number): void {}",
  "",
  "export function noComment(): void {}",
  "",
  "/** */",
  "export function emptyComment(): void {}",
  "",
].join("\n");

const OVERLOADS = [
  "/** Overload-only documentation does not count. */",
  "export function overloaded(value: string): void;",
  "export function overloaded(value: number): void {",
  "  void value;",
  "}",
  "",
  "export function documentedImpl(value: string): void;",
  "/** Implementation-signature documentation counts. */",
  "export function documentedImpl(value: number): void {",
  "  void value;",
  "}",
  "",
].join("\n");

const RULE_FILES: Readonly<Record<string, string>> = {
  "overloads.ts": OVERLOADS,
  "rules.ts": RULES,
  "us1.ts": US1_EXACT,
};

// The US1 surface slice: exported declarations produce rows, non-exported
// declarations produce none (the full FR-002 routing arrives with T020).
const SURFACE = [
  "export function exportedOne(): void {}",
  "",
  "function internalOne(): void {}",
  "",
  "export function exportedTwo(): void {}",
  "",
].join("\n");

// ---------------------------------------------------------------------------
// The pipeline tree (FR-004/FR-011; US1 scenarios 2-4, 6): a multi-file
// project with documented and undocumented functions across nested
// directories, plus a test file and a generated directory that must
// contribute nothing — the file-set parity fixture.
// ---------------------------------------------------------------------------

const PARITY_DOC = [
  "/** Adds two numbers. */",
  "export function add(left: number, right: number): number {",
  "  return left + right;",
  "}",
  "",
  "export function subtract(left: number, right: number): number {",
  "  return left - right;",
  "}",
  "",
].join("\n");

const PARITY_CALC = [
  "/**",
  " * Multiplies two numbers.",
  " * @param left The left factor.",
  " */",
  "export function multiply(left: number, right: number): number {",
  "  return left * right;",
  "}",
  "",
  "function hiddenProduct(values: number[]): number {",
  "  let total = 1;",
  "  for (const value of values) {",
  "    total *= value;",
  "  }",
  "  return total;",
  "}",
  "",
].join("\n");

const PARITY_TOP = ["export function topLevel(): void {}", ""].join("\n");

const PARITY_TEST = [
  'import { it } from "vitest";',
  'import { add } from "../src/doc.js";',
  "",
  'it("adds", () => {',
  "  void add(1, 2);",
  "});",
  "",
].join("\n");

const PARITY_GENERATED = [
  "// @generated by fixture - do not edit",
  "export function generatedApi(): void {}",
  "",
].join("\n");

const PARITY_FILES: Readonly<Record<string, string>> = {
  "generated/api.ts": PARITY_GENERATED,
  "src/doc.ts": PARITY_DOC,
  "src/internal/calc.ts": PARITY_CALC,
  "tests/doc.test.ts": PARITY_TEST,
  "top.ts": PARITY_TOP,
};

// The exact parity-tree rows, (file, line, name, kind, documented,
// doc_snippet?) in the documented order: add is documented with its
// summary line, subtract and topLevel are undocumented, multiply is
// documented through its multi-line summary-then-tags comment, and
// neither hiddenProduct (non-exported) nor the test/generated files
// produce rows.
const PARITY_EXPECTED: ReadonlyArray<Record<string, unknown>> = [
  {
    file: "src/doc.ts",
    line: 2,
    name: "add",
    kind: "function",
    documented: true,
    doc_snippet: "Adds two numbers.",
  },
  {
    file: "src/doc.ts",
    line: 6,
    name: "subtract",
    kind: "function",
    documented: false,
  },
  {
    file: "src/internal/calc.ts",
    line: 5,
    name: "multiply",
    kind: "function",
    documented: true,
    doc_snippet: "Multiplies two numbers.",
  },
  {
    file: "top.ts",
    line: 1,
    name: "topLevel",
    kind: "function",
    documented: false,
  },
];

// The pattern-scoped projection (FR-004 narrows within the analyzable
// set): ["src/doc.ts", "src/internal"] — one exact file pattern, one
// directory pattern — keeps add, subtract, and multiply (the prefix
// "src" alone would also match src/doc.ts; the exact-file pattern pins
// the path-equality arm while "src/internal" pins the segment-boundary
// arm), and excludes topLevel.
const PARITY_SCOPED_EXPECTED: ReadonlyArray<Record<string, unknown>> = [
  PARITY_EXPECTED[0],
  PARITY_EXPECTED[1],
  PARITY_EXPECTED[2],
];

// The protocol document's doc_coverage example row (protocol.md v1.2.0,
// the sibling clone at .uf/sibling-clones/gaze/), transcribed as the
// serializer's base fixture.
const SERIALIZER_BASE: SymbolRow = {
  name: "divide",
  package: "math_utils",
  kind: "function",
  file: "math_utils/ops.ts",
  line: 20,
  documented: true,
  doc_snippet: "Divide two numbers, raising ZeroDivisionError for zero divisor.",
};

/** One row with selective overrides — the invalid-value seam. */
function rowWith(overrides: Partial<SymbolRow>): SymbolRow {
  return { ...SERIALIZER_BASE, ...overrides };
}

describe("serializeSymbolRow: the SymbolRow wire shape (FR-001, FR-003)", () => {
  it.each([
    { kind: "function" },
    { kind: "type" },
    { kind: "constant" },
    { kind: "variable" },
    { kind: "class" },
    { kind: "method" },
  ] as const satisfies ReadonlyArray<{ kind: SymbolKind }>)(
    'serializes a "$kind" row with exactly the six required fields',
    ({ kind }) => {
      const serialized = serializeSymbolRow({
        ...SERIALIZER_BASE,
        kind,
        documented: false,
        doc_snippet: undefined,
      });
      expect(serialized.kind).toBe(kind);
      // Keys in the canonical sorted order the protocol layer's code-unit
      // key sort produces, so that pass is a structural no-op.
      expect(Object.keys(serialized)).toEqual([
        "documented",
        "file",
        "kind",
        "line",
        "name",
        "package",
      ]);
    },
  );

  it("includes doc_snippet when present — seven keys, doc_snippet first in canonical order", () => {
    const serialized = serializeSymbolRow(SERIALIZER_BASE);
    expect(serialized.doc_snippet).toBe(
      "Divide two numbers, raising ZeroDivisionError for zero divisor.",
    );
    expect(Object.keys(serialized)).toEqual([
      "doc_snippet",
      "documented",
      "file",
      "kind",
      "line",
      "name",
      "package",
    ]);
  });

  it("omits the doc_snippet key when absent — never null, never empty (spec 001 FR-013)", () => {
    const serialized = serializeSymbolRow({
      ...SERIALIZER_BASE,
      documented: true,
      doc_snippet: undefined,
    });
    expect("doc_snippet" in serialized).toBe(false);
    expect(Object.keys(serialized)).toEqual([
      "documented",
      "file",
      "kind",
      "line",
      "name",
      "package",
    ]);
  });

  it.each(["module", "interface member", "Function", ""])(
    "throws on the kind value %j outside the closed set (fail-loud, FR-001)",
    (kind) => {
      expect(() => serializeSymbolRow(rowWith({ kind: kind as SymbolKind }))).toThrow(
        `Invalid symbol kind: ${kind}`,
      );
    },
  );

  it("throws on a present-but-empty doc_snippet (fail-loud, spec 001 FR-013)", () => {
    expect(() => serializeSymbolRow(rowWith({ doc_snippet: "" }))).toThrow(
      "Invalid doc_snippet: must be a non-empty string when present",
    );
  });

  it("throws on a null doc_snippet — the malformed optional never reaches the wire", () => {
    expect(() =>
      serializeSymbolRow(rowWith({ doc_snippet: null as unknown as string })),
    ).toThrow();
  });
});

describe("documented and snippet rules (FR-003; US1 scenario 1, edge cases)", () => {
  let rows: readonly WireRow[] = [];
  let stderr: () => string = () => "";
  let cleanup: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    const tree = await createFixtureTree(RULE_FILES);
    cleanup = tree.cleanup;
    const run = await symbolsTree(tree.root);
    rows = run.rows;
    stderr = run.stderr;
  }, 120_000);

  afterAll(async () => {
    await cleanup?.();
  });

  it("the spec's US1-1 fixture: exactly two rows — documented divide with the exact snippet, undocumented add with no doc_snippet key (US1 scenario 1)", () => {
    expect(rowProjection(rows.filter((row) => row.file === "us1.ts"))).toEqual([
      {
        file: "us1.ts",
        line: 2,
        name: "divide",
        kind: "function",
        documented: true,
        doc_snippet: "Divide two numbers, raising an error for a zero divisor.",
      },
      {
        file: "us1.ts",
        line: 9,
        name: "add",
        kind: "function",
        documented: false,
      },
    ]);
  });

  it("a // line comment never counts as documentation", () => {
    const row = rowFor(rows, "lineComment", "rules.ts");
    expect(row.documented).toBe(false);
    expect("doc_snippet" in row).toBe(false);
  });

  it("a plain /* */ block comment is not a JSDoc comment", () => {
    const row = rowFor(rows, "plainBlock", "rules.ts");
    expect(row.documented).toBe(false);
    expect("doc_snippet" in row).toBe(false);
  });

  it("a tags-only comment is documentation with NO doc_snippet key (edge case)", () => {
    const row = rowFor(rows, "tagsOnly", "rules.ts");
    expect(row.documented).toBe(true);
    expect("doc_snippet" in row).toBe(false);
  });

  it("the snippet is the first non-empty non-tag line of the body: summary-then-tags, a leading empty line, and content asterisks (FR-003)", () => {
    expect(rowFor(rows, "summaryThenTags", "rules.ts").doc_snippet).toBe(
      "Computes the answer to everything.",
    );
    expect(rowFor(rows, "emptyFirstLine", "rules.ts").doc_snippet).toBe(
      "Skips the leading empty line.",
    );
    // The leading-* trim is the compiler renderer's own, so a **bold**
    // summary survives verbatim — no second asterisk is stripped here.
    expect(rowFor(rows, "boldSummary", "rules.ts").doc_snippet).toBe(
      "**bold** summary.",
    );
  });

  it("an empty /** */ JSDoc is attached documentation with NO doc_snippet key (edge case)", () => {
    // The comment node exists — documented is true — but the compiler
    // renders no description text at all, so there is no summary line to
    // surface (the docSnippetOf empty-text arm).
    const row = rowFor(rows, "emptyComment", "rules.ts");
    expect(row.line).toBe(40);
    expect(row.documented).toBe(true);
    expect("doc_snippet" in row).toBe(false);
  });

  it("prose after a block tag is the tag's continuation text, not the comment body — no snippet (compiler-native boundary)", () => {
    // The compiler parses @param out of the description and folds the
    // prose that follows into the tag's own value, so the rendered
    // comment body is empty: documented, with nothing to surface
    // (Constitution III — the compiler's tag association, not a custom
    // doc parser's line scanning).
    const row = rowFor(rows, "proseAfterTag", "rules.ts");
    expect(row.documented).toBe(true);
    expect("doc_snippet" in row).toBe(false);
  });

  it("overload signatures are not symbols: docs on the overload alone never count, docs on the implementation do (edge case)", () => {
    // Exactly one row per overloaded name — the body-bearing
    // implementation declaration; the body-less signature statements
    // produce nothing.
    const overloaded = rowFor(rows, "overloaded", "overloads.ts");
    expect(overloaded.line).toBe(3);
    expect(overloaded.documented).toBe(false);
    expect("doc_snippet" in overloaded).toBe(false);
    const documentedImpl = rowFor(rows, "documentedImpl", "overloads.ts");
    expect(documentedImpl.line).toBe(9);
    expect(documentedImpl.documented).toBe(true);
    expect(documentedImpl.doc_snippet).toBe(
      "Implementation-signature documentation counts.",
    );
  });

  it("wire shape over the rule tree: closed-set kinds, derivePackage, (file, line, name) order (FR-001)", () => {
    expectWireInvariants(rows);
    expect(rows).toHaveLength(13);
  });

  it("a clean tree writes no stderr diagnostics", () => {
    expect(stderr()).toBe("");
  });
});

describe("the US1 surface slice (FR-002 US1 slice; US1 scenario 1)", () => {
  it("export function declarations produce rows; non-exported declarations produce none", {
    timeout: 120_000,
  }, async () => {
    const tree = await createFixtureTree({ "surface.ts": SURFACE });
    registerCleanup(tree.cleanup);
    const run = await symbolsTree(tree.root);
    expect(rowProjection(run.rows)).toEqual([
      {
        file: "surface.ts",
        line: 1,
        name: "exportedOne",
        kind: "function",
        documented: false,
      },
      {
        file: "surface.ts",
        line: 5,
        name: "exportedTwo",
        kind: "function",
        documented: false,
      },
    ]);
    expectWireInvariants(run.rows);
  });
});

describe("pipeline, parity, and determinism (FR-001, FR-004, FR-011; US1 scenarios 2-4, 6)", () => {
  let root = "";
  let rows: readonly WireRow[] = [];
  let raw: unknown;
  let stderr: () => string = () => "";
  let analyzed: readonly Record<string, unknown>[] = [];
  let cleanup: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    const tree = await createFixtureTree(PARITY_FILES);
    cleanup = tree.cleanup;
    root = tree.root;
    const run = await symbolsTree(root);
    rows = run.rows;
    raw = run.raw;
    stderr = run.stderr;
    const sink = memorySink();
    analyzed = await analyze(root, undefined, sink.stream);
  }, 120_000);

  afterAll(async () => {
    await cleanup?.();
  });

  it("the exact rows over the mixed tree, ordered by (file, line, name) (US1 scenario 3)", () => {
    expect(rowProjection(rows)).toEqual(PARITY_EXPECTED);
    expectWireInvariants(rows);
  });

  it("the result is the one-key symbols envelope — no additional fields (US1 scenario 2)", () => {
    // Whichever documented shape the entry returns (the header's ENTRY
    // CONTRACT), the wire result the server hands the protocol layer is
    // exactly one `symbols` key: the bare array wrapped as the T009
    // handler wraps it, or the envelope itself — anything beyond the one
    // key is a wire-shape violation.
    const envelope: Record<string, unknown> = Array.isArray(raw)
      ? { symbols: raw }
      : (raw as Record<string, unknown>);
    expect(Object.keys(envelope)).toEqual(["symbols"]);
    expect(Array.isArray(envelope.symbols)).toBe(true);
  });

  it("repeat responses over fresh prepareAnalysis walks are byte-identical (US1 scenario 3)", {
    timeout: 120_000,
  }, async () => {
    const again = await symbolsTree(root);
    expect(JSON.stringify(again.rows)).toBe(JSON.stringify(rows));
    expect(JSON.stringify(again.raw)).toBe(JSON.stringify(raw));
  });

  it("a clean tree writes no stderr diagnostics", () => {
    expect(stderr()).toBe("");
  });

  it("rows cover exactly the source files analyze reports — test and generated arms excluded (US1 scenario 4)", () => {
    const rowFiles = [...new Set(rows.map((row) => row.file))].sort();
    const analyzeFiles = [
      ...new Set(analyzed.map((record) => (record as { file: string }).file)),
    ].sort();
    // Non-vacuous parity: four rows over three files.
    expect(rows).toHaveLength(4);
    expect(rowFiles).toEqual(["src/doc.ts", "src/internal/calc.ts", "top.ts"]);
    expect(rowFiles).toEqual(analyzeFiles);
    // No row references a file outside the analyzed set — in particular
    // neither the test file nor the generated directory.
    for (const row of rows) {
      expect(analyzeFiles).toContain(row.file);
    }
    expect(
      rows.filter(
        (row) => row.file === "tests/doc.test.ts" || row.file === "generated/api.ts",
      ),
    ).toEqual([]);
    expect(analyzeFiles).not.toContain("tests/doc.test.ts");
    expect(analyzeFiles).not.toContain("generated/api.ts");
  });

  it("omitted patterns mean all discovered sources (US1 scenario 2)", () => {
    // The beforeAll run passed no patterns; its rows are the full
    // discovered source surface — every source file's exported functions.
    expect(rowProjection(rows)).toEqual(PARITY_EXPECTED);
  });

  it("a present pattern set means the union of matches (US1 scenario 2)", {
    timeout: 120_000,
  }, async () => {
    const scoped = await symbolsTree(root, ["src/doc.ts", "src/internal"]);
    expect(rowProjection(scoped.rows)).toEqual(PARITY_SCOPED_EXPECTED);
    expectWireInvariants(scoped.rows);
  });

  it("a match-nothing pattern set yields empty symbols — a valid success, never an error (US1 scenario 6)", {
    timeout: 120_000,
  }, async () => {
    const empty = await symbolsTree(root, [""]);
    expect(empty.rows).toEqual([]);
    // The envelope form of the empty success is {"symbols": []} — the
    // empty array here, wrapped by the handler exactly as the populated
    // one is.
    const payload = Array.isArray(empty.raw)
      ? empty.raw
      : (empty.raw as { symbols: readonly WireRow[] }).symbols;
    expect(payload).toEqual([]);
  });
});

describe("program mode parity (FR-011; US1 scenario 5, edge case)", () => {
  // The same strict-config shape tests/complexity.test.ts plants to
  // exercise the program bootstrap. Documentation attachment is purely
  // syntactic, so the identical rows across both modes is the parity pin;
  // the bootstrap's valid-config-implies-program-mode behavior itself is
  // pinned by tests/program.test.ts.
  const TSCONFIG_STRICT =
    '{"compilerOptions": {"strict": true, "target": "ES2022", "module": "commonjs"}}';

  it("a valid tsconfig yields the identical serialized rows as parse-only over the same sources", {
    timeout: 120_000,
  }, async () => {
    const parseOnly = await createFixtureTree(PARITY_FILES);
    const program = await createFixtureTree({
      ...PARITY_FILES,
      "tsconfig.json": TSCONFIG_STRICT,
    });
    try {
      const loose = await symbolsTree(parseOnly.root);
      const compiled = await symbolsTree(program.root);
      // Non-vacuous parity: the parity tree's four rows span nested
      // directories, documented and undocumented symbols alike.
      expect(loose.rows).toHaveLength(4);
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
      const rows = extractRows(await docCoverage(tree.root, undefined, sink.stream));
      // The result carries exactly the readable source's row — the FIFO
      // contributed nothing to the rows.
      expect(rowProjection(rows)).toEqual([
        {
          file: "clean.ts",
          line: 1,
          name: "kept",
          kind: "function",
          documented: false,
        },
      ]);
      // ...and the skip is exactly one newline-terminated stderr line,
      // with stdout untouched (it is reserved for JSON-RPC responses).
      expectOneSkipLine(sink.text(), "pipe.ts");
      expect(stdout).not.toHaveBeenCalled();
    },
  );
});
