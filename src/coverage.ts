import { resolve } from "node:path";
import type { Writable } from "node:stream";

import { normalizePatterns, pathInScope } from "./analysis.js";
import { resolveRoot } from "./discovery.js";
import { relativeUnderBase } from "./internal.js";
import { MAX_FILE_BYTES, readBounded } from "./safeio.js";

/**
 * The Istanbul coverage artifact parser (FR-023–FR-026; research R10;
 * data-model.md's Istanbul document model; Constitution Principles I, II,
 * and V). `parseCoverage` (T028) reads the pre-existing
 * `<root>/coverage/coverage-final.json` — the conventional output location
 * for both vitest's and jest's Istanbul JSON reporters — and attributes
 * each statement to its innermost enclosing function.
 *
 * **Consumption, never production** (FR-025 — the constitution's required
 * conflict-resolution record): the analyzer never runs the analyzed
 * project's tests and never collects coverage itself. The artifact is the
 * pre-existing output of the project's own test run, read through the
 * bounded safe reader at the full 16 MiB budget — JSON cannot parse from a
 * truncated prefix, the `package.json` precedent — so analyzed code is
 * never executed (Principle V) and no single artifact can dominate memory.
 * The `coverage/` directory is pruned from WALKING only; the artifact is
 * read directly by its conventional path and the tree is never walked for
 * coverage. Root validation is unchanged: `resolveRoot` →
 * `InvalidRootPathError` → the server's `-32602` (contracts/coverage.md).
 *
 * **Degradation ladder** (FR-025): an absent artifact, a skipped read, a
 * JSON parse failure, or a non-object top level each yield the empty entry
 * list — never a JSON-RPC error. A skipped read has already written its
 * one stderr diagnostic line inside `readBounded`; the parse-failure and
 * non-object rungs stay silent because there is nothing to report and
 * nothing wrong with the request. One further rung is deliberately NOT
 * silent: a parseable object document in which no file entry holds the
 * referenced shape writes exactly one diagnostic line — `reading-stone:
 * skipping coverage document: no conforming file entries` — because a
 * document that parses yet conforms nowhere is the signature of an
 * emitter-shape mismatch, and reporting empty there silently was a false
 * negative (Principle II). An empty `{}` document has no keys and stays
 * silent: nothing conformed, but nothing failed to either.
 *
 * **Per-entry tolerance** (FR-026): within a parseable document, a file
 * entry whose `statementMap`, `fnMap`, or `s` — or the shapes they
 * reference — do not hold is skipped deterministically while conforming
 * entries report; the document is never rejected wholesale. The file entry
 * is the unit of conformance (data-model.md), so one malformed record
 * anywhere in a file entry skips that whole entry: partial reads of a
 * half-conforming entry would report counts the document never asserted.
 * `branchMap`/`b`/`f` may be present and are ignored — `s` is the only
 * execution-count source (the fixtures plant `f` values that contradict
 * `s` precisely to pin this).
 *
 * **Null end columns** (the vitest v8 emitter's real shape): Istanbul's
 * v8 coverage pipeline writes `"column": null` on END positions whenever
 * the sourcemap carries no column information — the motivating artifact
 * had null end columns on 1542 of 1558 statementMap records and in the
 * fnMap decl/loc ranges of 272 positions across its 250 records — so
 * requiring a numeric end column rejected every entry of a real document.
 * The conformance check therefore requires a numeric `line` on both
 * positions and a numeric START column, accepts a null or absent end
 * column, and normalizes it to the end-of-line sentinel
 * (`UNBOUNDED_END_COLUMN`): the range then deterministically contains
 * every position on its end line.
 *
 * **Resource bounds** (Principle V — the artifact is untrusted input):
 * attribution is O(statements × functions) per file entry, which the
 * 16 MiB read bound alone does not bound. Two budgets mirror extract.ts's
 * AST depth budget: a file entry over either per-entry record cap
 * (`MAX_STATEMENTS_PER_FILE_ENTRY` / `MAX_FUNCTIONS_PER_FILE_ENTRY`) is
 * skipped with one diagnostic line, and a document-level attribution work
 * budget (`MAX_ATTRIBUTION_WORK`, the running sum of statements ×
 * functions) skips any entry that would exceed its remainder, likewise
 * one line per skip. Skips are deterministic — JSON key enumeration order
 * is spec-defined — and never throw or become a JSON-RPC error.
 */

