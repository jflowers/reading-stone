// Extraction identity and edge-case fixtures for src/extract.ts (T009;
// FR-007 through FR-009; research R4, R5; data-model.md ExtractionRecord;
// Constitution Principles I and III).
//
// RED-FIRST: src/extract.ts does not exist yet — T013 creates it — so this
// suite fails on module resolution by design (tasks.md: US1 tests are
// written first and observed to FAIL before the paired implementation
// lands).
//
// The contract pinned here, following tests/program.test.ts's precedent of
// recording the tested surface at the top:
//
// - Entry point: `extractFunctions(realRoot, context, stderr)` returning
//   the deterministically ordered `ExtractionRecord[]`. Research R12's
//   pipeline names the extraction step `extractFunctions` (the only
//   documented name across the feature artifacts), and the arguments
//   mirror buildProgramContext's house style: the realpath-resolved root
//   first (program-mode source files carry absolute names that must
//   relativize against it; parse-only sources are already keyed by
//   root-relative path), the bootstrapped ProgramContext second, and the
//   injected diagnostic sink last (research R15's AST-depth skip channel).
// - Walk set: `collectSources(realRoot, context)` — the `[relPath,
//   SourceFile][]` pairs the extraction pass walks (005 T002; FR-004 and
//   FR-011; research R2). Parse-only mode returns the context's sources
//   keyed by root-relative path; program mode filters the compiler's
//   source file names to those relativizing strictly beneath the real
//   root (default libraries and out-of-root files excluded); the pairs
//   cover exactly the in-scope source arm analyze reports for the same
//   request (spec 003's file-set parity, asserted against the real
//   method); and a pattern set matching nothing yields an empty walk
//   set, never an error. RED-FIRST: collectSources is module-private
//   today — T003 adds the `export` keyword — so the section below fails
//   on `collectSources is not a function` by design. The missing named
//   export does not fail this file's module load (the binding is
//   undefined at runtime under vitest's transform), so every pre-existing
//   suite above stays green; verified before this section landed.
// - Ordering: `(relPath, line, name)` per FR-008, with the
//   platform-default stable sort resolving full-key ties (same file, line,
//   AND name — a getter/setter pair on one line) by AST position.
// - Line semantics: the 1-based line of the record's declaration (R4:
//   `sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))`).
//   Every fixture below is an array of lines joined with "\n", so each
//   entry's 1-based index IS its line number — the counts are auditable
//   in place.
//
// Assertions read only the serializable record fields (name, relPath,
// line, deferred) — never the body-owning AST node. FR-009's
// innermost-enclosing attribution (anonymous callback bodies scanning into
// the enclosing record) is not observable from those fields, so it stays
// with the detector suite (T010); here the unassigned forms are pinned by
// the absence of their records.

import { realpathSync } from "node:fs";
import { extname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { prepareAnalysis } from "../src/analysis.js";
import {
  collectSources,
  type ExtractionRecord,
  extractFunctions,
} from "../src/extract.js";
import { relativeUnderBase } from "../src/internal.js";
import { buildProgramContext } from "../src/program.js";
import {
  createFixtureTree,
  drainCleanups,
  memorySink,
  registerCleanup,
} from "./helpers/fixtures.js";
import { analyzeTree } from "./helpers/wire.js";

// Fixture trees register their cleanup with the shared helpers so every
// test body stays linear; afterEach drains the queue in creation order.
afterEach(async () => {
  vi.restoreAllMocks();
  await drainCleanups();
});

async function makeTree(files: Readonly<Record<string, string>>): Promise<string> {
  const tree = await createFixtureTree(files);
  registerCleanup(tree.cleanup);
  // The production caller passes a root that discovery's resolveRoot already
  // realpath-resolved; the fixture's mkdtemp path sits behind macOS's /var
  // symlink, so resolve it the same way before joining paths.
  return realpathSync(tree.root);
}

// Both bootstrap modes extract identically (research R5: the form table and
// scope tracker are purely lexical), so the identity suites run against each
// mode; program mode adds a root tsconfig so buildProgramContext takes the
// configured-program arm.
type Mode = "parse-only" | "program";

// A plain strict config for the program-mode fixtures: no include/files of
// its own to interfere (the bootstrap's extender config overrides the root
// set anyway), and target ES2022 so class-property initializers are native.
const TSCONFIG = '{"compilerOptions": {"strict": true, "target": "ES2022"}}';

// Exactly the six extensions discovery walks; the runner hands only these to
// buildProgramContext as the pre-read in-scope pairs (a tsconfig.json
// planted for program mode is config, not source).
const COMPILABLE_EXTENSIONS: ReadonlySet<string> = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
]);

