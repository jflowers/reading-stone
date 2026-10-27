import type { Dirent, Stats } from "node:fs";
import { access, readdir, realpath, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Writable } from "node:stream";
import { MAX_FILE_BYTES, readBounded } from "./safeio.js";

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
 * `discover` (T024) sequences the per-candidate precedence chain — safety
 * skip, `.d.ts` exclusion, generated-marker exclusion — over the walk
 * results and hands the survivors to `classifyFiles`, which applies
 * test-vs-source classification and lexicographically sorts the two final
 * lists. `detectFramework` (US4, FR-006) reports the test framework from
 * configuration presence at the resolved root, reading `package.json`
 * through the shared safe reader, and `hasGeneratedMarker` (US4, FR-007)
 * is the exported single-boolean view of the leading-comment scan the
 * chain runs. All four surfaces are exported and composable; `discover`
 * below runs them behind root-path validation (FR-010) and assembles the
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
 * before walking, and `resolveRoot`'s root-level readability probe (T024)
 * has already proven the root readable by the time the walk starts; this
 * function assumes an existing, accessible directory. A `readdir` failure
 * on a subdirectory propagates to the caller: silently skipping an
 * unreadable subtree would silently omit its files — a silent false
 * negative the constitution forbids (Principle II).
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
 * source file. The chain's async stages — safety skip and
 * generated-marker exclusion (FR-007) — run earlier, in `discover`'s
 * screen (`screenCandidates`); a candidate arriving here from `discover`
 * has already passed them, and the `.d.ts` check below is kept so direct
 * callers of this composable surface get the same policy.
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
 * Root-level vitest configuration basenames (FR-006, research R7): any
 * one of these present at the resolved project root reports `"vitest"`.
 * Exactly these four, matched by exact case-sensitive name.
 */
const VITEST_CONFIG_BASENAMES: readonly string[] = [
  "vitest.config.ts",
  "vitest.config.js",
  "vitest.config.mts",
  "vitest.config.mjs",
];

/**
 * Root-level jest configuration basenames (FR-006, research R7): any one
 * of these present at the resolved project root reports `"jest"`. Exactly
 * these five, matched by exact case-sensitive name.
 */
const JEST_CONFIG_BASENAMES: readonly string[] = [
  "jest.config.ts",
  "jest.config.js",
  "jest.config.mjs",
  "jest.config.cjs",
  "jest.config.json",
];

/**
 * Reports whether `name` exists directly at the analysis root (research
 * R7: root only, never recursive).
 *
 * Existence only — the candidate's contents are never read, so the probe
 * cannot block on a FIFO or any other non-regular entry named like a
 * config. `access` with no mode argument is the canonical F_OK existence
 * check; it follows a symlink, which is the ordinary meaning of "this
 * file exists at the root" — FR-018's never-follow rule governs tree
 * walking and file reading, and neither happens here. Any failure — the
 * usual absent name (ENOENT), or an inaccessible path — reads as "not
 * present".
 *
 * @param root Resolved absolute analysis root.
 * @param name Candidate basename, joined onto the root directly.
 * @returns `true` when `name` exists at the root.
 */
async function nameExistsAtRoot(root: string, name: string): Promise<boolean> {
  try {
    await access(join(root, name));
    return true;
  } catch {
    // Absent (or uncheckable) at the root: not present.
    return false;
  }
}

/**
 * Reports whether any of `names` exists directly at the analysis root
 * (FR-006, research R7).
 *
 * The loop short-circuits at the first name found; the boolean result is
 * independent of the declared order, which exists only to keep the probe
 * sequence itself deterministic.
 *
 * @param root Resolved absolute analysis root.
 * @param names Candidate basenames, joined onto the root directly.
 * @returns `true` when at least one name exists at the root.
 */
async function anyConfigPresentAtRoot(
  root: string,
  names: readonly string[],
): Promise<boolean> {
  for (const name of names) {
    if (await nameExistsAtRoot(root, name)) {
      return true;
    }
  }
  return false;
}