/**
 * The conventional artifact location (FR-023; contracts/coverage.md): the
 * only path read — root-relative, so `readBounded`'s containment check
 * accepts it — and not configurable via params in v1 (projects writing
 * coverage elsewhere report empty coverage; documented limitation).
 */
const COVERAGE_ARTIFACT_PATH = "coverage/coverage-final.json";

/**
 * The end-of-line sentinel a null or absent END column normalizes to (the
 * vitest v8 emitter's real shape — see the module header): Istanbul's v8
 * pipeline writes `"column": null` when a sourcemap position carries no
 * column information, meaning "no column bound on this line", so the
 * normalized range contains every position on its end line. A real column
 * can never reach it, and the spans it inflates (end-minus-start) only
 * lose "smallest span" attribution contests to precisely bounded ranges —
 * the deterministic, conservative direction.
 */
const UNBOUNDED_END_COLUMN = Number.MAX_SAFE_INTEGER;

/**
 * The per-file-entry record caps (Principle V; the extract.ts
 * AST-depth-budget precedent): a file entry whose statementMap or fnMap
 * holds more records than these caps is skipped with one stderr
 * diagnostic line. Real entries sit orders of magnitude below (the
 * motivating artifact's largest file entry: 618 statements, 90
 * functions), while a 16 MiB document can carry far more — and
 * attribution cost grows with the product, not the sum, of the two
 * counts.
 */
const MAX_STATEMENTS_PER_FILE_ENTRY = 50_000;
const MAX_FUNCTIONS_PER_FILE_ENTRY = 5_000;

/**
 * The document-level attribution work budget: the cumulative sum of
 * statements × functions across admitted file entries never exceeds this
 * many containment comparisons (tens of milliseconds at V8 speed), and an
 * entry that would exceed the remainder is skipped with one stderr
 * diagnostic line. Sized to clear real projects with room to spare (the
 * motivating artifact needs 74,536 work units total) while capping the
 * multiplicatively adversarial document the 16 MiB read bound alone
 * permits.
 */
const MAX_ATTRIBUTION_WORK = 25_000_000;

/**
 * One coverage entry (data-model.md's CoverageEntry; FR-024): a fnMap
 * function with its attributed statement counts. Field names mirror the
 * wire payload exactly — no camelCase/wire split applies to this record —
 * and the entity is an immutable value record (convention pack AP-004).
 */
export interface CoverageEntry {
  /** Root-relative POSIX path of the file the fnMap function belongs to. */
  readonly file: string;
  /** The fnMap name verbatim, including `(anonymous_N)` forms. */
  readonly function: string;
  /** 1-based fnMap `decl.start.line` — the declaration start line. */
  readonly start_line: number;
  /** The fnMap `loc.end.line` — the body end line. */
  readonly end_line: number;
  /** Attributed statements with execution count > 0 (integer ≥ 0). */
  readonly covered_stmts: number;
  /** All attributed statements (integer ≥ 0). */
  readonly total_stmts: number;
  /** `(covered * 100) / total` at full float precision; 0 when total is 0. */
  readonly percentage: number;
}

