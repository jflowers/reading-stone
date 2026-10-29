// The TargetIndex and the naming pairing strategy (T016; FR-004/FR-005's
// naming tier; research R4; data-model.md Sections 5.3–5.4 and 6;
// Constitution Principles I and III).
//
// Pairing connects a collected `TestFunction` (src/quality/collect.ts) to
// the `ExtractionRecord` targets it exercises. The `TargetIndex` is the
// pairing-support view over one pipeline run's prepared analysis — built
// once, consulted by every strategy — and the naming strategy is US1's
// pairing tier: a test whose title or nearest enclosing describe title
// equals a target name pairs by convention (research R4's
// conventional-title tier, the highest-availability signal).
//
// The strategy is purely lexical — no compiler queries, no I/O — so it
// runs identically in both `ProgramContext` modes (degradation reduces
// precision, never availability; research R4). The US2 strategies that
// DO consult the checker (calls, imports; T025) extend the evaluation
// loop below, reading the live context through the index.
//
// Determinism (Constitution I): every emitted list is ordered by the
// analyze record order — `(file, line, name)` through
// `compareFileLineName` — so repeated runs over the same tree pair
// byte-identically.

import type { Node } from "typescript/unstable/ast";
import type { ExtractionRecord } from "../extract.js";
import { compareFileLineName } from "../internal.js";
import type { Effect } from "../models.js";
import type { ProgramContext } from "../program.js";
import type { TestFunction } from "./collect.js";

/**
 * The pairing strategies, in evaluation priority order (data-model.md
 * Section 6; FR-004/FR-005's pinned confidences):
 *
 * - `naming` — the test's title or nearest enclosing describe title
 *   equals a target name: exact (case-sensitive) `90`, case-insensitive
 *   only `70`.
 * - `calls` — the test's callback contains a call expression resolving
 *   to the target: `80` (US2, T025).
 * - `imports` — the test's file statically imports and references the
 *   target: `75` (US2, T025).
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
 * review fix F1): within ONE test function's emitted pairs, the wire
 * pair key `(test_function, test_file, target_package, target_function)`
 * is unique. The test side is constant within one test's pairs, and the
 * row's `target_package` is derived from the target's file — a pure
 * function of `relPath` — so the key reduces here to
 * `(target relPath, target name)`: two distinct records sharing one file
 * and one declared name (same-named methods of different classes) are
 * wire-indistinguishable targets, and only the FIRST in the strategy's
 * record-ordered emission survives — the `byNode` first-wins discipline.
 * The collapse is a documented conservative imprecision: later
 * same-named records in the same file emit no pairs and no rows.
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
    const key = `${pair.target.relPath}\0${pair.target.name}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    kept.push(pair);
  }
  return kept;
}

/**
 * Pairs the collected test functions with their target records
 * (FR-004/FR-005): per test, the strategies evaluate in fixed priority
 * order — naming → calls → imports (US2's T025 extends the loop with
 * the latter two) — first-match-wins: evaluation stops at the first
 * strategy with any match, and only that strategy's pairs are emitted.
 * Each test's winning emission flows through the per-test pair-key
 * first-wins dedup (`dedupeByPairKey`, FR-005's amended soundness pin).
 *
 * US1's surface is the naming strategy alone; the loop structure and
 * the per-test independence it establishes are the seams US2 slots
 * into. Each test pairs independently — one test's matches never
 * affect another's — and unpaired tests produce no pairs, never
 * confidence-0 rows.
 *
 * @param tests The collected test functions (the collector's sorted output).
 * @param index The pairing-support target index for the same run.
 * @returns The pairs: per test in input order, each test's matches in
 * analyze record order `(file, line, name)`, wire-indistinguishable
 * same-file-same-name targets collapsed to the first record.
 */
export function pairTests(
  tests: readonly TestFunction[],
  index: TargetIndex,
): Pairing[] {
  const pairs: Pairing[] = [];
  // The folded name view is shared across every test in the call — one
  // scan of the records, not one per test (the strategy reads it; it
  // owns no other per-call state).
  const folded = buildFoldedNameIndex(index);
  for (const test of tests) {
    const named = dedupeByPairKey(namingPairs(test, index, folded));
    if (named.length > 0) {
      pairs.push(...named);
    }
    // US2's calls (80) and imports (75) strategies evaluate here, in
    // priority order after a naming miss, first-match-wins (T025) —
    // each tier's emission flows through the same per-test dedup.
  }
  return pairs;
}
