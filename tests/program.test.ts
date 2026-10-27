// Bootstrap fixtures for the TypeScript analysis context, src/program.ts
// (T005; spec US2 scenarios 1-6; FR-003 through FR-006; research R1, R2, R3,
// R13, R15; Constitution Principles III and V).
//
// RED-FIRST: src/program.ts does not exist yet — T006/T007 create it — so
// this suite fails on module resolution by design (tasks.md: US2 tests are
// written first and observed to FAIL before the paired implementation lands).
// The contract pinned here is data-model.md's ProgramContext union produced
// by buildProgramContext(realRoot, sourceFiles, stderr): the caller hands the
// realpath-resolved analysis root and the in-scope (relPath, text) pairs it
// pre-read through readBounded, and receives either mode "program" (a
// compiler program plus its type checker) or mode "parse-only" (one parsed
// source per in-scope file).
//
// API-surface design record: research R1/R2 name the classic compiler API
// (ts.createProgram, ts.createSourceFile, a wrapped CompilerHost). The
// promoted runtime dependency (T002) is typescript 7.0.2 — the native
// compiler, whose JavaScript surface is the `typescript/unstable/sync`
// client (API/Snapshot/Project/Program/Checker, with CompilerHost-style
// filesystem delegation) plus the `typescript/unstable/ast` types
// (SourceFile, ScriptKind, ScriptTarget, SyntaxKind). These tests pin the
// spec's contract through the calls that package answers —
// Program.getCompilerOptions/getSourceFile/getSourceFileNames/
// getSemanticDiagnostics and Checker.getTypeAtLocation, the semantic
// equivalents of the spec's ts.Program/ts.TypeChecker surface — so every
// scenario below asserts the spec requirement, not a bootstrap mechanism.

import { readdirSync, realpathSync, statSync } from "node:fs";
import { truncate } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, dirname, join } from "node:path";
import { Writable } from "node:stream";
import { ScriptKind, ScriptTarget, SyntaxKind } from "typescript/unstable/ast";
import type { FileSystem } from "typescript/unstable/fs";
import { DiagnosticCategory } from "typescript/unstable/sync";
import { afterEach, describe, expect, it, type Mock, vi } from "vitest";
import { buildProgramContext, type ProgramContext } from "../src/program.js";
import { MAX_FILE_BYTES } from "../src/safeio.js";
import { createFixtureTree } from "./helpers/fixtures.js";

// Fixture trees register their cleanup here so every test body stays linear;
// afterEach drains the queue in creation order (same pattern as
// tests/safeio.test.ts).
const pendingCleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  vi.restoreAllMocks();
  const cleanups = pendingCleanups.splice(0, pendingCleanups.length);
  for (const cleanup of cleanups) {
    await cleanup();
  }
});

async function makeTree(files: Readonly<Record<string, string>>): Promise<string> {
  const tree = await createFixtureTree(files);
  pendingCleanups.push(tree.cleanup);
  // The production caller passes a root that discovery's resolveRoot already
  // realpath-resolved; the fixture's mkdtemp path sits behind macOS's /var
  // symlink, so resolve it the same way before joining paths.
  return realpathSync(tree.root);
}

// In-memory stand-in for the Server's stderr: collects exactly what the
// bootstrap writes so tests can assert the one-line skip diagnostic format
// precisely (the helper is copied per-file — tasks.md pins the existing
// fixture/sink helpers rather than new shared test infrastructure).
function memorySink(): { stream: Writable; text: () => string } {
  const chunks: string[] = [];
  const stream = new Writable({
    decodeStrings: false,
    write(
      chunk: string | Uint8Array,
      _encoding: string,
      callback: (error?: Error | null) => void,
    ): void {
      const decoded =
        typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
      chunks.push(decoded);
      callback();
    },
  });
  return { stream, text: () => chunks.join("") };
}

// One in-scope (relPath, text) pair — buildProgramContext's second argument,
// the form the analysis pipeline's pre-read produces.
type SourcePair = readonly [string, string];

// Runs one bootstrap with a fresh stderr sink and a stdout spy, so every test
// can assert the full contract at once: the returned context, the diagnostics
// channel, and a stdout that stayed reserved for JSON-RPC responses (FR-017
// reserves stdout; the bootstrap's stderr is injected per the Testability
// principle).
// The second argument widens to the pipeline's full PreReadSource shape — a
// `null` text is an excluded file (its diagnostic was already written
// upstream by readBounded), so the filtering tests can hand one through.
function bootstrap(
  realRoot: string,
  sourceFiles: ReadonlyArray<readonly [string, string | null]>,
) {
  const sink = memorySink();
  const stdout = vi.spyOn(process.stdout, "write");
  const context = buildProgramContext(realRoot, sourceFiles, sink.stream);
  return { context, sink, stdout };
}

// Narrows the ProgramContext union after asserting the mode: the expect gives
// the vitest failure message, the manual check narrows the type so each test
// reads only the arm it pins.
function expectProgramMode(
  context: ProgramContext,
): Extract<ProgramContext, { mode: "program" }> {
  expect(context.mode).toBe("program");
  if (context.mode !== "program") {
    throw new Error(`expected mode "program", received "${context.mode}"`);
  }
  return context;
}

function expectParseOnlyMode(
  context: ProgramContext,
): Extract<ProgramContext, { mode: "parse-only" }> {
  expect(context.mode).toBe("parse-only");
  if (context.mode !== "parse-only") {
    throw new Error(`expected mode "parse-only", received "${context.mode}"`);
  }
  return context;
}

// Shared fixture texts (each appears twice per test — the on-disk tree and
// the pre-read in-scope pairs — so constants prevent drift between them).
const ALPHA = "export const alpha = 1;\n";
const OMEGA = "export function omega(): number {\n  return 2;\n}\n";
const UTIL = "export const util = (input: number): number => input * 2;\n";
const KEEPS = "export const keeps = 3;\n";
const SOLO = "export const solo = 5;\n";
const HELPER = "export const helper = 7;\n";
const A_SOURCE = "export const a = 11;\n";
const BROKEN = 'const n: number = "not a number";\n\nexport const m = n;\n';
const MAIN_IMPORTING =
  'import { value } from "hugepkg";\n\nexport const used = value;\n';
