/**
 * Disposition-table conformance suite (T031, SC-008, FR-030).
 *
 * docs/effect-disposition.md (rendered by T032) records, for each of the
 * 48 canonical taxonomy types, its tier, disposition, TypeScript mapping,
 * and rationale. This suite parses that document and conforms it to
 * SIDE_EFFECT_TYPES / TIER_MAP from src/taxonomy.ts, so the table can
 * never drift from the shipped taxonomy (no gaps, no duplicates, no
 * unknown rows) and every disposition judgment stays mechanically
 * checkable. The document is repo content, not untrusted analysis input
 * (Constitution Principle V does not apply to it); it is read once at
 * module scope.
 *
 * The committed suite IS the contract T032 implements against. Parsing
 * contract for docs/effect-disposition.md:
 *
 * FORMAT
 * - Markdown: GFM pipe tables. A disposition table is recognized by its
 *   header row, which must parse (after cell normalization, below) to
 *   exactly these five cells, in this order, case-sensitive:
 *       Type | Tier | Disposition | TypeScript mapping | Rationale
 *   Leading and trailing `|` on any row are optional.
 * - The header row must be followed by a separator row: every cell is
 *   dashes (at least one) with optional surrounding colons (`------`,
 *   `:---`, `---:`).
 * - Every subsequent line that contains a `|` is a data row. A table
 *   ends at the first line without a `|` (blank line, heading,
 *   paragraph).
 * - Each data row must have exactly 5 cells; any other cell count fails
 *   the parse with the offending line number.
 * - Cells are split on `|` characters not preceded by a backslash; `\|`
 *   unescapes to a literal pipe. Each cell is trimmed, then one pair of
 *   surrounding backticks is stripped (`` `ReturnValue` `` becomes
 *   ReturnValue), so single-code-span cells render either way; inner
 *   code spans are untouched.
 * - Multiple disposition tables (e.g. one per tier section) are allowed;
 *   their rows are concatenated in document order. Tables whose header
 *   does not match exactly — different columns, order, or names — are
 *   ignored. The 4-column tables in
 *   specs/002-analysis-engine/data-model.md are the normative DATA
 *   source but NOT this document's shape: T032 renders the Rationale
 *   column separately, per FR-030.
 * - A document containing no disposition table fails the parse.
 *
 * HOW ROWS MAP TO ASSERTIONS
 * - Type cell → must be a canonical name from SIDE_EFFECT_TYPES. Unknown
 *   names, missing canonical names, and duplicated canonical names each
 *   fail with a specific diff. Count-independent: no row count is
 *   pinned; expectations are derived from the taxonomy exports, so
 *   adding or removing a taxonomy type fails with that type's name.
 * - Tier cell → must equal TIER_MAP[type] for that canonical name.
 * - Disposition cell → must be from the closed set {strict, must,
 *   partial, best-effort, N/A}; every non-N/A row must carry its
 *   mechanical tier disposition (P0→strict, P1→must, P2→partial,
 *   P3/P4→best-effort); N/A is reserved for the seven normative rows
 *   (see NORMATIVE NA ROWS below).
 * - Mapping cell → P1 rows must carry a non-empty detect mapping that is
 *   not a none-sentinel ("N/A", "n/a", "none", "—", "-").
 * - Rationale cell → every N/A row must carry non-empty rationale; other
 *   rows may leave it empty.
 *
 * NORMATIVE N/A ROWS
 * - specs/002-analysis-engine/data-model.md disposition TABLES are the
 *   row-level normative source and contain seven N/A rows: Panic,
 *   MutexOp, WaitGroupOp, RecoverBehavior, ReflectionMutation,
 *   UnsafeMutation, SyncPoolOp. The "6 N/A rows" sentence in
 *   data-model.md's table-invariants paragraph omits SyncPoolOp and is
 *   superseded by the tables. The seven names are pinned individually
 *   (normative row data, like taxonomy.test.ts's pinned tier
 *   membership), never as a count: each of the seven is required to be
 *   N/A with non-empty rationale, and every other row is required to
 *   take its mechanical tier disposition — together these pin the N/A
 *   set to exactly the seven without asserting any count.
 *
 * RED STATE (TDD task ordering)
 * - T032 (the document) follows T031 (this suite). The document is read
 *   and parsed once at module scope: while it is absent the whole file
 *   fails during collection — 0 tests passing, the failure being the
 *   missing document itself. No test in this file can pass until the
 *   document exists.
 */