/**
 * The `coverage` method's entry (FR-023–FR-026; the analyze-shaped surface
 * T018 established): the serialized `CoverageEntry[]` payload — one entry
 * per fnMap function of every conforming, contained, in-scope file entry,
 * assembled in the `(file, start_line, function)` total order, and mapped
 * through `serializeCoverageEntry` so every entry on the returned array is
 * already wire-shaped.
 *
 * The returned array — not a `{functions: [...]}` wrapper — is the
 * documented result shape the server wraps into its JSON-RPC success
 * response (T029); both this entry and the payload are deterministic pure
 * functions of the analyzed tree and artifact (Constitution Principle I:
 * byte-identical repeat responses). The full degradation ladder (FR-025)
 * resolves to the empty array, never a thrown error: only `resolveRoot`'s
 * `InvalidRootPathError` escapes, for the server to map to `-32602`.
 *
 * Unlike `analyze`/`computeComplexity` there is no pipeline to prepare and
 * no compiler context to own: the tree is never walked (discovery
 * confinement is deliberately absent — FR-024 pins root containment and
 * `patterns` only, so a document entry with no on-disk source still
 * reports, research R10), and no native resource outlives the call.
 *
 * @param rootPath Absolute or relative project root; validated and
 * realpath-resolved by `resolveRoot` (an invalid root throws
 * `InvalidRootPathError`, the server maps to `-32602`). Document keys
 * are contained against both this request's cwd-resolved spelling and
 * the realpath form (see `containedRelativePath`).
 * @param patterns The raw `patterns` parameter value; shape-validated by
 * the server (`-32602`, T019) before analysis runs, normalized here
 * through the same FR-001 helpers `analyze` filters with.
 * @param stderr Injected diagnostic sink (Testability principle); defaults
 * to `process.stderr`. Stdout is never touched.
 * @returns The serialized coverage entries, `(file, start_line,
 * function)`-sorted; empty on every degradation-ladder rung.
 */
export async function parseCoverage(
  rootPath: string,
  patterns: unknown,
  stderr: Writable = process.stderr,
): Promise<readonly Record<string, unknown>[]> {
  const realRoot = await resolveRoot(rootPath);
  // The request's cwd-resolved root spelling — resolveRoot's step-1
  // arithmetic, before its step-2 realpath. Document keys are contained
  // against it alongside the canonical form (see containedRelativePath).
  const logicalRoot = resolve(rootPath);
  // The artifact is read through the bounded safe reader at the full 16 MiB
  // budget: JSON cannot parse from a truncated prefix, so a smaller marker
  // budget (the generated-marker precedent) is useless here — the package.json
  // precedent (research R10). A skip resolves null after readBounded's own
  // one-diagnostic line (absent, unreadable, symlink, oversized).
  const text = await readBounded(
    realRoot,
    COVERAGE_ARTIFACT_PATH,
    MAX_FILE_BYTES,
    stderr,
  );
  if (text === null) {
    return [];
  }
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch {
    return []; // Unparseable document (FR-025) — empty coverage, not an error.
  }
  if (!isRecord(document)) {
    return []; // Non-object top level — array, scalar, or null (FR-025).
  }
  // The same normalize-then-test pair every pattern-filtered method applies
  // (FR-024; R11): the helpers are shared with analyze/complexity, so "the
  // same path-prefix rules" is structural, never re-derived here.
  const patternSet = normalizePatterns(patterns);
  const entries: CoverageEntry[] = [];
  // Conformance is counted over the WHOLE document, not the contained,
  // in-scope subset: the zero-conformance diagnostic below reports a
  // document whose every entry fails the referenced shape — an
  // emitter-mismatch signature — while a request whose patterns match
  // nothing, or a document keyed entirely outside the root, is a
  // legitimate empty result over a conforming document and must stay
  // silent. Conformance therefore runs before the key-string rejections;
  // parseFileCoverage is linear in the already-16-MiB-bound document, so
  // validating a key this request will filter out costs nothing the read
  // has not already paid.
  let fileEntryCount = 0;
  let conformingFileEntries = 0;
  // The document-level attribution work budget (Principle V): admission
  // consumes statements × functions, and an entry that would exceed the
  // remainder is skipped below.
  let attributionWorkRemaining = MAX_ATTRIBUTION_WORK;
  for (const [key, value] of Object.entries(document)) {
    fileEntryCount += 1;
    const fileCoverage = parseFileCoverage(value);
    if (fileCoverage === null) {
      continue; // Non-conforming file entry (FR-026).
    }
    conformingFileEntries += 1;
    // Containment (FR-024): a key that does not resolve under either
    // spelling of the root is skipped whatever its payload. Then the
    // pattern filter — cheap key-string rejections.
    const relPath = containedRelativePath(realRoot, logicalRoot, key);
    if (relPath === null) {
      continue;
    }
    if (!pathInScope(relPath, patternSet)) {
      continue;
    }
    // The per-entry record caps (Principle V): a file entry this large is
    // pathological, and attribution cost grows with the product of the
    // two counts — skip it with one diagnostic line, never an error.
    const statementCount = Object.keys(fileCoverage.statementMap).length;
    const functionCount = Object.keys(fileCoverage.fnMap).length;
    if (
      statementCount > MAX_STATEMENTS_PER_FILE_ENTRY ||
      functionCount > MAX_FUNCTIONS_PER_FILE_ENTRY
    ) {
      stderr.write(
        `reading-stone: skipping ${relPath}: coverage record budget exceeded\n`,
      );
      continue;
    }
    // The document-level work budget: an entry that would exhaust the
    // remainder is skipped with one diagnostic line. Later, smaller
    // entries can still fit what remains; the JSON key enumeration order
    // that decides admission is spec-defined, so the skip set is
    // deterministic.
    const attributionWork = statementCount * functionCount;
    if (attributionWork > attributionWorkRemaining) {
      stderr.write(
        `reading-stone: skipping ${relPath}: attribution work budget exceeded\n`,
      );
      continue;
    }
    attributionWorkRemaining -= attributionWork;
    // A bounded push, never a spread: near the 16 MiB read bound a
    // document's file entries can together emit more entries than a
    // single spread call's argument limit allows (RangeError around 10^5
    // arguments), while the entries array itself stays far below any
    // engine limit.
    for (const entry of coverageEntriesFor(relPath, fileCoverage)) {
      entries.push(entry);
    }
  }
  // The zero-conformance diagnostic (see the module header): fire only
  // when the document had keys at all — an empty {} document conformed
  // nowhere but also failed nowhere.
  if (fileEntryCount > 0 && conformingFileEntries === 0) {
    stderr.write(
      "reading-stone: skipping coverage document: no conforming file entries\n",
    );
  }
  entries.sort(compareEntries);
  return entries.map(serializeCoverageEntry);
}

