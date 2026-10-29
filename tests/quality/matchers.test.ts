/**
 * The matcher-table conformance suite (T004, FR-007/FR-008; research R6;
 * data-model Section 4 — the tests/disposition.test.ts anti-drift
 * pattern). Two jobs, mirroring tests/disposition.test.ts's split:
 *
 * 1. Behavioral pins — the classification functions in
 *    src/quality/matchers.ts route every enumerated matcher and
 *    node:assert form to its pinned kind, apply the chain-modifier rule
 *    (`.not.`/`.resolves.` preserve, `.rejects.` reroutes to
 *    `error_check`, other intermediate properties inert), and route every
 *    miss to `""` — never an exception, never a drop (US3-6).
 * 2. Doc parity — specs/004-test-mapping/data-model.md's Section 4
 *    tables are parsed and diffed row-for-row against the module, so the
 *    normative prose cannot drift from the shipped table. The document
 *    is repo content, not untrusted analysis input (Constitution
 *    Principle V does not apply to it); it is read once at module scope.
 *
 * RED STATE (TDD task ordering): T004 precedes T007
 * (src/quality/matchers.ts). While the module is absent this file fails
 * during collection — 0 tests passing, the failure being the missing
 * module import itself. No test in this file can pass until the table
 * exists.
 *
 * Parsing contract for specs/004-test-mapping/data-model.md Section 4:
 *
 * FORMAT
 * - Markdown: GFM pipe tables. The Section 4.1 matcher table is
 *   recognized by a header row that parses to exactly `Matcher | Kind`;
 *   the Section 4.2 assert table by exactly `Assert form | Kind`. Other
 *   two-column tables in the document (Section 3's `Kind | Denotation`,
 *   Section 4.1's `Chain modifier | Effect`, Section 7's `Pass | Rule`)
 *   have different headers and are ignored.
 * - The header row must be followed by a separator row (dash cells with
 *   optional surrounding colons). Every subsequent line containing `|`
 *   is a data row; a table ends at the first line without one.
 * - Each data row must have exactly 2 cells; any other count fails the
 *   parse with the offending line number.
 * - Cells are split on `|` characters not preceded by a backslash, then
 *   trimmed with ALL backtick characters removed — unlike
 *   disposition.test.ts's surrounding-pair strip, these cells carry code
 *   spans around EACH side of a ` / `-separated form list
 *   (`` `assert.equal` / `assert.notEqual` ``), so a whole-cell strip
 *   would mangle the middle.
 *
 * HOW CELLS MAP TO ASSERTIONS
 * - Kind cell: one trailing parenthesized annotation is stripped
 *   (`(legacy jest alias)`, `(vitest)`), and the literal `""` maps to
 *   the empty string — the unclassified kind's wire spelling.
 * - Matcher cell (4.1): the matcher name verbatim.
 * - Assert-form cell (4.2): split on ` / ` into forms; each form's
 *   trailing `(bare)` annotation is stripped; `assert(value)` marks the
 *   memberless bare-call form, and every other form must be
 *   `assert.<member>` (its member name is the module key).
 */

import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  ASSERT_FUNCTION_KINDS,
  classifyAssertCall,
  classifyExpectChain,
  EXPECT_MATCHER_KINDS,
} from "../../src/quality/matchers.js";

// ---------------------------------------------------------------------------
// Pinned classification lists (data-model Section 4.1, transcribed) —
// the behavioral half's expected values, independent of the doc parse.
// ---------------------------------------------------------------------------

/** The 14 equality matchers: five value forms, six with-args mock forms, three legacy jest aliases. */
const EQUALITY_MATCHERS: readonly string[] = [
  "toBe",
  "toEqual",
  "toStrictEqual",
  "toBeCloseTo",
  "toMatchObject",
  "toHaveBeenCalledWith",
  "toHaveBeenLastCalledWith",
  "toHaveBeenNthCalledWith",
  "toHaveReturnedWith",
  "toHaveLastReturnedWith",
  "toHaveNthReturnedWith",
  "toBeCalledWith",
  "lastCalledWith",
  "nthCalledWith",
];

