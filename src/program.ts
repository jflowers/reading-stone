import { lstatSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, extname, isAbsolute, join, relative } from "node:path";
import type { Writable } from "node:stream";
import { ScriptKind, type SourceFile } from "typescript/unstable/ast";
import type { FileSystem, FileSystemEntries } from "typescript/unstable/fs";
import {
  API,
  type Checker,
  type Diagnostic,
  DiagnosticCategory,
  type Program,
} from "typescript/unstable/sync";
import { readBoundedSync } from "./safeio.js";

/**
 * The bootstrapped TypeScript analysis context — the foundation the
 * detector and complexity engine build on (FR-003 through FR-006; research
 * R1, R2, R3, R15; data-model.md ProgramContext; Constitution Principles
 * III and V). `buildProgramContext` turns the analysis pipeline's pre-read
 * in-scope sources into one of two contexts — mode `"program"` (a compiler
 * program plus its live type checker, built from the project's own
 * tsconfig) or mode `"parse-only"` (one parsed source per in-scope file).
 * The union is internal: it never appears on the wire.
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
 *   them, so the hermetic views below bound what the compiler can touch.
 * - `API.updateSnapshot({ openFiles })` — the parse-only route: with no
 *   tsconfig visible, the compiler loads every opened file into its
 *   inferred project and answers a parsed `SourceFile` per path.
 * - `API.updateSnapshot({ openProjects })` — the program-mode route: the
 *   native server builds a configured project for a config path served
 *   through the fs callbacks, so a synthesized config IS the classic
 *   `ts.createProgram(rootNames, options, host)` statement.
 * - `Program`/`Checker` — the program-mode arm's types: `Program` answers
 *   `getCompilerOptions`/`getSourceFile`/`getSourceFileNames`/
 *   `getConfigFileParsingDiagnostics`, `Checker` the type queries.
 * - `typescript/unstable/ast` — `SourceFile` and `ScriptKind`: the parsed
 *   sources this module returns and the enum the extension map enforces.
 *
 * The program-mode contract (FR-003, FR-005; research R1, R3), as the
 * classic vocabulary maps onto that surface:
 *
 * 1. **The extender config is the rootNames override.** The host serves a
 *    virtual config — `<root>/.reading-stone-tsconfig.json`, a path that
 *    never touches disk — that `extends` the project's own tsconfig,
 *    lists exactly the in-scope roots in `files`, and empties `include`
 *    and `references`. tsconfig extends replaces top-level fields rather
 *    than merging them (verified against 7.0.2), so the project's own
 *    include/files/references can never widen or narrow the root set:
 *    FR-003's every-in-scope-file-covered holds regardless of the
 *    project's include/exclude patterns. The virtual path is a sibling
 *    of the real tsconfig (not nested in a subdirectory) so the
 *    `extends` target and every base-relative path resolve against the
 *    same directory the project's own config lives in.
 * 2. **Forced options ride the extends merge.** The extender's
 *    `compilerOptions` — `noEmit: true`, `incremental: false`,
 *    `composite: false`, `skipLibCheck: true`, `allowJs: true`,
 *    `checkJs: false` — win over the project's own values; everything
 *    else (paths, baseUrl, strict, target, module resolution) flows
 *    verbatim through the extends chain, which the compiler parses
 *    natively — comments included, so real-world JSONC configs keep their
 *    type information instead of degrading to parse-only under an
 *    analyzer-side JSON re-parse. The classic `tsBuildInfoFile:
 *    undefined` adjustment has no JSON spelling ("unset" cannot be
 *    expressed through extends), so the bootstrap clears it on the
 *    parsed options object after the build — inert either way, with emit
 *    and incremental state force-disabled in the server's merged options
 *    too.
 * 3. **The bounded compiler host** (Constitution V) routes every compiler
 *    read: the two config texts and the in-scope pre-read texts come from
 *    memory; reads under the typescript package's own platform lib
 *    directory are bounded but exempt from root containment (the
 *    analyzer's dependency, not analyzed-tree content); any other in-root
 *    path is probed with lstat — never followed — and, when present,
 *    read through `readBoundedSync`, so skipped transitive files resolve
 *    as absent modules → `any` types → FR-017 ambiguity: graceful
 *    degradation, never a crash; every other compiler-resolved path
 *    outside the analysis root does not exist, with one diagnostic.
 *    Out-of-root existence probes answer false, so module resolution
 *    cannot walk past the analyzed tree.
 * 4. **The config-error boundary** (research R3): the extends chain
 *    propagates the project config's parse errors into the extender
 *    project's config diagnostics (verified) — that is where the
 *    fallback decision reads them. The no-inputs family — TS18002 (the
 *    files list is empty) and TS18003 (include matched nothing) — cannot
 *    affect a bootstrap whose root set is its own, so it never triggers
 *    fallback; every other error-category diagnostic does. Semantic and
 *    syntactic diagnostics are never a gate (FR-005): type errors
 *    surface as error types the ambiguity rules handle.
 * 5. **Resource closure and disposal**: parse-only sources are
 *    self-contained client-side binary views — lazy node materialization
 *    reads only the decoded buffer, never the compiler client — so that
 *    path closes the API client (and the native server behind it) before
 *    returning. Program mode cannot: `Checker`/`Program` calls
 *    round-trip to the live server, so the program arm carries
 *    `dispose()` — the consumer that drops the context closes the
 *    subprocess, and an idempotent guard makes double disposal safe. No
 *    native server outlives its consumer.
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
 *    diagnostic. A silently different kind would mis-shape every
 *    downstream rule that keys off script-kind semantics, and a diagnosed
 *    skip is Principle II's acknowledged-uncertainty pattern; the
 *    enforcement never fires on typescript 7.0.2 (verified) and exists to
 *    catch compiler drift loudly instead.
 * 3. **Skip semantics** mirror safeio's: a `null` pre-read text excludes
 *    the file (its diagnostic was already written by `readBounded`); a
 *    `RangeError` escaping source-file fetch/decode on pathological
 *    nesting is caught and treated as the same skip-with-one-diagnostic
 *    (research R15); parse diagnostics are ignored — the parser is
 *    error-tolerant and a file is never dropped for failing to parse.
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
 *   its live type checker. `Program`/`Checker` calls round-trip to the
 *   native compiler server, so the arm carries `dispose()`: the consumer
 *   that drops the context closes that server — no subprocess outlives its
 *   consumer (the analysis methods that own a context's lifetime are the
 *   Phase 4/5 pipeline entry points).
 * - `"parse-only"`: one parsed source per in-scope file, keyed by
 *   root-relative POSIX path, for trees with no usable tsconfig. The
 *   fallback is never an error and is invisible on the wire. The sources
 *   are self-contained client-side binary views, so this arm owns nothing
 *   to dispose.
 */
