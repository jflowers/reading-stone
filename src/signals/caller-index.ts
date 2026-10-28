import { sep } from "node:path";
import {
  isPropertyAssignment,
  isPropertyDeclaration,
  isVariableDeclaration,
  type Node,
} from "typescript/unstable/ast";
import type { Checker } from "typescript/unstable/sync";
import type { ExtractionRecord } from "../extract.js";
import { relativeUnderBase } from "../internal.js";
import type { ProgramContext } from "../program.js";

/**
 * The checker-resolved caller index (FR-016; research R7; data-model.md
 * Section 5.2) — the import-graph answer to US3's question, "how many
 * distinct in-scope modules call this function?", derived through the
 * compiler's own cross-module reference machinery rather than heuristic
 * name matching (Constitution Principle III: `getSignatureUsage` is the
 * verified `typescript/unstable/sync` surface, returning per usage the
 * reference-name handle paired with its call-expression handle when the
 * reference is invoked).
 *
 * Contract, per research R7 and data-model.md Section 5.2:
 *
 * 1. **One query per record.** Each extracted record costs exactly one
 *    `checker.getSignatureUsage` call — never one per call site — so the
 *    index's checker traffic stays proportional to project size, the same
 *    order as the detector's existing per-callee queries. The query node is
 *    the record's own declaration when it bears the declared name (function,
 *    method, accessor, and constructor declarations), and the NAME-GIVING
 *    PARENT declaration for the three assigned expression forms — a
 *    variable, class-property, or object-literal-property initializer —
 *    mirroring extract.ts's `recordNameForExpression` parent shapes: the
 *    symbol those records are called through is the binding, not the
 *    anonymous expression.
 * 2. **Qualifying call sites.** A usage counts only when it carries a call
 *    expression. The call handle is resolved to its node and the node's
 *    source-file `fileName` (original case) is mapped to a root-relative
 *    path through the shared `relativeUnderBase` — deliberately NOT the
 *    handle's own `path` string, which the server canonicalizes (case-folded
 *    on case-insensitive platforms) and which therefore cannot be compared
 *    against analyzer-side spellings without duplicating the server's
 *    canonicalization rules.
 * 3. **File-set parity (US3-7).** A call site is kept only when its
 *    root-relative path is in the caller's `inScopePaths` — the identical
 *    discovered, pattern-filtered, exclusion-filtered file set `analyze`
 *    reports over (T006's widening). Calls positioned in pattern-excluded
 *    modules that are still inside the compiler's program (the hermetic host
 *    serves in-root files on demand) and calls in test-classified files
 *    (excluded at discovery, never in the program) are both dropped here.
 * 4. **Self-recursion exclusion (US3-6).** Calls positioned inside the
 *    record's own body span do not count — the rule is positional, so a
 *    recursive self-call is not an inbound caller, while a same-module call
 *    from a DIFFERENT function (including one nested inside the record's
 *    span but a record of its own) resolves through its own declaration and
 *    is judged by its own position.
 * 5. **Distinct modules.** The count is the number of DISTINCT in-scope
 *    modules with at least one qualifying call site: the defining module
 *    counts when other functions in it call the record (US3-1), multiple
 *    sites within one module count that module once (US3-5), and
 *    module-level call sites count exactly like calls inside function
 *    bodies (US3's letter is call sites, not call sites in records).
 * 6. **Documented resolve-no-caller boundaries** (data-model.md Section
 *    5.2, pinned by tests/signals/caller-index.test.ts): anonymous
 *    default-export expressions (the `export default` form's parent is the
 *    ExportAssignment, which names nothing — the query runs against the
 *    expression itself and finds no symbol), accessors (property reads are
 *    name-only usages; no call expression is ever paired), and constructors
 *    (new expressions are not call expressions in the usage API's pairing).
 *
 * Mode boundary (research R7's documented degradation): in parse-only mode
 * there is no checker, so the index is EMPTY — no entries at all, never an
 * all-zero one — and no `caller_count` signal is emitted. Degradation
 * reduces precision, never availability.
 *
 * Strictly static (Constitution Principle V): the index never executes,
 * imports, or requires analyzed code. Every stage — reference resolution,
 * handle resolution, span comparison — reads the compiler's parsed views
 * only; `tests/signals/caller-index.test.ts`'s canary tree pins this by
 * planting a throwing module inside the compiler's resolved import graph.
 *
 * Lifetime: the checker round-trips to the live native compiler server, so
 * `buildCallerIndex` must run while the program-mode context is alive — the
 * consumer that owns the context's disposal (the adapter, T024) builds the
 * index before disposing, exactly as the detector's checker queries do.
 */

