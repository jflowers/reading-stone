import type { Writable } from "node:stream";
import { assembleFunctionRecords, detectEffects } from "./detector.js";
import { classifyFiles, resolveRoot, screenCandidates, walkTree } from "./discovery.js";
import { type ExtractionRecord, extractFunctions } from "./extract.js";
import { serializeFunctionRecord } from "./models.js";
import {
  buildProgramContext,
  type PreReadSource,
  type ProgramContext,
} from "./program.js";
import { MAX_FILE_BYTES, readBounded } from "./safeio.js";

/**
 * Pattern rules and the shared analysis pipeline (FR-001, FR-002; research
 * R11, R12; data-model.md PatternSet and the ProgramContext →
 * ExtractionRecord pipeline order).
 *
 * The pattern rules (T012) are pure — no filesystem, no walk — and shared
 * by every pattern-filtered method: the analyze and complexity scope filter
 * below, and coverage entry filtering (FR-024), so "the same path-prefix
 * rules" is structural. `prepareAnalysis` (T014) composes the exported
 * discovery, bootstrap, and extraction stages into the one pipeline both
 * analysis handlers consume, so FR-022's same-extraction-set, scope, and
 * ordering guarantee is structural — there is no second extraction path
 * to drift. `analyze` (T018) closes that pipeline over the detector:
 * detection, FR-020's response assembly, and serialization, with the
 * program-mode context's lifetime owned by the handler (disposed in a
 * `finally`) — and released by `prepareAnalysis` itself when extraction
 * throws — so no native compiler server outlives one analysis.
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

/**
 * The `prepareAnalysis` result (data-model.md's internal pipeline order:
 * `ProgramContext` → `ExtractionRecord`) — the surfaces the analyze and
 * complexity computations run over (FR-022: the identical extraction
 * set, scope, and ordering both methods report), plus the in-scope file
 * set spec 003's signal pipeline filters by.
 */
export interface PreparedAnalysis {
  /**
   * The bootstrapped analysis context (FR-003/FR-004). A program-mode
   * context owns a live native compiler server; the consumer that drops
   * it disposes it — the analysis handlers own that lifetime, exactly as
   * direct pipeline callers must. A parse-only context owns nothing to
   * dispose.
   */
  readonly context: ProgramContext;

  /**
   * The extracted function-likes, sorted by `(relPath, line, name)`
   * (FR-008) — the record set the detector (FR-009 attribution) and the
   * complexity engine (FR-021) both consume.
   */
  readonly records: readonly ExtractionRecord[];

  /**
   * The in-scope file set (spec 003 FR-016's file-set parity; research
   * R7): the pattern-filtered, test-excluded source list in
   * classifyFiles' sorted order — the exact set `records` were extracted
   * from. The caller index (spec 003 T009) filters call sites by this
   * set, so the index is built over the identical discovered,
   * pattern-filtered, exclusion-filtered file set as the analysis by
   * construction — no second scope computation to drift. A purely
   * additive widening: the analyze and complexity handlers ignore it,
   * and their behavior is unchanged.
   */
  readonly inScopePaths: readonly string[];
}

/**
 * Prepares the shared analysis over a project tree (FR-002; research R12):
 * resolve, walk, screen, classify, exclude, filter, bootstrap, extract —
 * the one pipeline the analyze and complexity handlers both consume, so
 * FR-022's same-extraction-set/scope/ordering guarantee is structural.
 *
 * Composition, in order:
 *
 * 1. `resolveRoot` validates and realpath-resolves the root (FR-010) —
 *    the same validation `discover` runs; an invalid root throws
 *    `InvalidRootPathError` here, for the server to map to `-32602`
 *    (no layering inversion).
 * 2. `walkTree` → `screenCandidates` → `classifyFiles`: the same
 *    walk/screen/classify chain `discover()` composes, minus framework
 *    detection — deterministic walk order, the safety-skip → `.d.ts` →
 *    generated-marker exclusion chain, then the test/source partition.
 * 3. Test files are additionally excluded from analysis (FR-002): only
 *    the classification's source arm proceeds. Generated files never
 *    reach this point (`screenCandidates` already dropped them), so test
 *    files and generated files are never analyzed. The exclusion precedes
 *    the pattern filter and is absolute: a pattern naming a test file
 *    still yields no records (FR-001 narrows within the analyzable set).
 * 4. The FR-001 pattern filter — `normalizePatterns` then `pathInScope`
 *    over classifyFiles' sorted list — keeps the in-scope subset; a set
 *    matching nothing yields an empty analysis, never an error.
 * 5. Each in-scope file is pre-read through the async `readBounded` at
 *    the full 16 MiB budget (a JSON-free whole-file read),
 *    `buildProgramContext` bootstraps the program or parse-only context
 *    over exactly those files (FR-003/FR-004; a `null` read excludes its
 *    file after `readBounded`'s own one-diagnostic skip), and
 *    `extractFunctions` walks the context's sources into the sorted
 *    record list (FR-007/FR-008).
 *
 * Diagnostics flow to the injected stderr; stdout is never touched (it is
 * reserved for JSON-RPC responses). The returned context's lifetime is
 * the consumer's — the analysis handlers dispose a program-mode context
 * when finished with it — and a mid-pipeline failure releases it here:
 * when extraction throws, the program-mode context is disposed before
 * the error propagates, so no native compiler server outlives the
 * pipeline call either way.
 *
 * @param rootPath Absolute or relative project root; a relative path
 * resolves against the analyzer process working directory, and a symlinked
 * root is realpath-resolved exactly once at the boundary (FR-018).
 * @param patterns The raw `patterns` parameter value. The server validates
 * its shape (`-32602`, T019) before analysis runs; this surface only
 * normalizes.
 * @param stderr Injected diagnostic sink (Testability principle); defaults
 * to `process.stderr`.
 * @returns The bootstrapped `ProgramContext`, the extraction records,
 * and the in-scope file set (spec 003 FR-016's file-set parity).
 * @throws InvalidRootPathError when the root does not exist, is not a
 * directory, or cannot be accessed; the server handler maps it to the
 * contract's `-32602` response.
 */
