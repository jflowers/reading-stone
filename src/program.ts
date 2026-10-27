import { basename, dirname, extname, join } from "node:path";
import type { Writable } from "node:stream";
import { ScriptKind, type SourceFile } from "typescript/unstable/ast";
import type { FileSystem } from "typescript/unstable/fs";
import { API, type Checker, type Program } from "typescript/unstable/sync";

/**
 * The bootstrapped TypeScript analysis context — the foundation the detector
 * and complexity engine build on (FR-003 through FR-006; research R1, R2,
 * R3, R15; data-model.md ProgramContext; Constitution Principles III and V).
 * `buildProgramContext` turns the analysis pipeline's pre-read in-scope
 * sources into one of two contexts — mode `"program"` (a compiler program
 * plus its type checker, built from the project's own tsconfig) or mode
 * `"parse-only"` (one parsed source per in-scope file). The union is
 * internal: it never appears on the wire.
 *
 * API-surface design record (typescript 7.0.2, the native compiler): the
 * classic API named in research R1/R2 (`ts.createProgram`,
 * `ts.createSourceFile`, a wrapped `CompilerHost`) does not exist in the
 * promoted runtime dependency — its main export carries only version
 * metadata. The equivalent verified surface is:
 *
 * - `typescript/unstable/sync` — the `API` client, spawned with filesystem
 *   delegation callbacks (`new API({ cwd, fs })`). Those callbacks are the
 *   bounded-compiler-host equivalent: every compiler read funnels through
 *   them, so the hermetic view below bounds what the compiler can touch.
 * - `API.updateSnapshot({ openFiles })` — the parse-only route: with no
 *   tsconfig visible, the compiler loads every opened file into its
 *   inferred project and answers a parsed `SourceFile` per path.
 * - `Program`/`Checker` — the program-mode arm's types (T007).
 * - `typescript/unstable/ast` — `SourceFile` and `ScriptKind`: the parsed
 *   sources this module returns and the enum the extension map enforces.
 *
 * T006 scope: the parse-only path is complete and is the result this module
 * produces. T007 adds tsconfig detection and the configured-program route
 * (the bounded compiler host over transitive reads, the forced option
 * adjustments); until it lands, no call produces mode `"program"`, and the
 * program-mode tests in tests/program.test.ts stay red by design.
 *
 * The parse-only path's contract (research R2):
 *
 * 1. **Hermetic compiler view**: the filesystem callbacks expose ONLY the
 *    pre-read in-scope sources — every other path (including any on-disk
 *    tsconfig) does not exist. Unknown paths answer `null`/`false`, never
 *    `undefined`: `undefined` is the fall-back-to-the-real-filesystem
 *    signal, and falling back would hand the compiler unbounded reads of
 *    untrusted tree content (Constitution V). The view is also why this
 *    path needs no tsconfig logic of its own: with nothing visible, every
 *    opened file lands in the compiler's single inferred project.
 * 2. **Explicit extension map**: `.ts`→TS, `.tsx`→TSX, `.js`/`.mjs`/`.cjs`
 *    →JS, `.jsx`→JSX — the same six extensions discovery walks,
 *    case-sensitively. The map is enforced, not advisory: a parsed source
 *    whose script kind does not match the mapped kind is skipped with one
 *    diagnostic. A silently different kind would mis-shape every downstream
 *    rule that keys off script-kind semantics, and a diagnosed skip is
 *    Principle II's acknowledged-uncertainty pattern; the enforcement never
 *    fires on typescript 7.0.2 (verified) and exists to catch compiler
 *    drift loudly instead.
 * 3. **Skip semantics** mirror safeio's: a `null` pre-read text excludes
 *    the file (its diagnostic was already written by `readBounded`); a
 *    `RangeError` escaping source-file fetch/decode on pathological
 *    nesting is caught and treated as the same skip-with-one-diagnostic
 *    (research R15); parse diagnostics are ignored — the parser is
 *    error-tolerant and a file is never dropped for failing to parse.
 * 4. **Resource closure**: parsed sources are self-contained client-side
 *    binary views — lazy node materialization reads only the decoded
 *    buffer, never the compiler client — so the client (and the native
 *    server process behind it) is closed before the context is returned.
 *    No subprocess outlives the bootstrap.
 */

/**
 * One in-scope source as the analysis pipeline pre-read it: the
 * root-relative POSIX path and the `readBounded` result verbatim. `text` is
 * `null` exactly when the bounded read skipped the file — its diagnostic
 * was already written, so `null` excludes the file from the bootstrap
 * silently (never a second diagnostic for one skip).
 */
export type PreReadSource = readonly [relPath: string, text: string | null];

