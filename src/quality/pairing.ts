// The pairing strategies and their first-match-wins evaluation loop (T016 +
// T025; FR-004/FR-005; research R4, R12; data-model.md Sections 5.3–5.4 and
// 6; Constitution Principles I, III, and V).
//
// Pairing connects a collected `TestFunction` (src/quality/collect.ts) to
// the `ExtractionRecord` targets it exercises. The `TargetIndex` is the
// pairing-support view over one pipeline run's prepared analysis — built
// once, consulted by every strategy — and the three strategies evaluate per
// test in fixed priority order (data-model Section 6):
//
// 1. `naming` (exact 90 / case-insensitive 70) — purely lexical: a test
//    whose title or nearest enclosing describe title equals a target name
//    pairs by convention (research R4's conventional-title tier, the
//    highest-availability signal). No compiler queries, no I/O — the
//    strategy runs identically in both `ProgramContext` modes.
// 2. `calls` (80) — the test's callback subtree contains a call resolving
//    to the target. Checker mode resolves each callee through
//    `checker.getSymbolAtLocation` (the verified surface
//    src/signals/evidence.ts rides) with aliases followed through the
//    shared `resolveSymbolAliases`, then matches the symbol's declaration
//    against `byNode` — method and property callees included, the symbol
//    identifies the declaring function. Parse-only matches the callee's
//    terminal identifier text against target names (research R4's
//    documented false-positive surface — degradation reduces precision,
//    never availability).
// 3. `imports` (75) — the test FILE statically imports the target through
//    a named import specifier AND references the binding outside the
//    import clause (a lexical identifier scan in BOTH modes — the pinned
//    precision concession: a per-identifier checker query would cost one
//    round-trip per identifier per file, disproportionate to the
//    75-confidence evidence class). Checker mode resolves each specifier
//    symbol with re-exports followed (edge case 7's barrel rule);
//    parse-only resolves the module specifier against the test file's
//    directory over the discovered in-root file set — the walk's six
//    extensions and `index` forms, barrels uncrossed, package specifiers
//    and root escapes resolving to nothing (the FR-004 containment guard:
//    a pure key computation over the discovered set, never a filesystem
//    probe — Constitution V). Every test in the file not already paired by
//    a higher-priority strategy pairs with each referenced target.
//
// First-match-wins per test (FR-004/US2-7): evaluation stops at the first
// strategy with any match and only that strategy's pairs are emitted — a
// test paired by naming never evaluates calls or imports.
//
// Determinism (Constitution I): every emitted list is ordered by the
// analyze record order — `(file, line, name)` through
// `compareFileLineName` — so repeated runs over the same tree pair
// byte-identically. Checker traffic is pinned (research R4): one
// `getSymbolAtLocation` query per call expression inside test callbacks
// and per import specifier per test file, with the file-scoped import
// evidence memoized per `pairTests` call — never recomputed per test or
// per assertion.
//
// Every walk this module owns (the callback-subtree call scan, the
// whole-file reference scan) is depth-bounded by the shared
// `MAPPING_WALK_DEPTH_BUDGET` (F2; plan.md Scale/Scope): pathological
// input degrades to a per-test or per-file skip with exactly one
// diagnostic written to the injected stderr — never a request crash
// (Constitution V).

import { join, posix } from "node:path";
import type { Writable } from "node:stream";
import {
  type CallExpression,
  type ImportSpecifier,
  isCallExpression,
  isIdentifier,
  isImportDeclaration,
  isNamedImports,
  isPropertyAccessExpression,
  isStringLiteral,
  type Node,
  type SourceFile,
  SyntaxKind,
} from "typescript/unstable/ast";
import { WALKED_EXTENSIONS } from "../discovery.js";
import type { ExtractionRecord } from "../extract.js";
import { compareFileLineName, MAPPING_WALK_DEPTH_BUDGET } from "../internal.js";
import { derivePackage, type Effect } from "../models.js";
import { type ProgramContext, resolveSymbolAliases } from "../program.js";
import type { TestFunction } from "./collect.js";

/**
 * The pairing strategies, in evaluation priority order (data-model.md
 * Section 6; FR-004/FR-005's pinned confidences):
 *
 * - `naming` — the test's title or nearest enclosing describe title
 *   equals a target name: exact (case-sensitive) `90`, case-insensitive
 *   only `70`.
 * - `calls` — the test's callback subtree contains a call expression
 *   resolving to the target: `80`.
 * - `imports` — the test's file statically imports and references the
 *   target through a named specifier: `75`.
 *
 * The union is the closed strategy vocabulary the `Pairing` record and
 * the row `confidence` values are pinned against; the full
 * first-match-wins evaluation order is naming → calls → imports (FR-005).
 */
export type PairingStrategy = "naming" | "calls" | "imports";

