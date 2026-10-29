// The `test_mapping` method entry (T019; FR-012/FR-013; research R2, R8;
// data-model.md Sections 1 and 8; Constitution Principles I, III, and V).
//
// `testMapping` orchestrates the mapping pipeline's stages over the ONE
// shared analysis pipeline: `prepareAnalysis` with the test-arm widening
// (FR-006 — the identical discovered, pattern-filtered,
// exclusion-filtered target set `analyze` reports, plus the full test
// arm), `detectEffects` over those targets (the same effect sets
// `analyze` reports), then the mapping stages — test collection, target
// indexing, pairing (US1: the naming strategy), assertion collection,
// inference — and FR-013's row assembly, stable-key sort, and
// serialization.
//
// Every stage is deterministic (Constitution I): the result is a pure
// function of the analyzed tree and analyzer version — no timestamps, no
// environment-dependent data — so repeated requests over the same tree
// serialize byte-identically (the two-walk golden R10 pins it end to
// end, walk included).
//
// Strictly static (Constitution V): test files are untrusted input,
// parsed with the compiler API inside the bounded hermetic host, never
// executed or imported — the throwing-module canary in
// tests/quality/pipeline.test.ts pins it. Skip diagnostics flow to the
// injected stderr sink, never stdout (it is reserved for JSON-RPC
// responses).
//
// Empty inputs are successes, never errors (US1-8): no test files, no
// production targets, a match-nothing pattern set, or no pairs all
// yield `{"mappings": []}`.

import type { Writable } from "node:stream";
import { prepareAnalysis } from "../analysis.js";
import { detectEffects } from "../detector.js";
import { derivePackage } from "../models.js";
import { type AssertionSite, collectAssertions } from "./assertions.js";
import { collectTestFunctions, type TestFunction } from "./collect.js";
import { inferSideEffectType } from "./inference.js";
import { buildTargetIndex, pairTests } from "./pairing.js";
import {
  type MappingRow,
  serializeMappingRow,
  type TestMappingResult,
} from "./types.js";

/**
 * One assembled row awaiting the stable-key sort: the wire-shaped row
 * plus its assertion anchor coordinates, which the sort reads numerically
 * (line then character) after the four string keys.
 */
interface PendingRow {
  readonly row: MappingRow;
  /** The assertion's anchor line — the sort's numeric fifth key. */
  readonly line: number;
  /** The assertion's anchor character — the sort's numeric sixth key. */
  readonly character: number;
}

/**
 * FR-013's stable row key: `(test_file, test_function, target_package,
 * target_function, assertion line, assertion character)` — UTF-16
 * code-unit comparison (JavaScript's default `<`) for the string keys,
 * numeric comparison for line and character, so line 10 sorts after
 * line 9, never lexicographically where `"10" < "9"`.
 *
 * Full-key ties return `0` and the platform-stable sort resolves them
 * by emission order — the AST-walk collection order the rows were
 * assembled in — which is the pinned final tie-break: two matcher
 * invocations sharing one expect chain (identical anchor, identical
 * pair) emit in the source order of their matcher properties
 * (data-model Section 8).
 *
 * @param a Left pending row.
 * @param b Right pending row.
 * @returns The six-key comparison result.
 */
function comparePendingRows(a: PendingRow, b: PendingRow): number {
  if (a.row.test_file !== b.row.test_file) {
    return a.row.test_file < b.row.test_file ? -1 : 1;
  }
  if (a.row.test_function !== b.row.test_function) {
    return a.row.test_function < b.row.test_function ? -1 : 1;
  }
  if (a.row.target_package !== b.row.target_package) {
    return a.row.target_package < b.row.target_package ? -1 : 1;
  }
  if (a.row.target_function !== b.row.target_function) {
    return a.row.target_function < b.row.target_function ? -1 : 1;
  }
  if (a.line !== b.line) {
    return a.line - b.line;
  }
  return a.character - b.character;
}