import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SIDE_EFFECT_TYPES, TIER_MAP, type Tier } from "../src/taxonomy.js";

/**
 * One parsed data row of docs/effect-disposition.md. Deliberately plain
 * strings, not the source types: this suite conforms the document to the
 * taxonomy, so it must not share the taxonomy's shapes (same stance as
 * tests/taxonomy.test.ts). `line` is the 1-based source line, carried so
 * assertion failures name the exact row to fix.
 */
interface DispositionRow {
  readonly type: string;
  readonly tier: string;
  readonly disposition: string;
  readonly mapping: string;
  readonly rationale: string;
  readonly line: number;
}

/** The exact header cells a disposition table must carry, in order. */
const HEADER_CELLS: readonly string[] = [
  "Type",
  "Tier",
  "Disposition",
  "TypeScript mapping",
  "Rationale",
];

/**
 * Normalizes one raw table cell: unescape `\|` to a literal pipe, trim
 * whitespace, then strip one pair of surrounding backticks so cells may
 * be rendered as single code spans (`` `ReturnValue` ``). Inner code
 * spans are untouched — only a backtick pair wrapping the whole cell is
 * stripped.
 */
function normalizeCell(raw: string): string {
  let cell = raw.replaceAll("\\|", "|").trim();
  if (cell.length >= 2 && cell.startsWith("`") && cell.endsWith("`")) {
    cell = cell.slice(1, -1).trim();
  }
  return cell;
}

/**
 * Splits one table line into normalized cells. Leading and trailing `|`
 * are optional and dropped; the split ignores pipes preceded by a
 * backslash (the GFM escaped pipe), which normalizeCell then unescapes.
 */
function splitRowCells(line: string): string[] {
  let body = line.trim();
  if (body.startsWith("|")) {
    body = body.slice(1);
  }
  if (body.endsWith("|")) {
    body = body.slice(0, -1);
  }
  return body.split(/(?<!\\)\|/).map(normalizeCell);
}

/** Reports whether the line is a disposition-table header row. */
function isDispositionHeader(line: string): boolean {
  if (!line.includes("|")) {
    return false;
  }
  const cells = splitRowCells(line);
  return (
    cells.length === HEADER_CELLS.length &&
    HEADER_CELLS.every((name, index) => cells[index] === name)
  );
}

/** Reports whether the line is a separator row (dash cells, optional
 * surrounding colons). */
function isSeparatorRow(line: string): boolean {
  if (!line.includes("|")) {
    return false;
  }
  const cells = splitRowCells(line);
  return cells.length > 0 && cells.every((cell) => /^:?-+:?$/.test(cell));
}

/**
 * Parses every disposition table in the document, in document order.
 * Pure: takes markdown text, returns rows, performs no I/O — the file
 * read lives at module scope so the missing-document RED state fails the
 * whole file during collection.
 *
 * Strict by design: a recognizable header without a separator row, or a
 * data row with a cell count other than 5, throws with the offending
 * line number. A normative document should fail loudly on structural
 * drift, not surface it as a confusing content diff downstream.
 *
 * @param markdown The full text of docs/effect-disposition.md.
 * @returns Every data row of every disposition table found.
 * @throws When no disposition table exists, a header lacks its separator
 * row, or a data row has the wrong cell count.
 */
function parseDispositionTables(markdown: string): DispositionRow[] {
  const lines = markdown.split("\n");
  const rows: DispositionRow[] = [];
  let lineIndex = 0;
  let tableFound = false;

  while (lineIndex < lines.length) {
    if (!isDispositionHeader(lines[lineIndex] ?? "")) {
      lineIndex += 1;
      continue;
    }
    tableFound = true;
    if (lineIndex + 1 >= lines.length || !isSeparatorRow(lines[lineIndex + 1] ?? "")) {
      throw new Error(
        `disposition table header at line ${lineIndex + 1} is not followed by a separator row (cells of dashes with optional colons)`,
      );
    }
    let body = lineIndex + 2;
    while (body < lines.length && (lines[body] ?? "").includes("|")) {
      const cells = splitRowCells(lines[body] ?? "");
      if (cells.length !== HEADER_CELLS.length) {
        throw new Error(
          `malformed disposition row at line ${body + 1}: expected ${HEADER_CELLS.length} cells, found ${cells.length}`,
        );
      }
      const [type, tier, disposition, mapping, rationale] = cells as [
        string,
        string,
        string,
        string,
        string,
      ];
      rows.push({
        type,
        tier,
        disposition,
        mapping,
        rationale,
        line: body + 1,
      });
      body += 1;
    }
    lineIndex = body;
  }

  if (!tableFound) {
    throw new Error(
      'no disposition table found: expected a header row "| Type | Tier | Disposition | TypeScript mapping | Rationale |" followed by a separator row',
    );
  }
  return rows;
}