/**
 * The read budget for the root `package.json` (FR-006, research R7).
 *
 * The full shared hard cap rather than a smaller prefix budget: JSON
 * cannot be parsed from a truncated prefix, so a partial read would only
 * manufacture a misleading parse failure. At the full cap, a
 * `package.json` over 16 MiB flows through `readBounded`'s own size-cap
 * skip — one honest diagnostic — instead of a phantom "malformed"
 * verdict, and every readable `package.json` within the cap is parsed in
 * full.
 */
const PACKAGE_JSON_BUDGET = MAX_FILE_BYTES;

/**
 * Reports whether the root `package.json` carries a `jest` key (FR-006,
 * research R7), reading the file through the shared safe reader.
 *
 * The read runs `readBounded`'s full guarded sequence (FR-017, FR-018):
 * containment, `lstat` (a symlinked `package.json` is skipped, never
 * followed), the regular-file check, the 16 MiB cap, and strict UTF-8
 * decoding. Every skip there — unreadable, symlink, oversized,
 * undecodable — resolves `null` after `readBounded` itself has written
 * the one `reading-stone: skipping package.json: <reason>` line, so this
 * function writes nothing on that path: the spec pins exactly one line
 * per skip (FR-017). A file that reads successfully but fails
 * `JSON.parse` is the one skip `readBounded` cannot see, so this function
 * writes the same-shaped line itself — still exactly one — and both
 * conditions land in the same place: no `jest` key, and the request
 * continues.
 *
 * A well-formed document whose top level is not an object with an own
 * `jest` property (a number, a string, `null`, an array) simply carries
 * no `jest` key — valid JSON in an unexpected shape is not a
 * diagnostic-worthy condition. Neither is absence: the guarded read is
 * gated on presence, because a root with no `package.json` is the normal
 * state of a project without one, and FR-017's one-diagnostic skip rules
 * exist for files that are present but cannot be read or parsed — a
 * missing file (or a symlink whose target is missing) is silently treated
 * as carrying no `jest` key, so it never manufactures a diagnostic.
 *
 * @param resolvedRoot Realpath-resolved absolute analysis root.
 * @param stderr Injected diagnostic sink (Testability principle); stdout
 * is never touched.
 * @returns `true` only when the file read, parsed, and carried an own
 * `jest` property.
 */
async function packageJsonHasJestKey(
  resolvedRoot: string,
  stderr: Writable,
): Promise<boolean> {
  // Gate: absence is not a skip condition — only a package.json that
  // exists flows into readBounded's one-diagnostic guarded sequence.
  if (!(await nameExistsAtRoot(resolvedRoot, "package.json"))) {
    return false;
  }
  const content = await readBounded(
    resolvedRoot,
    "package.json",
    PACKAGE_JSON_BUDGET,
    stderr,
  );
  if (content === null) {
    // readBounded's skip path has already written the one diagnostic
    // line; a second one here would violate the FR-017 contract.
    return false;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    // The malformed-JSON skip readBounded cannot see: this function
    // writes the one line itself, in readBounded's shape.
    stderr.write("reading-stone: skipping package.json: malformed JSON\n");
    return false;
  }
  if (parsed === null || typeof parsed !== "object") {
    // Valid JSON whose top level is not an object carries no jest key.
    return false;
  }
  return Object.hasOwn(parsed, "jest");
}