/**
 * The closed confidence vocabulary (data-model.md Section 5.3): one fixed
 * integer per strategy tier — naming exact `90`, naming case-insensitive
 * `70`, direct calls `80`, import graph `75`. A literal union, not
 * `number`, so the pin is compile-time enforced and an out-of-vocabulary
 * confidence cannot typecheck (iteration-2 review fix F6).
 */
export type PairingConfidence = 90 | 70 | 80 | 75;

/**
 * One established test-to-target pair (data-model.md Section 5.3): the
 * test and target are reference-identity carries of the collector's and
 * the pipeline's own objects — not copies — so downstream stages
 * (assertion collection, inference) keep AST access.
 */
export interface Pairing {
  /** The collected test function, by reference into the collector's output. */
  readonly test: TestFunction;
  /** The paired target record, by reference into the prepared records. */
  readonly target: ExtractionRecord;
  /** The strategy that established the pair. */
  readonly strategy: PairingStrategy;
  /** The strategy's fixed confidence — the closed union Section 5.3 pins. */
  readonly confidence: PairingConfidence;
}

/**
 * The pairing-support view over one pipeline run's prepared analysis
 * (data-model.md Section 5.4), built once per run by
 * `buildTargetIndex`:
 *
 * - `records` — the in-scope source records in `(file, line, name)` order
 *   (the identical `analyze` set; FR-006's target parity), the order
 *   every strategy's output follows.
 * - `byName` — declared name → the records carrying it, in record order
 *   (the naming strategy's lookup).
 * - `byNode` — declaration node → record (the checker-mode strategies'
 *   symbol-declaration matching, US2).
 * - `effects` — the `detectEffects` output per record (the inference
 *   stage's input, threaded here so pairing and inference share one
 *   detection result — never a second walk).
 * - `context` — the live `ProgramContext`; the pipeline entry owns
 *   disposal, the index only lends read access.
 */
export interface TargetIndex {
  /** The in-scope records, `(file, line, name)`-sorted. */
  readonly records: readonly ExtractionRecord[];
  /** Declared name → the records carrying it, in record order. */
  readonly byName: ReadonlyMap<string, readonly ExtractionRecord[]>;
  /** Declaration node → record (checker-mode symbol matching). */
  readonly byNode: ReadonlyMap<Node, ExtractionRecord>;
  /** The per-record effect sets (`detectEffects`' output). */
  readonly effects: ReadonlyMap<ExtractionRecord, readonly Effect[]>;
  /** The live analysis context; read-only lending, never owned. */
  readonly context: ProgramContext;
}

/**
 * Builds the pairing-support `TargetIndex` over one pipeline run's
 * prepared analysis (data-model.md Section 5.4).
 *
 * The records are sorted by the analyze record order —
 * `compareFileLineName` over `(relPath, line, name)` — so `records` and
 * every `byName` list are deterministic and match `analyze`'s reported
 * order even when a caller (hand-built test fixtures included) passes an
 * unsorted list. The sort is idempotent over `prepareAnalysis` output,
 * which is already in that order.
 *
 * @param records The in-scope source records (the identical `analyze`
 * set, FR-006's target parity).
 * @param effects The `detectEffects` output per record.
 * @param context The live `ProgramContext` of the same run; lent
 * read-only, never disposed here.
 * @returns The index every pairing strategy consults.
 */
export function buildTargetIndex(
  records: readonly ExtractionRecord[],
  effects: ReadonlyMap<ExtractionRecord, readonly Effect[]>,
  context: ProgramContext,
): TargetIndex {
  const ordered = [...records].sort((a, b) =>
    compareFileLineName(
      { file: a.relPath, line: a.line, name: a.name },
      { file: b.relPath, line: b.line, name: b.name },
    ),
  );
  const byName = new Map<string, ExtractionRecord[]>();
  const byNode = new Map<Node, ExtractionRecord>();
  for (const record of ordered) {
    const list = byName.get(record.name);
    if (list === undefined) {
      byName.set(record.name, [record]);
    } else {
      list.push(record);
    }
    // First-wins on a node-key collision: real extraction never produces
    // two records for one function-like node, so a collision only arises
    // in hand-built inputs — and the record order is the canonical one,
    // so the first record in that order owns the key (a later `set` would
    // silently flip the answer to whichever record sorted last).
    if (!byNode.has(record.node)) {
      byNode.set(record.node, record);
    }
  }
  return { records: ordered, byName, byNode, effects, context };
}

/** The naming strategy's exact-tier confidence (case-sensitive title match). */
const NAMING_EXACT_CONFIDENCE = 90;

/** The naming strategy's case-insensitive-only tier confidence. */
const NAMING_FOLD_CONFIDENCE = 70;

/** The calls strategy's confidence (a callback-subtree call resolving to the target). */
const CALLS_CONFIDENCE = 80;