const INDEX_TS = "export const index = 17;\n";
const PLAIN_JS = "export const jsValue = 19;\n";
const COMPONENT_JSX = "export const element = <div>content</div>;\n";
const MODULE_MJS = "export const moduleValue = 23;\n";
const COMMON_CJS = "exports.commonValue = 29;\n";
const PRESENT = "export const present = 37;\n";
const MISSING_FROM_SNAPSHOT = "export const missingFromSnapshot = 41;\n";
const WRONG_KIND = "export const wrongKind = 43;\n";
const OVERFLOW = "export const overflow = 47;\n";
const ESCAPED = "export const escaped = 53;\n";
const NOTES_TXT = "notes are not a compilable extension\n";

describe("buildProgramContext: program mode (US2 scenario 1, FR-003)", () => {
  // Program-mode bootstraps spawn the native compiler, so every test in this
  // file carries a timeout well above vitest's default.
  it('bootstraps mode "program" with a live checker and every in-scope file covered', {
    timeout: 30_000,
  }, async () => {
    const root = await makeTree({
      "tsconfig.json":
        '{"compilerOptions": {"strict": true, "target": "ES2022", "module": "commonjs"}}',
      "src/alpha.ts": ALPHA,
      "src/omega.ts": OMEGA,
      "lib/util.ts": UTIL,
    });
    const inScope: ReadonlyArray<SourcePair> = [
      ["src/alpha.ts", ALPHA],
      ["src/omega.ts", OMEGA],
      ["lib/util.ts", UTIL],
    ];
    const { context, sink, stdout } = bootstrap(root, inScope);

    const programMode = expectProgramMode(context);
    // FR-003's coverage guarantee: each in-scope root appears among the
    // program's source files — the bootstrap's own root set, never the
    // tsconfig's include/files output, decides coverage.
    const sourceFileNames = programMode.program.getSourceFileNames();
    for (const [relPath] of inScope) {
      expect(sourceFileNames).toContain(join(root, relPath));
    }
    const alpha = programMode.program.getSourceFile(join(root, "src/alpha.ts"));
    expect(alpha).toBeDefined();
    if (alpha === undefined) {
      throw new Error("in-scope source file missing from the program");
    }
    expect(alpha.fileName).toBe(join(root, "src/alpha.ts"));
    expect(alpha.text).toBe(ALPHA);
    // The context carries a live type checker wired to that program: it
    // resolves the type of a node in a covered file (the initializer of
    // alpha's exported constant, the literal 42 — well, 1).
    const varStmt = alpha.statements.find(
      (statement) => statement.kind === SyntaxKind.VariableStatement,
    );
    const initializer = varStmt?.declarationList.declarations[0]?.initializer;
    if (initializer === undefined) {
      throw new Error("fixture invariant: alpha's variable initializer is missing");
    }
    expect(programMode.checker.getTypeAtLocation(initializer)).toBeDefined();
    // A clean tree bootstraps with no skips and no stdout traffic.
    expect(sink.text()).toBe("");
    expect(stdout).not.toHaveBeenCalled();
  });

  it("forces the analyzer's option adjustments over the project's own config (US2 scenario 6, research R1)", {
    timeout: 30_000,
  }, async () => {
    const root = await makeTree({
      // Every forced option is set the wrong way by the project...
      "tsconfig.json": JSON.stringify({
        compilerOptions: {
          strict: true,
          target: "ES2020",
          noEmit: false,
          incremental: true,
          composite: true,
          tsBuildInfoFile: "./build/state.tsbuildinfo",
          skipLibCheck: false,
          allowJs: false,
          checkJs: true,
        },
      }),
      "src/main.ts": A_SOURCE,
    });
    const { context } = bootstrap(root, [["src/main.ts", A_SOURCE]]);

    const options = expectProgramMode(context).program.getCompilerOptions();
    // ...and the bootstrap forces its adjustments (research R1): analysis
    // is strictly read-only — no emit, no .tsbuildinfo writes — and never
    // fails on library or JavaScript code it must cover.
    expect(options.noEmit).toBe(true);
    expect(options.incremental).toBe(false);
    expect(options.composite).toBe(false);
    expect(options.tsBuildInfoFile).toBeUndefined();
    expect(options.skipLibCheck).toBe(true);
    expect(options.allowJs).toBe(true);
    expect(options.checkJs).toBe(false);
    // Everything else stays verbatim from the project's config (US2
    // scenario 6: the code as it exists — no analyzer-specific
    // configuration required of the analyzed project).
    expect(options.strict).toBe(true);
    expect(options.target).toBe(ScriptTarget.ES2020);
  });

  it("still bootstraps program mode when the tsconfig's only config error is the empty-files diagnostic (research R3)", {
    timeout: 30_000,
  }, async () => {
    const root = await makeTree({
      // `"files": []` is the designed-to-be-extended config style; the
      // compiler reports the empty-files diagnostic (TS18002) against it —
      // the one config-level error that cannot affect a bootstrap whose
      // root set is its own, so research R3 excludes it from the fallback
      // triggers.
      "tsconfig.json": '{"files": []}',
      "src/keeps.ts": KEEPS,
    });
    const { context, sink, stdout } = bootstrap(root, [["src/keeps.ts", KEEPS]]);

    const programMode = expectProgramMode(context);
    expect(programMode.program.getSourceFileNames()).toContain(
      join(root, "src/keeps.ts"),
    );
    expect(sink.text()).toBe("");
    expect(stdout).not.toHaveBeenCalled();
  });
});