/**
 * Detects the project's test framework from configuration presence at the
 * resolved project root (FR-006; research R7; Constitution Principle I).
 *
 * The detection basis is exactly what the spec pins (Assumption 2):
 * configuration presence at the root, non-recursive, independent of
 * source-file contents and of the process environment — so the same tree
 * reports the same framework on every run (US4 scenario 3):
 *
 * 1. `"vitest"` when any of the four vitest config basenames exists at
 *    the root;
 * 2. otherwise `"jest"` when any of the five jest config basenames exists
 *    at the root, or the root `package.json` carries a `jest` key;
 * 3. otherwise `"unknown"`.
 *
 * vitest wins when both frameworks are configured (FR-006). The
 * `package.json` read happens only on the jest-key fallback — a vitest
 * or jest config file has already decided the answer — and flows through
 * the shared safe reader with its 16 MiB cap and one-diagnostic skip
 * rules: an unreadable or malformed `package.json` writes exactly one
 * stderr diagnostic and is treated as having no `jest` key (FR-017),
 * while a root with no `package.json` is silent — absence is not a skip
 * condition.
 *
 * Sequenced into `discover()` (T024): the call replaced the US1
 * `"unknown"` placeholder, and the caller's stderr sink flows through —
 * the server handler forwards the server's own `stderr` — so a skipped
 * `package.json` diagnostic reaches the process stderr, never stdout.
 *
 * @param resolvedRoot Realpath-resolved absolute analysis root, the form
 * `resolveRoot` returns; every probe and read is relative to it.
 * @param stderr Injected diagnostic sink (Testability principle — the
 * server passes its own `stderr`); stdout is never touched.
 * @returns The lowercase framework string: `"vitest"`, `"jest"`, or
 * `"unknown"` (spec Assumption 11).
 */
export async function detectFramework(
  resolvedRoot: string,
  stderr: Writable,
): Promise<"vitest" | "jest" | "unknown"> {
  if (await anyConfigPresentAtRoot(resolvedRoot, VITEST_CONFIG_BASENAMES)) {
    return "vitest";
  }
  if (await anyConfigPresentAtRoot(resolvedRoot, JEST_CONFIG_BASENAMES)) {
    return "jest";
  }
  const hasJestKey = await packageJsonHasJestKey(resolvedRoot, stderr);
  return hasJestKey ? "jest" : "unknown";
}

/**
 * The prefix-read budget for generated-marker scanning (FR-007; research
 * R6): at most the first 64 KiB of a candidate file is ever read.
 *
 * A prefix budget, deliberately distinct from `PACKAGE_JSON_BUDGET`'s
 * full 16 MiB cap: only the leading comment block can carry an exclusion
 * marker, so 64 KiB — large enough for stacked license headers before a
 * marker, small enough that per-file I/O stays trivial — is all the
 * scanner needs. The plan's performance goals pin the value (spec
 * Assumption 5 makes the budget a plan-level decision). Truncation at
 * the budget is deterministic: the same bytes always produce the same
 * verdict.
 */
const MARKER_PREFIX_BUDGET = 64 * 1024;

/**
 * The case-sensitive generated-code markers (FR-007): a leading comment
 * block whose text contains either substring marks its file as
 * generated. Case matters — `@Generated` and `code generated` are not
 * markers.
 */
const GENERATED_MARKERS: readonly string[] = ["@generated", "Code generated"];

/**
 * Reports whether a UTF-16 code unit is whitespace the scanner skips
 * between leading comments.
 *
 * The set mirrors the trivia the TypeScript scanner itself skips between
 * tokens: ECMAScript's `WhiteSpace` and `LineTerminator` productions,
 * plus next line (U+0085), which the compiler's scanner also treats as
 * single-line whitespace. Spec-defined and engine-stable, never
 * locale-dependent (research R8) — the skip set is a fixed function of
 * the code unit.
 *
 * @param codeUnit A UTF-16 code unit from the decoded prefix.
 * @returns `true` when the unit is skippable inter-comment whitespace.
 */