/**
 * The analysis context `buildProgramContext` produces (data-model.md
 * ProgramContext; internal — not protocol-visible).
 *
 * - `"program"`: a compiler program built from a usable root tsconfig plus
 *   its live type checker (constructed by T007).
 * - `"parse-only"`: one parsed source per in-scope file, keyed by
 *   root-relative POSIX path, for trees with no usable tsconfig. The
 *   fallback is never an error and is invisible on the wire.
 */
export type ProgramContext =
  | { mode: "program"; program: Program; checker: Checker }
  | { mode: "parse-only"; sources: ReadonlyMap<string, SourceFile> };

/**
 * The explicit script-kind extension map (research R2): deterministic and
 * auditable, not filename inference with version-dependent `.mjs`/`.cjs`
 * behavior. Exactly the six extensions discovery walks, case-sensitively —
 * a file whose extension is absent from this map never reaches the
 * compiler. `.d.ts` names end in `.ts` and map to TS, matching the
 * compiler's own treatment of declaration files.
 */
const SCRIPT_KIND_BY_EXTENSION: ReadonlyMap<string, ScriptKind> = new Map([
  [".ts", ScriptKind.TS],
  [".tsx", ScriptKind.TSX],
  [".js", ScriptKind.JS],
  [".jsx", ScriptKind.JSX],
  [".mjs", ScriptKind.JS],
  [".cjs", ScriptKind.JS],
]);

/**
 * Writes one skip diagnostic line — the safeio template, with the
 * root-relative path like the async reader that produced the pre-read
 * texts. Shared by every parse-only skip site so the channel's format
 * stays single-sourced and deterministic (Constitution I).
 *
 * @param stderr Injected diagnostic sink (Testability principle); stdout is
 * never touched.
 * @param relPath Root-relative POSIX path, echoed verbatim.
 * @param reason Short, stable skip reason.
 */
function writeSkipDiagnostic(stderr: Writable, relPath: string, reason: string): void {
  stderr.write(`reading-stone: skipping ${relPath}: ${reason}\n`);
}

/**
 * Bootstraps the analysis context from the analyzed tree's own pre-read
 * sources (FR-004, FR-006; research R2).
 *
 * T006 scaffold: the parse-only path is the result — tsconfig detection and
 * the configured-program route (mode `"program"`) land in T007, so every
 * bootstrap currently answers the parse-only context: one parsed source per
 * in-scope file, keyed by root-relative path, with the absolute `fileName`
 * and pre-read `text` preserved. A tree with no usable in-scope sources
 * bootstraps an empty parse-only context without spawning the compiler at
 * all.
 *
 * @param realRoot Realpath-resolved absolute analysis root (discovery's
 * `resolveRoot` output); in-scope paths join beneath it.
 * @param sourceFiles The in-scope `(relPath, text)` pairs the pipeline
 * pre-read through the async `readBounded` (16 MiB budget — a JSON-free
 * whole-file read). A `null` text excludes its file.
 * @param stderr Injected diagnostic sink for per-file skips; stdout is
 * never touched (it is reserved for JSON-RPC responses).
 * @returns The parse-only `ProgramContext` (until T007 adds program mode).
 */
export function buildProgramContext(
  realRoot: string,
  sourceFiles: ReadonlyArray<PreReadSource>,
  stderr: Writable,
): ProgramContext {
  const usable = collectUsableSources(sourceFiles, stderr);
  if (usable.length === 0) {
    return { mode: "parse-only", sources: new Map<string, SourceFile>() };
  }
  const api = new API({
    cwd: realRoot,
    fs: createHermeticFileSystem(realRoot, usable),
  });
  try {
    return {
      mode: "parse-only",
      sources: parseSources(api, realRoot, usable, stderr),
    };
  } finally {
    // Parsed sources are self-contained binary views (see the module
    // header), so closing the client here strands nothing the returned
    // context (or a later AST walk) needs.
    api.close();
  }
}

/**
 * Filters the pre-read pairs down to the files the compiler will see:
 * `null` texts are excluded (already diagnosed by `readBounded`), and a
 * path whose extension is absent from the explicit map is a diagnosed skip
 * — discovery walks exactly the mapped extensions, so this fires only if
 * the two surfaces drift apart.
 *
 * @param sourceFiles Pre-read pairs, verbatim from the pipeline.
 * @param stderr Injected diagnostic sink for extension skips.
 * @returns The `(relPath, text)` pairs safe to hand to the compiler, in
 * caller order.
 */
function collectUsableSources(
  sourceFiles: ReadonlyArray<PreReadSource>,
  stderr: Writable,
): ReadonlyArray<readonly [string, string]> {
  const usable: Array<readonly [string, string]> = [];
  for (const [relPath, text] of sourceFiles) {
    if (text === null) {
      continue;
    }
    if (!SCRIPT_KIND_BY_EXTENSION.has(extname(relPath))) {
      writeSkipDiagnostic(stderr, relPath, "unsupported extension");
      continue;
    }
    usable.push([relPath, text]);
  }
  return usable;
}

