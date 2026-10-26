import type { Dirent, Stats } from "node:fs";
import { readdir, realpath, stat } from "node:fs/promises";
import { join, resolve } from "node:path";

/**
 * Deterministic tree walker for file discovery (FR-002/FR-003, research R2).
 *
 * Performs an async recursive descent over a project tree and returns every
 * *walk candidate*: an entry that is neither a directory nor a symlink and
 * whose name carries an in-scope TypeScript or JavaScript-family extension.
 * Candidates are returned as root-relative POSIX-separator paths in
 * deterministic depth-first order — each directory's entries are visited in
 * UTF-16 code-unit order — so any downstream per-file diagnostic emitted in
 * walk order is deterministic too (research R8), not just the sorted
 * response lists.
 *
 * The walker decides only what is visited and what is collected.
 * `classifyFiles` layers classification on top (`.d.ts` exclusion,
 * test-vs-source) and lexicographically sorts the two final lists;
 * generated-marker exclusion (US4) joins the precedence chain in a later
 * task. Both surfaces are exported and composable; `discover` below
 * sequences them behind root-path validation (FR-010) and assembles the
 * wire-shaped result (FR-001).
 */

/** File extensions considered by discovery (FR-002). Case-sensitive. */
const WALKED_EXTENSIONS: ReadonlySet<string> = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
]);

/**
 * Directory names pruned from the walk at any depth (FR-003) — exactly these
 * five, matched by exact case-sensitive name. Every other directory,
 * including dot-directories such as `.github`, is walked.
 */
const PRUNED_DIRECTORY_NAMES: ReadonlySet<string> = new Set([
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".git",
]);

/**
 * Reports whether a basename carries one of the walked extensions (FR-002).
 * Suffix match, case-sensitive: `.TS` is not a walked extension. Every
 * JavaScript-family name that matches is collected — never silently skipped
 * (Constitution Principle III).
 */
function hasWalkedExtension(name: string): boolean {
  for (const extension of WALKED_EXTENSIONS) {
    if (name.endsWith(extension)) {
      return true;
    }
  }
  return false;
}

/**
 * Reports whether a directory name is one of the five pruned directories
 * (FR-003). Exact, case-sensitive match on the entry name.
 */
function isPrunedDirectoryName(name: string): boolean {
  return PRUNED_DIRECTORY_NAMES.has(name);
}

/**
 * Orders dirents by entry name in UTF-16 code-unit order — the deterministic
 * visit order (research R2/R8). The default string comparison (`<` and `>`)
 * compares UTF-16 code units; `localeCompare` is locale- and ICU-dependent
 * and is rejected for that reason.
 */
function compareDirentNames(a: Dirent, b: Dirent): number {
  if (a.name < b.name) {
    return -1;
  }
  return a.name > b.name ? 1 : 0;
}

/**
 * Walks one directory level, yielding walk candidates as root-relative
 * POSIX-separator paths in deterministic depth-first order.
 *
 * Each recursion level is a separate awaited async call, so no explicit
 * depth budget is needed for walking (research R2, unlike AST visitors).
 *
 * @param absDir Absolute platform-native path of the directory to read.
 * @param relDir Root-relative POSIX path of the same directory; the empty
 * string at the walk root.
 */
async function* walkDirectory(
  absDir: string,
  relDir: string,
): AsyncGenerator<string, void, undefined> {
  const entries = await readdir(absDir, { withFileTypes: true });
  entries.sort(compareDirentNames);
  for (const entry of entries) {
    // Symlinks are never followed (FR-018): a symlinked directory is not
    // descended and a symlinked file is never read. Dirents report symlinks
    // as non-directories, but the check is kept explicit for intent.
    if (entry.isSymbolicLink()) {
      continue;
    }
    const relPath = relDir === "" ? entry.name : `${relDir}/${entry.name}`;
    if (entry.isDirectory()) {
      if (!isPrunedDirectoryName(entry.name)) {
        yield* walkDirectory(join(absDir, entry.name), relPath);
      }
      continue;
    }
    // Candidate: an entry that is neither directory nor symlink and carries
    // an in-scope extension. Deliberately NOT filtered on
    // `dirent.isFile()`: a FIFO or device named like a source file must
    // remain a candidate so the US3 safe reader (later phase) can diagnose
    // it with exactly one stderr line — filtering on isFile() would
    // silently drop it (binding spec-review advisory for this task).
    if (hasWalkedExtension(entry.name)) {
      yield relPath;
    }
  }
}