describe("buildProgramContext: parse-only fallback (US2 scenarios 2 and 5, FR-004)", () => {
  it('bootstraps mode "parse-only" with a source for every in-scope file when no tsconfig exists', {
    timeout: 30_000,
  }, async () => {
    const root = await makeTree({
      "src/solo.ts": SOLO,
      "lib/helper.ts": HELPER,
    });
    const inScope: ReadonlyArray<SourcePair> = [
      ["src/solo.ts", SOLO],
      ["lib/helper.ts", HELPER],
    ];
    const { context, sink, stdout } = bootstrap(root, inScope);

    const parseOnly = expectParseOnlyMode(context);
    // A source for every in-scope file (FR-004), keyed by root-relative
    // path with the absolute fileName and pre-read text preserved.
    expect(parseOnly.sources.size).toBe(inScope.length);
    for (const [relPath, text] of inScope) {
      const source = parseOnly.sources.get(relPath);
      expect(source?.fileName).toBe(join(root, relPath));
      expect(source?.text).toBe(text);
    }
    // The fallback completes normally: no diagnostics (an absent tsconfig
    // is a first-class mode, not a degradation to warn about) and no
    // stdout traffic.
    expect(sink.text()).toBe("");
    expect(stdout).not.toHaveBeenCalled();
  });

  it("falls back to parse-only when tsconfig.json is unparseable (US2 scenario 5)", {
    timeout: 30_000,
  }, async () => {
    const root = await makeTree({
      "tsconfig.json": "{ not json",
      "src/a.ts": A_SOURCE,
    });
    const { context, stdout } = bootstrap(root, [["src/a.ts", A_SOURCE]]);

    // A broken tsconfig degrades precision, never availability (FR-004):
    // the fallback is never an error and is invisible on the wire.
    const parseOnly = expectParseOnlyMode(context);
    const source = parseOnly.sources.get("src/a.ts");
    expect(source?.fileName).toBe(join(root, "src/a.ts"));
    expect(source?.text).toBe(A_SOURCE);
    expect(stdout).not.toHaveBeenCalled();
  });
});

describe("buildProgramContext: JavaScript-family sources (US2 scenario 4, FR-006)", () => {
  it("analyzes in-scope .js/.jsx/.mjs/.cjs files in parse-only mode with the explicit script-kind map (research R2)", {
    timeout: 30_000,
  }, async () => {
    const root = await makeTree({
      "src/plain.js": PLAIN_JS,
      "src/component.jsx": COMPONENT_JSX,
      "src/module.mjs": MODULE_MJS,
      "src/common.cjs": COMMON_CJS,
    });
    const inScope: ReadonlyArray<SourcePair> = [
      ["src/plain.js", PLAIN_JS],
      ["src/component.jsx", COMPONENT_JSX],
      ["src/module.mjs", MODULE_MJS],
      ["src/common.cjs", COMMON_CJS],
    ];
    const { context, sink, stdout } = bootstrap(root, inScope);

    const parseOnly = expectParseOnlyMode(context);
    // Never silently skipped (FR-006): every JavaScript-family root parses.
    expect(parseOnly.sources.size).toBe(inScope.length);
    for (const [relPath, text] of inScope) {
      const source = parseOnly.sources.get(relPath);
      expect(source?.fileName).toBe(join(root, relPath));
      expect(source?.text).toBe(text);
    }
    // The explicit extension map (research R2): .js/.mjs/.cjs parse as JS
    // and .jsx as JSX — deterministic and auditable, not filename inference
    // with version-dependent .mjs/.cjs behavior.
    expect(parseOnly.sources.get("src/plain.js")?.scriptKind).toBe(ScriptKind.JS);
    expect(parseOnly.sources.get("src/module.mjs")?.scriptKind).toBe(ScriptKind.JS);
    expect(parseOnly.sources.get("src/common.cjs")?.scriptKind).toBe(ScriptKind.JS);
    expect(parseOnly.sources.get("src/component.jsx")?.scriptKind).toBe(ScriptKind.JSX);
    expect(sink.text()).toBe("");
    expect(stdout).not.toHaveBeenCalled();
  });

  it("analyzes in-scope .js/.jsx/.mjs/.cjs files in program mode despite the project's allowJs: false (research R1)", {
    timeout: 30_000,
  }, async () => {
    const root = await makeTree({
      // The project's config forbids JavaScript; the forced allowJs: true
      // is load-bearing for FR-006 — without it these roots drop out of
      // the program entirely.
      "tsconfig.json": '{"compilerOptions": {"allowJs": false, "strict": true}}',
      "src/index.ts": INDEX_TS,
      "src/plain.js": PLAIN_JS,
      "src/component.jsx": COMPONENT_JSX,
      "src/module.mjs": MODULE_MJS,
      "src/common.cjs": COMMON_CJS,
    });
    const inScope: ReadonlyArray<SourcePair> = [
      ["src/index.ts", INDEX_TS],
      ["src/plain.js", PLAIN_JS],
      ["src/component.jsx", COMPONENT_JSX],
      ["src/module.mjs", MODULE_MJS],
      ["src/common.cjs", COMMON_CJS],
    ];
    const { context, sink, stdout } = bootstrap(root, inScope);

    const programMode = expectProgramMode(context);
    const sourceFileNames = programMode.program.getSourceFileNames();
    for (const [relPath] of inScope) {
      expect(sourceFileNames).toContain(join(root, relPath));
    }
    expect(sink.text()).toBe("");
    expect(stdout).not.toHaveBeenCalled();
  });
});

describe("buildProgramContext: type-error tolerance (US2 scenario 3, FR-005)", () => {
  it("bootstraps and completes over code with semantic type errors", {
    timeout: 30_000,
  }, async () => {
    const root = await makeTree({
      "tsconfig.json":
        '{"compilerOptions": {"strict": true, "target": "ES2022", "module": "commonjs"}}',
      "src/broken.ts": BROKEN,
    });
    const { context, sink, stdout } = bootstrap(root, [["src/broken.ts", BROKEN]]);

    const programMode = expectProgramMode(context);
    expect(
      programMode.program.getSourceFile(join(root, "src/broken.ts")),
    ).toBeDefined();
    // The fixture genuinely type-errors under the project's strict config…
    expect(
      programMode.program.getSemanticDiagnostics(join(root, "src/broken.ts")).length,
    ).toBeGreaterThan(0);
    // …and the bootstrap completed anyway: semantic diagnostics are never a
    // gate (FR-005). Type errors surface as error types the ambiguity rules
    // handle; they never abort the bootstrap and never touch the
    // diagnostics channel, which skip conditions own.
    expect(sink.text()).toBe("");
    expect(stdout).not.toHaveBeenCalled();
  });
});