/**
 * The `test_mapping` method's entry (FR-012/FR-013; data-model.md
 * Sections 1 and 8): the serialized `MappingRow[]` payload — one row per
 * (paired test, assertion), assembled in FR-013's stable-key order and
 * already wire-shaped through `serializeMappingRow`, under the result
 * interface's single `mappings` key.
 *
 * The stages, in order (all inside the context's live window):
 *
 * 1. `prepareAnalysis(rootPath, patterns, stderr, { includeTestArm: true })`
 *    — the one shared pipeline (FR-013's one-pipeline guarantee is
 *    structural, never a second walk): the identical target records
 *    `analyze` reports, the full pattern-UNfiltered test arm, and the
 *    bootstrapped `ProgramContext` admitting the test files.
 *    `InvalidRootPathError` propagates untouched for the server to map
 *    to the shared `-32602` root message.
 * 2. `detectEffects` over the target records — the same effect sets
 *    `analyze` reports, threaded through the `TargetIndex` so pairing
 *    and inference share one detection result.
 * 3. `collectTestFunctions` over the test arm — the test-side input,
 *    sorted by `(relPath, collection index)`.
 * 4. `buildTargetIndex` + `pairTests` — US1's naming strategy; US2's
 *    calls and imports strategies slot into the same evaluation loop.
 * 5. `collectAssertions` per paired test (memoized per test function —
 *    a test paired with several targets walks its callback once, never
 *    once per pair), `inferSideEffectType` per (pair, assertion).
 * 6. Row assembly and the stable-key sort, then `serializeMappingRow`.
 *
 * The program-mode context's dispose lifetime is owned here exactly as
 * the analysis handlers own theirs (the same `finally` discipline): the
 * native compiler server behind the context is closed whatever the
 * stage outcomes, so no subprocess outlives one request. A parse-only
 * context owns nothing to dispose. `prepareAnalysis` itself releases
 * the context when extraction throws, and an invalid root throws before
 * any context exists.
 *
 * @param rootPath Absolute or relative project root; validated and
 * realpath-resolved by `prepareAnalysis` (an invalid root throws
 * `InvalidRootPathError`, the server maps to `-32602`).
 * @param patterns The raw `patterns` parameter value; shape-validated by
 * the server (`-32602`) before analysis runs, normalized by
 * `prepareAnalysis`. Patterns narrow the TARGET arm exactly as `analyze`
 * applies them; the test arm is never narrowed (FR-006). A set matching
 * nothing yields `{"mappings": []}`, never an error.
 * @param stderr Injected diagnostic sink (Testability principle);
 * defaults to `process.stderr`. Stdout is never touched.
 * @returns The `TestMappingResult` — `{ mappings: [...] }`, rows in
 * FR-013's stable-key order, `[]` for every empty-input shape.
 * @throws InvalidRootPathError when the root does not exist, is not a
 * directory, or cannot be accessed; the server handler maps it to the
 * contract's `-32602` response.
 */
export async function testMapping(
  rootPath: string,
  patterns?: unknown,
  stderr: Writable = process.stderr,
): Promise<TestMappingResult> {
  const prepared = await prepareAnalysis(rootPath, patterns, stderr, {
    includeTestArm: true,
  });
  try {
    // The same detection result analyze reports, taken while the
    // program-mode context is live (checker queries ride it) and shared
    // by the target index and the inference stage — never a second walk.
    const effects = detectEffects(prepared.records, prepared.context);
    const tests = collectTestFunctions(
      prepared.testPaths,
      prepared.context,
      prepared.rootPath,
      stderr,
    );
    const index = buildTargetIndex(prepared.records, effects, prepared.context);
    const pairs = pairTests(tests, index);

    // Assertion collection memoized per test function: a test paired
    // with several same-named targets walks its callback subtree once,
    // and every pair's rows read the identical sites — evidence never
    // recomputed per assertion (research R8's single-walk discipline).
    const assertionsByTest = new Map<TestFunction, readonly AssertionSite[]>();
    const pending: PendingRow[] = [];
    for (const pair of pairs) {
      const sites = assertionsByTest.get(pair.test);
      const assertions = sites ?? collectAssertions(pair.test, stderr);
      if (sites === undefined) {
        assertionsByTest.set(pair.test, assertions);
      }
      const targetEffects = index.effects.get(pair.target) ?? [];
      for (const assertion of assertions) {
        pending.push({
          row: {
            test_function: pair.test.qualifiedTitle,
            test_file: pair.test.relPath,
            assertion_location: `${pair.test.relPath}:${assertion.line}`,
            assertion_type: assertion.kind,
            target_function: pair.target.name,
            target_package: derivePackage(pair.target.relPath),
            side_effect_type: inferSideEffectType(assertion, pair, targetEffects),
            confidence: pair.confidence,
          },
          line: assertion.line,
          character: assertion.character,
        });
      }
    }

    // The platform-stable sort: full-key ties (two matcher invocations
    // sharing one expect chain) keep their AST-walk collection order —
    // the pinned final tie-break.
    pending.sort(comparePendingRows);
    return { mappings: pending.map((entry) => serializeMappingRow(entry.row)) };
  } finally {
    if (prepared.context.mode === "program") {
      prepared.context.dispose();
    }
  }
}
