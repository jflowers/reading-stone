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
import { classifyPairs } from "./signals/adapter.js";
import { buildRecordEvidence } from "./signals/evidence.js";
import { type ClassifySignalsResult, serializeSignal } from "./signals/types.js";

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
 * throws — so no native compiler server outlives one analysis. Spec 003
 * (T025) inserts the classification core between detection and assembly
 * (FR-012): the evidence snapshots are taken while that context is live,
 * then the pair-keyed fan-out rebuilds every effect as a classified
 * immutable value, so each one reaches the wire already carrying
 * `classification: {label, confidence}`.
 *
 * `classifySignals` (T029, FR-014) is the second method entry here — the
 * `classify_signals` handler's payload source, running the identical
 * stages `analyze` runs over the same `prepareAnalysis` pipeline and
 * owning the same dispose lifetime, differing only in the last stage
 * (feed serialization instead of record assembly). Both entries consume
 * the pure fan-out core from src/signals/adapter.ts strictly
 * one-directionally (convention pack AP-005: circular dependencies MUST
 * NOT exist between modules): this module imports the core, and nothing
 * under src/signals/ imports this module back, so the classify_signals
 * flow is acyclic end to end.
 *
 * Spec 004 (T005) adds the one widening every mapping stage consumes
 * (FR-006): an optional `options` parameter whose `includeTestArm` flag
 * admits the discovered test arm to the bootstrap — program mode's
 * extender-config `files` root set and the parse-only sources map both
 * derive from the same pre-read list — while the extraction records stay
 * narrowed to the in-scope source set, so the target set remains the
 * identical `analyze` file set. The flag is opt-in: the three method
 * entries below pass nothing and observe only the inert
 * `testPaths: []` result field.
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

  /**
   * The realpath-resolved absolute analysis root — `resolveRoot`'s output
   * (FR-010's resolved form, never the raw request spelling). The base the
   * caller index relativizes call-site file names against, threaded here so
   * `buildCallerIndex` never re-derives it from record file names. A purely
   * additive widening: consumers that do not need it ignore it, and their
   * behavior is unchanged.
   */
  readonly rootPath: string;

  /**
   * The discovered, exclusion-screened test arm in classifyFiles' sorted
   * order (spec 004 FR-006): `[]` unless the caller passed
   * `{ includeTestArm: true }`. Pattern-UNfiltered by contract —
   * `patterns` narrow the target arm only, so a pattern set naming test
   * files still yields the full test arm here. Generated and skipped
   * files are excluded by the screening both arms share. A purely
   * additive widening: consumers that pass no flag observe only this
   * inert empty field, and their behavior is unchanged.
   */
  readonly testPaths: readonly string[];
}

/**
 * The `prepareAnalysis` widening options (spec 004 FR-006; research R2):
 * the opt-in switch that admits the test arm to the bootstrap. The
 * mapping pipeline (`test_mapping`, spec 004) is the consumer that sets
 * it; every other caller passes nothing and observes no behavior change
 * beyond the inert `testPaths: []` result field.
 */