describe("buildProgramContext: bounded compiler host (research R1, Constitution V)", () => {
  it("skips an oversized transitive dependency with exactly one stderr diagnostic instead of reading it unbounded", {
    timeout: 30_000,
  }, async () => {
    const root = await makeTree({
      "tsconfig.json": '{"compilerOptions": {"module": "commonjs"}}',
      "src/main.ts": MAIN_IMPORTING,
      "node_modules/hugepkg/index.d.ts": "export declare const value: number;\n",
    });
    // The walk prunes node_modules, so the dependency reaches the compiler
    // only through module resolution — the transitive path the bounded
    // compiler host guards. Sparse-grow it past the 16 MiB cap.
    await truncate(join(root, "node_modules/hugepkg/index.d.ts"), MAX_FILE_BYTES + 1);

    const { context, sink, stdout } = bootstrap(root, [
      ["src/main.ts", MAIN_IMPORTING],
    ]);

    const programMode = expectProgramMode(context);
    // The in-scope root stays covered; the skipped dependency resolves as
    // an absent module (any types) — graceful degradation, never a crash.
    expect(programMode.program.getSourceFileNames()).toContain(
      join(root, "src/main.ts"),
    );
    // Exactly one diagnostic: the bounded read's skip line, naming the
    // absolute path verbatim with safeio's reason string — the huge file
    // is skipped before it is ever opened, never read unbounded.
    expect(sink.text()).toBe(
      `reading-stone: skipping ${join(root, "node_modules/hugepkg/index.d.ts")}: exceeds 16 MiB size limit\n`,
    );
    expect(stdout).not.toHaveBeenCalled();
  });
});

describe("buildProgramContext: usable-source filtering (FR-004, research R2)", () => {
  it("bootstraps an empty parse-only context when the in-scope set is empty", {
    timeout: 30_000,
  }, async () => {
    // A tree whose every read was skipped upstream, or that the walk found
    // nothing in: the bootstrap's own early return — an empty context, never
    // an error, and never a diagnostic of its own.
    const root = await makeTree({ "src/unreached.ts": SOLO });
    const { context, sink, stdout } = bootstrap(root, []);

    const parseOnly = expectParseOnlyMode(context);
    expect(parseOnly.sources.size).toBe(0);
    expect(sink.text()).toBe("");
    expect(stdout).not.toHaveBeenCalled();
  });

  it("excludes a null pre-read text silently — its diagnostic was already written", {
    timeout: 30_000,
  }, async () => {
    const root = await makeTree({
      "src/solo.ts": SOLO,
      "src/oversized.ts": HELPER,
    });
    // readBounded already wrote the skipped file's diagnostic line before the
    // bootstrap ran; the null text just excludes it — never a second
    // diagnostic for one skip (safeio's skip semantics carried through).
    const { context, sink, stdout } = bootstrap(root, [
      ["src/solo.ts", SOLO],
      ["src/oversized.ts", null],
    ]);

    const parseOnly = expectParseOnlyMode(context);
    expect(parseOnly.sources.size).toBe(1);
    expect(parseOnly.sources.get("src/solo.ts")?.text).toBe(SOLO);
    expect(sink.text()).toBe("");
    expect(stdout).not.toHaveBeenCalled();
  });

  it("skips a source whose extension is outside the explicit map with exactly one diagnostic", {
    timeout: 30_000,
  }, async () => {
    const root = await makeTree({
      "src/solo.ts": SOLO,
      "src/notes.txt": NOTES_TXT,
    });
    // Discovery walks exactly the six mapped extensions, so an unmapped
    // extension reaching the bootstrap means the two surfaces drifted apart:
    // a diagnosed skip (Principle II's acknowledged uncertainty), never a
    // silent mis-shape handed to the compiler.
    const { context, sink, stdout } = bootstrap(root, [
      ["src/solo.ts", SOLO],
      ["src/notes.txt", NOTES_TXT],
    ]);

    const parseOnly = expectParseOnlyMode(context);
    expect(parseOnly.sources.size).toBe(1);
    expect(parseOnly.sources.get("src/solo.ts")?.text).toBe(SOLO);
    expect(sink.text()).toBe(
      "reading-stone: skipping src/notes.txt: unsupported extension\n",
    );
    expect(stdout).not.toHaveBeenCalled();
  });
});