/** The 4 comparison matchers — ordered relations only. */
const COMPARISON_MATCHERS: readonly string[] = [
  "toBeGreaterThan",
  "toBeGreaterThanOrEqual",
  "toBeLessThan",
  "toBeLessThanOrEqual",
];

/** The 3 membership matchers — containment and pattern matching. */
const MEMBERSHIP_MATCHERS: readonly string[] = [
  "toContain",
  "toContainEqual",
  "toMatch",
];

/** The 4 error_check matchers. */
const ERROR_CHECK_MATCHERS: readonly string[] = [
  "toThrow",
  "toThrowError",
  "toThrowErrorMatchingSnapshot",
  "toThrowErrorMatchingInlineSnapshot",
];

/** The 19 `""`-routed forms: property, truthiness, occurrence, count, snapshot (and siblings). */
const UNCLASSIFIED_MATCHERS: readonly string[] = [
  "toBeTruthy",
  "toBeFalsy",
  "toBeNull",
  "toBeUndefined",
  "toBeDefined",
  "toBeNaN",
  "toBeInstanceOf",
  "toHaveBeenCalled",
  "toHaveBeenCalledTimes",
  "toHaveReturned",
  "toHaveReturnedTimes",
  "toBeCalled",
  "toBeCalledTimes",
  "toHaveProperty",
  "toHaveLength",
  "toMatchSnapshot",
  "toMatchInlineSnapshot",
  "toBeTypeOf",
  "toSatisfy",
];

// Section 4.2's named assert functions, transcribed.
const EQUALITY_ASSERTS: readonly string[] = [
  "equal",
  "notEqual",
  "strictEqual",
  "notStrictEqual",
  "deepEqual",
  "notDeepEqual",
  "deepStrictEqual",
  "notDeepStrictEqual",
];
const MEMBERSHIP_ASSERTS: readonly string[] = ["match", "doesNotMatch"];
const ERROR_CHECK_ASSERTS: readonly string[] = [
  "throws",
  "doesNotThrow",
  "rejects",
  "doesNotReject",
];
const UNCLASSIFIED_ASSERTS: readonly string[] = ["ok", "ifError", "fail"];

// ---------------------------------------------------------------------------
// Doc parser — module-private, mirroring tests/disposition.test.ts's
// strict-by-design stance: structural drift fails loudly with line
// numbers, never surfaces as a confusing content diff downstream.
// ---------------------------------------------------------------------------

/** One parsed Section 4.1 row. */
interface MatcherRow {
  readonly matcher: string;
  readonly kind: string;
  readonly line: number;
}

/** One parsed Section 4.2 row (one doc row may carry two ` / `-separated forms). */
interface AssertRow {
  readonly members: readonly string[];
  readonly bare: boolean;
  readonly kind: string;
  readonly line: number;
}

/** Normalizes one raw cell: unescape `\|`, remove backtick delimiters, trim. */
function normalizeCell(raw: string): string {
  return raw.replaceAll("\\|", "|").replaceAll("`", "").trim();
}

/** Splits one table line into normalized cells (leading/trailing `|` optional). */
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

/** Reports whether the line is a separator row (dash cells, optional colons). */
function isSeparatorRow(line: string): boolean {
  if (!line.includes("|")) {
    return false;
  }
  const cells = splitRowCells(line);
  return cells.length > 0 && cells.every((cell) => /^:?-+:?$/.test(cell));
}

/** Reports whether the line is a header row for the given exact cells, in order. */
function isHeaderRow(line: string, headerCells: readonly string[]): boolean {
  if (!line.includes("|")) {
    return false;
  }
  const cells = splitRowCells(line);
  return (
    cells.length === headerCells.length &&
    headerCells.every((name, index) => cells[index] === name)
  );
}

/** Parses the kind cell: strip one trailing annotation; `""` is the empty-string kind. */
function parseKindCell(cell: string): string {
  const kind = cell.replace(/\s*\([^)]*\)\s*$/, "").trim();
  return kind === '""' ? "" : kind;
}