/** The imports strategy's confidence (a referenced named import of the target). */
const IMPORTS_CONFIDENCE = 75;

/**
 * The strategy walks' depth sentinel (F2): raised when the callback-subtree
 * call scan or the whole-file reference scan passes the shared
 * `MAPPING_WALK_DEPTH_BUDGET`, caught at the owning strategy boundary —
 * never escapes this module (the extract.ts `AstDepthExceeded` discipline).
 * A `RangeError` from lazy node materialization is caught at the same site
 * and treated identically.
 */
class MappingWalkDepthExceeded extends Error {
  constructor() {
    super("ast depth exceeds budget");
  }
}

/**
 * The case-folded name view, built once per `pairTests` call: folded
 * declared name → the records carrying any spelling of it, in record
 * order. `toLowerCase` on both sides — platform-stable, no locale fold
 * (research R4) — and deduplicated across spellings that fold together
 * (`Add` and `ADD` share one list), each record appearing exactly once.
 */
type FoldedNameIndex = ReadonlyMap<string, readonly ExtractionRecord[]>;

/**
 * Builds the case-folded name view over the index's records — one scan,
 * record order preserved by construction (the input is
 * `compareFileLineName`-sorted), so the fold tier's output needs no
 * re-sort.
 */
function buildFoldedNameIndex(index: TargetIndex): FoldedNameIndex {
  const folded = new Map<string, ExtractionRecord[]>();
  for (const record of index.records) {
    const key = record.name.toLowerCase();
    const list = folded.get(key);
    if (list === undefined) {
      folded.set(key, [record]);
    } else {
      list.push(record);
    }
  }
  return folded;
}

/**
 * Collects a match set back into the analyze record order: filters the
 * index's `(file, line, name)`-sorted records by membership, so every
 * strategy's output follows FR-005's deterministic order regardless of
 * how the matches were gathered (title and describe contributions
 * merge, same-named targets stream in record order).
 *
 * @param index The target index whose `records` supply the order.
 * @param matches The matched records, in any order.
 * @returns The matched records in `(file, line, name)` order.
 */
function inRecordOrder(
  index: TargetIndex,
  matches: ReadonlySet<ExtractionRecord>,
): readonly ExtractionRecord[] {
  return index.records.filter((record) => matches.has(record));
}

/**
 * The naming strategy (FR-004/FR-005's naming tier; research R4;
 * data-model.md Section 6): a test whose title OR nearest enclosing
 * describe title equals a target name pairs — the match rule is a
 * disjunction, both candidate names contributing their matches at the
 * same tier.
 *
 * Tiering is per test (research R4): the exact tier (case-sensitive
 * equality) shadows the case-insensitive tier — a test matching one
 * target exactly and another case-insensitively emits only the exact
 * pairs at `90`. With no exact match, the case-insensitive tier
 * (`toLowerCase` both sides, no locale fold) pairs at `70`. A test
 * matched by neither tier produces no pairs — never confidence-0 rows.
 *
 * Only the NEAREST enclosing describe title is consulted (data-model
 * Section 5.1): outer levels qualify the title, never pair it. An empty
 * title or describe segment matches nothing — extraction names are
 * never empty, so the lookup is structurally miss-free.
 *
 * @param test The collected test function.
 * @param index The pairing-support target index.
 * @param folded The case-folded name view shared across the call's tests.
 * @returns The naming pairs, in analyze record order — `[]` when the
 * strategy matches nothing (evaluation falls through to the next
 * strategy).
 */
function namingPairs(
  test: TestFunction,
  index: TargetIndex,
  folded: FoldedNameIndex,
): readonly Pairing[] {
  // The two candidate names (data-model Section 5.1): the title, and
  // the nearest enclosing describe title when one exists.
  const candidates = new Set<string>([test.title]);
  if (test.describeTitles.length > 0) {
    candidates.add(test.describeTitles[test.describeTitles.length - 1] ?? "");
  }

  const exact = new Set<ExtractionRecord>();
  for (const name of candidates) {
    for (const record of index.byName.get(name) ?? []) {
      exact.add(record);
    }
  }
  if (exact.size > 0) {
    return inRecordOrder(index, exact).map((target) => ({
      test,
      target,
      strategy: "naming" as const,
      confidence: NAMING_EXACT_CONFIDENCE,
    }));
  }

  const fold = new Set<ExtractionRecord>();
  for (const name of candidates) {
    for (const record of folded.get(name.toLowerCase()) ?? []) {
      fold.add(record);
    }
  }
  if (fold.size > 0) {
    return inRecordOrder(index, fold).map((target) => ({
      test,
      target,
      strategy: "naming" as const,
      confidence: NAMING_FOLD_CONFIDENCE,
    }));
  }
  return [];
}

