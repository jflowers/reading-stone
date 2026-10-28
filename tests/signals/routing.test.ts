/**
 * Routing-table conformance suite (T003, FR-007; research R2; data-model.md
 * Section 6).
 *
 * src/signals/routing.ts (T005) holds the normative effect-type routing
 * table: for each of the 48 canonical taxonomy types, the naming prefixes
 * and documentation vocabulary that AGREE with it. This suite conforms the
 * table to its two normative sources so neither can drift:
 *
 * - the closed FR-005/FR-006 vocabularies — 18 contractual + 4 incidental
 *   prefixes, 2 direct tags, 9 indirect + 4 incidental verbs — no other
 *   token may appear in any row, and
 * - the 48-row table in specs/003-classify-signals/data-model.md Section 6,
 *   parsed here and diffed row by row and column by column against the code
 *   table (the tests/disposition.test.ts parse-the-document anti-drift
 *   pattern: when a prose document restates normative code data, a test
 *   parses the document so the prose cannot drift).
 *
 * Exhaustiveness is layered: the `Readonly<Record<SideEffectType,
 * RoutingBranch>>` shape already makes key totality compile-time (a missing,
 * extra, or misspelled row cannot build); this suite asserts the runtime
 * mirror — the table's own keys are exactly `SIDE_EFFECT_TYPES` — and
 * derives every expectation from the taxonomy exports, so no row count is
 * pinned: adding or removing a taxonomy type fails with that type's name.
 *
 * The document is repo content, not untrusted analysis input (Constitution
 * Principle V does not apply to it); it is read once at module scope. If it
 * is absent or structurally drifted, the whole file fails during collection
 * — 0 tests passing, the failure being the document itself.
 *
 * The committed suite IS the contract the data-model table must satisfy.
 * Parsing contract for specs/003-classify-signals/data-model.md:
 *
 * FORMAT
 * - Markdown: GFM pipe tables. A routing table is recognized by its header
 *   row, which must parse (after cell normalization, below) to exactly
 *   these six cells, in this order, case-sensitive:
 *       Effect type | Contractual prefixes | Incidental prefixes | Direct tags | Indirect verbs | Incidental verbs
 *   Leading and trailing `|` on any row are optional.
 * - The header row must be followed by a separator row: every cell is
 *   dashes (at least one) with optional surrounding colons (`------`,
 *   `:---`, `---:`).
 * - Every subsequent line that contains a `|` is a data row. A table ends
 *   at the first line without a `|` (blank line, heading, paragraph).
 * - Each data row must have exactly 6 cells; any other cell count fails
 *   the parse with the offending line number.
 * - Cells are split on `|` characters not preceded by a backslash; `\|`
 *   unescapes to a literal pipe. Each cell is trimmed, then one pair of
 *   surrounding backticks is stripped (`` `@returns` `` becomes @returns),
 *   so single-code-span cells render either way; inner code spans are
 *   untouched.
 * - Each of the five vocabulary cells holds either the none mark `—` (em
 *   dash — an empty list) or a comma-separated token list, each token
 *   trimmed. An empty vocabulary cell fails the parse: the document
 *   renders `—`, never a blank. Token membership in the closed lists is
 *   NOT a parse rule — the doc-parity diff against the code table (whose
 *   own vocabulary is closed-list-checked below) rejects any junk token
 *   with a row diff naming the column.
 * - Multiple routing tables are allowed; their rows are concatenated in
 *   document order. Tables whose header does not match exactly — different
 *   columns, order, or names — are ignored (the field tables elsewhere in
 *   data-model.md are data sources, not this shape).
 * - A document containing no routing table fails the parse.
 *
 * THE ERR SENTINEL MARKER
 * - data-model.md Section 6 documents the `Err` + `SentinelError` special
 *   case (+30, in place of the prefix rules) with the exact cell text
 *   `Err special case only` in the SentinelError row's Contractual
 *   prefixes column. The parser recognizes that exact cell — in the
 *   Contractual prefixes column only — as a marker: an empty prefix list
 *   plus a row flag. The special case is NOT table data: the +30 rule is a
 *   naming-extractor rule (research R3; src/signals/naming.ts,
 *   behaviorally pinned by tests/signals/naming.test.ts, T014), so this
 *   suite requires the marker on exactly the SentinelError row, requires
 *   the code table's SentinelError row to carry no naming vocabulary, and
 *   treats the marker text in any other column as an ordinary token (which
 *   parity then rejects). "Err" is in no closed list, so the vocabulary
 *   checks already forbid it as table data in every row.
 *
 * HOW ROWS MAP TO ASSERTIONS
 * - Effect type cell → must be a canonical name from SIDE_EFFECT_TYPES.
 *   Unknown names, missing canonical names, and duplicated canonical names
 *   each fail with a specific diff.
 * - Contractual prefixes cell → `ROUTING_TABLE[type].naming`, exactly.
 * - Direct tags cell → `docTags`. Indirect verbs cell → `docIndirect`.
 * - Incidental prefixes + Incidental verbs cells → `docIncidental`, which
 *   holds the prefixes then the verbs, in order (RoutingBranch merges the
 *   two incidental columns; the token sets are disjoint).
 * - Every diff is order-exact: routing.ts renders each row's vocabulary in
 *   pinned closed-list order precisely so this diff is exact, order
 *   included.
 */