export type ProgramContext =
  | {
      mode: "program";
      program: Program;
      checker: Checker;
      /**
       * Closes the native compiler server behind the program and checker
       * (idempotent); the context is unusable afterwards.
       */
      dispose(): void;
    }
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
 * The analyzer's virtual program-mode config, served at
 * `<root>/.reading-stone-tsconfig.json` — a path that never touches disk.
 * Dot-prefixed and `.json`-suffixed so it can never collide with an
 * in-scope source (discovery walks exactly the six compilable extensions),
 * and a sibling of the real tsconfig so the extender's relative `extends`
 * and every base-relative path resolve against the root. A real file
 * planted at that name is shadowed by the served text: the compiler's
 * only filesystem is the delegation callbacks below.
 */
const VIRTUAL_CONFIG_NAME = ".reading-stone-tsconfig.json";

/**
 * The analyzer's forced compiler-option adjustments (research R1), layered
 * over the project's own config through the extender's extends-merge
 * precedence: analysis is strictly read-only — no emit, no incremental
 * state — and never fails on library or JavaScript code it must cover.
 * `tsBuildInfoFile` is not here — JSON cannot spell "unset" — so the
 * bootstrap clears it on the parsed options after the build instead.
 */
const FORCED_COMPILER_OPTIONS = {
  noEmit: true,
  incremental: false,
  composite: false,
  skipLibCheck: true,
  allowJs: true,
  checkJs: false,
} as const;