/**
 * Collects every data row of every table whose header matches
 * `headerCells` exactly, in document order. Pure; strict.
 *
 * @param markdown The full document text.
 * @param headerCells The exact header cells identifying the target table.
 * @returns Each row's normalized cells with its 1-based source line.
 * @throws When a matching header lacks a separator row, a data row has a
 * cell count other than `headerCells.length`, or no matching table exists.
 */
function parseTableRows(
  markdown: string,
  headerCells: readonly string[],
): Array<{ cells: string[]; line: number }> {
  const lines = markdown.split("\n");
  const rows: Array<{ cells: string[]; line: number }> = [];
  let lineIndex = 0;
  let tableFound = false;
  while (lineIndex < lines.length) {
    if (!isHeaderRow(lines[lineIndex] ?? "", headerCells)) {
      lineIndex += 1;
      continue;
    }
    tableFound = true;
    const next = lines[lineIndex + 1] ?? "";
    if (lineIndex + 1 >= lines.length || !isSeparatorRow(next)) {
      throw new Error(
        `${headerCells.join(" | ")} table header at line ${lineIndex + 1} is not followed by a separator row`,
      );
    }
    let body = lineIndex + 2;
    while (body < lines.length && (lines[body] ?? "").includes("|")) {
      const cells = splitRowCells(lines[body] ?? "");
      if (cells.length !== headerCells.length) {
        throw new Error(
          `malformed ${headerCells.join(" | ")} row at line ${body + 1}: expected ` +
            `${headerCells.length} cells, found ${cells.length}`,
        );
      }
      rows.push({ cells, line: body + 1 });
      body += 1;
    }
    lineIndex = body;
  }
  if (!tableFound) {
    throw new Error(
      `no ${headerCells.join(" | ")} table found in specs/004-test-mapping/data-model.md Section 4`,
    );
  }
  return rows;
}

/** Parses every Section 4.1 matcher row: matcher name → kind. */
function parseMatcherTable(markdown: string): MatcherRow[] {
  return parseTableRows(markdown, ["Matcher", "Kind"]).map(({ cells, line }) => ({
    matcher: cells[0] ?? "",
    kind: parseKindCell(cells[1] ?? ""),
    line,
  }));
}

/** Parses every Section 4.2 assert row: ` / `-separated forms, `(bare)` stripped. */
function parseAssertTable(markdown: string): AssertRow[] {
  return parseTableRows(markdown, ["Assert form", "Kind"]).map(({ cells, line }) => {
    const kind = parseKindCell(cells[1] ?? "");
    const forms = (cells[0] ?? "")
      .split(" / ")
      .map((form) => form.trim())
      .map((form) => form.replace(/\s*\(bare\)\s*$/, ""))
      .filter((form) => form !== "");
    const bare = forms.includes("assert(value)");
    const members = forms
      .filter((form) => form !== "assert(value)")
      .map((form) => {
        if (!form.startsWith("assert.")) {
          throw new Error(`unrecognized assert form at line ${line}: "${form}"`);
        }
        return form.slice("assert.".length);
      });
    return { members, bare, kind, line };
  });
}

const DATA_MODEL_URL = new URL(
  "../../specs/004-test-mapping/data-model.md",
  import.meta.url,
);

/**
 * Reads the normative document. Throws — rather than returning a
 * sentinel — when it is absent, so a moved or renamed data model fails
 * the whole file during collection with a self-describing reason.
 */
function readDataModel(): string {
  if (!existsSync(DATA_MODEL_URL)) {
    throw new Error(
      "specs/004-test-mapping/data-model.md does not exist: T004's doc-parity suite diffs " +
        "src/quality/matchers.ts against its Section 4 tables, so the document is part of " +
        "this suite's contract. No test in this file can pass without it.",
    );
  }
  return readFileSync(DATA_MODEL_URL, "utf8");
}

// Module-scope read + parse: the exact RED state is the whole file
// failing during collection (0 tests passing) with the reason above.
const MATCHER_ROWS: readonly MatcherRow[] = parseMatcherTable(readDataModel());
const ASSERT_ROWS: readonly AssertRow[] = parseAssertTable(readDataModel());