/**
 * Walks the project tree rooted at `root` and returns all walk candidates
 * as root-relative POSIX-separator paths in deterministic walk order.
 *
 * The caller (`discover`, T009) validates and realpath-resolves `root`
 * before walking; this function assumes `root` is an existing, accessible
 * directory. A `readdir` failure on a subdirectory propagates to the
 * caller: silently skipping an unreadable subtree would silently omit its
 * files — a silent false negative the constitution forbids (Principle II).
 *
 * @param root Absolute path of an existing directory to walk.
 * @returns Walk candidates in deterministic depth-first order. The list is
 * NOT globally sorted — sorting the response lists is `classifyFiles`'s
 * responsibility (FR-008).
 */
export async function walkTree(root: string): Promise<string[]> {
  const candidates: string[] = [];
  for await (const relPath of walkDirectory(root, "")) {
    candidates.push(relPath);
  }
  return candidates;
}

/**
 * Basename segments (dot-delimited, case-sensitive) that carry the
 * test-name signal (FR-005, research R13): a segment equal to `test` or
 * `spec` appearing strictly between the first and last segments of the
 * basename — the precise meaning of `*.test.*` / `*.spec.*` for walked
 * files, which always end in a known extension.
 */
const TEST_NAME_SEGMENTS: ReadonlySet<string> = new Set(["test", "spec"]);

/**
 * Directory names that make every walked file beneath them a test file
 * (FR-005). Matched exactly and case-sensitively against any directory
 * component of the path — `mytests` and `testUtils` do not match.
 */
const TEST_DIRECTORY_NAMES: ReadonlySet<string> = new Set([
  "__tests__",
  "tests",
  "test",
]);

/**
 * Returns the basename — the final `/`-separated segment — of a
 * root-relative POSIX walk path.
 *
 * Hand-rolled rather than `node:path`'s `basename` because walk paths are
 * POSIX-by-construction (`walkDirectory` joins with `/` only) while
 * `path.basename` resolves separators platform-dependently; the
 * determinism mandate (research R8) is not delegated to the platform.
 *
 * @param relPath Root-relative POSIX-separator walk path.
 * @returns The basename of `relPath`; the whole path when it contains no
 * `/` (a root-level file).
 */
function basenameOf(relPath: string): string {
  return relPath.slice(relPath.lastIndexOf("/") + 1);
}

/**
 * Reports whether a basename is a TypeScript declaration file (FR-004):
 * a name ending with the literal `.d.ts`. Declaration files carry no
 * function bodies to analyze, so they are excluded from both lists as a
 * documented policy — silently, with no diagnostic (research R13, spec
 * edge case). Case-sensitive: `.D.TS` is not a declaration name.
 *
 * @param name Basename of a walk candidate.
 * @returns `true` when `name` ends with the literal `.d.ts`.
 */
function isDeclarationFileName(name: string): boolean {
  return name.endsWith(".d.ts");
}

/**
 * Reports whether a basename carries the test-name signal (FR-005): some
 * dot-delimited segment equal to `test` or `spec` that is neither the
 * first nor the last segment.
 *
 * `foo.test.ts` and `foo.spec.jsx` are tests by name; `test.ts` and
 * `test.foo.ts` are not (`test` is the first segment); neither is
 * `foo.teststep.ts` — segment equality, not substring. Case-sensitive.
 *
 * @param name Basename of a walk candidate.
 * @returns `true` when a middle dot-delimited segment is `test` or `spec`.
 */
function isTestName(name: string): boolean {
  const segments = name.split(".");
  // slice(1, -1) is exactly "the segments strictly between the first and
  // the last" — empty for two-segment basenames such as `test.ts`, which
  // is why a first-segment `test` never matches.
  for (const segment of segments.slice(1, -1)) {
    if (TEST_NAME_SEGMENTS.has(segment)) {
      return true;
    }
  }
  return false;
}

/**
 * Reports whether any directory component of a root-relative POSIX walk
 * path is exactly `__tests__`, `tests`, or `test` (FR-005).
 *
 * Only directory components count — never the basename — so a root-level
 * `tests.ts` is not a test by this signal. Exact, case-sensitive match.
 *
 * @param relPath Root-relative POSIX-separator walk path.
 * @returns `true` when a directory component is a test-directory name.
 */