const DOCUMENT_URL = new URL("../docs/effect-disposition.md", import.meta.url);

/**
 * Reads the disposition document. Throws — rather than returning a
 * sentinel — when it is absent, so the RED state for the T031→T032
 * ordering is an explicit, self-describing failure.
 */
function readDispositionDocument(url: URL): string {
  if (!existsSync(url)) {
    throw new Error(
      "docs/effect-disposition.md does not exist yet: task T032 renders it, and this suite (T031) is that document's conformance contract — the parsing contract it must satisfy is documented in this file's header. No test in this file can pass until the document exists.",
    );
  }
  return readFileSync(url, "utf8");
}

// Module-scope read + parse: the exact RED state is the whole file
// failing during collection (0 tests passing) with the reason above.
const ROWS: readonly DispositionRow[] = parseDispositionTables(
  readDispositionDocument(DOCUMENT_URL),
);

// ---------------------------------------------------------------------------
// Parser contract — inline fixtures. These lock the format rules T032
// renders against; they use synthetic documents, not the real one.
// ---------------------------------------------------------------------------

const MINIMAL_DOC: string = [
  "# Effect disposition",
  "",
  "| Type | Tier | Disposition | TypeScript mapping | Rationale |",
  "|------|------|-------------|---------------------|-----------|",
  "| `ReturnValue` | P0 | strict | `return <expr>` | full conformance |",
  "Panic | P2 | N/A | none | no panic mechanism in TypeScript",
  "",
  "Paragraph after the table.",
].join("\n");

const TWO_TABLE_DOC: string = [
  "# Dispositions",
  "",
  "Intro paragraph.",
  "",
  "| Type | Tier | Disposition | TypeScript mapping | Rationale |",
  "| --- | --- | --- | --- | --- |",
  "| ReturnValue | P0 | strict | `return <expr>` | |",
  "",
  "## P1 section",
  "",
  "| Type | Tier | Disposition | TypeScript mapping | Rationale |",
  "| --- | --- | --- | --- | --- |",
  "| SliceMutation | P1 | must | mutating array methods | FP-documented |",
  "",
  "Trailing text.",
].join("\n");

const FOUR_COLUMN_DOC: string = [
  "| Type | Tier | Disposition | TypeScript mapping |",
  "|------|------|-------------|---------------------|",
  "| ReturnValue | P0 | strict | `return <expr>` |",
].join("\n");