// ---------------------------------------------------------------------------
// Istanbul document model (data-model.md; untrusted parsed input)
// ---------------------------------------------------------------------------

/**
 * One Istanbul position: 1-based line, 0-based column. This is the
 * NORMALIZED shape — a parsed end position may carry a null column, which
 * `parseSourceRange` replaces with `UNBOUNDED_END_COLUMN`, so every value
 * of this type is numeric.
 */
interface SourcePosition {
  readonly line: number;
  readonly column: number;
}

/** One Istanbul location range: inclusive start and end positions. */
interface SourceRange {
  readonly start: SourcePosition;
  readonly end: SourcePosition;
}

/** One Istanbul fnMap record: the function's name and its two ranges. */
interface FnMapRecord {
  readonly name: string;
  readonly decl: SourceRange;
  readonly loc: SourceRange;
}

/** One validated file entry: the three maps attribution consumes. */
interface FileCoverage {
  readonly statementMap: Readonly<Record<string, SourceRange>>;
  readonly fnMap: Readonly<Record<string, FnMapRecord>>;
  readonly s: Readonly<Record<string, number>>;
}

/**
 * Whether `value` is a plain object — the document model's "object"
 * (FR-026): `typeof` object, not null, and not an array. Istanbul's maps
 * are keyed by string ids, so an array is as non-conforming as a scalar;
 * rejecting both keeps the check total where `typeof` alone is not.
 *
 * @param value The parsed JSON value to test.
 * @returns Whether the value is a non-array, non-null object.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Whether `value` holds the referenced START `Pos` shape: an object whose
 * `line` and `column` are both numbers. JSON.parse cannot produce NaN or
 * Infinity, so `typeof` is the whole finiteness story for parsed input;
 * deeper range checks (integer, 1-based) are not pinned by the document
 * model and would risk dropping entries FR-024 requires reporting.
 *
 * @param value The parsed JSON value to test.
 * @returns Whether the value is a start position of the referenced shape.
 */