/**
 * The per-test pair-key first-wins dedup (FR-005 amended; iteration-2
 * review fix F1, extended iteration-3 to the derived wire key): within
 * ONE test function's emitted pairs, the wire pair key
 * `(test_function, test_file, target_package, target_function)` is
 * unique. The test side is constant within one test's pairs, and the
 * row's `target_package` is derived from the target's file — a pure
 * function of `relPath` — so the key reduces here to the derived wire
 * identity `(derivePackage(relPath), name)`. `derivePackage` is NOT
 * injective over files (same-stem different extensions
 * `util.js`/`util.cjs`; a dot in a stem vs a nested directory
 * `a.b.ts`/`a/b.ts`; a file vs its directory index
 * `pkg.ts`/`pkg/index.ts`), so two distinct records that share one file
 * and one declared name (same-named methods of different classes) OR
 * that sit in different files whose paths derive the same package while
 * sharing the declared name, are wire-indistinguishable targets — and
 * only the FIRST in the strategy's record-ordered emission survives —
 * the `byNode` first-wins discipline. The collapse is a documented
 * conservative imprecision: later wire-indistinguishable records emit
 * no pairs and no rows.
 *
 * The dedup domain is deliberately the test function, never the bare
 * wire tuple: same-titled sibling tests inside one describe (spec edge
 * case 2) share `test_function` but are distinct test functions, each
 * keeping its own pairs (their rows disambiguate downstream through
 * `assertion_location`). Strategy-agnostic by construction — whatever
 * the winning strategy emitted gets deduped — so the US2 calls/imports
 * tiers inherit the rule without re-plumbing.
 *
 * @param testPairs One test's emitted pairs, in record order.
 * @returns The deduplicated pairs — order and first-wins preserved.
 */