/**
 * The no-inputs config-diagnostic family (research R3): TS18002 (the
 * files list is empty) and TS18003 (include matched nothing). Neither can
 * affect a bootstrap whose root set is its own, so both are excluded from
 * the fallback triggers.
 */
const NO_INPUTS_CONFIG_ERROR_CODES: ReadonlySet<number> = new Set([18002, 18003]);

/** Module-scope `require` for resolving the analyzer's own dependencies. */
const moduleRequire = createRequire(import.meta.url);

/**
 * Writes one skip diagnostic line — the safeio template. Shared by every
 * bootstrap skip site so the channel's format stays single-sourced and
 * deterministic (Constitution I). Parse-only sites pass root-relative
 * paths; the program-mode host passes the absolute compiler-resolved
 * paths, matching safeio's own absolute-path diagnostics for those reads.
 *
 * @param stderr Injected diagnostic sink (Testability principle); stdout is
 * never touched.
 * @param path The skipped path, echoed verbatim.
 * @param reason Short, stable skip reason.
 */
function writeSkipDiagnostic(stderr: Writable, path: string, reason: string): void {
  stderr.write(`reading-stone: skipping ${path}: ${reason}\n`);
}

/**
 * Bootstraps the analysis context from the analyzed tree's own pre-read
 * sources (FR-003 through FR-006; research R1, R2, R3).
 *
 * Mode selection: a usable root `tsconfig.json` drives the program arm —
 * the extender-config route and bounded compiler host documented in the
 * module header. Anything else — no tsconfig, an unreadable one, or a
 * config error beyond the no-inputs family (research R3) — falls back to
 * the parse-only arm: one parsed source per in-scope file, keyed by
 * root-relative path, with the absolute `fileName` and pre-read `text`
 * preserved. A tree with no usable in-scope sources bootstraps an empty
 * parse-only context without spawning the compiler at all.
 *
 * @param realRoot Realpath-resolved absolute analysis root (discovery's
 * `resolveRoot` output); in-scope paths join beneath it.
 * @param sourceFiles The in-scope `(relPath, text)` pairs the pipeline
 * pre-read through the async `readBounded` (16 MiB budget — a JSON-free
 * whole-file read). A `null` text excludes its file.
 * @param stderr Injected diagnostic sink for per-file skips; stdout is
 * never touched (it is reserved for JSON-RPC responses).
 * @returns The bootstrapped `ProgramContext` in either mode.
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
  // Program mode first (T007): a usable root tsconfig yields the
  // configured program over exactly the in-scope files. A `null` return
  // is the documented fallback, never an error.
  const configured = buildConfiguredProgram(realRoot, usable, stderr);
  if (configured !== null) {
    return configured;
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
 * Bootstraps the configured-program arm (FR-003, FR-005; research R1,
 * R3): when a usable `tsconfig.json` sits at the resolved root, spawn the
 * native compiler once, open the extender project over exactly the
 * in-scope files with the analyzer's forced options, and hand the live
 * program and checker to the caller.
 *
 * The classic-API vocabulary of research R1 — `ts.readConfigFile`,
 * `ts.parseJsonConfigFileContent` error checks, `ts.createProgram` with
 * rootNames — maps onto the native surface as: the config text is read
 * through the bounded reader before anything spawns; the project's own
 * config is parsed by the compiler itself as the extender's `extends`
 * base (comments, chained extends, and enum-name options all natively
 * handled); and the extender's `files` list IS the rootNames override.
 *
 * Every fallback trigger is silent, except the bounded reader's skips,
 * which diagnose themselves: a broken config degrades precision, never
 * availability (FR-004).
 *
 * @param realRoot Realpath-resolved absolute analysis root.
 * @param usable The filtered pre-read in-scope pairs (at least one).
 * @param stderr Injected diagnostic sink; stdout is never touched.
 * @returns The program-mode context, or `null` when the parse-only
 * fallback should run (no tsconfig, unreadable config, or a blocking
 * config error).
 */