function isStartPosition(value: unknown): value is SourcePosition {
  return (
    isRecord(value) &&
    typeof value.line === "number" &&
    typeof value.column === "number"
  );
}

/**
 * One parsed END position before normalization: the column may be a
 * number, null, or absent (see `isEndPosition`).
 */
interface RawEndPosition {
  readonly line: number;
  readonly column: number | null | undefined;
}

/**
 * Whether `value` holds the referenced END `Pos` shape: a numeric `line`,
 * and a `column` that is a number or null/absent. Istanbul's v8 emitters
 * (vitest's coverage pipeline) write `"column": null` on end positions
 * when the sourcemap carries no column information — the motivating
 * real-world artifact had null end columns on 1542 of 1558 statementMap
 * records — so a conformance check demanding a numeric end column
 * rejected every entry of a real document (a silent false negative,
 * Principle II). A null or absent end column normalizes to the
 * end-of-line sentinel in `parseSourceRange`.
 *
 * @param value The parsed JSON value to test.
 * @returns Whether the value is an end position of the referenced shape.
 */
function isEndPosition(value: unknown): value is RawEndPosition {
  return (
    isRecord(value) &&
    typeof value.line === "number" &&
    (typeof value.column === "number" ||
      value.column === null ||
      value.column === undefined)
  );
}

/**
 * Validates one referenced `Loc` shape and returns it NORMALIZED: a fresh
 * range whose null or absent end column (see `isEndPosition`) is replaced
 * by the end-of-line sentinel, so every position downstream
 * (`comparePositions`, `rangeContains`, span math) sees numeric columns
 * and the rules stay total. Both positions are copied fresh, so the types
 * rest on validation rather than casts and the normalized range never
 * aliases the parsed document.
 *
 * @param value The parsed JSON range to validate.
 * @returns The normalized range, or null when the referenced shape does
 * not hold.
 */
function parseSourceRange(value: unknown): SourceRange | null {
  if (!isRecord(value) || !isStartPosition(value.start) || !isEndPosition(value.end)) {
    return null;
  }
  const end = value.end;
  const endColumn = typeof end.column === "number" ? end.column : UNBOUNDED_END_COLUMN;
  return {
    start: { line: value.start.line, column: value.start.column },
    end: { line: end.line, column: endColumn },
  };
}

/**
 * Validates one referenced fnMap record shape and returns it with its
 * `decl`/`loc` ranges normalized (see `parseSourceRange`): an object with
 * a string `name` and two conforming ranges. A record missing any of the
 * three (the SHAPELESS_FN fixture: `decl` present, `loc` absent) is
 * non-conforming — the referenced shape does not hold, so FR-026 skips
 * the file entry. Extra fields (real Istanbul records carry them) are not
 * violations: the conformance check verifies the required shape, never
 * forbids additions.
 *
 * @param value The parsed JSON value to validate.
 * @returns The normalized fnMap record, or null when non-conforming.
 */
function parseFnMapRecord(value: unknown): FnMapRecord | null {
  if (!isRecord(value) || typeof value.name !== "string") {
    return null;
  }
  const decl = parseSourceRange(value.decl);
  const loc = parseSourceRange(value.loc);
  if (decl === null || loc === null) {
    return null;
  }
  return { name: value.name, decl, loc };
}

/**
 * Validates one file entry against the conformance check (FR-026) and
 * returns it with its three maps narrowed to typed records — fresh,
 * normalized copies (a null or absent end column becomes the end-of-line
 * sentinel; see `parseSourceRange`), so the types rest on validation
 * rather than casts.
 *
 * The unit of conformance is the whole file entry: `statementMap`, `fnMap`,
 * and `s` must be objects AND every value they reference must hold its
 * shape, or the entry is skipped. A statement id missing from `s` is not a
 * shape violation — `s`'s referenced shape is "statementId → number" for
 * the ids it carries — so such a statement counts toward `total_stmts`
 * uncovered (the pinned `s[id] > 0` formula reads absence as not-executed).
 *
 * @param value The parsed file-entry value.
 * @returns The validated file coverage, or null when non-conforming.
 */