/**
 * The per-record caller index (data-model.md Section 5.2): every extracted
 * record mapped to its distinct in-scope calling-module count. Internal —
 * not protocol-visible; `RecordEvidence.callerModuleCount` (T019) is the
 * value's consumer-facing spelling.
 *
 * Keying is by record REFERENCE: records are immutable value records
 * (convention pack AP-004) flowing from one `prepareAnalysis` call, and the
 * adapter holds the same array it passes here, so identity is stable and
 * structural lookups (`index.get(record)`) cannot collide across same-named
 * records. In program mode the map is TOTAL — one entry per record, 0 for
 * uncalled records (US3-4); in parse-only mode it is empty.
 */
export type CallerIndex = ReadonlyMap<ExtractionRecord, number>;

/**
 * Builds the caller index over one prepared analysis (FR-016; research R7).
 *
 * In program mode, one `checker.getSignatureUsage` query per extracted
 * record (see the module header for the query-node selection and the
 * qualifying-call-site rules); in parse-only mode the result is the empty
 * index — research R7's documented degradation boundary. An empty record
 * list yields the empty index in either mode (there is nothing to count and
 * no record to derive the analysis root from), even against a live
 * program-mode context.
 *
 * @param context The bootstrapped analysis context — must still be live in
 * program mode (checker calls round-trip to the native compiler server).
 * @param records The extracted function-likes, as `prepareAnalysis`
 * returned them — the same instances the caller will look up by.
 * @param inScopePaths The pattern-filtered, test-excluded source list from
 * `PreparedAnalysis.inScopePaths` (T006) — the identical file set `analyze`
 * reports over, so US3-7's parity is structural.
 * @returns The per-record distinct-module count map — one entry per record
 * in program mode, empty in parse-only mode.
 */
export function buildCallerIndex(
  context: ProgramContext,
  records: readonly ExtractionRecord[],
  inScopePaths: readonly string[],
): CallerIndex {
  // Parse-only is the documented no-checker boundary: an empty index, so no
  // `caller_count` signal can be emitted downstream.
  if (context.mode !== "program") {
    return new Map();
  }
  const [firstRecord] = records;
  if (firstRecord === undefined) {
    // The empty-record case: nothing to count and no record to derive the
    // analysis root from — the empty index, even with a live checker.
    return new Map();
  }
  const inScopeSet = new Set(inScopePaths);
  const realRoot = deriveAnalysisRoot(firstRecord);
  const index = new Map<ExtractionRecord, number>();
  for (const record of records) {
    index.set(
      record,
      distinctCallerModuleCount(context.checker, record, realRoot, inScopeSet),
    );
  }
  return index;
}

/**
 * Counts one record's distinct in-scope calling modules — the per-record
 * body of the index build, kept separate from `buildCallerIndex` so the
 * mode and totality bookkeeping stays flat.
 *
 * @param checker The live program-mode type checker.
 * @param record The function-like to count callers of.
 * @param realRoot The analysis root derived from the record set (see
 * `deriveAnalysisRoot`).
 * @param inScopeSet The in-scope root-relative paths, as a membership set.
 * @returns The number of distinct in-scope modules with at least one
 * qualifying call site (module-level sites included, self-recursion
 * excluded, each module counted once).
 */
function distinctCallerModuleCount(
  checker: Checker,
  record: ExtractionRecord,
  realRoot: string,
  inScopeSet: ReadonlySet<string>,
): number {
  const usages = checker.getSignatureUsage(queryDeclarationFor(record));
  const modules = new Set<string>();
  for (const usage of usages) {
    // Only invoked references count: a usage without a call expression is a
    // read (an alias assignment, a property access on an accessor) — live
    // usage of the binding, but not a call site.
    if (usage.call === undefined) {
      continue;
    }
    const callNode = usage.call.resolve();
    if (callNode === undefined) {
      // A handle the producing project cannot resolve does not identify a
      // call site the index can position — dropped, never counted.
      continue;
    }
    const callRelPath = relativeUnderBase(
      realRoot,
      toPosixSeparators(callNode.getSourceFile().fileName),
    );
    // US3-7's parity filter: only call sites in the identical in-scope file
    // set `analyze` reports over. Out-of-root files (default libraries) and
    // pattern-excluded in-root modules resolve to null or a non-member
    // relPath here and are dropped.
    if (callRelPath === null || !inScopeSet.has(callRelPath)) {
      continue;
    }
    // US3-6: a call positioned inside the record's own body span is the
    // record calling itself (self-recursion), not an inbound caller. The
    // same-file gate keeps the span comparison inside one file's position
    // space; a different function in the same module falls outside the
    // record's span and counts (US3-1 — the defining module is a caller
    // like any other).
    if (callRelPath === record.relPath && isPositionInside(callNode, record.node)) {
      continue;
    }
    modules.add(callRelPath);
  }
  return modules.size;
}