function buildConfiguredProgram(
  realRoot: string,
  usable: ReadonlyArray<readonly [string, string]>,
  stderr: Writable,
): ProgramContext | null {
  const tsconfigPath = join(realRoot, "tsconfig.json");
  // An absent tsconfig is the first-class no-config case, not a skip: no
  // diagnostic, straight to the parse-only fallback.
  if (!pathExists(tsconfigPath)) {
    return null;
  }
  // The config text through the bounded reader (research R1 step 1): a
  // skip — oversized, symlinked, non-regular, undecodable — has already
  // written its one diagnostic and falls back here, before any spawn.
  const tsconfigText = readBoundedSync(tsconfigPath, stderr);
  if (tsconfigText === undefined) {
    return null;
  }
  const extenderPath = join(realRoot, VIRTUAL_CONFIG_NAME);
  const servedTexts = new Map<string, string>([
    [tsconfigPath, tsconfigText],
    [extenderPath, buildExtenderConfig(realRoot, usable)],
  ]);
  const api = new API({
    cwd: realRoot,
    fs: createProgramFileSystem(realRoot, usable, servedTexts, stderr),
  });
  let handedOff = false;
  try {
    const snapshot = api.updateSnapshot({ openProjects: [extenderPath] });
    const project = snapshot.getProject(extenderPath);
    if (
      project === undefined ||
      hasBlockingConfigErrors(project.program.getConfigFileParsingDiagnostics())
    ) {
      // Research R3's boundary: no project, or a config error beyond the
      // no-inputs family. The finally below closes this server before
      // the caller re-runs the parse-only fallback on a fresh one.
      return null;
    }
    // The forced `tsBuildInfoFile: undefined` (research R1): extends can
    // only override the value, never unset it, so the inherited path is
    // cleared here on the parsed options object — the client-side mirror
    // of the classic `{...options, tsBuildInfoFile: undefined}` spread.
    // Emit and incremental state are force-disabled in the merged options
    // the server holds too, so the inherited value is inert either way.
    project.compilerOptions.tsBuildInfoFile = undefined;
    handedOff = true;
    let disposed = false;
    return {
      mode: "program",
      program: project.program,
      checker: project.checker,
      dispose: () => {
        // Idempotent: a consumer that disposes twice — or from a cleanup
        // path after an error — never closes a dead channel twice.
        if (disposed) {
          return;
        }
        disposed = true;
        api.close();
      },
    };
  } finally {
    // Every path that did not hand the client to a consumer — fallback,
    // or a throw from the snapshot/project calls — closes it here.
    if (!handedOff) {
      api.close();
    }
  }
}

/**
 * Renders the virtual extender config — the program-mode statement of
 * research R1's rootNames override and forced options. `extends` pulls
 * the project's own options in verbatim (the compiler resolves the chain,
 * comments and all, through the bounded host); `files` fixes the root set
 * to exactly the in-scope paths; and the empty `include`/`references`
 * arrays REPLACE any the project declared (tsconfig extends substitutes
 * top-level fields), so nothing outside the in-scope override can enter
 * the program through the config.
 *
 * @param realRoot Realpath-resolved absolute analysis root.
 * @param usable The filtered pre-read in-scope pairs (at least one).
 * @returns The serialized config text, deterministic for the same inputs.
 */