import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  CONTRACTUAL_PREFIXES,
  DIRECT_TAGS,
  INCIDENTAL_PREFIXES,
  INCIDENTAL_VERBS,
  INDIRECT_VERBS,
  ROUTING_TABLE,
  type RoutingBranch,
} from "../../src/signals/routing.js";
import { SIDE_EFFECT_TYPES } from "../../src/taxonomy.js";

// ---------------------------------------------------------------------------
// Pinned closed vocabularies (FR-005/FR-006), transcribed verbatim from
// data-model.md Section 6's closing vocabulary list. Pinned here — NOT
// imported from src/signals/routing.ts — so this suite conforms the code
// table and its exported lists to the spec, never the reverse: a drifted
// constant fails loudly instead of silently widening what the table may
// draw from (the NORMATIVE_NA_ROWS stance of tests/disposition.test.ts).
// ---------------------------------------------------------------------------

const PINNED_CONTRACTUAL_PREFIXES: readonly string[] = [
  "Get",
  "Fetch",
  "Load",
  "Read",
  "Save",
  "Write",
  "Update",
  "Set",
  "Delete",
  "Remove",
  "Handle",
  "Process",
  "Compute",
  "Analyze",
  "Classify",
  "Parse",
  "Build",
  "New",
];

const PINNED_INCIDENTAL_PREFIXES: readonly string[] = [
  "log",
  "debug",
  "trace",
  "print",
];

const PINNED_DIRECT_TAGS: readonly string[] = ["@returns", "@throws"];

const PINNED_INDIRECT_VERBS: readonly string[] = [
  "returns",
  "writes",
  "modifies",
  "updates",
  "sets",
  "persists",
  "stores",
  "deletes",
  "removes",
];

const PINNED_INCIDENTAL_VERBS: readonly string[] = [
  "logs",
  "prints",
  "traces",
  "debugs",
];

// Membership sets derived from the pinned lists (own data only — Set
// lookups never consult the prototype chain, the taxonomy.ts stance).
const CONTRACTUAL_PREFIX_VOCABULARY: ReadonlySet<string> = new Set(
  PINNED_CONTRACTUAL_PREFIXES,
);
const DIRECT_TAG_VOCABULARY: ReadonlySet<string> = new Set(PINNED_DIRECT_TAGS);
const INDIRECT_VERB_VOCABULARY: ReadonlySet<string> = new Set(PINNED_INDIRECT_VERBS);
// RoutingBranch.docIncidental merges the incidental prefixes and verbs, so
// its closed vocabulary is the union of the two (disjoint) token sets.
const INCIDENTAL_VOCABULARY: ReadonlySet<string> = new Set([
  ...PINNED_INCIDENTAL_PREFIXES,
  ...PINNED_INCIDENTAL_VERBS,
]);