// ---------------------------------------------------------------------------
// Parser contract — inline fixtures. These lock the format rules against
// synthetic documents, not the real one.
// ---------------------------------------------------------------------------

const MINIMAL_MATCHER_DOC: string = [
  "### 4.1 `expect()` matchers",
  "",
  "| Matcher | Kind |",
  "| --- | --- |",
  "| `toBe` | `equality` |",
  "| `toBeCalledWith` | `equality` (legacy jest alias) |",
  '| `toBeTypeOf` | `""` (vitest) |',
  "",
  "Prose after the table.",
].join("\n");

const MINIMAL_ASSERT_DOC: string = [
  "### 4.2 `node:assert` functions",
  "",
  "| Assert form | Kind |",
  "| --- | --- |",
  '| `assert(value)` (bare) | `""` |',
  '| `assert.ok` | `""` |',
  "| `assert.equal` / `assert.notEqual` | `equality` |",
  "| `assert.match` / `assert.doesNotMatch` | `membership` |",
  "",
  "Prose after the table.",
].join("\n");

describe("parseMatcherTable (parser contract)", () => {
  it("parses rows with kind annotations and the literal empty-string kind", () => {
    const rows = parseMatcherTable(MINIMAL_MATCHER_DOC);
    expect(rows).toEqual([
      { matcher: "toBe", kind: "equality", line: 5 },
      { matcher: "toBeCalledWith", kind: "equality", line: 6 },
      { matcher: "toBeTypeOf", kind: "", line: 7 },
    ]);
  });

  it("fails when the document contains no Matcher | Kind table", () => {
    expect(() => parseMatcherTable("# Only prose\n\nNo tables.")).toThrow(
      /no Matcher \| Kind table found/,
    );
  });

  it("ignores tables whose header does not match exactly", () => {
    // The modifier table and Section 3's vocabulary table are not the
    // matcher table; a document holding only them has no matcher rows.
    const doc = [
      "| Chain modifier | Effect |",
      "| --- | --- |",
      "| `.not.` | Preserves the matcher's kind |",
      "",
      "| Kind | Denotation |",
      "| --- | --- |",
      "| equality | exact value |",
    ].join("\n");
    expect(() => parseMatcherTable(doc)).toThrow(/no Matcher \| Kind table found/);
  });

  it("fails on a data row with the wrong cell count", () => {
    const doc = [
      "| Matcher | Kind |",
      "| --- | --- |",
      "| toBe | equality | extra |",
    ].join("\n");
    expect(() => parseMatcherTable(doc)).toThrow(
      /malformed Matcher \| Kind row at line 3: expected 2 cells, found 3/,
    );
  });

  it("fails when a matcher header is not followed by a separator row", () => {
    const doc = ["| Matcher | Kind |", "| toBe | equality |"].join("\n");
    expect(() => parseMatcherTable(doc)).toThrow(
      /table header at line 1 is not followed by a separator row/,
    );
  });
});

describe("parseAssertTable (parser contract)", () => {
  it("splits two-form rows, recognizes the bare form, and strips (bare) annotations", () => {
    const rows = parseAssertTable(MINIMAL_ASSERT_DOC);
    expect(rows).toEqual([
      { members: [], bare: true, kind: "", line: 5 },
      { members: ["ok"], bare: false, kind: "", line: 6 },
      { members: ["equal", "notEqual"], bare: false, kind: "equality", line: 7 },
      { members: ["match", "doesNotMatch"], bare: false, kind: "membership", line: 8 },
    ]);
  });

  it("fails on a form that is neither the bare call nor an assert.<member> spelling", () => {
    const doc = [
      "| Assert form | Kind |",
      "| --- | --- |",
      '| require(`x`) | `""` |',
    ].join("\n");
    expect(() => parseAssertTable(doc)).toThrow(
      /unrecognized assert form at line 3: "require\(x\)"/,
    );
  });
});

// ---------------------------------------------------------------------------
// Behavioral pins — the classification functions over the pinned lists.
// ---------------------------------------------------------------------------

