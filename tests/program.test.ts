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

import { realpathSync } from "node:fs";
import { truncate } from "node:fs/promises";
import { join } from "node:path";
import { Writable } from "node:stream";
import { ScriptKind, ScriptTarget, SyntaxKind } from "typescript/unstable/ast";
import { afterEach, describe, expect, it, vi } from "vitest";
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
function bootstrap(realRoot: string, sourceFiles: ReadonlyArray<SourcePair>) {
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