function parseFileCoverage(value: unknown): FileCoverage | null {
  if (!isRecord(value)) {
    return null; // A scalar or array file entry (FR-026).
  }
  const { statementMap, fnMap, s } = value;
  if (!isRecord(statementMap) || !isRecord(fnMap) || !isRecord(s)) {
    return null; // A missing or non-object map (FR-026).
  }
  const statements: Record<string, SourceRange> = {};
  for (const [id, range] of Object.entries(statementMap)) {
    const parsed = parseSourceRange(range);
    if (parsed === null) {
      return null;
    }
    statements[id] = parsed;
  }
  const functions: Record<string, FnMapRecord> = {};
  for (const [id, record] of Object.entries(fnMap)) {
    const parsed = parseFnMapRecord(record);
    if (parsed === null) {
      return null;
    }
    functions[id] = parsed;
  }
  const counts: Record<string, number> = {};
  for (const [id, count] of Object.entries(s)) {
    if (typeof count !== "number") {
      return null;
    }
    counts[id] = count;
  }
  return { statementMap: statements, fnMap: functions, s: counts };
}

// ---------------------------------------------------------------------------
// Attribution (FR-023; contracts/coverage.md; research R10)
// ---------------------------------------------------------------------------

/**
 * Compares two positions as `(line, column)` — line first, then column
 * (FR-023's pinned comparison).
 *
 * @param a Left position.
 * @param b Right position.
 * @returns Negative, zero, or positive as `a` sorts before, equal, or after.
 */
function comparePositions(a: SourcePosition, b: SourcePosition): number {
  if (a.line !== b.line) {
    return a.line - b.line;
  }
  return a.column - b.column;
}

/**
 * Whether `range` contains `position` inclusively: the position sorts on or
 * after the range's start and on or before its end (both compared as
 * `(line, column)`).
 *
 * @param range The candidate containing range.
 * @param position The statement's start position.
 * @returns Whether the position lies within the range.
 */
function rangeContains(range: SourceRange, position: SourcePosition): boolean {
  return (
    comparePositions(position, range.start) >= 0 &&
    comparePositions(position, range.end) <= 0
  );
}

/**
 * One loc range's span as a `(lineCount, columnExtent)` tuple: the tuple
 * FR-023's "smallest span" compares, lines primary and columns secondary.
 * Both components are end-minus-start, so an identical range yields an
 * identical tuple and the fnMap-key tiebreak decides; the two-component
 * form keeps the metric total where a single blended number would tie
 * ranges of different shapes.
 */
type Span = readonly [number, number];

/**
 * Compares two spans as `(lineCount, columnExtent)`, lines primary.
 *
 * @param a Left span.
 * @param b Right span.
 * @returns Negative, zero, or positive as `a` is smaller, equal, or larger.
 */
function compareSpans(a: Span, b: Span): number {
  if (a[0] !== b[0]) {
    return a[0] - b[0];
  }
  return a[1] - b[1];
}

/**
 * Attributes one statement start to its innermost containing fnMap function
 * (FR-023): among the functions whose `loc` range contains the position,
 * the smallest span wins; equal spans fall to the lexicographically
 * smallest fnMap key, so the rule is total (the tie fixture's keys "2" and
 * "10" name identical ranges — "10" < "2" decides, discriminated from
 * insertion order). A start contained by no range attributes to nothing.
 *
 * @param fnMap The file entry's validated fnMap.
 * @param start The statement's start position.
 * @returns The owning fnMap key, or null when no range contains the start.
 */