/**
 * Selects the declaration node the checker queries for one record: the
 * record's own node when it bears the declared name, and the name-giving
 * parent declaration for the three assigned expression forms (research R7).
 *
 * The parent shapes mirror extract.ts's `recordNameForExpression` exactly —
 * a variable declaration, object-literal property assignment, or class
 * property declaration whose initializer IS the record's node — because the
 * symbol callers invoke is the binding those parents declare, not the
 * anonymous arrow or function expression itself (querying the expression
 * directly finds no usages: it has no name for the reference machinery to
 * resolve). Every other form, including the `export default` expression
 * (whose parent is the ExportAssignment — the documented resolve-no-caller
 * boundary), is queried as the record node itself.
 *
 * @param record The function-like to select the query declaration for.
 * @returns The node to hand to `checker.getSignatureUsage`.
 */
function queryDeclarationFor(record: ExtractionRecord): Node {
  const node = record.node;
  const parent = node.parent;
  if (
    (isVariableDeclaration(parent) && parent.initializer === node) ||
    (isPropertyAssignment(parent) && parent.initializer === node) ||
    (isPropertyDeclaration(parent) && parent.initializer === node)
  ) {
    return parent;
  }
  return node;
}

/**
 * Derives the analysis root from a record's source file (research R12's
 * pipeline hands `buildCallerIndex` no root of its own): the record's
 * absolute `fileName` is the hermetic host's `join(realRoot, relPath)`
 * spelling served verbatim, so stripping the root-relative suffix recovers
 * the root exactly — the same spelling every other in-root program file's
 * `fileName` uses, which is what makes `relativeUnderBase` exact on the
 * call-site files below.
 *
 * The suffix relation holds by construction (extraction computed each
 * `relPath` as `relativeUnderBase(realRoot, fileName)` for the same
 * `fileName`), so the throw is a fail-loud guard against compiler-surface
 * drift — the models.ts serializer posture — never a reachable path on the
 * verified surface.
 *
 * @param record Any record from the set being indexed.
 * @returns The absolute analysis root in POSIX separators.
 * @throws Error when the record's file name does not end with its
 * root-relative path — an impossible state on the real pipeline.
 */
function deriveAnalysisRoot(record: ExtractionRecord): string {
  const fileName = toPosixSeparators(record.node.getSourceFile().fileName);
  const suffix = `/${record.relPath}`;
  if (!fileName.endsWith(suffix)) {
    throw new Error(
      `caller index cannot relativize "${fileName}" against "${record.relPath}"`,
    );
  }
  return fileName.slice(0, fileName.length - suffix.length);
}

/**
 * Positional containment (US3-6): whether `inner`'s span lies inside
 * `outer`'s — both nodes from the same source file (callers gate on the
 * file first, since positions are file-local). `getStart`/`getEnd` use the
 * same leading-trivia convention on both nodes, so the comparison is
 * self-consistent for full-span containment of the call expression.
 *
 * @param inner The candidate containing node (the call expression).
 * @param outer The enclosing node (the record's declaration).
 * @returns Whether `inner` is positioned inside `outer`'s span.
 */
function isPositionInside(inner: Node, outer: Node): boolean {
  return inner.getStart() >= outer.getStart() && inner.getEnd() <= outer.getEnd();
}

/**
 * Normalizes a path's separators to `/` (a no-op on POSIX, where the
 * analysis pipeline and CI run): keeps the suffix test in
 * `deriveAnalysisRoot` and the `relativeUnderBase` input in one spelling
 * discipline regardless of the platform the server spells file names for.
 *
 * @param path The path to normalize.
 * @returns The same path with platform separators as `/`.
 */
function toPosixSeparators(path: string): string {
  return path.split(sep).join("/");
}