// Runs one extraction over a fixture tree in the requested mode: build the
// tree (plus a root tsconfig in program mode), bootstrap the ProgramContext
// over the pre-read in-scope pairs, extract, and dispose the program-mode
// context before returning — the serializable record fields are computed
// during extraction (the (file, line, name) sort forces name, relPath, and
// line to exist before return), so assertions never need the live compiler.
async function extractFromTree(files: Readonly<Record<string, string>>, mode: Mode) {
  const onDisk: Record<string, string> =
    mode === "program" ? { ...files, "tsconfig.json": TSCONFIG } : { ...files };
  const root = await makeTree(onDisk);
  const pairs = Object.entries(files)
    .filter(([relPath]) => COMPILABLE_EXTENSIONS.has(extname(relPath)))
    .map(([relPath, text]) => [relPath, text] as const);
  const sink = memorySink();
  const stdout = vi.spyOn(process.stdout, "write");
  const context = buildProgramContext(root, pairs, sink.stream);
  try {
    // Fail loud when the requested mode did not materialize: a silent
    // tsconfig fallback would turn a "both modes" test into parse-only
    // twice.
    expect(context.mode).toBe(mode);
    const records = extractFunctions(root, context, sink.stream);
    return { records, sink, stdout };
  } finally {
    if (context.mode === "program") {
      context.dispose();
    }
  }
}

// The serializable identity asserted throughout: one (relPath, line, name)
// triple per record, in the deterministic order. The body-owning node and
// the scope chain are never read here — this suite's contract is the
// wire-shaped fields.
function identity(records: ReadonlyArray<ExtractionRecord>) {
  return records.map((record) => ({
    relPath: record.relPath,
    line: record.line,
    name: record.name,
  }));
}

// ---------------------------------------------------------------------------
// The R4 form table (FR-007/FR-008): one file per form so each record's
// relPath is unambiguous, plus a JavaScript-family source pinning FR-006's
// same-extraction guarantee. Each fixture's lines are numbered by array
// index; the expected table states each record's (relPath, line, name)
// exactly.
// ---------------------------------------------------------------------------

const FORM_DECLARATION = [
  "// Form 1: a function declaration extracts under its declared name.",
  "export function declared(): number {",
  "  return 1;",
  "}",
  "",
].join("\n");

const FORM_CLASS_METHOD = [
  "// Form 2: a class method extracts under the method name.",
  "export class Widget {",
  "  resize(): void {",
  "    return;",
  "  }",
  "}",
  "",
].join("\n");

const FORM_OBJECT_METHOD = [
  "// Form 3: an object-literal method extracts under the method name.",
  "export const table = {",
  "  prepare(): void {",
  "    return;",
  "  },",
  "};",
  "",
].join("\n");

const FORM_CONSTRUCTOR = [
  "// Form 4: a constructor extracts under the literal name; the class's",
  "// non-function property initializer is not extracted.",
  "export class Gadget {",
  "  ready = false;",
  "  constructor() {",
  "    this.ready = true;",
  "  }",
  "}",
  "",
].join("\n");

const FORM_ACCESSOR = [
  "// Form 5: a getter/setter pair extracts under the property name — one",
  "// record per accessor, distinguished by declaration line.",
  "export class Dial {",
  "  private stored = 0;",
  "  get value(): number {",
  "    return this.stored;",
  "  }",
  "  set value(next: number) {",
  "    this.stored = next;",
  "  }",
  "}",
  "",
].join("\n");

const FORM_VARIABLE_ARROW = [
  "// Form 6: a variable-assigned arrow function extracts under the",
  "// variable name.",
  "export const compute = (input: number): number => {",
  "  return input * 2;",
  "};",
  "",
].join("\n");

const FORM_OBJECT_PROPERTY = [
  "// Form 7: an object-literal function-valued property extracts under",
  "// the property name.",
  "export const handlers = {",
  "  onSave: (): void => {",
  "    return;",
  "  },",
  "};",
  "",
].join("\n");