function attributeStatement(
  fnMap: Readonly<Record<string, FnMapRecord>>,
  start: SourcePosition,
): string | null {
  let bestKey: string | null = null;
  let bestSpan: Span | null = null;
  for (const [key, record] of Object.entries(fnMap)) {
    if (!rangeContains(record.loc, start)) {
      continue;
    }
    const span: Span = [
      record.loc.end.line - record.loc.start.line,
      record.loc.end.column - record.loc.start.column,
    ];
    // Smallest span wins; an equal span falls to the smaller fnMap key.
    const versusBest = bestSpan === null ? -1 : compareSpans(span, bestSpan);
    if (versusBest < 0 || (versusBest === 0 && bestKey !== null && key < bestKey)) {
      bestKey = key;
      bestSpan = span;
    }
  }
  return bestKey;
}

/**
 * Builds one file entry's coverage entries: attribute every statementMap
 * statement to its innermost function, count per function, then emit one
 * entry per fnMap function — functions with no attributed statements
 * included, reporting `total_stmts` 0 and exactly `percentage` 0 (FR-023's
 * no-division-error rule; the empty-body fixture).
 *
 * Statements inside a nested function's range count toward the innermost
 * enclosing function only (US4 scenario 7): attribution assigns each
 * statement to exactly one owner, so the enclosing function's totals never
 * include the nested statement. Entries are constructed in lexicographic
 * fnMap-key order, so full `(file, start_line, function)` ties keep a
 * deterministic relative order through the stable final sort.
 *
 * @param relPath The file entry's root-relative POSIX path.
 * @param fileCoverage The file entry's validated maps.
 * @returns One coverage entry per fnMap function, fnMap-key-ordered.
 */
function coverageEntriesFor(
  relPath: string,
  fileCoverage: FileCoverage,
): CoverageEntry[] {
  const coveredCounts = new Map<string, number>();
  const totalCounts = new Map<string, number>();
  for (const [id, range] of Object.entries(fileCoverage.statementMap)) {
    const owner = attributeStatement(fileCoverage.fnMap, range.start);
    if (owner === null) {
      continue; // No fnMap range contains the start: unattributed.
    }
    totalCounts.set(owner, (totalCounts.get(owner) ?? 0) + 1);
    const count = fileCoverage.s[id];
    if (count !== undefined && count > 0) {
      coveredCounts.set(owner, (coveredCounts.get(owner) ?? 0) + 1);
    }
  }
  const entries: CoverageEntry[] = [];
  for (const [key, record] of Object.entries(fileCoverage.fnMap).sort(
    compareFnMapKeys,
  )) {
    const totalStmts = totalCounts.get(key) ?? 0;
    const coveredStmts = coveredCounts.get(key) ?? 0;
    entries.push({
      file: relPath,
      function: record.name,
      start_line: record.decl.start.line,
      end_line: record.loc.end.line,
      covered_stmts: coveredStmts,
      total_stmts: totalStmts,
      // Multiply-first association: (covered * 100) / total reproduces the
      // pinned double 66.66666666666667 for 2-of-3; the division-first
      // (covered / total) * 100 is one ulp lower. Total 0 is exactly 0.0 —
      // never a division error (FR-023).
      percentage: totalStmts === 0 ? 0 : (coveredStmts * 100) / totalStmts,
    });
  }
  return entries;
}

/**
 * Compares fnMap entry pairs by key — code-unit comparison (not
 * `localeCompare`, which is locale-dependent) — for the canonical
 * construction order inside one file entry.
 *
 * @param a Left [key, record] pair.
 * @param b Right [key, record] pair.
 * @returns The key comparison result.
 */