function dedupeByPairKey(testPairs: readonly Pairing[]): readonly Pairing[] {
  const seen = new Set<string>();
  const kept: Pairing[] = [];
  for (const pair of testPairs) {
    // The derived wire identity, not (relPath, name): colliding-package
    // files (pkg.ts vs pkg/index.ts) derive one target_package, so the
    // key must collapse them exactly like the same-file case — the
    // iteration-3 F1 amendment (data-model.md Section 6).
    const key = `${derivePackage(pair.target.relPath)}\0${pair.target.name}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    kept.push(pair);
  }
  return kept;
}

/**
 * Resolves one test file's parsed source in either bootstrap mode — the
 * collect.ts `resolveTestSources` route for a single path: parse-only
 * sources are keyed by root-relative path already; program-mode source
 * names are the compiler's absolute file names, spelled exactly as the
 * extender config's `files` root set spelled them — `join(realRoot,
 * relPath)` — so the same join resolves them back.
 *
 * @param relPath The test file's root-relative POSIX path.
 * @param context The bootstrapped `ProgramContext` of the same run.
 * @param rootPath Realpath-resolved absolute analysis root — the
 * program-mode source-name base.
 * @returns The file's parsed source, or undefined when absent from the
 * bootstrap (a pre-read skip whose diagnostic readBounded already wrote).
 */
function testSourceFile(
  relPath: string,
  context: ProgramContext,
  rootPath: string,
): SourceFile | undefined {
  if (context.mode === "parse-only") {
    return context.sources.get(relPath);
  }
  return context.program.getSourceFile(join(rootPath, relPath));
}

/**
 * The calls strategy (FR-004/FR-005's calls tier; research R4; data-model
 * Section 6): the test's callback subtree is scanned for `CallExpression`s
 * — nested function expressions inside the callback included, exactly the
 * assertion walk's scan domain — and each distinct target reached pairs at
 * `80`, in analyze record order.
 *
 * Checker mode resolves each callee through `getSymbolAtLocation` and
 * matches the resolved symbol's declaration against `byNode` (one query
 * per call expression — the pinned traffic bound); parse-only matches the
 * callee's terminal identifier text against target names (documented
 * false-positive surface). A test whose callback argument is a bare
 * identifier reference (no subtree) has no call evidence — the truthful
 * empty result, never a scan of the referenced function's body.
 *
 * The walk is depth-bounded (F2): a pathological callback discards only
 * THIS test's call pairs — the assertion walk's per-test skip unit — with
 * exactly one diagnostic to `stderr`.
 *
 * @param test The collected test function.
 * @param index The pairing-support target index.
 * @param stderr The diagnostic sink for depth-budget skips.
 * @returns The calls pairs, in analyze record order — `[]` when the
 * strategy matches nothing (evaluation falls through to imports).
 */
function callsPairs(
  test: TestFunction,
  index: TargetIndex,
  stderr: Writable,
): readonly Pairing[] {
  const callback = test.callback;
  if (callback === null) {
    return [];
  }
  const matches = new Set<ExtractionRecord>();
  try {
    walkForCalls(callback, index, matches, 0);
  } catch (error) {
    // Only the depth sentinel and a materialization RangeError are
    // diagnosed skips; anything else escapes (a crash is never a silent
    // skip — the collectAssertions rethrow discipline).
    if (!(error instanceof MappingWalkDepthExceeded || error instanceof RangeError)) {
      throw error;
    }
    stderr.write(
      `reading-stone: skipping call pairing in ${test.relPath}:${test.line}: ast depth exceeds budget\n`,
    );
    return [];
  }
  if (matches.size === 0) {
    return [];
  }
  return inRecordOrder(index, matches).map((target) => ({
    test,
    target,
    strategy: "calls" as const,
    confidence: CALLS_CONFIDENCE,
  }));
}

/**
 * The calls walk: a post-order descent over the test's callback subtree
 * (children before the node — the assertion walk's discipline), collecting
 * every `CallExpression`'s target match. Depth-bounded by the shared
 * `MAPPING_WALK_DEPTH_BUDGET`; the sentinel raised past the budget is
 * caught by `callsPairs`' per-test skip.
 *
 * @param node The subtree root (the test's callback).
 * @param index The pairing-support target index.
 * @param matches The matched records, gathered as a set.
 * @param depth The current nesting depth (0 at the callback root).
 */
function walkForCalls(
  node: Node,
  index: TargetIndex,
  matches: Set<ExtractionRecord>,
  depth: number,
): void {
  if (depth > MAPPING_WALK_DEPTH_BUDGET) {
    throw new MappingWalkDepthExceeded();
  }
  node.forEachChild((child) => {
    walkForCalls(child, index, matches, depth + 1);
  });
  if (!isCallExpression(node)) {
    return;
  }
  collectCallTarget(node, index, matches);
}

/**
 * Resolves one call expression's callee to target records, per mode
 * (research R4): checker mode through the symbol route, parse-only through
 * terminal-identifier name matching.
 *
 * The query node both modes read is the callee's terminal identifier — the
 * callee identifier itself for a plain call (`add(...)`), the invoked
 * property's name for a method or property callee (`calc.add(...)`):
 * checker mode queries the checker AT that identifier (the symbol
 * identifies the declaring function — method and property callees
 * included, the verified route with aliases followed), while parse-only
 * reads its text against `byName`. Every other callee form (an element
 * access, a call-rooted chain) contributes nothing in either mode.
 *
 * @param call The collected call expression.
 * @param index The pairing-support target index.
 * @param matches The matched records, gathered as a set.
 */
function collectCallTarget(
  call: CallExpression,
  index: TargetIndex,
  matches: Set<ExtractionRecord>,
): void {
  const callee = call.expression;
  const terminal = isIdentifier(callee)
    ? callee
    : isPropertyAccessExpression(callee)
      ? callee.name
      : null;
  if (terminal === null) {
    return;
  }
  if (index.context.mode === "program") {
    const { checker } = index.context;
    const symbol = checker.getSymbolAtLocation(terminal);
    const resolved = resolveSymbolAliases(checker, symbol);
    if (resolved === null) {
      return;
    }
    for (const declaration of resolved.declarations) {
      const declarationNode = declaration.resolve();
      const record =
        declarationNode === undefined ? undefined : index.byNode.get(declarationNode);
      if (record !== undefined) {
        matches.add(record);
      }
    }
    return;
  }
  for (const record of index.byName.get(terminal.text) ?? []) {
    matches.add(record);
  }
}

/**
 * One named-import binding — the imports tier's unit of evidence: the
 * specifier node the checker query reads, the module specifier text the
 * parse-only resolver reads, the local binding name the reference scan
 * looks for, and the module-side imported name the parse-only record
 * matching looks for (they differ only under `as` renames:
 * `import { add as sum }` binds `sum` locally against the module's `add`).
 */
interface ImportBinding {
  /** The named import specifier (the checker query's node). */
  readonly specifier: ImportSpecifier;
  /** The module specifier text (`"../src/math"`), unquoted. */
  readonly moduleSpecifier: string;
  /** The local binding name — the reference scan's subject. */
  readonly localName: string;
  /** The module-side name — the parse-only record matching's subject. */
  readonly importedName: string;
}

/**
 * The imports tier's per-`pairTests`-call state: the memoized file-scoped
 * import evidence (computed once per test file, only when a test actually
 * reaches the third tier — a file whose every test pairs by naming or
 * calls is never analyzed) and the parse-only records-by-file view (built
 * lazily on first parse-only need — never at all when no test reaches the
 * tier).
 */
interface ImportsTier {
  /** The pairing-support target index of the same run. */
  readonly index: TargetIndex;
  /** Realpath-resolved absolute analysis root — the program-mode base. */
  readonly rootPath: string;
  /** The diagnostic sink for depth-budget skips. */
  readonly stderr: Writable;
  /** Memoized per-file import evidence: relPath → referenced target records. */
  readonly evidenceByFile: Map<string, readonly ExtractionRecord[]>;
  /** The parse-only `(relPath, name)` record view, built on first need. */
  recordsByFile: Map<string, ReadonlyMap<string, readonly ExtractionRecord[]>> | null;
}

/**
 * The imports tier's file-scoped evidence (FR-004/FR-005's imports tier;
 * research R4; data-model Section 6): the target records this test file
 * statically imports through named specifiers AND references outside the
 * import clause, in analyze record order — `[]` when none.
 *
 * The order of operations is deliberate: the reference scan runs FIRST
 * (the cheap, mode-independent lexical pass), so an unused import is dead
 * evidence (US2-5) that never reaches the checker queries or the
 * parse-only record matching — the unreferenced specifier costs nothing.
 * The reference scan is depth-bounded (F2): a pathological file discards
 * its whole import evidence with exactly one diagnostic (per-file skip —
 * its tests fall through to unpaired, never a crash).
 *
 * @param tier The imports tier's per-run state.
 * @param relPath The test file's root-relative POSIX path.
 * @returns The referenced imported targets, in analyze record order.
 */
function importedTargetsFor(
  tier: ImportsTier,
  relPath: string,
): readonly ExtractionRecord[] {
  const sourceFile = testSourceFile(relPath, tier.index.context, tier.rootPath);
  if (sourceFile === undefined) {
    return [];
  }
  const bindings = namedImportBindings(sourceFile);
  if (bindings.length === 0) {
    return [];
  }

  let referencedNames: Set<string>;
  try {
    referencedNames = collectReferencedNames(sourceFile);
  } catch (error) {
    if (!(error instanceof MappingWalkDepthExceeded || error instanceof RangeError)) {
      throw error;
    }
    tier.stderr.write(
      `reading-stone: skipping import pairing in ${relPath}: ast depth exceeds budget\n`,
    );
    return [];
  }

  const matches = new Set<ExtractionRecord>();
  for (const binding of bindings) {
    if (!referencedNames.has(binding.localName)) {
      // US2-5: an unused import is dead evidence — pairs nothing.
      continue;
    }
    collectImportTargets(tier, relPath, binding, matches);
  }
  if (matches.size === 0) {
    return [];
  }
  return inRecordOrder(tier.index, matches);
}

/**
 * Collects the file's named-import bindings — a statement-level scan (no
 * recursion, so no depth budget): import declarations are top-level only,
 * and the named-specifier elements are read directly off each clause.
 * Type-only imports are skipped (the whole-clause `import type` form and
 * the inline `{ type X }` element form alike): the erased binding names a
 * type, never a runtime target. Default and namespace imports carry no
 * named specifier and contribute nothing (a default-imported or
 * namespace-referenced function still pairs through the calls tier, whose
 * callee resolution is import-form-agnostic).
 *
 * @param sourceFile The test file's parsed source.
 * @returns The named-import bindings, in source order.
 */
function namedImportBindings(sourceFile: SourceFile): ImportBinding[] {
  const bindings: ImportBinding[] = [];
  for (const statement of sourceFile.statements) {
    if (!isImportDeclaration(statement)) {
      continue;
    }
    const clause = statement.importClause;
    // The whole-clause `import type` form: TS 7's native AST spells the
    // erased marker as the clause's `type` phase modifier, not a boolean.
    if (clause === undefined || clause.phaseModifier === SyntaxKind.TypeKeyword) {
      continue;
    }
    const moduleSpecifier = isStringLiteral(statement.moduleSpecifier)
      ? statement.moduleSpecifier.text
      : null;
    if (moduleSpecifier === null) {
      continue;
    }
    const named = clause.namedBindings;
    if (named === undefined || !isNamedImports(named)) {
      continue;
    }
    for (const specifier of named.elements) {
      if (specifier.isTypeOnly) {
        continue;
      }
      bindings.push({
        specifier,
        moduleSpecifier,
        localName: specifier.name.text,
        importedName: specifier.propertyName?.text ?? specifier.name.text,
      });
    }
  }
  return bindings;
}

/**
 * The reference-presence scan (research R4's pinned precision concession):
 * every identifier text appearing ANYWHERE in the file outside the import
 * clauses — a single whole-file walk, both modes, never per-identifier
 * checker queries. Deliberately coarse: a same-named property or a
 * shadowed local counts as a reference (the documented conservative
 * imprecision — availability over precision at the 75 tier).
 *
 * @param sourceFile The test file's parsed source.
 * @returns The referenced identifier texts (import clauses excluded).
 */
function collectReferencedNames(sourceFile: SourceFile): Set<string> {
  const names = new Set<string>();
  const walk = (node: Node, depth: number): void => {
    if (depth > MAPPING_WALK_DEPTH_BUDGET) {
      throw new MappingWalkDepthExceeded();
    }
    node.forEachChild((child) => {
      walk(child, depth + 1);
    });
    if (isIdentifier(node)) {
      names.add(node.text);
    }
  };
  for (const statement of sourceFile.statements) {
    if (isImportDeclaration(statement)) {
      continue;
    }
    walk(statement, 0);
  }
  return names;
}

/**
 * Resolves one referenced import binding to target records, per mode
 * (research R4): checker mode through the specifier symbol with re-exports
 * followed (edge case 7's barrel rule — the alias chain lands on the
 * declaring function's node); parse-only through module-specifier path
 * resolution over the discovered in-root file set, then imported-name
 * matching against the records in the resolved file.
 *
 * @param tier The imports tier's per-run state.
 * @param relPath The test file's root-relative POSIX path.
 * @param binding The referenced import binding.
 * @param matches The matched records, gathered as a set.
 */
function collectImportTargets(
  tier: ImportsTier,
  relPath: string,
  binding: ImportBinding,
  matches: Set<ExtractionRecord>,
): void {
  if (tier.index.context.mode === "program") {
    const { checker } = tier.index.context;
    const symbol = checker.getSymbolAtLocation(binding.specifier.name);
    const resolved = resolveSymbolAliases(checker, symbol);
    if (resolved === null) {
      return;
    }
    for (const declaration of resolved.declarations) {
      const declarationNode = declaration.resolve();
      const record =
        declarationNode === undefined
          ? undefined
          : tier.index.byNode.get(declarationNode);
      if (record !== undefined) {
        matches.add(record);
      }
    }
    return;
  }
  const resolvedPath = resolveSpecifierPath(tier, relPath, binding.moduleSpecifier);
  if (resolvedPath === null) {
    return;
  }
  const fileRecords = recordsByFileView(tier).get(resolvedPath);
  for (const record of fileRecords?.get(binding.importedName) ?? []) {
    matches.add(record);
  }
}

/**
 * The parse-only records-by-file view: root-relative path → declared name →
 * the records carrying it, in record order (the input is
 * `compareFileLineName`-sorted, so the lists need no re-sort). Built once
 * per `pairTests` call, lazily — the checker-mode run never builds it.
 *
 * @param tier The imports tier's per-run state.
 * @returns The `(relPath, name)` record view.
 */
function recordsByFileView(
  tier: ImportsTier,
): Map<string, ReadonlyMap<string, readonly ExtractionRecord[]>> {
  if (tier.recordsByFile === null) {
    const view = new Map<string, Map<string, ExtractionRecord[]>>();
    for (const record of tier.index.records) {
      let names = view.get(record.relPath);
      if (names === undefined) {
        names = new Map();
        view.set(record.relPath, names);
      }
      const list = names.get(record.name);
      if (list === undefined) {
        names.set(record.name, [record]);
      } else {
        list.push(record);
      }
    }
    tier.recordsByFile = view;
  }
  return tier.recordsByFile;
}

/**
 * The parse-only module-specifier path resolution (research R4; data-model
 * Section 6's containment pin): a pure key computation over the discovered
 * in-root file set — never a filesystem probe (Constitution V).
 *
 * Only relative specifiers (`./`, `../`) resolve; package specifiers
 * (`node:...`, bare package names) denote no in-root target and resolve to
 * nothing. The specifier is joined against the test file's directory and
 * normalized lexically (POSIX — the relPath discipline); a resolved path
 * escaping the analysis root (leading `..`) or absolute resolves to
 * nothing. The candidate enumeration, in order: the bare resolved path (a
 * specifier naming a discovered file exactly), then the walk's six
 * extensions, then the `index` forms — discovery's own
 * `WALKED_EXTENSIONS` order, so resolution and discovery can never
 * disagree about which extensions name an in-root module. The first
 * candidate present in the discovered set wins; a `.js`-suffixed
 * specifier naming a `.ts` file does not substitute (the documented
 * boundary — extensionless specifiers resolve through the enumeration).
 *
 * @param tier The imports tier's per-run state (carries the parse-only
 * sources map — the discovered in-root file set).
 * @param testRelPath The test file's root-relative POSIX path.
 * @param moduleSpecifier The module specifier text, unquoted.
 * @returns The resolved root-relative POSIX path, or null when the
 * specifier resolves to nothing.
 */
function resolveSpecifierPath(
  tier: ImportsTier,
  testRelPath: string,
  moduleSpecifier: string,
): string | null {
  if (!moduleSpecifier.startsWith("./") && !moduleSpecifier.startsWith("../")) {
    return null;
  }
  // `join` normalizes the joined segments lexically, so ".." components
  // resolve away ("tests" + "../src/math" → "src/math").
  const resolved = posix.join(posix.dirname(testRelPath), moduleSpecifier);
  // The containment guard: the literal ".." test errs toward rejecting (the
  // relativeUnderBase precedent — even an in-base sibling such as
  // "..hidden.ts" is refused rather than risk an escape).
  if (resolved === "" || resolved.startsWith("..") || posix.isAbsolute(resolved)) {
    return null;
  }
  // The discovered in-root file set: the parse-only sources map. The
  // resolver runs only from collectImportTargets' parse-only branch, but
  // that narrowing does not cross the call boundary — the guard here makes
  // the access total instead of trusted.
  const context = tier.index.context;
  if (context.mode !== "parse-only") {
    return null;
  }
  const knownFiles = context.sources;
  if (knownFiles.has(resolved)) {
    return resolved;
  }
  for (const extension of WALKED_EXTENSIONS) {
    const candidate = `${resolved}${extension}`;
    if (knownFiles.has(candidate)) {
      return candidate;
    }
  }
  for (const extension of WALKED_EXTENSIONS) {
    const candidate = `${resolved}/index${extension}`;
    if (knownFiles.has(candidate)) {
      return candidate;
    }
  }
  return null;
}

/**
 * Pairs the collected test functions with their target records
 * (FR-004/FR-005): per test, the strategies evaluate in fixed priority
 * order — naming → calls → imports — first-match-wins: evaluation stops
 * at the first strategy with any match, and only that strategy's pairs
 * are emitted (a test paired by naming never evaluates calls or imports;
 * a test paired by calls never evaluates imports). Each test's winning
 * emission flows through the per-test pair-key first-wins dedup
 * (`dedupeByPairKey`, FR-005's amended soundness pin).
 *
 * The imports tier is file-scoped: its evidence (the referenced imported
 * targets) is memoized per test file inside this call, computed only when
 * a test actually reaches the third tier — never recomputed per test, and
 * never at all for a file whose every test pairs by naming or calls
 * (research R4's pinned traffic bound: one `getSymbolAtLocation` query
 * per import specifier per test file).
 *
 * Each test pairs independently — one test's matches never affect
 * another's — and unpaired tests produce no pairs, never confidence-0
 * rows. Every walk the tiers own is depth-bounded by the shared
 * `MAPPING_WALK_DEPTH_BUDGET` (F2), with per-test and per-file skips
 * diagnosed to `stderr`.
 *
 * @param tests The collected test functions (the collector's sorted output).
 * @param index The pairing-support target index for the same run.
 * @param rootPath Realpath-resolved absolute analysis root — the
 * program-mode source-name base for the file-scoped import walk (the
 * collect.ts threading precedent: passed explicitly, never re-derived;
 * never consulted in parse-only mode).
 * @param stderr The diagnostic sink for depth-budget skips (the server's
 * stderr; never stdout — protocol fidelity).
 * @returns The pairs: per test in input order, each test's matches in
 * analyze record order `(file, line, name)`, wire-indistinguishable
 * targets (same-file and colliding-package same-named records alike)
 * collapsed to the first record.
 */
export function pairTests(
  tests: readonly TestFunction[],
  index: TargetIndex,
  rootPath: string,
  stderr: Writable = process.stderr,
): Pairing[] {
  const pairs: Pairing[] = [];
  // The folded name view is shared across every test in the call — one
  // scan of the records, not one per test (the strategy reads it; it
  // owns no other per-call state).
  const folded = buildFoldedNameIndex(index);
  // The imports tier's per-run state: file-scoped evidence memoized per
  // test file, the parse-only record view built lazily on first need.
  const importsTier: ImportsTier = {
    index,
    rootPath,
    stderr,
    evidenceByFile: new Map(),
    recordsByFile: null,
  };
  for (const test of tests) {
    // Priority 1 — naming (purely lexical, mode-independent).
    const named = dedupeByPairKey(namingPairs(test, index, folded));
    if (named.length > 0) {
      pairs.push(...named);
      continue;
    }
    // Priority 2 — calls (the test's own callback subtree).
    const called = dedupeByPairKey(callsPairs(test, index, stderr));
    if (called.length > 0) {
      pairs.push(...called);
      continue;
    }
    // Priority 3 — imports (file-scoped evidence, memoized per file).
    if (!importsTier.evidenceByFile.has(test.relPath)) {
      importsTier.evidenceByFile.set(
        test.relPath,
        importedTargetsFor(importsTier, test.relPath),
      );
    }
    const imported = dedupeByPairKey(
      (importsTier.evidenceByFile.get(test.relPath) ?? []).map((target) => ({
        test,
        target,
        strategy: "imports" as const,
        confidence: IMPORTS_CONFIDENCE,
      })),
    );
    if (imported.length > 0) {
      pairs.push(...imported);
    }
  }
  return pairs;
}