describe("buildProgramContext: bounded-reader tsconfig skip (research R1, FR-004)", () => {
  it("falls back to parse-only when the root tsconfig is itself skipped by the bounded reader", {
    timeout: 30_000,
  }, async () => {
    const root = await makeTree({
      "tsconfig.json": '{"compilerOptions": {"strict": true}}',
      "src/a.ts": A_SOURCE,
    });
    // The config text is read through the bounded reader before anything
    // spawns (research R1 step 1): an oversized config has already written
    // its one diagnostic and falls back here — a broken config degrades
    // precision, never availability.
    await truncate(join(root, "tsconfig.json"), MAX_FILE_BYTES + 1);

    const { context, sink, stdout } = bootstrap(root, [["src/a.ts", A_SOURCE]]);

    const parseOnly = expectParseOnlyMode(context);
    expect(parseOnly.sources.get("src/a.ts")?.text).toBe(A_SOURCE);
    expect(sink.text()).toBe(
      `reading-stone: skipping ${join(root, "tsconfig.json")}: exceeds 16 MiB size limit\n`,
    );
    expect(stdout).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Compiler-drift guards (research R1, R2, R3, R15). The guards exercised
// below — the per-file skip paths, the config-diagnostic boundary, disposal,
// the hermetic listings, and the lib-directory fallbacks — exist to catch
// compiler misbehavior loudly: the module header states the script-kind
// enforcement "never fires on typescript 7.0.2 (verified) and exists to catch
// compiler drift loudly instead", and the same drift-defense reading governs
// its siblings. They cannot fire against the well-behaved native server, so
// these tests script the misbehavior through a recording stand-in for the
// `typescript/unstable/sync` API class: the real module passes through
// untouched otherwise, the stand-in never spawns the native server, and its
// constructor captures each spawned client (cwd plus the delegation
// callbacks — the bounded host under test) so routing and lifecycle contracts
// are asserted directly. Principle II governs: a diagnosed skip is safety
// behavior worth testing, not trimming. No test below spawns a native server,
// so none needs the spawn timeout the unmocked suites carry.
// ---------------------------------------------------------------------------

// The analyzer's own `require`, captured before any per-test doMock so
// lib-directory routing assertions can resolve the real typescript package
// even while the freshly imported module under test resolves a scripted one.
const realRequire = createRequire(import.meta.url);

// One recorded compiler client: the cwd and delegation callbacks it was
// spawned with, plus the close spy lifecycle assertions read.
type MockedClient = {
  cwd: string;
  fs: FileSystem;
  close: Mock;
};

// A parsed-source stand-in carrying exactly the members the bootstrap reads
// back: fileName, text, and scriptKind.
function fakeSource(fileName: string, text: string, scriptKind: ScriptKind) {
  return { fileName, text, scriptKind };
}

// Scripts ONE test's compiler-client module: the real module passes through
// untouched except that `API` becomes a recording stand-in that never spawns
// the native server. `updateSnapshot` answers the scripted snapshot (or
// throws if a test that expects no spawn forgot to script one), and the
// constructor captures every spawned client in the returned log. Pair with
// importFreshProgram() below so the mock applies to exactly this test.
function mockCompilerClient(snapshot?: unknown): Array<MockedClient> {
  const clients: Array<MockedClient> = [];
  vi.doMock("typescript/unstable/sync", async (importOriginal) => {
    const actual = await importOriginal<typeof import("typescript/unstable/sync")>();
    class RecordingAPI {
      readonly cwd: string;
      readonly fs: FileSystem;
      readonly close = vi.fn();
      constructor(options: { cwd: string; fs: FileSystem }) {
        this.cwd = options.cwd;
        this.fs = options.fs;
        clients.push(this);
      }
      updateSnapshot(): unknown {
        if (snapshot === undefined) {
          throw new Error(
            "fixture invariant: the compiler client was consulted without a scripted snapshot",
          );
        }
        return snapshot;
      }
    }
    return { ...actual, API: RecordingAPI };
  });
  return clients;
}

// Scripts ONE test's resolution of the analyzer's own typescript package:
// "throw" models an unresolvable package (computeCompilerLibDirectory's
// resolve catch), and a packageJsonPath models a resolvable package whose
// platform-package candidates are both absent. Every other module id
// resolves for real, so the rest of the freshly imported graph is unaffected.
function mockTypescriptResolution(
  resolution: "throw" | { packageJsonPath: string },
): void {
  vi.doMock("node:module", async (importOriginal) => {
    const actual = await importOriginal<typeof import("node:module")>();
    const realCreateRequire = actual.createRequire;
    return {
      ...actual,
      createRequire: (filename: string | URL) => {
        const real = realCreateRequire(filename);
        return {
          resolve: (id: string, options?: { paths?: Array<string> }) => {
            if (id === "typescript/package.json") {
              if (resolution === "throw") {
                throw new Error(`Cannot find module '${id}'`);
              }
              return resolution.packageJsonPath;
            }
            return real.resolve(id, options);
          },
        };
      },
    };
  });
}

// Imports a fresh, mock-respecting copy of src/program.ts: vi.resetModules()
// clears the registry so the dynamic import re-evaluates the module (and its
// compiler-client dependency) through the active doMock registrations, while
// the file's static import — used by every unmocked test above — keeps its
// original real-module binding.
async function importFreshProgram(): Promise<typeof import("../src/program.js")> {
  vi.resetModules();
  return await import("../src/program.js");
}

// The mocked-describe counterpart of bootstrap(): same sink and stdout-spy
// contract, but against the freshly imported module under test.
function bootstrapMocked(
  build: typeof import("../src/program.js")["buildProgramContext"],
  realRoot: string,
  sourceFiles: ReadonlyArray<readonly [string, string | null]>,
) {
  const sink = memorySink();
  const stdout = vi.spyOn(process.stdout, "write");
  const context = build(realRoot, sourceFiles, sink.stream);
  return { context, sink, stdout };
}

// Narrows a captured client's delegation callbacks to the members the
// routing assertions exercise (program.ts always provides every callback, so
// a miss is a fixture invariant, not a branch under test).
function requireHost(fs: FileSystem) {
  const { readFile, fileExists, directoryExists, getAccessibleEntries, realpath } = fs;
  if (
    readFile === undefined ||
    fileExists === undefined ||
    directoryExists === undefined ||
    getAccessibleEntries === undefined ||
    realpath === undefined
  ) {
    throw new Error(
      "fixture invariant: the bootstrap must provide every filesystem callback",
    );
  }
  return { readFile, fileExists, directoryExists, getAccessibleEntries, realpath };
}

// A clean program-mode project for routing tests: no config diagnostics (the
// fallback boundary reads none), plus the program and checker handed through
// to the consumer.
function cleanProgramProject() {
  return {
    program: { getConfigFileParsingDiagnostics: () => [] },
    checker: {},
    compilerOptions: {},
  };
}

// Mirrors computeCompilerLibDirectory's documented candidate order (hoisted
// beside the typescript package first, nested under it second) so routing
// tests can address real lib paths — the same directory the unmocked module
// resolves in this repository's install.
function realCompilerLibDirectory(): string {
  const typescriptDirectory = dirname(realRequire.resolve("typescript/package.json"));
  const platformPackage = `typescript-${process.platform}-${process.arch}`;
  const candidates = [
    join(dirname(typescriptDirectory), "@typescript", platformPackage, "lib"),
    join(typescriptDirectory, "node_modules", "@typescript", platformPackage, "lib"),
  ];
  for (const candidate of candidates) {
    try {
      if (statSync(candidate).isDirectory()) {
        return candidate;
      }
    } catch {
      // Not present: try the next candidate, mirroring the source.
    }
  }
  throw new Error("fixture invariant: the analyzer's lib directory did not resolve");
}

// One guaranteed-present platform lib declaration name, for routing
// assertions against the real lib directory.
function sampleLibDeclaration(libDirectory: string): string {
  const sample = readdirSync(libDirectory).find((name) => name.endsWith(".d.ts"));
  if (sample === undefined) {
    throw new Error("fixture invariant: no platform lib .d.ts to read");
  }
  return sample;
}

describe("buildProgramContext: compiler-drift guards (research R1, R2, R3, R15)", () => {
  afterEach(() => {
    vi.doUnmock("typescript/unstable/sync");
    vi.doUnmock("node:module");
    vi.resetModules();
  });

  it("never spawns the compiler for an empty usable set", async () => {
    const root = await makeTree({ "src/unreached.ts": SOLO });
    const clients = mockCompilerClient();
    const { buildProgramContext: build } = await importFreshProgram();
    const { context, sink, stdout } = bootstrapMocked(build, root, []);

    const parseOnly = expectParseOnlyMode(context);
    expect(parseOnly.sources.size).toBe(0);
    expect(clients.length).toBe(0);
    expect(sink.text()).toBe("");
    expect(stdout).not.toHaveBeenCalled();
  });

  it("isolates per-file skips when the snapshot misbehaves: missing files, wrong script kinds, parser stack overflow", async () => {
    const root = await makeTree({
      "src/present.ts": PRESENT,
      "src/missing.ts": MISSING_FROM_SNAPSHOT,
      "src/wrongkind.ts": WRONG_KIND,
      "src/overflow.ts": OVERFLOW,
    });
    const pairs: ReadonlyArray<SourcePair> = [
      ["src/present.ts", PRESENT],
      ["src/missing.ts", MISSING_FROM_SNAPSHOT],
      ["src/wrongkind.ts", WRONG_KIND],
      ["src/overflow.ts", OVERFLOW],
    ];
    const present = fakeSource(join(root, "src/present.ts"), PRESENT, ScriptKind.TS);
    const snapshot = {
      // The parse-only route: every opened file lands in one inferred
      // project, so one scripted project answers all four fetches.
      getDefaultProjectForFile: () => ({
        program: {
          getSourceFile: (absPath: string) => {
            if (absPath === join(root, "src/missing.ts")) {
              return undefined; // the snapshot never materialized the file
            }
            if (absPath === join(root, "src/wrongkind.ts")) {
              return fakeSource(absPath, WRONG_KIND, ScriptKind.JSX); // decoded as the wrong kind
            }
            if (absPath === join(root, "src/overflow.ts")) {
              throw new RangeError("Maximum call stack size exceeded"); // research R15
            }
            return present;
          },
        },
      }),
    };
    const clients = mockCompilerClient(snapshot);
    const { buildProgramContext: build } = await importFreshProgram();
    const { context, sink, stdout } = bootstrapMocked(build, root, pairs);

    const parseOnly = expectParseOnlyMode(context);
    // One skip never aborts its siblings (FR-004 availability): the healthy
    // file parses while each misbehavior earns exactly one diagnostic, in
    // pair order.
    expect(parseOnly.sources.size).toBe(1);
    expect(parseOnly.sources.get("src/present.ts")).toBe(present);
    expect(sink.text()).toBe(
      "reading-stone: skipping src/missing.ts: not present in snapshot\n" +
        "reading-stone: skipping src/wrongkind.ts: unexpected script kind\n" +
        "reading-stone: skipping src/overflow.ts: parser stack overflow\n",
    );
    // The parse-only route always closes its client before returning.
    expect(clients.length).toBe(1);
    expect(clients[0].close).toHaveBeenCalledTimes(1);
    expect(stdout).not.toHaveBeenCalled();
  });

  it("rethrows a fatal compiler error after closing the client — a crash is never a silent skip", async () => {
    const root = await makeTree({ "src/main.ts": A_SOURCE });
    const snapshot = {
      getDefaultProjectForFile: () => ({
        program: {
          getSourceFile: () => {
            throw new Error("compiler channel died");
          },
        },
      }),
    };
    const clients = mockCompilerClient(snapshot);
    const { buildProgramContext: build } = await importFreshProgram();
    const sink = memorySink();
    const stdout = vi.spyOn(process.stdout, "write");

    // Only a RangeError is a diagnosed skip (research R15); anything else
    // escapes — and the finally still closes the client, so no native server
    // outlives a crashed bootstrap.
    expect(() => build(root, [["src/main.ts", A_SOURCE]], sink.stream)).toThrowError(
      "compiler channel died",
    );
    expect(clients.length).toBe(1);
    expect(clients[0].close).toHaveBeenCalledTimes(1);
    expect(sink.text()).toBe("");
    expect(stdout).not.toHaveBeenCalled();
  });

  it("serves the hermetic view: in-scope texts from memory, sorted in-scope listings, and does-not-exist for everything else", async () => {
    const root = await makeTree({
      "alpha.ts": ALPHA,
      "src/omega.ts": OMEGA,
      "lib/util.ts": UTIL,
    });
    const pairs: ReadonlyArray<SourcePair> = [
      ["alpha.ts", ALPHA],
      ["src/omega.ts", OMEGA],
      ["lib/util.ts", UTIL],
    ];
    const byPath = new Map(
      pairs.map(([relPath, text]) => [
        join(root, relPath),
        fakeSource(join(root, relPath), text, ScriptKind.TS),
      ]),
    );
    const snapshot = {
      getDefaultProjectForFile: () => ({
        program: { getSourceFile: (absPath: string) => byPath.get(absPath) },
      }),
    };
    const clients = mockCompilerClient(snapshot);
    const { buildProgramContext: build } = await importFreshProgram();
    const { context, sink, stdout } = bootstrapMocked(build, root, pairs);

    const parseOnly = expectParseOnlyMode(context);
    expect(parseOnly.sources.size).toBe(3);
    const host = requireHost(clients[0].fs);
    // readFile answers from the pre-read pairs and NEVER falls back to the
    // real filesystem: unknown paths do not exist (`null`, not `undefined`).
    expect(host.readFile(join(root, "alpha.ts"))).toBe(ALPHA);
    expect(host.readFile(join(root, "unknown.ts"))).toBe(null);
    expect(host.fileExists(join(root, "src/omega.ts"))).toBe(true);
    expect(host.fileExists(join(root, "unknown.ts"))).toBe(false);
    expect(host.directoryExists(join(root, "src"))).toBe(true);
    expect(host.directoryExists(join(root, "nodir"))).toBe(false);
    // Listings are the in-scope view only — sorted, so the compiler's view is
    // a pure function of the tree (Constitution I) — and deliberately not
    // the real directory contents: include-style globbing can never surface
    // files beyond the in-scope set.
    expect(host.getAccessibleEntries(root)).toEqual({
      files: ["alpha.ts"],
      directories: ["lib", "src"],
    });
    expect(host.getAccessibleEntries(join(root, "src"))).toEqual({
      files: ["omega.ts"],
      directories: [],
    });
    expect(host.getAccessibleEntries(join(root, "nodir"))).toEqual({
      files: [],
      directories: [],
    });
    expect(host.realpath(join(root, "alpha.ts"))).toBe(join(root, "alpha.ts"));
    expect(clients[0].close).toHaveBeenCalledTimes(1);
    expect(sink.text()).toBe("");
    expect(stdout).not.toHaveBeenCalled();
  });

  it("terminates the ancestor walk at the filesystem root for a pair that escapes the analysis root", async () => {
    // buildHermeticView's ancestor walk carries a termination guarantee
    // independent of root membership: it stops at the filesystem root. A
    // relPath that escapes the root (a pair the pipeline's own walk can
    // never produce — defense in depth for future callers) is the only input
    // that climbs past the pre-seeded root directory, so it pins the
    // guarantee: without the break, the dirname chain has no other stop.
    const root = await makeTree({});
    const escapedAbs = join(root, "../escaped.ts");
    const snapshot = {
      getDefaultProjectForFile: () => ({
        program: {
          getSourceFile: () => fakeSource(escapedAbs, ESCAPED, ScriptKind.TS),
        },
      }),
    };
    const clients = mockCompilerClient(snapshot);
    const { buildProgramContext: build } = await importFreshProgram();
    const { context, sink, stdout } = bootstrapMocked(build, root, [
      ["../escaped.ts", ESCAPED],
    ]);

    const parseOnly = expectParseOnlyMode(context);
    expect(parseOnly.sources.get("../escaped.ts")?.fileName).toBe(escapedAbs);
    expect(parseOnly.sources.get("../escaped.ts")?.text).toBe(ESCAPED);
    const host = requireHost(clients[0].fs);
    // The walk climbed to the filesystem root — and stopped there.
    expect(host.directoryExists("/")).toBe(true);
    // The escaped file is indexed in its real parent directory, and the root
    // itself is the only subdirectory the view added there.
    expect(host.getAccessibleEntries(dirname(root))).toEqual({
      files: ["escaped.ts"],
      directories: [basename(root)],
    });
    expect(clients[0].close).toHaveBeenCalledTimes(1);
    expect(sink.text()).toBe("");
    expect(stdout).not.toHaveBeenCalled();
  });

  it("keeps program mode through non-error and no-inputs config diagnostics, and disposes exactly once", async () => {
    const root = await makeTree({
      "tsconfig.json": '{"compilerOptions": {"strict": true}}',
      "src/main.ts": A_SOURCE,
    });
    const mainSource = fakeSource(join(root, "src/main.ts"), A_SOURCE, ScriptKind.TS);
    const fakeProgram = {
      getConfigFileParsingDiagnostics: () => [
        // Message-category config output is never a gate...
        { category: DiagnosticCategory.Message, code: 1234 },
        // ...and the no-inputs family cannot affect a bootstrap whose root
        // set is its own (research R3's exclusion).
        { category: DiagnosticCategory.Error, code: 18002 },
      ],
      getSourceFileNames: () => [join(root, "src/main.ts")],
      getSourceFile: () => mainSource,
    };
    const fakeChecker = {};
    const fakeProject = {
      program: fakeProgram,
      checker: fakeChecker,
      compilerOptions: { tsBuildInfoFile: "./build/state.tsbuildinfo" },
    };
    const snapshot = { getProject: () => fakeProject };
    const clients = mockCompilerClient(snapshot);
    const { buildProgramContext: build } = await importFreshProgram();
    const { context, sink, stdout } = bootstrapMocked(build, root, [
      ["src/main.ts", A_SOURCE],
    ]);

    const programMode = expectProgramMode(context);
    // The context wires the project's own program and checker...
    expect(programMode.program).toBe(fakeProgram);
    expect(programMode.checker).toBe(fakeChecker);
    // ...and the forced `tsBuildInfoFile: undefined` adjustment is observable
    // on the parsed options object (the client-side mirror of the classic
    // `{...options, tsBuildInfoFile: undefined}` spread).
    expect(fakeProject.compilerOptions.tsBuildInfoFile).toBeUndefined();
    // Disposal closes the native server exactly once, however often the
    // consumer calls it: no channel is closed twice.
    programMode.dispose();
    programMode.dispose();
    expect(clients.length).toBe(1);
    expect(clients[0].close).toHaveBeenCalledTimes(1);
    expect(sink.text()).toBe("");
    expect(stdout).not.toHaveBeenCalled();
  });

  it("falls back to parse-only on a blocking config error, closing the failed client first", async () => {
    const root = await makeTree({
      "tsconfig.json": '{"compilerOptions": {"strict": true}}',
      "src/main.ts": A_SOURCE,
    });
    const parsed = fakeSource(join(root, "src/main.ts"), A_SOURCE, ScriptKind.TS);
    const snapshot = {
      // The program attempt reports a config error beyond the no-inputs
      // family (research R3's boundary)...
      getProject: () => ({
        program: {
          getConfigFileParsingDiagnostics: () => [
            { category: DiagnosticCategory.Error, code: 5023 },
          ],
        },
        checker: {},
        compilerOptions: {},
      }),
      // ...so the parse-only retry re-runs on a fresh client.
      getDefaultProjectForFile: () => ({
        program: { getSourceFile: () => parsed },
      }),
    };
    const clients = mockCompilerClient(snapshot);
    const { buildProgramContext: build } = await importFreshProgram();
    const { context, sink, stdout } = bootstrapMocked(build, root, [
      ["src/main.ts", A_SOURCE],
    ]);

    const parseOnly = expectParseOnlyMode(context);
    expect(parseOnly.sources.get("src/main.ts")).toBe(parsed);
    // Two clients, each closed exactly once: the failed program attempt in
    // its finally, the parse-only retry in its own. The fallback itself is
    // silent — a broken config degrades precision, never availability.
    expect(clients.length).toBe(2);
    expect(clients[0].cwd).toBe(root);
    expect(clients[1].cwd).toBe(root);
    expect(clients[0].close).toHaveBeenCalledTimes(1);
    expect(clients[1].close).toHaveBeenCalledTimes(1);
    expect(sink.text()).toBe("");
    expect(stdout).not.toHaveBeenCalled();
  });

  it("routes compiler reads through the bounded program host: memory first, bounded lib reads, out-of-root refused", async () => {
    const root = await makeTree({
      "tsconfig.json": '{"compilerOptions": {"strict": true}}',
      "src/main.ts": A_SOURCE,
    });
    const snapshot = { getProject: () => cleanProgramProject() };
    const clients = mockCompilerClient(snapshot);
    const { buildProgramContext: build } = await importFreshProgram();
    const { context, sink, stdout } = bootstrapMocked(build, root, [
      ["src/main.ts", A_SOURCE],
    ]);
    expectProgramMode(context);

    const host = requireHost(clients[0].fs);
    // (1) The two config texts and the in-scope pre-read texts come from
    // memory: the served project config verbatim, and the virtual extender
    // exactly as built (deterministic for the same inputs — Constitution I).
    expect(host.readFile(join(root, "tsconfig.json"))).toBe(
      '{"compilerOptions": {"strict": true}}',
    );
    expect(host.readFile(join(root, ".reading-stone-tsconfig.json"))).toBe(
      JSON.stringify({
        extends: "./tsconfig.json",
        files: [join(root, "src/main.ts")],
        include: [],
        references: [],
        compilerOptions: {
          noEmit: true,
          incremental: false,
          composite: false,
          skipLibCheck: true,
          allowJs: true,
          checkJs: false,
        },
      }),
    );
    expect(host.readFile(join(root, "src/main.ts"))).toBe(A_SOURCE);
    // (2) An absent in-root probe is routine resolution traffic: a silent
    // does-not-exist, never a skip diagnostic.
    expect(host.readFile(join(root, "src/absent.ts"))).toBe(null);
    expect(sink.text()).toBe("");
    // (3) Reads under the analyzer's own platform lib directory are bounded
    // but exempt from root containment: a real lib file reads through
    // readBoundedSync...
    const libDirectory = realCompilerLibDirectory();
    const libFile = sampleLibDeclaration(libDirectory);
    expect(host.readFile(join(libDirectory, libFile))).toBeTypeOf("string");
    expect(sink.text()).toBe("");
    // ...and a lib path the bounded reader skips resolves as absent, with
    // safeio's own diagnostic (never an unbounded read).
    expect(host.readFile(join(libDirectory, "not-a-real-lib.d.ts"))).toBe(null);
    expect(sink.text()).toBe(
      `reading-stone: skipping ${join(libDirectory, "not-a-real-lib.d.ts")}: unreadable\n`,
    );
    // (4) Every other compiler-resolved path outside the analysis root does
    // not exist, with one diagnostic.
    const outside = join(dirname(root), "outside.ts");
    expect(host.readFile(outside)).toBe(null);
    expect(sink.text()).toBe(
      `reading-stone: skipping ${join(libDirectory, "not-a-real-lib.d.ts")}: unreadable\n` +
        `reading-stone: skipping ${outside}: outside analysis root\n`,
    );
    // (5) Existence probing mirrors the read routing: out-of-root paths do
    // not exist, so module resolution cannot walk past the analyzed tree.
    expect(host.fileExists(join(root, "tsconfig.json"))).toBe(true);
    expect(host.fileExists(join(root, "src/main.ts"))).toBe(true);
    expect(host.fileExists(join(root, "src/absent.ts"))).toBe(false);
    expect(host.fileExists(outside)).toBe(false);
    expect(host.directoryExists(root)).toBe(true);
    expect(host.directoryExists(outside)).toBe(false);
    // (6) Directory listings stay the hermetic in-scope view, and realpath
    // is identity — the analyzed tree as the compiler may see it.
    expect(host.getAccessibleEntries(root)).toEqual({
      files: [],
      directories: ["src"],
    });
    expect(host.realpath(join(root, "src/main.ts"))).toBe(join(root, "src/main.ts"));
    expect(stdout).not.toHaveBeenCalled();
  });

  it("degrades to no lib directory when the typescript package cannot be resolved", async () => {
    const root = await makeTree({
      "tsconfig.json": '{"compilerOptions": {"strict": true}}',
      "src/main.ts": A_SOURCE,
    });
    // computeCompilerLibDirectory's resolve catch: without the typescript
    // package nothing could have spawned the server, so the lib directory is
    // absent — and no out-of-root path qualifies as a lib read anymore.
    mockTypescriptResolution("throw");
    const snapshot = { getProject: () => cleanProgramProject() };
    const clients = mockCompilerClient(snapshot);
    const { buildProgramContext: build } = await importFreshProgram();
    const { context, sink, stdout } = bootstrapMocked(build, root, [
      ["src/main.ts", A_SOURCE],
    ]);
    expectProgramMode(context);

    const host = requireHost(clients[0].fs);
    const libDirectory = realCompilerLibDirectory();
    const libFile = sampleLibDeclaration(libDirectory);
    // A path that normally qualifies as a bounded lib read now does not
    // exist — with the out-of-root diagnostic, proving the lib route closed.
    expect(host.readFile(join(libDirectory, libFile))).toBe(null);
    expect(sink.text()).toBe(
      `reading-stone: skipping ${join(libDirectory, libFile)}: outside analysis root\n`,
    );
    expect(stdout).not.toHaveBeenCalled();
  });

  it("degrades to no lib directory when neither platform-package candidate exists", async () => {
    const root = await makeTree({
      "tsconfig.json": '{"compilerOptions": {"strict": true}}',
      "src/main.ts": A_SOURCE,
    });
    // The typescript package resolves, but into a location where neither
    // documented candidate (hoisted beside it, nested under it) exists: the
    // deterministic candidate order runs to exhaustion and the lib directory
    // is absent.
    mockTypescriptResolution({
      packageJsonPath: join(root, "typescript", "package.json"),
    });
    const snapshot = { getProject: () => cleanProgramProject() };
    const clients = mockCompilerClient(snapshot);
    const { buildProgramContext: build } = await importFreshProgram();
    const { context, sink, stdout } = bootstrapMocked(build, root, [
      ["src/main.ts", A_SOURCE],
    ]);
    expectProgramMode(context);

    const host = requireHost(clients[0].fs);
    const libDirectory = realCompilerLibDirectory();
    const libFile = sampleLibDeclaration(libDirectory);
    expect(host.readFile(join(libDirectory, libFile))).toBe(null);
    expect(sink.text()).toBe(
      `reading-stone: skipping ${join(libDirectory, libFile)}: outside analysis root\n`,
    );
    expect(stdout).not.toHaveBeenCalled();
  });
});