describe("classifyExpectChain: matcher routing (Section 4.1)", () => {
  it.each(EQUALITY_MATCHERS)("routes %s to equality", (matcher) => {
    expect(classifyExpectChain(matcher, [])).toBe("equality");
  });

  it.each(COMPARISON_MATCHERS)("routes %s to comparison", (matcher) => {
    expect(classifyExpectChain(matcher, [])).toBe("comparison");
  });

  it.each(MEMBERSHIP_MATCHERS)("routes %s to membership", (matcher) => {
    expect(classifyExpectChain(matcher, [])).toBe("membership");
  });

  it.each(ERROR_CHECK_MATCHERS)("routes %s to error_check", (matcher) => {
    expect(classifyExpectChain(matcher, [])).toBe("error_check");
  });

  it.each(UNCLASSIFIED_MATCHERS)("routes %s to the empty string", (matcher) => {
    expect(classifyExpectChain(matcher, [])).toBe("");
  });

  it.each(["toBeWithin", "toCustomMatcher", "toEqual-ish", "not"])(
    "routes the unknown/custom matcher %s to the empty string (never an exception, never a drop)",
    (matcher) => {
      expect(classifyExpectChain(matcher, [])).toBe("");
    },
  );
});

describe("classifyExpectChain: modifier semantics (Section 4.1's modifier table)", () => {
  it(".not. preserves the matcher's kind", () => {
    expect(classifyExpectChain("toBe", ["not"])).toBe("equality");
    expect(classifyExpectChain("toThrow", ["not"])).toBe("error_check");
    expect(classifyExpectChain("toContain", ["not"])).toBe("membership");
    expect(classifyExpectChain("toBeTruthy", ["not"])).toBe("");
  });

  it(".resolves. preserves the matcher's kind", () => {
    expect(classifyExpectChain("toEqual", ["resolves"])).toBe("equality");
    expect(classifyExpectChain("toBeGreaterThan", ["resolves"])).toBe("comparison");
    expect(classifyExpectChain("toThrow", ["resolves"])).toBe("error_check");
  });

  it(".rejects. routes to error_check regardless of matcher", () => {
    expect(classifyExpectChain("toEqual", ["rejects"])).toBe("error_check");
    expect(classifyExpectChain("toBeGreaterThan", ["rejects"])).toBe("error_check");
    expect(classifyExpectChain("toContain", ["rejects"])).toBe("error_check");
    // Even an unknown matcher under .rejects. observes the rejection
    // channel: the reroute is "regardless of matcher".
    expect(classifyExpectChain("toBeWithin", ["rejects"])).toBe("error_check");
  });

  it("any other intermediate property is inert (classification by the invoked matcher)", () => {
    expect(classifyExpectChain("toEqual", ["foo"])).toBe("equality");
    expect(classifyExpectChain("toBe", ["some", "unknown", "chain"])).toBe("equality");
    expect(classifyExpectChain("toBeTruthy", ["context"])).toBe("");
  });

  it("modifier combinations: preservation composes, .rejects. wins regardless", () => {
    expect(classifyExpectChain("toEqual", ["not", "resolves"])).toBe("equality");
    expect(classifyExpectChain("toEqual", ["resolves", "not"])).toBe("equality");
    expect(classifyExpectChain("toEqual", ["not", "rejects"])).toBe("error_check");
  });

  // `await` transparency (US3-10) is structural: the chain reconstructor
  // in src/quality/assertions.ts unwraps AwaitExpression wrappers before
  // the modifier list reaches this pure function, so an awaited chain
  // classifies identically by construction. The behavioral await pin
  // lives in tests/quality/assertions.test.ts (T010/T026), which drives
  // real `await expect(...)` source through the collector.
});