export async function prepareAnalysis(
  rootPath: string,
  patterns: unknown,
  stderr: Writable = process.stderr,
): Promise<PreparedAnalysis> {
  const realRoot = await resolveRoot(rootPath);
  const candidates = await walkTree(realRoot);
  const surviving = await screenCandidates(realRoot, candidates, stderr);
  // FR-002: test files are additionally excluded from analysis. Only the
  // classification's source arm proceeds — classifyFiles owns the
  // test/source partition, so taking the one arm is the whole exclusion,
  // with no second copy of the test signals to drift. Generated files
  // were already screened out above; test files and generated files are
  // never analyzed.
  const { sourceFiles } = classifyFiles(surviving);
  // FR-001 narrows within the analyzable set, after the structural
  // exclusion: the same normalize-then-test pair every pattern-filtered
  // method applies, over the sorted source list (deterministic order).
  const patternSet = normalizePatterns(patterns);
  const inScope = sourceFiles.filter((relPath) => pathInScope(relPath, patternSet));
  const preRead = await preReadSources(realRoot, inScope, stderr);
  const context = buildProgramContext(realRoot, preRead, stderr);
  let records: ExtractionRecord[];
  try {
    records = extractFunctions(realRoot, context, stderr);
  } catch (error) {
    // A program-mode context owns a live native compiler server; a failed
    // extraction must not leak it. Release before the throw propagates —
    // the same lifetime contract the handlers' finally owns (a parse-only
    // context has nothing to dispose).
    if (context.mode === "program") {
      context.dispose();
    }
    throw error;
  }
  return { context, records, inScopePaths: inScope };
}

/**
 * The `analyze` method's handler (FR-020; the analyze contract): the
 * serialized `FunctionRecord[]` payload — detection effects attributed per
 * record, assembled in the `(file, line, name)` total order, and mapped
 * through `serializeFunctionRecord` so every entry on the returned array
 * is already wire-shaped (fixed key order, validated fields — the
 * protocol layer's sorted-key serializer then only re-orders keys).
 *
 * The returned array — not a `{functions: [...]}` wrapper — is the
 * documented result shape the server wraps into its JSON-RPC success
 * response (T019); both this entry and the payload are deterministic
 * pure functions of the analyzed tree (Constitution Principle I:
 * byte-identical repeat responses).
 *
 * The program-mode context's lifetime is this handler's: the native
 * compiler server behind it is closed in the `finally` whatever the
 * detection outcome, so no subprocess outlives one analysis. A
 * parse-only context owns nothing to dispose.
 *
 * @param rootPath Absolute or relative project root; validated and
 * realpath-resolved by `prepareAnalysis` (an invalid root throws
 * `InvalidRootPathError`, the server maps to `-32602`).
 * @param patterns The raw `patterns` parameter value; shape-validated by
 * the server (`-32602`, T019) before analysis runs, normalized here.
 * @param stderr Injected diagnostic sink (Testability principle); defaults
 * to `process.stderr`. Stdout is never touched.
 * @returns The serialized function records, `(file, line, name)`-sorted.
 */
export async function analyze(
  rootPath: string,
  patterns: unknown,
  stderr: Writable = process.stderr,
): Promise<readonly Record<string, unknown>[]> {
  const prepared = await prepareAnalysis(rootPath, patterns, stderr);
  try {
    const effects = detectEffects(prepared.records, prepared.context);
    const assembled = assembleFunctionRecords(prepared.records, effects);
    return assembled.map(serializeFunctionRecord);
  } finally {
    if (prepared.context.mode === "program") {
      prepared.context.dispose();
    }
  }
}

/**
 * Pre-reads the in-scope files for the bootstrap (research R12): each file
 * through the async `readBounded` at the full 16 MiB budget — a JSON-free
 * whole-file read, the form `buildProgramContext`'s pre-read pairs expect.
 * A skipped read resolves `null` after `readBounded`'s own one-diagnostic
 * skip; the `null` text is passed through for the bootstrap to exclude the
 * file silently (never a second diagnostic for one skip). Reads are
 * sequential, so per-file skip diagnostics land in the sorted list's order
 * (research R8's deterministic-diagnostic discipline).
 *
 * @param realRoot Realpath-resolved absolute analysis root; every read is
 * contained within it (FR-018).
 * @param inScope The pattern-filtered, test-excluded source files, in
 * classifyFiles' sorted order.
 * @param stderr Injected diagnostic sink; stdout is never touched.
 * @returns One `(relPath, text)` pair per in-scope file, in order.
 */
async function preReadSources(
  realRoot: string,
  inScope: readonly string[],
  stderr: Writable,
): Promise<PreReadSource[]> {
  const preRead: PreReadSource[] = [];
  for (const relPath of inScope) {
    const text = await readBounded(realRoot, relPath, MAX_FILE_BYTES, stderr);
    preRead.push([relPath, text]);
  }
  return preRead;
}