function isScannerWhitespace(codeUnit: number): boolean {
  return (
    codeUnit === 0x20 || // space
    // Horizontal tab through carriage return: tab, line feed, vertical
    // tab, form feed, carriage return.
    (codeUnit >= 0x09 && codeUnit <= 0x0d) ||
    codeUnit === 0x85 || // next line
    codeUnit === 0xa0 || // no-break space
    codeUnit === 0x1680 || // ogham space mark
    // En quad through hair space: the Unicode Zs width range.
    (codeUnit >= 0x2000 && codeUnit <= 0x200a) ||
    codeUnit === 0x2028 || // line separator
    codeUnit === 0x2029 || // paragraph separator
    codeUnit === 0x202f || // narrow no-break space
    codeUnit === 0x205f || // medium mathematical space
    codeUnit === 0x3000 || // ideographic space
    codeUnit === 0xfeff // zero-width no-break space (a mid-file BOM)
  );
}

/**
 * Reports whether a UTF-16 code unit terminates a line comment: exactly
 * the ECMAScript `LineTerminator` production — line feed, carriage
 * return, LINE SEPARATOR (U+2028), PARAGRAPH SEPARATOR (U+2029) — the
 * same four the TypeScript scanner ends comments at. Recognizing all
 * four matters for accuracy: a U+2028 inside a comment ends it in real
 * JavaScript, so a scanner that kept consuming would swallow following
 * code as comment text and could false-match a marker inside it.
 *
 * @param codeUnit A UTF-16 code unit from the decoded prefix.
 * @returns `true` when the unit ends the current line.
 */
function isLineTerminator(codeUnit: number): boolean {
  return (
    codeUnit === 0x0a || // line feed
    codeUnit === 0x0d || // carriage return
    codeUnit === 0x2028 || // line separator
    codeUnit === 0x2029 // paragraph separator
  );
}

/**
 * Reports whether one consumed comment's text contains a marker. The
 * comment delimiters cannot themselves contain a marker, so the whole
 * slice — delimiters included — is searched; case is significant
 * (FR-007).
 *
 * @param text One consumed comment, delimiters included.
 * @returns `true` when `@generated` or `Code generated` appears in it.
 */
function commentHasGeneratedMarker(text: string): boolean {
  return GENERATED_MARKERS.some((marker) => text.includes(marker));
}

/**
 * Reports whether the leading comment trivia of decoded file content
 * carries a generated-code marker (FR-007; research R6).
 *
 * Bounded lexical-trivia scanning — not a reimplementation of
 * TypeScript semantics (research R6; Principle III's target is the AST
 * work of issue #3). The grammar walked is exactly what the spec pins:
 * an optional single shebang line at position zero, then whitespace and
 * consecutive line comments and block comments, stopping at the first
 * non-comment content. Markers are matched only in consumed comment
 * text, so the same words in a string literal or in a comment after
 * code begins never exclude a file. A leading UTF-8 BOM never reaches
 * this function — `readBounded`'s decoder strips one.
 *
 * Truncation determinism (research R8): every bound is the input string
 * itself. A line comment that reaches the boundary without a terminator
 * is consumed to the boundary, and a block comment left unterminated at
 * the boundary is consumed to the boundary with its text scanned — the
 * budget admits no further bytes, so the verdict is a pure function of
 * the prefix.
 *
 * @param content The decoded file prefix (at most the 64 KiB budget).
 * @returns `true` when any leading comment's text carries a marker.
 */