const FORM_CLASS_PROPERTY = [
  "// Form 8: a class-property function initializer extracts under the",
  "// property name.",
  "export class Engine {",
  "  handler = (): void => {",
  "    return;",
  "  };",
  "}",
  "",
].join("\n");

const FORM_DEFAULT_EXPORT = [
  '// Form 9: an anonymous default-export function extracts as "default".',
  "export default function (): number {",
  "  return 9;",
  "}",
  "",
].join("\n");

// A JavaScript-family source (FR-006): the same extraction over .js, using
// the FunctionExpression variant of the variable-assigned form.
const FORM_JAVASCRIPT = [
  "// A JavaScript-family source extracts identically (FR-006): a",
  "// variable-assigned function expression under the variable name.",
  "export const fold = function (input) {",
  "  return input + 1;",
  "};",
  "",
].join("\n");

const FORM_FILES: Readonly<Record<string, string>> = {
  // The literal order is the emission order (the pre-read pairs); the
  // expected table below asserts the (file, line, name) sort over it.
  "forms/declaration.ts": FORM_DECLARATION,
  "forms/class-method.ts": FORM_CLASS_METHOD,
  "forms/object-method.ts": FORM_OBJECT_METHOD,
  "forms/constructor.ts": FORM_CONSTRUCTOR,
  "forms/accessor.ts": FORM_ACCESSOR,
  "forms/variable-arrow.ts": FORM_VARIABLE_ARROW,
  "forms/object-property.ts": FORM_OBJECT_PROPERTY,
  "forms/class-property.ts": FORM_CLASS_PROPERTY,
  "forms/default-export.ts": FORM_DEFAULT_EXPORT,
  "forms/javascript.js": FORM_JAVASCRIPT,
};

describe.each(["parse-only", "program"] as const)(
  "extractFunctions: the R4 form table in %s mode (FR-007, FR-008)",
  (mode) => {
    it("yields one named record per extraction form, sorted by (file, line, name)", {
      timeout: 30_000,
    }, async () => {
      const { records, sink, stdout } = await extractFromTree(FORM_FILES, mode);

      expect(identity(records)).toEqual([
        { relPath: "forms/accessor.ts", line: 5, name: "value" },
        { relPath: "forms/accessor.ts", line: 8, name: "value" },
        { relPath: "forms/class-method.ts", line: 3, name: "resize" },
        { relPath: "forms/class-property.ts", line: 4, name: "handler" },
        { relPath: "forms/constructor.ts", line: 5, name: "constructor" },
        { relPath: "forms/declaration.ts", line: 2, name: "declared" },
        { relPath: "forms/default-export.ts", line: 2, name: "default" },
        { relPath: "forms/javascript.js", line: 3, name: "fold" },
        { relPath: "forms/object-method.ts", line: 3, name: "prepare" },
        { relPath: "forms/object-property.ts", line: 4, name: "onSave" },
        { relPath: "forms/variable-arrow.ts", line: 3, name: "compute" },
      ]);
      // The serializable shape per data-model.md's ExtractionRecord:
      // identity strings, a positive 1-based integer line, and the
      // boolean deferred walk flag (only its presence and type are pinned
      // here — its value is walk state the detector consumes).
      for (const record of records) {
        expect(record.name).toBeTypeOf("string");
        expect(record.relPath).toBeTypeOf("string");
        expect(Number.isInteger(record.line)).toBe(true);
        expect(record.line).toBeGreaterThanOrEqual(1);
        expect(record.deferred).toBeTypeOf("boolean");
      }
      expect(sink.text()).toBe("");
      expect(stdout).not.toHaveBeenCalled();
    });
  },
);

// ---------------------------------------------------------------------------
// Nested function-likes (FR-007): extraction is not limited to module scope
// — every extracted form inside another record's body is its own record
// (research R4: nested extracted function-likes are separate records).
// ---------------------------------------------------------------------------

const NESTED = [
  "// Nested extracted function-likes are separate records (FR-007): an",
  "// inner function declaration, an inner variable-assigned arrow, and a",
  "// method of a class declared inside the enclosing function.",
  "export function outer(): void {",
  "  function inner(): void {",
  "    return;",
  "  }",
  "  const local = (): void => {",
  "    return;",
  "  };",
  "  class Inside {",
  "    method(): void {",
  "      return;",
  "    }",
  "  }",
  "}",
  "",
].join("\n");