/**
 * One code-table column and the closed vocabulary its tokens may draw
 * from. The field names index `RoutingBranch` directly, so a renamed field
 * cannot compile here — the suite stays locked to the code table's shape.
 */
interface ColumnVocabulary {
  readonly field: keyof RoutingBranch;
  readonly allowed: ReadonlySet<string>;
  readonly label: string;
}

const COLUMN_VOCABULARIES: readonly ColumnVocabulary[] = [
  {
    field: "naming",
    allowed: CONTRACTUAL_PREFIX_VOCABULARY,
    label: "contractual-prefix",
  },
  { field: "docTags", allowed: DIRECT_TAG_VOCABULARY, label: "direct-tag" },
  {
    field: "docIndirect",
    allowed: INDIRECT_VERB_VOCABULARY,
    label: "indirect-verb",
  },
  {
    field: "docIncidental",
    allowed: INCIDENTAL_VOCABULARY,
    label: "incidental prefix-or-verb",
  },
];

/**
 * One parsed data row of data-model.md Section 6. Deliberately plain
 * strings and string arrays, not `RoutingBranch`: this suite conforms the
 * document to the code table, so it must not share the code table's shape
 * (same stance as tests/disposition.test.ts). The five vocabulary columns
 * stay separate — `RoutingBranch` merges the two incidental columns, and
 * that merge is itself one of the things parity asserts. `line` is the
 * 1-based source line, carried so assertion failures name the exact row
 * to fix.
 */
interface RoutingRow {
  readonly type: string;
  readonly contractualPrefixes: readonly string[];
  readonly incidentalPrefixes: readonly string[];
  readonly directTags: readonly string[];
  readonly indirectVerbs: readonly string[];
  readonly incidentalVerbs: readonly string[];
  readonly sentinelSpecialCase: boolean;
  readonly line: number;
}

/** The exact header cells a routing table must carry, in order. */
const HEADER_CELLS: readonly string[] = [
  "Effect type",
  "Contractual prefixes",
  "Incidental prefixes",
  "Direct tags",
  "Indirect verbs",
  "Incidental verbs",
];

/**
 * The none mark data-model.md renders in vocabulary cells with no tokens —
 * an em dash (U+2014), not a hyphen.
 */
const NONE_MARK = "—";

/**
 * The exact contractual-prefixes cell text that documents the
 * `Err` + `SentinelError` special case. Recognized only in that column; see
 * the file header's ERR SENTINEL MARKER section.
 */
const SENTINEL_MARK = "Err special case only";