function hasTestDirectoryComponent(relPath: string): boolean {
  const lastSlash = relPath.lastIndexOf("/");
  // A root-level file (no `/` in the path) has no directory components.
  if (lastSlash === -1) {
    return false;
  }
  const directoryPart = relPath.slice(0, lastSlash);
  for (const component of directoryPart.split("/")) {
    if (TEST_DIRECTORY_NAMES.has(component)) {
      return true;
    }
  }
  return false;
}

/**
 * The disjoint result of classifying walk candidates (FR-005): every
 * classified file lands in exactly one list.
 *
 * Field names are camelCase per convention pack CS-006 — this is an
 * internal support type, not the protocol payload; the wire shape
 * (`source_files` / `test_files`) is assembled by `discover` (T009) per
 * contracts/discover.md.
 */
export interface FileClassification {
  readonly sourceFiles: readonly string[];
  readonly testFiles: readonly string[];
}

/**
 * Classifies walk candidates into disjoint, sorted source and test file
 * lists (FR-004, FR-005, FR-008; research R8, R13).
 *
 * Precedence per research R13: a trailing-`.d.ts` basename is excluded
 * from both lists first (silent documented policy, no diagnostic); then
 * any test signal — name or directory — classifies the file into
 * `testFiles`, because test wins over source; every other candidate is a
 * source file. Generated-marker exclusion (US4) will join the chain
 * between `.d.ts` and the test signals in a later task.
 *
 * Determinism (FR-008 / research R8): both lists are sorted with the
 * default `Array.prototype.sort()` comparator — UTF-16 code-unit
 * lexicographic, stable, locale-independent, and Node-version-stable.
 * `localeCompare` is locale- and ICU-dependent and is never used.
 *
 * @param candidates Root-relative POSIX-separator walk candidates (the
 * output of `walkTree`), in any order.
 * @returns The disjoint, lexicographically sorted file lists.
 */
export function classifyFiles(candidates: readonly string[]): FileClassification {
  const sourceFiles: string[] = [];
  const testFiles: string[] = [];
  for (const relPath of candidates) {
    const name = basenameOf(relPath);
    // Precedence chain (research R13): `.d.ts` exclusion drops the file
    // from both lists before any test signal is considered.
    if (isDeclarationFileName(name)) {
      continue;
    }
    if (isTestName(name) || hasTestDirectoryComponent(relPath)) {
      testFiles.push(relPath);
      continue;
    }
    sourceFiles.push(relPath);
  }
  sourceFiles.sort();
  testFiles.sort();
  return { sourceFiles, testFiles };
}

/**
 * The error thrown when a discovery root fails validation (FR-010): the
 * root does not exist, is not a directory, or cannot be accessed.
 *
 * All three failure modes deliberately share one message: the wire
 * contract (contracts/discover.md error table) maps every root failure
 * to the same `-32602` response — `Invalid params: root_path is not a
 * directory: <path>` — so this error mirrors that unified phrasing and
 * the server handler can produce the contract message without
 * re-classifying the failure. The underlying fs error, when one exists,
 * rides along as the standard `cause` for debugging and never reaches
 * the wire.
 *
 * The carried path is the cwd-resolved root (the absolute form of the
 * caller's `root_path`), not the realpath-canonicalized form:
 * `path.resolve` never touches the filesystem, so the reported path is
 * a deterministic, caller-predictable function of the input and never
 * leaks platform canonicalization (macOS resolves `/var` to
 * `/private/var`) into error messages.
 */
export class InvalidRootPathError extends Error {
  /** The cwd-resolved root path that failed validation. */
  readonly rootPath: string;

  /**
   * @param rootPath The cwd-resolved root path that failed validation;
   * embedded in the message and exposed as a field so the server
   * handler can build the contract's `-32602` response (research R9
   * layering: discovery never imports from server).
   * @param options Standard error options; fs failures pass the
   * underlying error as `cause` (`ENOENT`, `EACCES`, ...).
   */
  constructor(rootPath: string, options?: ErrorOptions) {
    super(`root_path is not a directory: ${rootPath}`, options);
    this.rootPath = rootPath;
  }
}

