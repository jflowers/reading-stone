/**
 * Pattern rules for analysis scoping (FR-001; research R11; data-model.md
 * PatternSet).
 *
 * Pure functions only — no filesystem, no walk (tasks.md T012). The two
 * surfaces here are shared by every pattern-filtered method: the analyze
 * and complexity scope filter (T014's `prepareAnalysis`) and coverage
 * entry filtering (FR-024), so "the same path-prefix rules" is structural.
 * `prepareAnalysis` (T014) extends this module with the shared pipeline;
 * these rules stay pure and deterministic (Constitution Principle I).
 */

/**
 * Normalized pattern state (data-model.md PatternSet; internal — not
 * protocol-visible).
 *
 * `null` is the whole-tree marker: `patterns` absent, `null`, empty, or
 * exactly one of the catch-all forms `["./..."]` / `["..."]`. Any other
 * value is the array of normalized directory prefixes.
 */
export type PatternSet = null | readonly string[];

/**
 * Normalizes one pattern element into a directory prefix: strip one
 * leading `./`, then one trailing `/...` — exactly one of each, in that
 * order (research R11). `"././src"` keeps its second `./`, and no glob or
 * regex interpretation exists (rejected in research R11).
 *
 * The result may be a documented match-nothing prefix: the empty string
 * (from `""` or `"./"`), `"."`, or a non-singleton `"..."` — such an
 * element matches no path, so a set of only such elements matches
 * nothing rather than everything.
 */
function normalizePattern(element: string): string {
  let prefix = element;
  if (prefix.startsWith("./")) {
    prefix = prefix.slice(2);
  }
  if (prefix.endsWith("/...")) {
    prefix = prefix.slice(0, -4);
  }
  return prefix;
}

/**
 * Normalizes the raw `patterns` parameter into a `PatternSet` (FR-001).
 *
 * The catch-alls — `patterns` absent, `null`, the empty array, or the
 * exact singleton forms `["./..."]` and `["..."]` — normalize to `null`,
 * the whole tree. Every other element becomes a directory prefix through
 * `normalizePattern`, deduplicated preserving first occurrence.
 *
 * Match-nothing elements are kept, never dropped: `[""]`, `["."]`, and
 * `["./"]` normalize to prefixes that match no path, so a pattern set
 * matching nothing yields empty analysis results downstream, never an
 * error. Only the exact singleton forms are catch-alls — a lone `"..."`
 * element inside a larger array survives as a match-nothing prefix.
 *
 * The input domain is the server-validated one (T019 rejects non-array
 * or non-string-element `patterns` with `-32602` before analysis runs):
 * `undefined`, `null`, or an array of strings. Validation itself is the
 * dispatch layer's concern, not this function's.
 *
 * @param patterns The raw `patterns` parameter value.
 */
export function normalizePatterns(patterns: unknown): PatternSet {
  if (patterns === null || patterns === undefined) {
    return null;
  }
  const elements = patterns as readonly string[];
  if (elements.length === 0) {
    return null;
  }
  const prefixes = new Set<string>();
  for (const element of elements) {
    prefixes.add(normalizePattern(element));
  }
  // The catch-all check is on the raw element count: only the exact
  // singleton forms are catch-alls, so `["...", "..."]` is not one (its
  // lone distinct prefix still matches nothing — research R11).
  if (elements.length === 1 && prefixes.has("...")) {
    return null;
  }
  return [...prefixes];
}

/**
 * Reports whether a root-relative POSIX-separator path is in scope under a
 * normalized pattern set (FR-001).
 *
 * `null` means the whole tree. Otherwise a pattern matches when the path
 * equals a prefix — the prefix may itself be a file path — or begins with
 * `prefix + "/"`, a segment boundary: the prefix `src` does not match
 * `srcx/lib.ts`, and the file pattern `src/lib.ts` does not scope its
 * siblings. Patterns union — any matching prefix puts the path in scope.
 *
 * @param relPath Root-relative POSIX-separator path to test.
 * @param patternSet A normalized pattern set from `normalizePatterns`.
 */
export function pathInScope(relPath: string, patternSet: PatternSet): boolean {
  if (patternSet === null) {
    return true;
  }
  return patternSet.some(
    (prefix) => relPath === prefix || relPath.startsWith(`${prefix}/`),
  );
}