export interface PrepareAnalysisOptions {
  /**
   * When `true`, the discovered, exclusion-screened test arm is pre-read
   * through the same bounded `readBounded` and appended to the bootstrap
   * input (sorted source arm, then sorted test arm), so the program
   * mode's extender-config `files` root set and the parse-only sources
   * map both admit the test files — checker queries can resolve
   * test-file imports and calls. The extraction records are STILL
   * narrowed to the in-scope source set: the target set remains the
   * identical `analyze` file set, record-for-record.
   */
  readonly includeTestArm: boolean;
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
 *    record list (FR-007/FR-008), and the records are narrowed to the
 *    in-scope set — the program arm's transitive imports are excluded
 *    (FR-001/FR-022; the parse-only arm is structurally in scope).
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
 * @param options The widening options (spec 004 FR-006); omitted by the
 * analyze/complexity/classify_signals callers, which observe no behavior
 * change beyond the inert `testPaths: []` result field.
 * @returns The bootstrapped `ProgramContext`, the extraction records, the
 * in-scope file set (spec 003 FR-016's file-set parity), the
 * realpath-resolved analysis root, and the test arm (`[]` unless
 * `{ includeTestArm: true }` was passed).
 * @throws InvalidRootPathError when the root does not exist, is not a
 * directory, or cannot be accessed; the server handler maps it to the
 * contract's `-32602` response.
 */
export async function prepareAnalysis(
  rootPath: string,
  patterns: unknown,
  stderr: Writable = process.stderr,
  options?: PrepareAnalysisOptions,
): Promise<PreparedAnalysis> {
  const realRoot = await resolveRoot(rootPath);
  const candidates = await walkTree(realRoot);
  const surviving = await screenCandidates(realRoot, candidates, stderr);
  // FR-002: test files are additionally excluded from analysis. Only the
  // classification's source arm proceeds — classifyFiles owns the
  // test/source partition, so taking the one arm is the whole exclusion,
  // with no second copy of the test signals to drift. Generated files
  // were already screened out above; test files and generated files are
  // never analyzed. Spec 004's widening (FR-006) captures the other arm
  // for the opt-in caller: the test arm flows to the bootstrap and back
  // as `testPaths`, pattern-UNfiltered — patterns narrow the target arm
  // only.
  const { sourceFiles, testFiles } = classifyFiles(surviving);
  // FR-001 narrows within the analyzable set, after the structural
  // exclusion: the same normalize-then-test pair every pattern-filtered
  // method applies, over the sorted source list (deterministic order).
  const patternSet = normalizePatterns(patterns);
  const inScope = sourceFiles.filter((relPath) => pathInScope(relPath, patternSet));
  const testArm = options?.includeTestArm === true ? testFiles : [];
  // The bootstrap input is deterministic in both modes: the sorted
  // source arm, then the sorted test arm. Program mode derives the
  // extender config's `files` root set from this list (so the test arm
  // enters the configured program); parse-only mode derives its
  // root-relative sources map from it identically.
  const preRead = await preReadSources(realRoot, [...inScope, ...testArm], stderr);
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
  // FR-001/FR-022's scope guarantee over the configured program: the program
  // arm can contain pattern-excluded in-root files — transitive imports the
  // hermetic host serves on demand (src/program.ts) — and, under spec 004's
  // widening, the admitted test arm; extraction's walk is root-containment
  // scoped (src/extract.ts), so the record set is narrowed here to the
  // identical in-scope list the pattern filter produced. The narrowing
  // filter below is UNCONDITIONAL — the FR-006 parity invariant in both
  // modes: the parse-only arm needs it just as much, because the widened
  // test arm is admitted there too and its files are equally subject to
  // the pattern filter's in-scope narrowing (F4's review fix: the old
  // "needs no narrowing" claim described the pre-widening parse-only
  // view, not the landed one). Both modes' record sets ARE the in-scope
  // set — what FR-022's same-extraction-set guarantee, spec 003 US3-7's
  // identical-file-set guarantee, and spec 004 FR-006's target-parity
  // guarantee (the widened call reports `analyze`'s records
  // record-for-record) all rest on.
  const inScopeSet = new Set(inScope);
  records = records.filter((record) => inScopeSet.has(record.relPath));
  return {
    context,
    records,
    inScopePaths: inScope,
    rootPath: realRoot,
    testPaths: testArm,
  };
}

/**
 * The `analyze` method's handler (FR-020; the analyze contract): the
 * serialized `FunctionRecord[]` payload — detection effects attributed per
 * record, assembled in the `(file, line, name)` total order, and mapped
 * through `serializeFunctionRecord` so every entry on the returned array
 * is already wire-shaped (fixed key order, validated fields — the
 * protocol layer's sorted-key serializer then only re-orders keys).
 *
 * Spec 003 inserts the classification core between detection and
 * assembly (FR-012; research R10; the adapter's composition contract):
 * the evidence snapshots are taken while the program-mode context is
 * still live — every checker query and the caller index's
 * `getSignatureUsage` traffic round-trips to the native compiler server —
 * then `classifyPairs` runs the pair-keyed fan-out and rebuilds each
 * record's effects as new immutable values carrying
 * `classification: {label, confidence}`. Every same-type effect on a
 * record shares the identical pair classification (FR-008/FR-011), every
 * effect in every response carries one (FR-012, superseding spec 002
 * FR-019's omission rule here at the wiring layer — the detector itself
 * is untouched and still produces unclassified effects), and the
 * classified instances are what assembly consumes, so
 * `serializeEffect` → `serializeClassification`'s fail-loud validation
 * (closed label set, integer 0–100) now exercises on every `analyze`
 * response.
 *
 * The returned array — not a `{functions: [...]}` wrapper — is the
 * documented result shape the server wraps into its JSON-RPC success
 * response (T019); both this entry and the payload are deterministic
 * pure functions of the analyzed tree (Constitution Principle I:
 * byte-identical repeat responses, classification fields included).
 *
 * The program-mode context's lifetime is this handler's — unchanged by
 * the classification insertion: the native compiler server behind it is
 * closed in the `finally` whatever the detection and classification
 * outcome, so no subprocess outlives one analysis. A parse-only context
 * owns nothing to dispose.
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
    // Spec 003's insertion point (FR-012; research R10): evidence while
    // the program-mode context is live (the caller index's
    // `getSignatureUsage` traffic rides it), then the pair-keyed fan-out
    // rebuilding effects as classified immutable values — between
    // detection and assembly, exactly where FR-012 places the change.
    const evidence = buildRecordEvidence(
      prepared.context,
      prepared.records,
      prepared.inScopePaths,
      prepared.rootPath,
    );
    const classified = classifyPairs(prepared.records, effects, evidence);
    const assembled = assembleFunctionRecords(prepared.records, classified.effects);
    return assembled.map(serializeFunctionRecord);
  } finally {
    if (prepared.context.mode === "program") {
      prepared.context.dispose();
    }
  }
}

/**
 * The `classify_signals` method's entry (FR-014; research R10, R11): the
 * serialized `Signal[]` payload — the raw evidence behind `analyze`'s
 * classifications, one row per rule that matched per (function record,
 * canonical effect type) pair — in FR-014's `(package, function,
 * side_effect_type, source)` total order, each row already wire-shaped
 * through `serializeSignal` (validated fields, omit-unset-optionals
 * `reasoning`). The returned array — not a `{"signals": [...]}` wrapper —
 * is the payload the server handler wraps into its JSON-RPC success
 * response, exactly as it wraps `analyze`'s array. The return type is
 * `ClassifySignalsResult["signals"]` — the payload half of the wire result
 * interface — so the entry-to-handler hand-off is compile-time pinned: the
 * handler types its wrapper against the interface, and this return cannot
 * drift from the wire contract.
 *
 * The stages are `analyze`'s, identically and in the identical order
 * (FR-013's one-shared-pipeline guarantee is structural, never a second
 * walk): `prepareAnalysis` — the one discovery/bootstrap/extraction
 * pipeline, so the identical discovered, pattern-filtered,
 * exclusion-filtered file set and record set — then `detectEffects`, then
 * the T024 core with the program-mode context still live: the evidence
 * snapshots (`buildRecordEvidence`, caller index included) taken while the
 * checker can still answer, then `classifyPairs` — the pair-keyed fan-out
 * whose four-key-ordered `signals` feed is this entry's payload. The two
 * entries differ by the last stage only: assembly and
 * `serializeFunctionRecord` in `analyze`, feed serialization here.
 *
 * The entry lives here beside `analyze` — not in src/signals/adapter.ts —
 * so the module dependency stays strictly one-directional (convention
 * pack AP-005): this module imports the pure core; nothing under
 * src/signals/ imports this module back.
 *
 * The program-mode context's dispose lifetime is owned here exactly as
 * `analyze` owns its own (the same `finally` discipline): the native
 * compiler server behind the context is closed whatever the detection and
 * classification outcome, so no subprocess outlives one request. A
 * parse-only context owns nothing to dispose. `prepareAnalysis` itself
 * releases the context when extraction throws, and an invalid root throws
 * `InvalidRootPathError` before any context exists — it propagates
 * untouched for the server to map to the shared `-32602` root message.
 *
 * Deterministic (Constitution Principle I): the feed is a pure function of
 * the analyzed tree and analyzer version — fixed row order, fixed
 * reasoning templates, no timestamps or environment-dependent data — so
 * repeated requests over the same tree serialize byte-identically.
 *
 * @param rootPath Absolute or relative project root; validated and
 * realpath-resolved by `prepareAnalysis` (an invalid root throws
 * `InvalidRootPathError`, the server maps to `-32602`).
 * @param patterns The raw `patterns` parameter value; shape-validated by
 * the server (`-32602`) before analysis runs, normalized by
 * `prepareAnalysis`. A set matching nothing yields `[]`, never an error.
 * @param stderr Injected diagnostic sink (Testability principle); defaults
 * to `process.stderr`. Stdout is never touched.
 * @returns The serialized signals — `ClassifySignalsResult["signals"]`, the
 * `readonly Signal[]` the server handler wraps under the result interface's
 * single `signals` key — `(package, function, side_effect_type, source)`
 * -sorted.
 * @throws InvalidRootPathError when the root does not exist, is not a
 * directory, or cannot be accessed; the server handler maps it to the
 * contract's `-32602` response.
 */
export async function classifySignals(
  rootPath: string,
  patterns: unknown,
  stderr: Writable = process.stderr,
): Promise<ClassifySignalsResult["signals"]> {
  const prepared = await prepareAnalysis(rootPath, patterns, stderr);
  try {
    const effects = detectEffects(prepared.records, prepared.context);
    // The core's composition order (the adapter header's composition
    // contract): evidence while the program-mode context is live — the
    // caller index's `getSignatureUsage` traffic and every checker query
    // ride it — then the pair-keyed fan-out whose four-key-ordered feed is
    // the payload.
    const evidence = buildRecordEvidence(
      prepared.context,
      prepared.records,
      prepared.inScopePaths,
      prepared.rootPath,
    );
    const classified = classifyPairs(prepared.records, effects, evidence);
    return classified.signals.map(serializeSignal);
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