/**
 * Validates and resolves the discovery root (FR-010, FR-018; research
 * R5) in a fixed, security-relevant order:
 *
 * 1. `path.resolve` the (possibly relative) `root_path` against the
 *    analyzer process working directory (spec Assumption 8). Pure
 *    string arithmetic: the filesystem is not touched and symlinks are
 *    not followed — canonicalization is step 2's job.
 * 2. `fs.realpath` the resolved root exactly once: a symlinked root is
 *    followed at this boundary only, and the path is canonicalized. A
 *    nonexistent root (`ENOENT`) or an inaccessible one (`EACCES`)
 *    fails here.
 * 3. `stat` the real path and require a directory — a file used as the
 *    root rejects.
 *
 * Containment downstream (FR-018) is enforced against the returned
 * resolved root: the walker only ever joins root-relative segments onto
 * it and never follows symlinks, so no walked path can escape it
 * (research R5's structural layer).
 *
 * @param rootPath Absolute or relative root path from the caller.
 * @returns The realpath-resolved absolute root to walk.
 * @throws InvalidRootPathError when the root does not exist, is not a
 * directory, or cannot be accessed.
 */
async function resolveRoot(rootPath: string): Promise<string> {
  const resolved = resolve(rootPath);
  let realRoot: string;
  let rootStat: Stats;
  try {
    // Nonexistent (ENOENT from realpath) and inaccessible (EACCES from
    // either call) roots fail here; both map to the same unified
    // rejection (FR-010).
    realRoot = await realpath(resolved);
    rootStat = await stat(realRoot);
  } catch (cause) {
    throw new InvalidRootPathError(resolved, { cause });
  }
  if (!rootStat.isDirectory()) {
    // A file (or any non-directory entry) used as the root rejects. The
    // error carries the cwd-resolved path — see InvalidRootPathError.
    throw new InvalidRootPathError(resolved);
  }
  return realRoot;
}

/**
 * The `discover` result payload (FR-001) — the JSON-RPC wire shape,
 * field for field, as contracts/discover.md defines it.
 *
 * Field names are snake_case by design: this is the protocol payload,
 * not an internal support type, so the wire contract governs the naming
 * (same convention as `InitializeResult` in protocol.ts) rather than
 * convention-pack CS-006's camelCase rule for internal types. The
 * camelCase classification fields (`FileClassification.sourceFiles` and
 * `.testFiles`) map onto the wire names in `discover`.
 */
export interface DiscoveryResult {
  /**
   * Lexicographically sorted, root-relative POSIX-separator source
   * file paths.
   */
  readonly source_files: readonly string[];
  /**
   * Lexicographically sorted, root-relative POSIX-separator test file
   * paths; disjoint from `source_files`.
   */
  readonly test_files: readonly string[];
  /**
   * The detected test framework: `"vitest"`, `"jest"`, or `"unknown"`;
   * always present (contracts/discover.md).
   */
  readonly framework: "vitest" | "jest" | "unknown";
}

/**
 * Discovers a project's source and test files (FR-001, FR-010; research
 * R5) — the implementation behind the `discover` JSON-RPC method.
 *
 * Composes the exported building blocks: `resolveRoot` validates and
 * realpath-resolves the root, `walkTree` collects the walk candidates
 * in deterministic order, and `classifyFiles` splits them into the
 * disjoint, sorted lists. The returned object is already the
 * wire-shaped result, so the server handler returns it as the JSON-RPC
 * result unchanged (byte-level determinism is the protocol layer's
 * serializer).
 *
 * @param rootPath Absolute or relative project root; a relative path
 * resolves against the analyzer process working directory (spec
 * Assumption 8), and a symlinked root is realpath-resolved exactly once
 * at the boundary (FR-018 / research R5).
 * @returns The discovery result: sorted, root-relative POSIX
 * `source_files` and `test_files`, and the detected test `framework`.
 * @throws InvalidRootPathError when the root does not exist, is not a
 * directory, or cannot be accessed (FR-010); the server handler maps it
 * to the contract's `-32602` response.
 */
export async function discover(rootPath: string): Promise<DiscoveryResult> {
  const realRoot = await resolveRoot(rootPath);
  const candidates = await walkTree(realRoot);
  const { sourceFiles, testFiles } = classifyFiles(candidates);
  return {
    source_files: sourceFiles,
    test_files: testFiles,
    // Incremental placeholder (FR-006 lands in US4, T022-T024):
    // spec.md's US4 priority rationale frames framework detection as a
    // refinement of US1's raw enumeration — "valuable for downstream
    // interpretation but not required for the core discovery value" —
    // so US1 ships the contract's neutral sentinel (spec Assumption 1)
    // and US4's wiring task replaces this literal with
    // detectFramework(resolvedRoot).
    framework: "unknown",
  };
}