function leadingCommentBlockHasMarker(content: string): boolean {
  let index = 0;
  // A shebang is recognized only at position zero and only once: a `#!`
  // appearing after any other content is code, where the scan has
  // already stopped.
  if (content.startsWith("#!")) {
    while (index < content.length && !isLineTerminator(content.charCodeAt(index))) {
      index++;
    }
    // The line break ending the shebang is skipped as whitespace below.
  }
  while (index < content.length) {
    while (index < content.length && isScannerWhitespace(content.charCodeAt(index))) {
      index++;
    }
    if (index >= content.length) {
      break;
    }
    if (content.startsWith("//", index)) {
      // Line comment: its text runs to the next line terminator or the
      // boundary. The terminator itself is absorbed by the whitespace
      // skip on the next pass.
      const start = index;
      index += 2;
      while (index < content.length && !isLineTerminator(content.charCodeAt(index))) {
        index++;
      }
      if (commentHasGeneratedMarker(content.slice(start, index))) {
        return true;
      }
      continue;
    }
    if (content.startsWith("/*", index)) {
      // Block comment: closed by the first closing delimiter after the
      // opener (block comments do not nest). When the closing delimiter
      // lies beyond the truncation boundary, the comment is consumed to
      // the boundary — the text present is scanned and the scan stops
      // (a documented deterministic choice; see the function comment).
      const start = index;
      const closeIndex = content.indexOf("*/", index + 2);
      index = closeIndex === -1 ? content.length : closeIndex + 2;
      if (commentHasGeneratedMarker(content.slice(start, index))) {
        return true;
      }
      continue;
    }
    // First non-comment, non-whitespace content: the leading comment
    // block is over. Markers beyond this point — trailing comments,
    // string literals, later code — must not match; research R6 rejects
    // a regex over the raw prefix for exactly this failure mode.
    break;
  }
  return false;
}

/**
 * The verdict of one candidate's leading-comment scan (T024): the
 * safety-skip fact and the marker verdict as separate fields.
 *
 * `hasGeneratedMarker`'s public contract collapses both into one boolean
 * (`false` on either), which is correct for the scanner's own semantics
 * but loses the fact `discover`'s precedence chain needs: a skipped file
 * is excluded from both lists — readBounded's diagnostic is already
 * written — while an unmarked file continues toward classification. This
 * internal shape keeps the two apart so the chain can act on each
 * precisely: one canonical scan, two honest views.
 */
interface MarkerScan {
  /** `true` when readBounded skipped the file (diagnostic already written). */
  readonly skipped: boolean;
  /** `true` when the leading comment block carries a generated marker. */
  readonly marked: boolean;
}

/**
 * Runs the bounded leading-comment scan for one walk candidate (T024):
 * `readBounded`'s guarded 64 KiB prefix read, then the marker scan over
 * the decoded prefix — one read per candidate, shared by the exported
 * `hasGeneratedMarker` and `discover`'s precedence chain.
 *
 * @param resolvedRoot Realpath-resolved absolute analysis root; the read
 * is contained within it (FR-018).
 * @param relPath Walk-built root-relative POSIX path, echoed verbatim in
 * `readBounded`'s diagnostics.
 * @param stderr Injected diagnostic sink; stdout is never touched.
 * @returns The skip fact and the marker verdict as separate fields.
 */
async function scanLeadingComments(
  resolvedRoot: string,
  relPath: string,
  stderr: Writable,
): Promise<MarkerScan> {
  const prefix = await readBounded(resolvedRoot, relPath, MARKER_PREFIX_BUDGET, stderr);
  if (prefix === null) {
    // readBounded's skip path has already written the one diagnostic
    // line; the caller excludes the file from both lists on this fact.
    return { skipped: true, marked: false };
  }
  return { skipped: false, marked: leadingCommentBlockHasMarker(prefix) };
}