describe("extractFunctions: nested function-likes (FR-007)", () => {
  it("extracts each nested function-like as its own record", {
    timeout: 30_000,
  }, async () => {
    const { records, sink, stdout } = await extractFromTree(
      { "nested.ts": NESTED },
      "parse-only",
    );

    expect(identity(records)).toEqual([
      { relPath: "nested.ts", line: 4, name: "outer" },
      { relPath: "nested.ts", line: 5, name: "inner" },
      { relPath: "nested.ts", line: 8, name: "local" },
      { relPath: "nested.ts", line: 12, name: "method" },
    ]);
    expect(sink.text()).toBe("");
    expect(stdout).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// The not-extracted table (FR-007 exclusions): body-less declarations and
// unassigned function expressions never yield records.
// ---------------------------------------------------------------------------

const NOT_EXTRACTED = [
  "// Body-less declarations and unassigned function expressions are",
  "// never extracted (FR-007 exclusions): only the overload's",
  "// implementation and the enclosing withInlineCallbacks carry records.",
  "export function overloaded(a: string): void;",
  "export function overloaded(a: number): void;",
  "export function overloaded(a: string | number): void {",
  "  return;",
  "}",
  "",
  "declare function ambient(): void;",
  "",
  "export interface Contract {",
  "  fulfill(): void;",
  "}",
  "",
  "export abstract class Base {",
  "  abstract perform(): void;",
  "}",
  "",
  "export function withInlineCallbacks(): void {",
  "  [1, 2].forEach(function (item) {",
  "    void item;",
  "  });",
  "  const immediate = (() => {",
  "    return 1;",
  "  })();",
  "  return;",
  "}",
  "",
].join("\n");

describe("extractFunctions: the not-extracted table (FR-007 exclusions)", () => {
  it("extracts only the overload implementation and the enclosing function", {
    timeout: 30_000,
  }, async () => {
    const { records, sink, stdout } = await extractFromTree(
      { "not-extracted.ts": NOT_EXTRACTED },
      "parse-only",
    );

    // The body-less overload signatures (lines 4-5), the ambient
    // `declare function`, the interface method signature, the abstract
    // method, the forEach call-argument callback, and the IIFE behind
    // `immediate` (its initializer is a CallExpression, not a function)
    // all contribute nothing. FR-009's convention — the anonymous bodies
    // scan into the innermost enclosing record — is not observable from
    // the serializable fields and stays with the detector suite (T010).
    expect(identity(records)).toEqual([
      { relPath: "not-extracted.ts", line: 6, name: "overloaded" },
      { relPath: "not-extracted.ts", line: 20, name: "withInlineCallbacks" },
    ]);
    expect(sink.text()).toBe("");
    expect(stdout).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Accessor and same-line edge cases (FR-008): the full-key tie and the
// name component of the sort key.
// ---------------------------------------------------------------------------

const ONE_LINE_ACCESSORS = [
  "// A getter/setter pair on one line: same file, line, and name, so the",
  "// platform-default stable sort resolves the full-key tie by AST",
  "// position (source order — the getter precedes the setter). The",
  "// serializable fields cannot distinguish the pair's two records; this",
  "// fixture pins their cardinality and shared identity.",
  "export class Pair {",
  "  get same(): number { return 1; } set same(next: number) { void next; }",
  "}",
  "",
].join("\n");

const SAME_LINE_ARROWS = [
  "// Two variable-assigned arrows on one line, declared in reverse name",
  "// order: the (file, line, name) sort resolves the same-line pair by",
  "// NAME (FR-008 puts name in the key), so alpha sorts before bravo",
  "// despite bravo's earlier AST position.",
  "export const bravo = (): void => { return; }, alpha = (): void => { return; };",
  "",
].join("\n");

const DEFAULT_ARROW = [
  "// An arrow function as the default export is extracted and named",
  `"default" — R4 row 9's ExportAssignment shape.`,
  "export default (): number => {",
  "  return 1;",
  "};",
  "",
].join("\n");

describe("extractFunctions: accessor and same-line edge cases (FR-008)", () => {
  it("yields two records for a getter/setter pair written on one line", {
    timeout: 30_000,
  }, async () => {
    const { records, sink, stdout } = await extractFromTree(
      { "one-line-accessors.ts": ONE_LINE_ACCESSORS },
      "parse-only",
    );

    expect(identity(records)).toEqual([
      { relPath: "one-line-accessors.ts", line: 7, name: "same" },
      { relPath: "one-line-accessors.ts", line: 7, name: "same" },
    ]);
    expect(sink.text()).toBe("");
    expect(stdout).not.toHaveBeenCalled();
  });

  it("resolves two same-line arrows by name, not declaration order", {
    timeout: 30_000,
  }, async () => {
    const { records, sink, stdout } = await extractFromTree(
      { "same-line.ts": SAME_LINE_ARROWS },
      "parse-only",
    );

    expect(identity(records)).toEqual([
      { relPath: "same-line.ts", line: 5, name: "alpha" },
      { relPath: "same-line.ts", line: 5, name: "bravo" },
    ]);
    expect(sink.text()).toBe("");
    expect(stdout).not.toHaveBeenCalled();
  });

  it(`names an arrow default export "default"`, { timeout: 30_000 }, async () => {
    const { records, sink, stdout } = await extractFromTree(
      { "default-arrow.ts": DEFAULT_ARROW },
      "parse-only",
    );

    expect(identity(records)).toEqual([
      { relPath: "default-arrow.ts", line: 3, name: "default" },
    ]);
    expect(sink.text()).toBe("");
    expect(stdout).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Deterministic ordering (FR-008): the (file, line, name) sort normalizes
// the emission order — and, in program mode, whatever order the compiler
// reports its source files in.
// ---------------------------------------------------------------------------

const ZEBRA = [
  "// Declared first in the emission order; sorted last by file.",
  "export function zulu(): void {",
  "  return;",
  "}",
  "",
].join("\n");

const SRC_ALPHA = [
  "// Line precedes name in the sort key: beta (line 3) sorts before",
  "// alphaFn (line 7) despite the reverse alphabetical declaration order.",
  "export function beta(): void {",
  "  return;",
  "}",
  "",
  "export function alphaFn(): void {",
  "  return;",
  "}",
  "",
].join("\n");

const MID = [
  "// Sorted between src/alpha.ts and zebra.ts by file name.",
  "export function middle(): void {",
  "  return;",
  "}",
  "",
].join("\n");

const ORDER_FILES: Readonly<Record<string, string>> = {
  // The literal (emission) order is deliberately unsorted: zebra first,
  // the src/ subtree second, mid last.
  "zebra.ts": ZEBRA,
  "src/alpha.ts": SRC_ALPHA,
  "mid.ts": MID,
};

describe.each(["parse-only", "program"] as const)(
  "extractFunctions: deterministic ordering in %s mode (FR-008)",
  (mode) => {
    it("orders records by (file, line, name) regardless of emission order", {
      timeout: 30_000,
    }, async () => {
      const { records, sink, stdout } = await extractFromTree(ORDER_FILES, mode);

      expect(identity(records)).toEqual([
        { relPath: "mid.ts", line: 2, name: "middle" },
        { relPath: "src/alpha.ts", line: 3, name: "beta" },
        { relPath: "src/alpha.ts", line: 7, name: "alphaFn" },
        { relPath: "zebra.ts", line: 2, name: "zulu" },
      ]);
      expect(sink.text()).toBe("");
      expect(stdout).not.toHaveBeenCalled();
    });
  },
);

// ---------------------------------------------------------------------------
// Degenerate trees: no in-scope sources, no records — never an error.
// ---------------------------------------------------------------------------

describe("extractFunctions: degenerate trees", () => {
  it("yields no records for a tree with no in-scope sources", {
    timeout: 30_000,
  }, async () => {
    const { records, sink, stdout } = await extractFromTree({}, "parse-only");

    expect(records).toEqual([]);
    expect(sink.text()).toBe("");
    expect(stdout).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// collectSources: the walk set (005 T002; FR-004 and FR-011; research R2).
//
// The second tested surface, recorded per the header above. RED-FIRST:
// collectSources is module-private in src/extract.ts today — T003 adds the
// `export` keyword — so these tests fail on `collectSources is not a
// function` by design while every suite above stays green.
//
// The clauses, one per group below:
//
// - Parse-only keying (FR-004): the context's sources keyed by
//   root-relative path, each SourceFile carrying the absolute fileName
//   under the real root and the pre-read text verbatim.
// - Program-mode containment (FR-004): exactly the compiler's source file
//   names that relativize strictly beneath the real root — default
//   libraries and out-of-root files excluded. The compiler always pulls
//   the default libraries in from outside the root, so the filter has
//   real exclusions to make; the expected set is computed from the raw
//   names, not hardcoded.
// - Walk-set parity (FR-004; spec 003's file-set parity): the pairs cover
//   exactly the in-scope source arm — the identical file set analyze
//   reports for the same request, asserted against the real method, not
//   assumed. The fixture plants a test file (name signal) and a generated
//   file (leading-comment marker) alongside the sources and keeps the
//   source arm free of imports into the excluded arms, so the whole-tree
//   walk set equals the in-scope list in both modes.
// - Degenerate scope: a pattern set matching nothing yields an empty walk
//   set, never an error (FR-004's shared analysis-params semantics).
// ---------------------------------------------------------------------------

// The unit fixture for the bootstrap-mode keying: a nested TypeScript
// source and a root-level JavaScript source, both declaring a record.
const WALK_UNIT_FILES: Readonly<Record<string, string>> = {
  "src/one.ts": ["export function one(): number {", "  return 1;", "}", ""].join("\n"),
  "two.js": ["export function two() {", "  return 2;", "}", ""].join("\n"),
};

// The parity fixture: two source files — each declaring a record, so
// analyze's distinct reported file set observes the whole arm — plus a
// test file classified by name signal and a generated file excluded by its
// leading-comment marker. Nothing in the source arm imports the excluded
// arms, so the program-mode compiler never pulls them in transitively.
const WALK_PARITY_FILES: Readonly<Record<string, string>> = {
  "src/entry.ts": [
    'import { helper } from "./util";',
    "",
    "export function entryRun(): number {",
    "  return helper(1);",
    "}",
    "",
  ].join("\n"),
  "src/util.ts": [
    "export function helper(n: number): number {",
    "  return n + 1;",
    "}",
    "",
  ].join("\n"),
  "src/util.test.ts": [
    'import { helper } from "./util";',
    "",
    "export function probe(): number {",
    "  return helper(2);",
    "}",
    "",
  ].join("\n"),
  "generated/api.ts": [
    "// @generated by fixture — do not edit",
    "export function generatedValue(): number {",
    "  return 3;",
    "}",
    "",
  ].join("\n"),
};

// Bootstraps a context over a fixture tree without extracting: the
// collectSources unit tests read the pairs while the context is live
// (program-mode source files round-trip to the native compiler server), so
// unlike extractFromTree the driver hands the context back for the caller
// to dispose.
async function contextFromTree(
  files: Readonly<Record<string, string>>,
  mode: Mode,
): Promise<{
  root: string;
  context: ReturnType<typeof buildProgramContext>;
  sink: ReturnType<typeof memorySink>;
  stdout: ReturnType<typeof vi.spyOn>;
}> {
  const onDisk: Record<string, string> =
    mode === "program" ? { ...files, "tsconfig.json": TSCONFIG } : { ...files };
  const root = await makeTree(onDisk);
  const pairs = Object.entries(files)
    .filter(([relPath]) => COMPILABLE_EXTENSIONS.has(extname(relPath)))
    .map(([relPath, text]) => [relPath, text] as const);
  const sink = memorySink();
  const stdout = vi.spyOn(process.stdout, "write");
  const context = buildProgramContext(root, pairs, sink.stream);
  return { root, context, sink, stdout };
}

describe("collectSources: bootstrap-mode keying (005 FR-004)", () => {
  it("parse-only mode returns the context's sources keyed by root-relative path", async () => {
    const { root, context, sink, stdout } = await contextFromTree(
      WALK_UNIT_FILES,
      "parse-only",
    );
    expect(context.mode).toBe("parse-only");

    const pairs = collectSources(root, context);

    // Keying: pairs keyed by root-relative path, each SourceFile carrying
    // the absolute fileName under the real root and the pre-read text.
    expect(pairs.map(([relPath]) => relPath).sort()).toEqual(["src/one.ts", "two.js"]);
    for (const [relPath, sourceFile] of pairs) {
      expect(sourceFile.fileName).toBe(join(root, relPath));
      expect(sourceFile.text).toBe(WALK_UNIT_FILES[relPath]);
    }
    expect(sink.text()).toBe("");
    expect(stdout).not.toHaveBeenCalled();
  });

  it("program mode keeps only compiler names that relativize beneath the root", {
    timeout: 30_000,
  }, async () => {
    const { root, context, sink, stdout } = await contextFromTree(
      WALK_UNIT_FILES,
      "program",
    );
    expect(context.mode).toBe("program");
    try {
      const raw = context.program.getSourceFileNames();
      // Non-vacuity: the compiler's name set includes the default
      // libraries from outside the root, so the containment filter has
      // real exclusions to make.
      expect(raw.some((name) => relativeUnderBase(root, name) === null)).toBe(true);

      const pairs = collectSources(root, context);

      // Containment: exactly the raw names that relativize strictly
      // beneath the real root, keyed by that relative path — computed
      // from the raw set, not hardcoded.
      const expected = raw
        .map((name) => relativeUnderBase(root, name))
        .filter((rel): rel is string => rel !== null)
        .sort();
      expect(pairs.map(([relPath]) => relPath).sort()).toEqual(expected);
      for (const [relPath, sourceFile] of pairs) {
        expect(sourceFile.fileName).toBe(join(root, relPath));
      }
      // The fixture's own sources survive the filter in both spellings:
      // a nested .ts and a root-level .js.
      expect(pairs.map(([relPath]) => relPath)).toContain("src/one.ts");
      expect(pairs.map(([relPath]) => relPath)).toContain("two.js");
      expect(sink.text()).toBe("");
      expect(stdout).not.toHaveBeenCalled();
    } finally {
      context.dispose();
    }
  });
});

describe.each(["parse-only", "program"] as const)(
  "collectSources: walk-set parity in %s mode (005 FR-004/FR-011)",
  (mode) => {
    it("covers exactly the in-scope source arm analyze reports", {
      timeout: 30_000,
    }, async () => {
      const onDisk: Record<string, string> =
        mode === "program"
          ? { ...WALK_PARITY_FILES, "tsconfig.json": TSCONFIG }
          : { ...WALK_PARITY_FILES };
      const root = await makeTree(onDisk);
      const sink = memorySink();
      const prepared = await prepareAnalysis(root, undefined, sink.stream);
      expect(prepared.context.mode).toBe(mode);
      try {
        const walkSet = collectSources(root, prepared.context)
          .map(([relPath]) => relPath)
          .sort();

        // The arm itself: the two source files, nothing else — the test
        // file (name signal) and the generated file (marker) are absent
        // from the walk set exactly as they are from discovery's lists.
        expect(walkSet).toEqual(["src/entry.ts", "src/util.ts"]);

        // Parity with the pipeline's own in-scope list (FR-011: both
        // new methods ride prepareAnalysis; the walk set must be that
        // arm).
        expect(walkSet).toEqual([...prepared.inScopePaths]);

        // Parity with the real method, asserted not assumed: analyze
        // over the same request reports exactly the walk-set files.
        // Every in-scope file declares a record, so the distinct
        // reported file set observes the whole arm.
        const analyzed = await analyzeTree(root);
        expect(
          [...new Set(analyzed.functions.map((record) => record.file))].sort(),
        ).toEqual(walkSet);
        expect(analyzed.stderr()).toBe("");
        expect(sink.text()).toBe("");
      } finally {
        if (prepared.context.mode === "program") {
          prepared.context.dispose();
        }
      }
    });
  },
);

describe("collectSources: degenerate scope (005 FR-004)", () => {
  it("a pattern set matching nothing yields an empty walk set, never an error", {
    timeout: 30_000,
  }, async () => {
    // A usable tsconfig sits at the root, yet the pattern set matches
    // nothing: the empty in-scope set short-circuits the bootstrap
    // before any config is consulted, so the arm's mode is an
    // implementation detail here and is deliberately not asserted.
    const root = await makeTree({ ...WALK_PARITY_FILES, "tsconfig.json": TSCONFIG });
    const sink = memorySink();
    const prepared = await prepareAnalysis(root, ["./no-such-dir"], sink.stream);
    expect(prepared.inScopePaths).toEqual([]);
    try {
      expect(collectSources(root, prepared.context)).toEqual([]);
      expect(sink.text()).toBe("");
    } finally {
      if (prepared.context.mode === "program") {
        prepared.context.dispose();
      }
    }
  });
});