describe("classifyAssertCall: node:assert routing (Section 4.2)", () => {
  it.each(EQUALITY_ASSERTS)("routes assert.%s to equality", (member) => {
    expect(classifyAssertCall(member)).toBe("equality");
  });

  it.each(MEMBERSHIP_ASSERTS)("routes assert.%s to membership", (member) => {
    expect(classifyAssertCall(member)).toBe("membership");
  });

  it.each(ERROR_CHECK_ASSERTS)("routes assert.%s to error_check", (member) => {
    expect(classifyAssertCall(member)).toBe("error_check");
  });

  it.each(UNCLASSIFIED_ASSERTS)("routes assert.%s to the empty string", (member) => {
    expect(classifyAssertCall(member)).toBe("");
  });

  it("routes the memberless bare call assert(value) to the empty string", () => {
    expect(classifyAssertCall(undefined)).toBe("");
  });

  it.each(["equalsStrict", "calledWith", "matches", "iferror"])(
    "routes the unknown member %s to the empty string (never an exception, never a drop)",
    (member) => {
      expect(classifyAssertCall(member)).toBe("");
    },
  );

  it("not-prefixed functions preserve their base kind (never comparison — it denotes ordered relations only)", () => {
    // The not-siblings are equality rows in the pinned table; this test
    // names the principle so a future table edit rerouting any of them
    // to "comparison" fails with the semantic reason visible.
    expect(classifyAssertCall("notEqual")).toBe("equality");
    expect(classifyAssertCall("notStrictEqual")).toBe("equality");
    expect(classifyAssertCall("notDeepEqual")).toBe("equality");
    expect(classifyAssertCall("notDeepStrictEqual")).toBe("equality");
    expect(classifyAssertCall("doesNotMatch")).toBe("membership");
    expect(classifyAssertCall("doesNotThrow")).toBe("error_check");
    expect(classifyAssertCall("doesNotReject")).toBe("error_check");
  });
});

// ---------------------------------------------------------------------------
// Doc parity — the real document, diffed against the module.
// ---------------------------------------------------------------------------

describe("src/quality/matchers.ts against data-model.md Section 4 (doc parity)", () => {
  it("diffs every Section 4.1 row against EXPECT_MATCHER_KINDS, order included", () => {
    expect(
      MATCHER_ROWS.map((row) => [row.matcher, row.kind]),
      "every Matcher | Kind row must equal the module's EXPECT_MATCHER_KINDS entry, " +
        "in document order — the table cannot drift from the normative prose",
    ).toEqual([...EXPECT_MATCHER_KINDS.entries()]);
  });

  it("diffs every Section 4.2 named form against ASSERT_FUNCTION_KINDS, order included", () => {
    const docMembers = ASSERT_ROWS.flatMap((row) =>
      row.members.map((member) => [member, row.kind]),
    );
    expect(
      docMembers,
      "every Assert form | Kind row's members must equal the module's " +
        "ASSERT_FUNCTION_KINDS entries, in document order",
    ).toEqual([...ASSERT_FUNCTION_KINDS.entries()]);
  });

  it("pins the bare assert(value) form to the empty string", () => {
    const bareKinds = ASSERT_ROWS.filter((row) => row.bare).map((row) => row.kind);
    expect(
      bareKinds,
      "exactly the doc's bare row(s), each routed to the empty string",
    ).toEqual([""]);
  });

  it("keeps the pinned behavioral lists consistent with the document rows", () => {
    // The behavioral half's expected values (the module-independent
    // lists above) and the doc rows must describe the same table — this
    // closes the loop so a doc edit that does not update the pinned
    // lists (or vice versa) fails here with both sides named.
    expect(
      MATCHER_ROWS.filter((row) => row.kind === "equality").map((row) => row.matcher),
    ).toEqual(EQUALITY_MATCHERS);
    expect(
      MATCHER_ROWS.filter((row) => row.kind === "comparison").map((row) => row.matcher),
    ).toEqual(COMPARISON_MATCHERS);
    expect(
      MATCHER_ROWS.filter((row) => row.kind === "membership").map((row) => row.matcher),
    ).toEqual(MEMBERSHIP_MATCHERS);
    expect(
      MATCHER_ROWS.filter((row) => row.kind === "error_check").map(
        (row) => row.matcher,
      ),
    ).toEqual(ERROR_CHECK_MATCHERS);
    expect(
      MATCHER_ROWS.filter((row) => row.kind === "").map((row) => row.matcher),
    ).toEqual(UNCLASSIFIED_MATCHERS);
  });
});