function compareFnMapKeys(
  a: readonly [string, FnMapRecord],
  b: readonly [string, FnMapRecord],
): number {
  if (a[0] !== b[0]) {
    return a[0] < b[0] ? -1 : 1;
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Containment, ordering, and serialization (FR-024)
// ---------------------------------------------------------------------------

/**
 * Normalizes one document file key against ONE spelling of the analysis
 * root. Both emitter shapes key files — vitest root-relatively, jest
 * absolutely — so every key resolves against that root before the shared
 * containment helper reduces it: an absolute key passes `resolve`
 * unchanged, and a relative key joins the root. Containment itself is
 * `relativeUnderBase` (src/internal.ts) — lexical, with the deliberately
 * literal `..` defense — and its separator normalization to POSIX
 * mirrors the wire contract every other root-relative path honors.
 *
 * @param root One spelling of the absolute analysis root.
 * @param key The document's file key (relative or absolute).
 * @returns The root-relative POSIX path, or null when not under this root.
 */
function relativeUnderRoot(root: string, key: string): string | null {
  return relativeUnderBase(root, resolve(root, key));
}

/**
 * Normalizes one document file key to its root-relative POSIX path, or
 * rejects it (FR-024's spec edge case), trying BOTH spellings of the
 * analysis root: the realpath form `resolveRoot` canonicalized to, and
 * the request's cwd-resolved `root_path` it canonicalized FROM. An
 * Istanbul document keys files by whatever spelling the emitting test
 * run saw — jest keys absolutely, and a `root_path` spelled through a
 * symlink (macOS's `/var` → `/private/var`, a linked workspace)
 * realpaths to a different lexical form, so a document keyed by the
 * request's own spelling would be silently dropped — a false negative
 * Principle II forbids. Both spellings denote the same directory
 * (`resolveRoot` derived the one from the other), so neither admits an
 * escape the other would not; at most one can contain an absolute key,
 * so the outcome stays a deterministic function of the request and
 * document (Principle I). A key under neither is skipped.
 *
 * @param realRoot The realpath-resolved analysis root.
 * @param logicalRoot The request's cwd-resolved root spelling.
 * @param key The document's file key (relative or absolute).
 * @returns The root-relative POSIX path, or null when not under the root.
 */
function containedRelativePath(
  realRoot: string,
  logicalRoot: string,
  key: string,
): string | null {
  return relativeUnderRoot(realRoot, key) ?? relativeUnderRoot(logicalRoot, key);
}

/**
 * The FR-024 total order over entries: `(file, start_line, function)`,
 * code-unit comparison for the string keys, numeric line ordering between
 * them, and `0` on full-key ties — applied whatever order the document's
 * keys and fnMaps arrive in, so the wire guarantee holds structurally.
 *
 * @param a Left entry.
 * @param b Right entry.
 * @returns The three-key comparison result.
 */
function compareEntries(a: CoverageEntry, b: CoverageEntry): number {
  if (a.file !== b.file) {
    return a.file < b.file ? -1 : 1;
  }
  if (a.start_line !== b.start_line) {
    return a.start_line - b.start_line;
  }
  if (a.function !== b.function) {
    return a.function < b.function ? -1 : 1;
  }
  return 0;
}

/**
 * Serializes a `CoverageEntry` to its wire shape (FR-024): exactly the
 * seven fields, emitted in the canonical sorted-key order the protocol
 * layer's sorted-key serializer produces — so the server's `serialize`
 * pass re-orders these keys as a structural no-op and each entry is
 * wire-final in the form that serializer defines.
 *
 * A pure projection, deliberately without the fail-loud field validation
 * `models.ts`'s record serializers apply (the `serializeComplexityEntry`
 * precedent): every `CoverageEntry` is constructed at this module's single
 * site from fields whose validity is structural — validated document
 * strings and numbers — and the wire shape itself (exactly these seven
 * keys) is pinned by `tests/coverage.test.ts`'s wire-invariant assertions.
 *
 * @param entry The coverage entry to serialize.
 * @returns A JSON-ready object with `covered_stmts`, `end_line`, `file`,
 * `function`, `percentage`, `start_line`, and `total_stmts`.
 */
export function serializeCoverageEntry(entry: CoverageEntry): Record<string, unknown> {
  return {
    covered_stmts: entry.covered_stmts,
    end_line: entry.end_line,
    file: entry.file,
    function: entry.function,
    percentage: entry.percentage,
    start_line: entry.start_line,
    total_stmts: entry.total_stmts,
  };
}
