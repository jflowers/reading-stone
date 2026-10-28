import { isAbsolute, relative, sep } from "node:path";

/**
 * Shared internal primitives consumed across the analysis modules (the
 * review council's DRY finding, dispatch 44e85014): the `(file, line,
 * name)` total order every wire payload is sorted by, and the lexical
 * path-containment test every root-relative spelling flows through.
 *
 * A dedicated leaf module — `node:path` is its only import — so every
 * consumer (extract, detector, complexity, coverage, program) can share
 * these without an import cycle or a layering inversion: extract.ts as
 * the canonical site was considered and rejected because program.ts (a
 * module extract itself depends on) and coverage.ts would then import
 * from their own consumer or an unrelated pipeline stage for a path
 * primitive. Internal, not protocol-visible: `src/index.ts` deliberately
 * does not re-export this module (convention pack AP-001's explicit
 * barrel of the public surface only).
 */

/**
 * The record identity the `(file, line, name)` order sorts by: the
 * root-relative POSIX file path, the 1-based declaration line, and the
 * declared name. `FunctionRecord` and `ComplexityEntry` carry these
 * fields under exactly these names; `ExtractionRecord` spells the file
 * field `relPath` and adapts at its comparator.
 */
export interface FileLineName {
  /** Root-relative POSIX path of the declaring file. */
  readonly file: string;
  /** 1-based line of the function declaration. */
  readonly line: number;
  /** The function's declared name. */
  readonly name: string;
}

/**
 * The FR-008/FR-020 total order: `(file, line, name)` with codepoint
 * comparison for the string keys — the platform-default string comparison
 * the wire contract's golden tests pin — numeric line ordering between
 * them, and `0` on full-key ties so the platform-default stable sort
 * resolves them by emission (source) order — the getter-before-setter
 * resolution for a one-line accessor pair.
 *
 * @param a Left record.
 * @param b Right record.
 * @returns The three-key comparison result.
 */
export function compareFileLineName(a: FileLineName, b: FileLineName): number {
  if (a.file !== b.file) {
    return a.file < b.file ? -1 : 1;
  }
  if (a.line !== b.line) {
    return a.line - b.line;
  }
  if (a.name !== b.name) {
    return a.name < b.name ? -1 : 1;
  }
  return 0;
}

/**
 * Lexical containment: `candidate`'s root-relative POSIX spelling under
 * `base`, or `null` when the candidate is not strictly inside. The
 * "begins with `..`" test is deliberately literal (the safeio precedent):
 * as defense in depth it errs toward rejecting, so even a pathological
 * in-base sibling such as `..hidden.ts` is refused rather than risk an
 * escape.
 *
 * @param base Containing directory (an analysis root or library root).
 * @param candidate Absolute path to test.
 * @returns The root-relative POSIX path, or `null` when not under `base`.
 */
export function relativeUnderBase(base: string, candidate: string): string | null {
  const rel = relative(base, candidate);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    return null;
  }
  return rel.split(sep).join("/");
}