function buildExtenderConfig(
  realRoot: string,
  usable: ReadonlyArray<readonly [string, string]>,
): string {
  return JSON.stringify({
    extends: "./tsconfig.json",
    // Absolute paths: the config is served at a virtual path whose
    // directory is the root, but absolute entries remove any ambiguity
    // about the resolution base.
    files: usable.map(([relPath]) => join(realRoot, relPath)),
    include: [],
    references: [],
    compilerOptions: FORCED_COMPILER_OPTIONS,
  });
}

/**
 * Research R3's fallback boundary over the extender project's config
 * diagnostics: the extends chain propagates the project config's own
 * parse errors here (verified against typescript 7.0.2), so one check
 * covers both the extender and the config it extends. Only error-category
 * diagnostics gate, and the no-inputs family is excluded — a bootstrap
 * whose root set is its own cannot be affected by an empty files list or
 * an include that matches nothing.
 *
 * @param diagnostics The project's config-file parsing diagnostics.
 * @returns `true` when at least one non-no-inputs error is reported.
 */
function hasBlockingConfigErrors(diagnostics: readonly Diagnostic[]): boolean {
  for (const diagnostic of diagnostics) {
    if (diagnostic.category !== DiagnosticCategory.Error) {
      continue;
    }
    if (NO_INPUTS_CONFIG_ERROR_CODES.has(diagnostic.code)) {
      continue;
    }
    return true;
  }
  return false;
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
 * The shared hermetic view over the analyzed tree: the in-scope texts by
 * absolute path plus the directory set the compiler may see (the root and
 * each in-scope file's ancestor directories). Both host flavors build on
 * it — the parse-only host serves nothing else, and the program host adds
 * its bounded-read routing around it.
 */
type HermeticView = {
  readonly fileTexts: ReadonlyMap<string, string>;
  readonly directories: ReadonlySet<string>;
};

/**
 * Indexes the pre-read pairs into the hermetic view. The ancestor walk
 * terminates at the filesystem root (a path's `dirname` chain is finite).
 *
 * @param realRoot Realpath-resolved absolute analysis root.
 * @param sources The filtered pre-read pairs.
 * @returns The in-scope texts and visible directories.
 */
function buildHermeticView(
  realRoot: string,
  sources: ReadonlyArray<readonly [string, string]>,
): HermeticView {
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
  return { fileTexts, directories };
}

/**
 * One hermetic directory listing: the in-scope files and known directories
 * directly inside `dirName`, sorted so the compiler's view is a pure
 * function of the tree, independent of caller pair order (Constitution
 * I). Deliberately NOT the real directory contents — include-style
 * globbing through the compiler (the project config's own, parsed along
 * the extends chain) must never surface files beyond the in-scope set.
 *
 * @param view The hermetic view to list from.
 * @param dirName Directory to list.
 * @returns The sorted files and directories the compiler may see.
 */
function hermeticDirectoryEntries(
  view: HermeticView,
  dirName: string,
): FileSystemEntries {
  return {
    files: [...view.fileTexts.keys()]
      .filter((absPath) => dirname(absPath) === dirName)
      .map((absPath) => basename(absPath))
      .sort(),
    directories: [...view.directories]
      .filter((dir) => dir !== dirName && dirname(dir) === dirName)
      .map((dir) => basename(dir))
      .sort(),
  };
}

/**
 * Builds the hermetic filesystem the parse-only compiler client is
 * spawned with — that mode's bounded host (Constitution V). Every
 * callback answers from the pre-read pairs and never returns `undefined`,
 * so the compiler can never fall back to the real filesystem: unknown
 * paths do not exist, and no `writeFile` callback is provided at all.
 * Directory existence is the analysis root plus each source's ancestor
 * directories — enough for the compiler's per-file project resolution,
 * while the on-disk tsconfig stays invisible: with nothing configured to
 * find, every opened file lands in the compiler's single inferred
 * project, exactly the parse-only route's requirement.
 *
 * @param realRoot Realpath-resolved absolute analysis root.
 * @param sources The filtered pre-read pairs.
 * @returns The delegation callbacks for `new API({ cwd, fs })`.
 */
function createHermeticFileSystem(
  realRoot: string,
  sources: ReadonlyArray<readonly [string, string]>,
): FileSystem {
  const view = buildHermeticView(realRoot, sources);
  return {
    readFile: (fileName) => {
      // `null` — never `undefined` — so an unknown path does not exist
      // rather than falling back to the real filesystem. An empty-string
      // text is a real empty file and must be served, not skipped.
      const text = view.fileTexts.get(fileName);
      return text === undefined ? null : text;
    },
    fileExists: (fileName) => view.fileTexts.has(fileName),
    directoryExists: (dirName) => view.directories.has(dirName),
    getAccessibleEntries: (dirName) => hermeticDirectoryEntries(view, dirName),
    realpath: (path) => path,
  };
}

/**
 * The program mode's bounded compiler host (FR-003; research R1;
 * Constitution Principle V): the delegation callbacks the native server
 * is spawned with. Every route is ordered so the compiler can never fall
 * back to the real filesystem — `undefined` is the fallback signal, and
 * every answer is a text or does-not-exist:
 *
 * 1. The two served config texts (the project's own tsconfig and the
 *    virtual extender) and the in-scope pre-read texts come from memory.
 * 2. Reads under the typescript package's own platform lib directory are
 *    bounded but exempt from root containment — the analyzer's
 *    dependency, not analyzed-tree content.
 * 3. Any other in-root path is probed with lstat (never followed) and,
 *    only when present, read through `readBoundedSync`: skipped
 *    transitive files resolve as absent modules, their types degrading
 *    to `any` for FR-017's ambiguity rules — graceful degradation, never
 *    a crash. Absent probes stay silent: routine module-resolution
 *    misses (package.json lookups) are not skips.
 * 4. Every other compiler-resolved path outside the analysis root does
 *    not exist, with one diagnostic — a config whose typeRoots or paths
 *    point outside the root degrades to `any` types rather than reading
 *    out-of-root trees.
 *
 * Existence probing mirrors the read routing: out-of-root paths do not
 * exist, in-root paths are probed with lstat, and directory listings are
 * the hermetic in-scope view — include-style globbing can only ever see
 * in-scope files, never widening the program's root set.
 *
 * @param realRoot Realpath-resolved absolute analysis root.
 * @param usable The filtered pre-read in-scope pairs.
 * @param servedTexts The config texts served verbatim, keyed by path —
 * the project tsconfig and the virtual extender.
 * @param stderr Injected diagnostic sink for bounded-read skips.
 * @returns The delegation callbacks for `new API({ cwd, fs })`.
 */
function createProgramFileSystem(
  realRoot: string,
  usable: ReadonlyArray<readonly [string, string]>,
  servedTexts: ReadonlyMap<string, string>,
  stderr: Writable,
): FileSystem {
  const view = buildHermeticView(realRoot, usable);
  return {
    readFile: (fileName) => {
      const served = servedTexts.get(fileName);
      if (served !== undefined) {
        return served;
      }
      const inScope = view.fileTexts.get(fileName);
      if (inScope !== undefined) {
        return inScope;
      }
      const libDirectory = compilerLibDirectory();
      if (libDirectory !== null && isPathInside(libDirectory, fileName)) {
        return readBoundedSync(fileName, stderr) ?? null;
      }
      if (isPathInside(realRoot, fileName)) {
        // Absent probes are normal resolution traffic, not skips: only
        // an existing file earns a bounded read — and its possible one
        // skip diagnostic (the oversized-transitive-dep case).
        if (!pathExists(fileName)) {
          return null;
        }
        return readBoundedSync(fileName, stderr) ?? null;
      }
      writeSkipDiagnostic(stderr, fileName, "outside analysis root");
      return null;
    },
    fileExists: (fileName) => {
      if (servedTexts.has(fileName) || view.fileTexts.has(fileName)) {
        return true;
      }
      const libDirectory = compilerLibDirectory();
      if (
        (libDirectory !== null && isPathInside(libDirectory, fileName)) ||
        isPathInside(realRoot, fileName)
      ) {
        return pathExists(fileName);
      }
      return false;
    },
    directoryExists: (dirName) => {
      if (view.directories.has(dirName)) {
        return true;
      }
      if (isPathInside(realRoot, dirName)) {
        try {
          // lstat, never stat: a symlinked directory is not followed —
          // the safeio discipline extends to the compiler's view of the
          // analyzed tree (Constitution V).
          return lstatSync(dirName).isDirectory();
        } catch {
          return false;
        }
      }
      return false;
    },
    getAccessibleEntries: (dirName) => hermeticDirectoryEntries(view, dirName),
    realpath: (path) => path,
  };
}

/** Memoized result of `computeCompilerLibDirectory` (undefined = unset). */
let compilerLibDirectoryCache: string | null | undefined;

/**
 * The typescript package's platform-specific lib directory — where the
 * native compiler's default libraries (`lib.es2020.full.d.ts` and kin)
 * live — resolved once per process. `null` when it cannot be located, in
 * which case no out-of-root path qualifies as a lib read.
 */
function compilerLibDirectory(): string | null {
  if (compilerLibDirectoryCache === undefined) {
    compilerLibDirectoryCache = computeCompilerLibDirectory();
  }
  return compilerLibDirectoryCache;
}

/**
 * Locates the lib directory from the analyzer's own dependency tree: the
 * `typescript` package first, then the
 * `@typescript/typescript-<platform>-<arch>` package that carries the
 * native compiler binary — either hoisted beside it (the npm default) or
 * nested under it. The candidate order is deterministic; both are the
 * same package the `API` client spawns, so a server that spawned at all
 * implies at least one resolves.
 */
function computeCompilerLibDirectory(): string | null {
  let typescriptDirectory: string;
  try {
    typescriptDirectory = dirname(moduleRequire.resolve("typescript/package.json"));
  } catch {
    // Without the typescript package nothing could have spawned the
    // server; treat the lib directory as absent rather than throw.
    return null;
  }
  const platformPackage = `typescript-${process.platform}-${process.arch}`;
  const candidates = [
    join(dirname(typescriptDirectory), "@typescript", platformPackage, "lib"),
    join(typescriptDirectory, "node_modules", "@typescript", platformPackage, "lib"),
  ];
  for (const candidate of candidates) {
    if (isExistingDirectory(candidate)) {
      return candidate;
    }
  }
  return null;
}

/**
 * Unlike the analyzed-tree probes, this check follows symlinks (stat, not
 * lstat): the lib directory is the analyzer's own dependency, and package
 * managers legitimately symlink it (pnpm-style stores).
 *
 * @param path Candidate directory.
 * @returns Whether it exists as a directory.
 */
function isExistingDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Whether a path exists, probed with lstat so the final symlink is never
 * followed — the analyzed tree's own existence question, distinct from
 * the analyzer-dependency probes (which follow). A probe is metadata
 * only: no content is read, so the Constitution V read bounds are not in
 * play.
 *
 * @param path Candidate path.
 * @returns Whether anything exists at the path (any file type).
 */
function pathExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Lexical containment: `candidate` is strictly inside `base`. The
 * "begins with `..`" test is deliberately literal (the safeio precedent):
 * as defense in depth it errs toward rejecting, so even a pathological
 * in-base sibling such as `..hidden.ts` is refused rather than risk an
 * escape.
 *
 * @param base Containing directory.
 * @param candidate Path to test.
 * @returns Whether the candidate is strictly beneath the base.
 */
function isPathInside(base: string, candidate: string): boolean {
  const rel = relative(base, candidate);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
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