/**
 * Builds the hermetic filesystem the compiler client is spawned with — the
 * parse-only mode's bounded host (Constitution V). Every callback answers
 * from the pre-read pairs and never returns `undefined`, so the compiler
 * can never fall back to the real filesystem: unknown paths do not exist,
 * and no `writeFile` callback is provided at all. Directory existence is
 * the analysis root plus each source's ancestor directories — enough for
 * the compiler's per-file project resolution, while the on-disk tsconfig
 * stays invisible (its detection is T007's route).
 *
 * @param realRoot Realpath-resolved absolute analysis root.
 * @param sources The filtered pre-read pairs.
 * @returns The delegation callbacks for `new API({ cwd, fs })`.
 */
function createHermeticFileSystem(
  realRoot: string,
  sources: ReadonlyArray<readonly [string, string]>,
): FileSystem {
  const fileTexts = new Map<string, string>();
  const directories = new Set<string>([realRoot]);
  for (const [relPath, text] of sources) {
    const absPath = join(realRoot, relPath);
    fileTexts.set(absPath, text);
    for (let dir = dirname(absPath); !directories.has(dir); dir = dirname(dir)) {
      directories.add(dir);
      if (dir === dirname(dir)) {
        break; // Reached the filesystem root: a termination guarantee.
      }
    }
  }
  return {
    readFile: (fileName) => {
      // `null` — never `undefined` — so an unknown path does not exist
      // rather than falling back to the real filesystem. An empty-string
      // text is a real empty file and must be served, not skipped.
      const text = fileTexts.get(fileName);
      return text === undefined ? null : text;
    },
    fileExists: (fileName) => fileTexts.has(fileName),
    directoryExists: (dirName) => directories.has(dirName),
    getAccessibleEntries: (dirName) => ({
      // Sorted so the compiler's view is a pure function of the tree,
      // independent of caller pair order (Constitution I).
      files: [...fileTexts.keys()]
        .filter((absPath) => dirname(absPath) === dirName)
        .map((absPath) => basename(absPath))
        .sort(),
      directories: [...directories]
        .filter((dir) => dir !== dirName && dirname(dir) === dirName)
        .map((dir) => basename(dir))
        .sort(),
    }),
    realpath: (path) => path,
  };
}

/**
 * Parses every usable in-scope source through the compiler client's
 * inferred project — the parse-only route (research R2). All files open in
 * one `updateSnapshot` and land in one inferred project; each is fetched
 * back as a self-contained parsed source, verified against the explicit
 * extension map, and keyed by its root-relative path.
 *
 * @param api The spawned compiler client (lifecycle owned by the caller).
 * @param realRoot Realpath-resolved absolute analysis root.
 * @param sources The filtered pre-read pairs.
 * @param stderr Injected diagnostic sink for per-file skips.
 * @returns Parsed sources keyed by root-relative POSIX path, in pair order.
 */
function parseSources(
  api: API,
  realRoot: string,
  sources: ReadonlyArray<readonly [string, string]>,
  stderr: Writable,
): Map<string, SourceFile> {
  const snapshot = api.updateSnapshot({
    openFiles: sources.map(([relPath]) => join(realRoot, relPath)),
  });
  const parsed = new Map<string, SourceFile>();
  for (const [relPath] of sources) {
    const absPath = join(realRoot, relPath);
    // The mapped kind the compiler must have used. The lookup cannot miss
    // (collectUsableSources rejected unmapped extensions), so a miss
    // collapses into the mismatch comparison below rather than a separate
    // branch.
    const expectedKind = SCRIPT_KIND_BY_EXTENSION.get(extname(relPath));
    try {
      const project = snapshot.getDefaultProjectForFile(absPath);
      const source = project?.program.getSourceFile(absPath);
      if (source === undefined) {
        writeSkipDiagnostic(stderr, relPath, "not present in snapshot");
        continue;
      }
      // Reading scriptKind forces the source-file header decode, so the
      // comparison stays inside the RangeError guard (research R15).
      if (source.scriptKind !== expectedKind) {
        writeSkipDiagnostic(stderr, relPath, "unexpected script kind");
        continue;
      }
      parsed.set(relPath, source);
    } catch (error) {
      if (error instanceof RangeError) {
        // Pathological nesting escaping source-file fetch/decode (research
        // R15): the same skip-with-one-diagnostic as a bounded-read skip —
        // the per-file guard isolates the damage, never a request abort.
        writeSkipDiagnostic(stderr, relPath, "parser stack overflow");
        continue;
      }
      throw error;
    }
  }
  return parsed;
}