/**
 * Reports whether a walked file's leading comment block carries a
 * generated-code marker (FR-007; research R6) — the signal that
 * excludes the file from both discover lists.
 *
 * The read runs `readBounded`'s full guarded sequence (FR-017, FR-018)
 * over the bounded 64 KiB prefix, so containment, the regular-file
 * check, the 16 MiB size cap, and strict UTF-8 decoding all apply. A
 * skipped file resolves `null` after `readBounded` itself has written
 * the one `reading-stone: skipping <relPath>: <reason>` line; this
 * function writes nothing on that path (FR-017's one-diagnostic
 * contract) and reads the file as not marked — the safety skip already
 * excludes it from both lists higher in the precedence chain (safety
 * skip → `.d.ts` → generated marker → test → source), so a `false`
 * here can never re-include it.
 *
 * A file that is merely marked — the exclusion this function reports —
 * is a silent documented policy like `.d.ts` (FR-004, FR-007): no
 * diagnostic, because nothing is wrong with the file; it is generated
 * code, out of scope by policy.
 *
 * Sequenced into `discover()` (T024): the precedence chain runs this
 * same scan through the shared internal `scanLeadingComments`, which
 * keeps the safety-skip fact distinguishable from the marker verdict.
 * The exported boolean view preserves T023's single-`false` contract: a
 * safety-skipped file reads as not marked, sound in the chain because
 * the skip itself — not the verdict — excludes the file from both lists.
 *
 * @param resolvedRoot Realpath-resolved absolute analysis root; the read
 * is contained within it (FR-018).
 * @param relPath Walk-built root-relative POSIX path, echoed verbatim in
 * `readBounded`'s diagnostics.
 * @param stderr Injected diagnostic sink (Testability principle — the
 * server passes its own `stderr`); stdout is never touched.
 * @returns `true` when the leading comment block's text contains the
 * case-sensitive `@generated` or `Code generated` marker; `false` when
 * it does not, when the prefix carries no comment trivia, or when the
 * safe reader skipped the file.
 */
export async function hasGeneratedMarker(
  resolvedRoot: string,
  relPath: string,
  stderr: Writable,
): Promise<boolean> {
  const { marked } = await scanLeadingComments(resolvedRoot, relPath, stderr);
  return marked;
}

/**
 * Applies the per-candidate precedence chain's excluding stages to the
 * walk results (T024; FR-004, FR-007, FR-017; research R13) and returns
 * the candidates that survive into path-only classification.
 *
 * The chain, in the spec's order — safety skip → `.d.ts` → generated
 * marker — with test-vs-source classification (in `classifyFiles`) as
 * the final stages:
 *
 * 1. **Safety skip** (FR-017): every walked candidate flows through
 *    `readBounded`'s guarded 64 KiB prefix read first — the scan's own
 *    read, so each file is read exactly once. A `null` return (FIFO,
 *    oversized, unreadable, decode error, symlink) excludes the file
 *    from both lists; readBounded has already written the one
 *    `reading-stone: skipping <relPath>: <reason>` line. This is why
 *    the read precedes even the `.d.ts` name check: the safety reader —
 *    not the name — decides whether a candidate named like a source
 *    file is readable (a FIFO named `types.d.ts` is diagnosed, not
 *    silently dropped).
 * 2. **`.d.ts` exclusion** (FR-004): silent documented policy.
 * 3. **Generated-marker exclusion** (FR-007): silent documented policy —
 *    a marked file is generated code, out of scope by policy, and the
 *    exclusion wins over test classification (spec edge case).
 *
 * Candidates are screened in deterministic walk order, so the skip
 * diagnostics land in walk order too (research R8).
 *
 * @param resolvedRoot Realpath-resolved absolute analysis root.
 * @param candidates Walk candidates (`walkTree`'s output), in walk order.
 * @param stderr Injected diagnostic sink; stdout is never touched.
 * @returns The candidates that survive all three excluding stages, in
 * walk order, for `classifyFiles` to split into test and source lists.
 */