describe("parseDispositionTables", () => {
  it("parses data rows with normalized cells and 1-based line numbers", () => {
    const rows = parseDispositionTables(MINIMAL_DOC);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({
      type: "ReturnValue",
      tier: "P0",
      disposition: "strict",
      mapping: "return <expr>",
      rationale: "full conformance",
      line: 5,
    });
    // Line 6 omits the leading and trailing pipes — still a valid row.
    expect(rows[1]).toEqual({
      type: "Panic",
      tier: "P2",
      disposition: "N/A",
      mapping: "none",
      rationale: "no panic mechanism in TypeScript",
      line: 6,
    });
  });

  it("concatenates rows across multiple tables in document order", () => {
    const rows = parseDispositionTables(TWO_TABLE_DOC);
    expect(rows.map((row) => row.type)).toEqual(["ReturnValue", "SliceMutation"]);
    expect(rows.map((row) => row.line)).toEqual([7, 13]);
  });

  it("unescapes \\| to a literal pipe inside cells", () => {
    const doc = [
      "| Type | Tier | Disposition | TypeScript mapping | Rationale |",
      "| --- | --- | --- | --- | --- |",
      "| LeftRight | P0 | strict | `a \\| b` | pipe union |",
    ].join("\n");
    const rows = parseDispositionTables(doc);
    expect(rows[0]?.mapping).toBe("a | b");
  });

  it("fails when the document contains no disposition table", () => {
    expect(() => parseDispositionTables("# Only prose\n\nNo tables here.")).toThrow(
      /no disposition table found/,
    );
  });

  it("ignores tables whose header does not match the five canonical columns", () => {
    // The data-model.md 4-column shape is the normative DATA source but
    // not this document's shape; it must not be picked up as one.
    expect(() => parseDispositionTables(FOUR_COLUMN_DOC)).toThrow(
      /no disposition table found/,
    );
  });

  it("fails when a disposition header is not followed by a separator row", () => {
    const doc = [
      "| Type | Tier | Disposition | TypeScript mapping | Rationale |",
      "| ReturnValue | P0 | strict | `return <expr>` | |",
    ].join("\n");
    expect(() => parseDispositionTables(doc)).toThrow(
      /header at line 1 is not followed by a separator row/,
    );
  });

  it("fails on a data row with the wrong cell count", () => {
    const doc = [
      "| Type | Tier | Disposition | TypeScript mapping | Rationale |",
      "| --- | --- | --- | --- | --- |",
      "| ReturnValue | P0 | strict | missing cells |",
    ].join("\n");
    expect(() => parseDispositionTables(doc)).toThrow(
      /malformed disposition row at line 3: expected 5 cells, found 4/,
    );
  });
});

// ---------------------------------------------------------------------------
// Conformance — the real document, asserted against the taxonomy exports.
// ---------------------------------------------------------------------------

const CANONICAL_NAMES: ReadonlySet<string> = new Set(SIDE_EFFECT_TYPES);

// Own-key tier view of TIER_MAP for looking up arbitrary row strings.
// Map lookups never consult the prototype chain (mirrors the pattern
// src/taxonomy.ts uses for ALIAS_TARGETS); unknown names yield undefined.
const TIER_BY_NAME: ReadonlyMap<string, Tier> = new Map(Object.entries(TIER_MAP));

// The mechanical tier→disposition mapping (FR-030).
const TIER_DISPOSITION: Readonly<Record<Tier, string>> = {
  P0: "strict",
  P1: "must",
  P2: "partial",
  P3: "best-effort",
  P4: "best-effort",
};

const CLOSED_SET: readonly string[] = [
  "strict",
  "must",
  "partial",
  "best-effort",
  "N/A",
];

// The seven normative N/A rows, transcribed from the disposition TABLES
// in specs/002-analysis-engine/data-model.md (the row-level normative
// source). Pinned individually, never as a count — see the file header.
const NORMATIVE_NA_ROWS: readonly string[] = [
  "Panic",
  "MutexOp",
  "WaitGroupOp",
  "RecoverBehavior",
  "ReflectionMutation",
  "UnsafeMutation",
  "SyncPoolOp",
];

// Placeholder strings that carry no detect mapping. A P1 row's mapping
// cell must be non-empty and not one of these (FR-030: P1 is
// must-detect, so a P1 row cannot carry a "none" placeholder where a
// mapping is owed).
const NONE_SENTINELS: ReadonlySet<string> = new Set(["N/A", "n/a", "none", "—", "-"]);

function groupRowsByType(
  rows: readonly DispositionRow[],
): Map<string, DispositionRow[]> {
  const byType = new Map<string, DispositionRow[]>();
  for (const row of rows) {
    const bucket = byType.get(row.type);
    if (bucket === undefined) {
      byType.set(row.type, [row]);
    } else {
      bucket.push(row);
    }
  }
  return byType;
}