/**
 * Normalizes one raw table cell: unescape `\|` to a literal pipe, trim
 * whitespace, then strip one pair of surrounding backticks so cells may be
 * rendered as single code spans (`` `@returns` ``). Inner code spans are
 * untouched — only a backtick pair wrapping the whole cell is stripped.
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

/** Reports whether the line is a routing-table header row. */
function isRoutingHeader(line: string): boolean {
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
 * Parses one vocabulary cell: the none mark `—` is an empty list; any other
 * non-empty cell is a comma-separated token list with each token trimmed.
 * Token membership in the closed lists is deliberately NOT checked here —
 * the doc-parity diff rejects junk tokens with a row diff.
 *
 * @param cell The normalized cell text.
 * @param line The 1-based source line, for the failure message.
 * @returns The cell's token list.
 * @throws When the cell is empty (the document renders `—`, never blank).
 */
function parseVocabularyCell(cell: string, line: number): string[] {
  if (cell === NONE_MARK) {
    return [];
  }
  if (cell === "") {
    throw new Error(
      `empty vocabulary cell at line ${line}: render "—" (em dash) for no vocabulary, never a blank cell`,
    );
  }
  return cell.split(",").map((token) => token.trim());
}

/**
 * Parses every routing table in the document, in document order. Pure:
 * takes markdown text, returns rows, performs no I/O — the file read lives
 * at module scope so a missing or structurally drifted document fails the
 * whole file during collection.
 *
 * Strict by design: a recognizable header without a separator row, a data
 * row with a cell count other than 6, or an empty vocabulary cell throws
 * with the offending line number. A normative document should fail loudly
 * on structural drift, not surface it as a confusing content diff
 * downstream.
 *
 * @param markdown The full text of data-model.md.
 * @returns Every data row of every routing table found.
 * @throws When no routing table exists, a header lacks its separator row,
 * a data row has the wrong cell count, or a vocabulary cell is blank.
 */
function parseRoutingTables(markdown: string): RoutingRow[] {
  const lines = markdown.split("\n");
  const rows: RoutingRow[] = [];
  let lineIndex = 0;
  let tableFound = false;

  while (lineIndex < lines.length) {
    if (!isRoutingHeader(lines[lineIndex] ?? "")) {
      lineIndex += 1;
      continue;
    }
    tableFound = true;
    if (lineIndex + 1 >= lines.length || !isSeparatorRow(lines[lineIndex + 1] ?? "")) {
      throw new Error(
        `routing table header at line ${lineIndex + 1} is not followed by a separator row (cells of dashes with optional colons)`,
      );
    }
    let body = lineIndex + 2;
    while (body < lines.length && (lines[body] ?? "").includes("|")) {
      const cells = splitRowCells(lines[body] ?? "");
      if (cells.length !== HEADER_CELLS.length) {
        throw new Error(
          `malformed routing row at line ${body + 1}: expected ${HEADER_CELLS.length} cells, found ${cells.length}`,
        );
      }
      const [
        type,
        contractual,
        incidentalPrefixes,
        directTags,
        indirectVerbs,
        incidentalVerbs,
      ] = cells as [string, string, string, string, string, string];
      const sentinelSpecialCase = contractual === SENTINEL_MARK;
      rows.push({
        type,
        contractualPrefixes: sentinelSpecialCase
          ? []
          : parseVocabularyCell(contractual, body + 1),
        incidentalPrefixes: parseVocabularyCell(incidentalPrefixes, body + 1),
        directTags: parseVocabularyCell(directTags, body + 1),
        indirectVerbs: parseVocabularyCell(indirectVerbs, body + 1),
        incidentalVerbs: parseVocabularyCell(incidentalVerbs, body + 1),
        sentinelSpecialCase,
        line: body + 1,
      });
      body += 1;
    }
    lineIndex = body;
  }

  if (!tableFound) {
    throw new Error(
      'no routing table found: expected a header row "| Effect type | Contractual prefixes | Incidental prefixes | Direct tags | Indirect verbs | Incidental verbs |" followed by a separator row',
    );
  }
  return rows;
}

const DOCUMENT_URL = new URL(
  "../../specs/003-classify-signals/data-model.md",
  import.meta.url,
);

/**
 * Reads the data model. Throws — rather than returning a sentinel — when it
 * is absent, so a missing document is an explicit, self-describing failure
 * during collection.
 */
function readDataModel(url: URL): string {
  if (!existsSync(url)) {
    throw new Error(
      "specs/003-classify-signals/data-model.md does not exist: it is the normative source (Section 6) of the routing table this suite conforms src/signals/routing.ts against, per the parsing contract documented in this file's header. No test in this file can pass without it.",
    );
  }
  return readFileSync(url, "utf8");
}

// Module-scope read + parse: a missing or structurally drifted document is
// the whole file failing during collection (0 tests passing).
const ROWS: readonly RoutingRow[] = parseRoutingTables(readDataModel(DOCUMENT_URL));

// ---------------------------------------------------------------------------
// Parser contract — inline fixtures. These lock the format rules the
// data-model table is parsed under; they use synthetic documents, not the
// real one.
// ---------------------------------------------------------------------------

const MINIMAL_DOC: string = [
  "# Routing",
  "",
  "| Effect type | Contractual prefixes | Incidental prefixes | Direct tags | Indirect verbs | Incidental verbs |",
  "|------|------|------|------|------|------|",
  "| `ReturnValue` | Get, Read | — | `@returns` | returns | — |",
  "StdoutWrite | Write | log, print | — | writes | logs, debugs",
  "",
  "Paragraph after the table.",
].join("\n");

const TWO_TABLE_DOC: string = [
  "# Routing",
  "",
  "| Effect type | Contractual prefixes | Incidental prefixes | Direct tags | Indirect verbs | Incidental verbs |",
  "| --- | --- | --- | --- | --- | --- |",
  "| ReturnValue | Get | — | — | — | — |",
  "",
  "## Second section",
  "",
  "| Effect type | Contractual prefixes | Incidental prefixes | Direct tags | Indirect verbs | Incidental verbs |",
  "| --- | --- | --- | --- | --- | --- |",
  "| StdoutWrite | Write | log | — | writes | logs |",
  "",
  "Trailing text.",
].join("\n");

// The 4-column field-table shape used elsewhere in data-model.md (Section
// 5.1) is a data source but NOT the routing table's shape; it must not be
// picked up as one.
const FIELD_TABLE_DOC: string = [
  "| Field | Type | Mode | Contents |",
  "|------|------|------|----------|",
  "| record | ExtractionRecord | both | name, relPath |",
].join("\n");

describe("parseRoutingTables", () => {
  it("parses data rows with token lists, none marks, and 1-based line numbers", () => {
    const rows = parseRoutingTables(MINIMAL_DOC);
    expect(rows).toHaveLength(2);
    // Backticked cells strip to plain text; — cells parse to empty lists.
    expect(rows[0]).toEqual({
      type: "ReturnValue",
      contractualPrefixes: ["Get", "Read"],
      incidentalPrefixes: [],
      directTags: ["@returns"],
      indirectVerbs: ["returns"],
      incidentalVerbs: [],
      sentinelSpecialCase: false,
      line: 5,
    });
    // Line 6 omits the leading and trailing pipes — still a valid row.
    expect(rows[1]).toEqual({
      type: "StdoutWrite",
      contractualPrefixes: ["Write"],
      incidentalPrefixes: ["log", "print"],
      directTags: [],
      indirectVerbs: ["writes"],
      incidentalVerbs: ["logs", "debugs"],
      sentinelSpecialCase: false,
      line: 6,
    });
  });

  it("parses the Err special-case cell as an empty contractual list with the row flagged", () => {
    const doc = [
      "| Effect type | Contractual prefixes | Incidental prefixes | Direct tags | Indirect verbs | Incidental verbs |",
      "| --- | --- | --- | --- | --- | --- |",
      "| SentinelError | Err special case only | — | @throws | — | — |",
    ].join("\n");
    const rows = parseRoutingTables(doc);
    expect(rows[0]?.contractualPrefixes).toEqual([]);
    expect(rows[0]?.sentinelSpecialCase).toBe(true);
  });

  it("treats the Err marker text outside the Contractual prefixes column as an ordinary token", () => {
    // The marker is a Contractual-prefixes-column concept; anywhere else
    // the text is just a (junk) token that the doc-parity diff rejects —
    // the special case cannot leak into other columns' parsing.
    const doc = [
      "| Effect type | Contractual prefixes | Incidental prefixes | Direct tags | Indirect verbs | Incidental verbs |",
      "| --- | --- | --- | --- | --- | --- |",
      "| ErrorReturn | — | — | Err special case only | — | — |",
    ].join("\n");
    const rows = parseRoutingTables(doc);
    expect(rows[0]?.sentinelSpecialCase).toBe(false);
    expect(rows[0]?.directTags).toEqual(["Err special case only"]);
  });

  it("concatenates rows across multiple tables in document order", () => {
    const rows = parseRoutingTables(TWO_TABLE_DOC);
    expect(rows.map((row) => row.type)).toEqual(["ReturnValue", "StdoutWrite"]);
    expect(rows.map((row) => row.line)).toEqual([5, 11]);
  });

  it("unescapes \\| to a literal pipe inside cells", () => {
    const doc = [
      "| Effect type | Contractual prefixes | Incidental prefixes | Direct tags | Indirect verbs | Incidental verbs |",
      "| --- | --- | --- | --- | --- | --- |",
      "| LeftRight | Get \\| Fetch | — | — | — | — |",
    ].join("\n");
    const rows = parseRoutingTables(doc);
    expect(rows[0]?.contractualPrefixes).toEqual(["Get | Fetch"]);
  });

  it("fails when the document contains no routing table", () => {
    expect(() => parseRoutingTables("# Only prose\n\nNo tables here.")).toThrow(
      /no routing table found/,
    );
  });

  it("ignores tables whose header does not match the six canonical columns", () => {
    expect(() => parseRoutingTables(FIELD_TABLE_DOC)).toThrow(/no routing table found/);
  });

  it("fails when a routing header is not followed by a separator row", () => {
    const doc = [
      "| Effect type | Contractual prefixes | Incidental prefixes | Direct tags | Indirect verbs | Incidental verbs |",
      "| ReturnValue | Get | — | — | — | — |",
    ].join("\n");
    expect(() => parseRoutingTables(doc)).toThrow(
      /header at line 1 is not followed by a separator row/,
    );
  });

  it("fails on a data row with the wrong cell count", () => {
    const doc = [
      "| Effect type | Contractual prefixes | Incidental prefixes | Direct tags | Indirect verbs | Incidental verbs |",
      "| --- | --- | --- | --- | --- | --- |",
      "| ReturnValue | Get | — | — | — |",
    ].join("\n");
    expect(() => parseRoutingTables(doc)).toThrow(
      /malformed routing row at line 3: expected 6 cells, found 5/,
    );
  });

  it("fails on an empty vocabulary cell", () => {
    const doc = [
      "| Effect type | Contractual prefixes | Incidental prefixes | Direct tags | Indirect verbs | Incidental verbs |",
      "| --- | --- | --- | --- | --- | --- |",
      "| ChannelClose | | — | — | — | — |",
    ].join("\n");
    expect(() => parseRoutingTables(doc)).toThrow(/empty vocabulary cell at line 3/);
  });
});

// ---------------------------------------------------------------------------
// Closed vocabulary exports — the extractor-facing constants conform to the
// pinned lists, so a drifted constant fails here instead of silently
// widening what the table (and the naming/documentation extractors) match.
// ---------------------------------------------------------------------------

describe("closed vocabulary exports (FR-005/FR-006)", () => {
  it.each([
    {
      name: "CONTRACTUAL_PREFIXES",
      exported: CONTRACTUAL_PREFIXES,
      pinned: PINNED_CONTRACTUAL_PREFIXES,
    },
    {
      name: "INCIDENTAL_PREFIXES",
      exported: INCIDENTAL_PREFIXES,
      pinned: PINNED_INCIDENTAL_PREFIXES,
    },
    {
      name: "DIRECT_TAGS",
      exported: DIRECT_TAGS,
      pinned: PINNED_DIRECT_TAGS,
    },
    {
      name: "INDIRECT_VERBS",
      exported: INDIRECT_VERBS,
      pinned: PINNED_INDIRECT_VERBS,
    },
    {
      name: "INCIDENTAL_VERBS",
      exported: INCIDENTAL_VERBS,
      pinned: PINNED_INCIDENTAL_VERBS,
    },
  ])(
    "$name transcribes the pinned closed list, order included",
    ({ exported, pinned }) => {
      expect(exported).toEqual(pinned);
    },
  );
});

// ---------------------------------------------------------------------------
// Code-table conformance — ROUTING_TABLE asserted against the taxonomy
// exports and the closed vocabularies.
// ---------------------------------------------------------------------------

const CANONICAL_NAMES: ReadonlySet<string> = new Set(SIDE_EFFECT_TYPES);

// Own-key view of ROUTING_TABLE. Object keys are inherently
// duplicate-free, so sets suffice: unknown and missing keys are each a
// specific diff, and a count is never pinned.
const CODE_KEYS: ReadonlySet<string> = new Set(Object.keys(ROUTING_TABLE));

describe("ROUTING_TABLE (FR-007)", () => {
  it("is keyed by exactly the canonical taxonomy types (no gaps, no unknown rows)", () => {
    const unknown = Object.keys(ROUTING_TABLE).filter(
      (key) => !CANONICAL_NAMES.has(key),
    );
    const missing = SIDE_EFFECT_TYPES.filter((type) => !CODE_KEYS.has(type));
    expect(
      { unknown, missing },
      "the table's own keys must be exactly SIDE_EFFECT_TYPES from src/taxonomy.ts — " +
        "the Readonly<Record<SideEffectType, RoutingBranch>> shape already makes this " +
        "compile-time, and this is its runtime mirror: adding or removing a taxonomy " +
        "type must fail here with that type's name",
    ).toEqual({ unknown: [], missing: [] });
  });

  it("draws every row's vocabulary from the column-appropriate closed lists", () => {
    const offenders: string[] = [];
    for (const type of SIDE_EFFECT_TYPES) {
      const branch = ROUTING_TABLE[type];
      for (const column of COLUMN_VOCABULARIES) {
        for (const token of branch[column.field]) {
          if (!column.allowed.has(token)) {
            offenders.push(
              `${type}.${column.field}: "${token}" is not a closed ${column.label}`,
            );
          }
        }
      }
    }
    expect(
      offenders,
      "FR-007: no token outside the FR-005/FR-006 closed lists — 18 contractual " +
        "prefixes, 4 incidental prefixes, 2 direct tags, 9 indirect verbs, 4 incidental " +
        "verbs — may appear in any row",
    ).toEqual([]);
  });

  it("routes SentinelError to no prefix — the Err special case is extractor rule, not table data", () => {
    // The +30 Err+SentinelError rule (research R3) replaces the prefix
    // rules inside the naming extractor (src/signals/naming.ts, T022; its
    // behavioral pin is tests/signals/naming.test.ts, T014). This suite
    // pins the table's side of that boundary: the special case is never
    // stored as vocabulary — SentinelError's naming list is empty, and
    // "Err" is in no closed list, so the check above already forbids it in
    // every row.
    expect(ROUTING_TABLE.SentinelError.naming).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Doc parity — the real document's Section 6 table, asserted against the
// code table so the prose cannot drift.
// ---------------------------------------------------------------------------

function groupRowsByType(rows: readonly RoutingRow[]): Map<string, RoutingRow[]> {
  const byType = new Map<string, RoutingRow[]>();
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

describe("data-model.md Section 6 (FR-007 routing table)", () => {
  const byType = groupRowsByType(ROWS);

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

  it("marks the Err special case on exactly the SentinelError row", () => {
    const flagged = ROWS.filter((row) => row.sentinelSpecialCase);
    expect(
      flagged.map((row) => row.type),
      "data-model.md Section 6 documents the Err+SentinelError special case with the " +
        'exact cell "Err special case only" in the SentinelError row\'s Contractual ' +
        "prefixes column — exactly one row may carry it, and never as vocabulary. " +
        `Flagged rows: ${
          flagged.map((row) => `${row.type} (line ${row.line})`).join(", ") || "none"
        }`,
    ).toEqual(["SentinelError"]);
  });

  it.each([...SIDE_EFFECT_TYPES])(
    "%s: all five vocabulary columns match the code table",
    (type) => {
      // The bucket holds every row parsed for the type; the exactly-once
      // test above pins that bucket to one row, and this takes it.
      const row = byType.get(type)?.[0];
      expect(row, `${type} must appear in the Section 6 routing table`).toBeDefined();
      if (row === undefined) {
        return;
      }
      const branch = ROUTING_TABLE[type];
      expect(
        branch.naming,
        `${type} (line ${row.line}): Contractual prefixes column`,
      ).toEqual(row.contractualPrefixes);
      expect(branch.docTags, `${type} (line ${row.line}): Direct tags column`).toEqual(
        row.directTags,
      );
      expect(
        branch.docIndirect,
        `${type} (line ${row.line}): Indirect verbs column`,
      ).toEqual(row.indirectVerbs);
      expect(
        branch.docIncidental,
        `${type} (line ${row.line}): Incidental prefixes column then Incidental ` +
          "verbs column, merged in order",
      ).toEqual([...row.incidentalPrefixes, ...row.incidentalVerbs]);
    },
  );
});