export async function screenCandidates(
  resolvedRoot: string,
  candidates: readonly string[],
  stderr: Writable,
): Promise<string[]> {
  const surviving: string[] = [];
  for (const relPath of candidates) {
    // Stage 1 — safety skip: the guarded prefix read runs for every
    // candidate; a null return has already written its one diagnostic.
    const { skipped, marked } = await scanLeadingComments(
      resolvedRoot,
      relPath,
      stderr,
    );
    if (skipped) {
      continue;
    }
    // Stage 2 — `.d.ts` exclusion: silent documented policy (FR-004).
    if (isDeclarationFileName(basenameOf(relPath))) {
      continue;
    }
    // Stage 3 — generated-marker exclusion: silent documented policy
    // (FR-007); wins over the test signals classifyFiles applies later.
    if (marked) {
      continue;
    }
    surviving.push(relPath);
  }
  return surviving;
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
 * Reports whether a filesystem error is a permission failure (`EACCES` or
 * `EPERM`) — the codes whose meaning on the resolved root itself is "this
 * root cannot be read" and therefore belongs to root validation (FR-010),
 * not to the fail-loud mid-walk surface.
 *
 * @param error A caught fs error from a root-level probe.
 * @returns `true` when the error's code is `EACCES` or `EPERM`.
 */
function isPermissionDenied(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const code = (error as NodeJS.ErrnoException).code;
  return code === "EACCES" || code === "EPERM";
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
 * 4. `readdir` the real root once as a readability probe — `realpath`
 *    and `stat` both succeed on an unreadable (mode 000) directory, so
 *    only this probe surfaces a root-level `EACCES`/`EPERM` as an
 *    `InvalidRootPathError` (T024, the T005-flagged src fix) rather than
 *    letting the walk's root `readdir` fail as an unexpected internal
 *    error; every other probe failure rethrows, and mid-walk
 *    subdirectory `readdir` failures stay fail-loud (Principle II).
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
export async function resolveRoot(rootPath: string): Promise<string> {
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
  // Step 4 — root readability probe (T024, the T005-flagged src fix):
  // a chmod-000 root passes realpath and stat — only readdir surfaces
  // the EACCES — so without this probe the walk's root readdir failure
  // would escape as an internal error (-32603) instead of the contract's
  // invalid-params surface (-32602). The listing is discarded — walkTree
  // re-reads the root — because the probe's job is the permission
  // verdict, kept here where the cwd-resolved path is in scope for
  // InvalidRootPathError.
  try {
    await readdir(realRoot);
  } catch (cause) {
    if (isPermissionDenied(cause)) {
      throw new InvalidRootPathError(resolved, { cause });
    }
    throw cause;
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
 * Discovers a project's source and test files (FR-001, FR-006, FR-007,
 * FR-010; research R5) — the implementation behind the `discover`
 * JSON-RPC method.
 *
 * Composes the exported building blocks: `resolveRoot` validates and
 * realpath-resolves the root, `walkTree` collects the walk candidates in
 * deterministic order, `screenCandidates` applies the per-candidate
 * precedence chain's excluding stages (safety skip → `.d.ts` → generated
 * marker), `classifyFiles` splits the survivors into the disjoint,
 * sorted lists, and `detectFramework` reports the test framework from
 * configuration presence at the root. The returned object is already the
 * wire-shaped result, so the server handler returns it as the JSON-RPC
 * result unchanged (byte-level determinism is the protocol layer's
 * serializer).
 *
 * Diagnostics (FR-017) flow to the injected stderr sink — the server
 * handler forwards the server's own `stderr`, so a skip line reaches the
 * process stderr, never stdout; direct callers that omit the sink get
 * `process.stderr`.
 *
 * @param rootPath Absolute or relative project root; a relative path
 * resolves against the analyzer process working directory (spec
 * Assumption 8), and a symlinked root is realpath-resolved exactly once
 * at the boundary (FR-018 / research R5).
 * @param stderr Diagnostic sink for safe-reader skip lines
 * (Testability principle); defaults to `process.stderr`.
 * @returns The discovery result: sorted, root-relative POSIX
 * `source_files` and `test_files`, and the detected test `framework`.
 * @throws InvalidRootPathError when the root does not exist, is not a
 * directory, or cannot be accessed (FR-010); the server handler maps it
 * to the contract's `-32602` response.
 */
export async function discover(
  rootPath: string,
  stderr: Writable = process.stderr,
): Promise<DiscoveryResult> {
  const realRoot = await resolveRoot(rootPath);
  const candidates = await walkTree(realRoot);
  const surviving = await screenCandidates(realRoot, candidates, stderr);
  const { sourceFiles, testFiles } = classifyFiles(surviving);
  const framework = await detectFramework(realRoot, stderr);
  return {
    source_files: sourceFiles,
    test_files: testFiles,
    framework,
  };
}