describe("docs/effect-disposition.md (FR-030 disposition table)", () => {
  const byType = groupRowsByType(ROWS);
  const canonicalRows = ROWS.filter((row) => CANONICAL_NAMES.has(row.type));

  it("contains only canonical taxonomy names (no unknown rows)", () => {
    const unknown = ROWS.filter((row) => !CANONICAL_NAMES.has(row.type)).map(
      (row) => `${row.type} (line ${row.line})`,
    );
    expect(
      unknown,
      "the table must cover exactly the canonical names from src/taxonomy.ts; unknown rows: " +
        `${unknown.join(", ")}`,
    ).toEqual([]);
  });

  it("covers every canonical taxonomy name exactly once (no gaps, no duplicates)", () => {
    const missing = SIDE_EFFECT_TYPES.filter((type) => !byType.has(type));
    const duplicated = SIDE_EFFECT_TYPES.filter(
      (type) => (byType.get(type)?.length ?? 0) > 1,
    );
    expect(
      { duplicated, missing },
      "every name in SIDE_EFFECT_TYPES must appear exactly once; adding or " +
        "removing a taxonomy type must fail here with that type's name",
    ).toEqual({ duplicated: [], missing: [] });
  });

  it("records dispositions from the closed set only", () => {
    const offenders = ROWS.filter((row) => !CLOSED_SET.includes(row.disposition)).map(
      (row) => `${row.type} (line ${row.line}): "${row.disposition}"`,
    );
    expect(
      offenders,
      "dispositions must come from {strict, must, partial, best-effort, N/A}",
    ).toEqual([]);
  });

  it("records the taxonomy tier assignment for every canonical row", () => {
    const offenders = canonicalRows
      .filter((row) => row.tier !== TIER_BY_NAME.get(row.type))
      .map(
        (row) =>
          `${row.type} (line ${row.line}): tier "${row.tier}", expected ` +
          `"${TIER_BY_NAME.get(row.type) ?? "?"}"`,
      );
    expect(
      offenders,
      "the Tier column must match TIER_MAP from src/taxonomy.ts",
    ).toEqual([]);
  });

  it("assigns every non-N/A row its mechanical tier disposition", () => {
    const offenders = canonicalRows
      .filter((row) => {
        const tier = TIER_BY_NAME.get(row.type);
        return (
          row.disposition !== "N/A" &&
          tier !== undefined &&
          row.disposition !== TIER_DISPOSITION[tier]
        );
      })
      .map((row) => `${row.type} (line ${row.line}): "${row.disposition}"`);
    expect(
      offenders,
      "P0→strict, P1→must, P2→partial, P3/P4→best-effort, except N/A rows",
    ).toEqual([]);
  });

  it("reserves N/A for the seven normative rows", () => {
    const offenders = canonicalRows
      .filter(
        (row) => row.disposition === "N/A" && !NORMATIVE_NA_ROWS.includes(row.type),
      )
      .map((row) => `${row.type} (line ${row.line})`);
    expect(
      offenders,
      "only the data-model.md table's N/A rows may carry N/A; every other " +
        "row follows the mechanical tier mapping",
    ).toEqual([]);
  });

  it.each(NORMATIVE_NA_ROWS)(
    "%s is N/A with non-empty rationale (normative from the data-model tables)",
    (type) => {
      const row = byType.get(type)?.[0];
      expect(row, `${type} must appear in the disposition table`).toBeDefined();
      if (row === undefined) {
        return;
      }
      expect(row.disposition, `${type} is one of the seven normative N/A rows`).toBe(
        "N/A",
      );
      expect(row.rationale, `${type} must carry non-empty N/A rationale`).not.toBe("");
    },
  );

  it("carries non-empty rationale on every N/A row", () => {
    const offenders = ROWS.filter(
      (row) => row.disposition === "N/A" && row.rationale === "",
    ).map((row) => `${row.type} (line ${row.line})`);
    expect(
      offenders,
      "FR-030: every N/A row carries non-empty rationale (checked for any " +
        "N/A row, not just the seven normative ones)",
    ).toEqual([]);
  });

  it("never assigns N/A to a P1 row", () => {
    const offenders = canonicalRows
      .filter((row) => TIER_BY_NAME.get(row.type) === "P1" && row.disposition === "N/A")
      .map((row) => `${row.type} (line ${row.line})`);
    expect(offenders, "P1 is must-detect; N/A is not available at P1 (FR-030)").toEqual(
      [],
    );
  });

  it("carries a detect mapping on every P1 row", () => {
    const offenders = canonicalRows
      .filter((row) => TIER_BY_NAME.get(row.type) === "P1")
      .filter((row) => row.mapping === "" || NONE_SENTINELS.has(row.mapping))
      .map((row) => `${row.type} (line ${row.line}): mapping "${row.mapping}"`);
    expect(
      offenders,
      "every P1 row must carry a detect mapping (FR-030: P1 is must-detect)",
    ).toEqual([]);
  });
});
