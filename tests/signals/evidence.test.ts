/**
 * Evidence-seam compiler fixtures (T011, FR-002 through FR-006 inputs;
 * research R5, R6, R7, R13; data-model.md Section 5.1).
 *
 * src/signals/evidence.ts (T018/T019) computes one immutable
 * RecordEvidence snapshot per extracted function record — the pure
 * extractors' only input besides the effect type (research R12's seam).
 * This suite pins the compiler-facing half of that contract: every
 * field's value over real fixture trees driven through the real
 * pipeline (createFixtureTree → prepareAnalysis → buildRecordEvidence),
 * in both context modes.
 *
 * RED-FIRST: this suite was written and observed failing before
 * src/signals/evidence.ts existed (the module-resolution failure is the
 * red observation), per the task-pairing discipline in tasks.md.
 *
 * Every expectation below is transcribed from verified typescript 7.0.2
 * behavior (the promoted runtime dependency's own unstable AST and sync
 * checker surfaces), pinned by scratch probes over these exact fixture
 * trees. The load-bearing compiler facts the fixtures hold:
 *
 * - JSDoc hosting (docText/docTags): the compiler attaches a
 *   declaration's JSDoc through its own hosting walk — a function-like
 *   inherits the comment sitting on its root variable statement
 *   (variable-declaration unification), on a property assignment it
 *   fills, and on an export assignment it sits under. The walk stops at
 *   object literals and class bodies: a statement-level comment does
 *   NOT document an object-literal member rooted two levels below it,
 *   and a class-level comment does NOT document its methods.
 *   docTags is the getJSDocTags list (bare tag names — `returns`, not
 *   `@returns`); docText flattens the description and tag comment
 *   texts, single-space joined, exactly as getTextOfJSDocComment
 *   renders each part.
 * - Heritage (interfaceMember): checker.getSymbolAtLocation resolves a
 *   class's implements clauses and its extends-a-class clauses; a base
 *   counts only when a declaration's kind is InterfaceDeclaration, and
 *   membership reads the interface symbol's DECLARED member table —
 *   never apparent-member lookup, which would find Object-prototype
 *   members and manufacture matches on every toString-alike (the
 *   hazard this suite pins). A class extends clause referencing an
 *   interface is semantically invalid TypeScript and resolves through
 *   NO checker route (symbol null, type any, declared base types
 *   empty — verified): such a clause contributes nothing, pinned here
 *   as the resolvability boundary (Constitution Principle II —
 *   undeterminable is absence of evidence, never an error).
 * - Return types (exportedReturnType): a type reference resolves
 *   through the checker's type (import aliases resolve to the target's
 *   declared symbol); exported means an export modifier on a
 *   declaration of the resolved symbol, ambient means a .d.ts
 *   declaration (the platform libs). Unresolved references carry no
 *   type symbol and never fire.
 * - Exportedness (exportedFunction/exportedReceiver): ESM is the
 *   export modifier on the declaration, its root variable statement,
 *   or its export assignment (`export default` included); CJS is a
 *   `module.exports.<name>` / `module.exports` / `exports.<name>`
 *   assignment targeting the binding in the same file (spec edge case
 *   5 — JavaScript-family sources are first-class). Class-member
 *   records never take the function component; object-literal members
 *   rooted at an exported binding do.
 *
 * Constitution V: every value comes from static AST and checker
 * queries. The caller-index suite's canary holds for the identical
 * bootstrap/extraction/checker pipeline this seam rides on; nothing
 * here executes or imports analyzed code either.
 */
import { afterEach, describe, expect, it } from "vitest";
import { prepareAnalysis } from "../../src/analysis.js";
import type { ExtractionRecord } from "../../src/extract.js";
import { buildCallerIndex } from "../../src/signals/caller-index.js";
import {
  buildRecordEvidence,
  type RecordEvidence,
} from "../../src/signals/evidence.js";
import {
  createFixtureTree,
  drainCleanups,
  memorySink,
  registerCleanup,
} from "../helpers/fixtures.js";

// Fixture trees register their cleanup with the shared helpers so every
// test body stays linear; afterEach drains the queue in creation order.
afterEach(async () => {
  await drainCleanups();
});

// A plain strict config for the program-mode fixtures (the caller-index
// suite's TSCONFIG): no include/files of its own to interfere — the
// bootstrap's extender config overrides the root set anyway — and target
// ES2022 so class-property initializers are native.
const TSCONFIG = '{"compilerOptions": {"strict": true, "target": "ES2022"}}';

function withTsconfig(
  sources: Readonly<Record<string, string>>,
): Record<string, string> {
  return { ...sources, "tsconfig.json": TSCONFIG };
}

/** One run's assertion surfaces: the records and their evidence map. */
interface EvidenceRun {
  readonly records: readonly ExtractionRecord[];
  readonly evidence: ReadonlyMap<ExtractionRecord, RecordEvidence>;
}

// Runs the real pipeline over a fixture tree and computes evidence while
// the context is live: createFixtureTree → prepareAnalysis →
// buildRecordEvidence → dispose. The mode assertion is inside the try on
// purpose (the runIndex discipline): a silent tsconfig fallback to
// parse-only would degrade every checker component vacuously — every
// interfaceMember/exportedReturnType assertion below would pass as false
// and every callerModuleCount as 0 — without failing a single one.
async function runEvidence(
  files: Readonly<Record<string, string>>,
  expectedMode: "program" | "parse-only" = "program",
): Promise<EvidenceRun> {
  const tree = await createFixtureTree(files);
  registerCleanup(tree.cleanup);
  const sink = memorySink();
  const prepared = await prepareAnalysis(tree.root, undefined, sink.stream);
  try {
    expect(prepared.context.mode).toBe(expectedMode);
    const evidence = buildRecordEvidence(
      prepared.context,
      prepared.records,
      prepared.inScopePaths,
    );
    return { records: prepared.records, evidence };
  } finally {
    if (prepared.context.mode === "program") {
      prepared.context.dispose();
    }
  }
}

// The single-record lookup: (relPath, name) must identify exactly one
// record and that record must have an evidence entry — the throw-based
// guards surface totality violations as loud failures, not soft skips.
function evOf(run: EvidenceRun, relPath: string, name: string): RecordEvidence {
  const matches = run.records.filter(
    (record) => record.relPath === relPath && record.name === name,
  );
  if (matches.length === 0) {
    throw new Error(`no extraction record "${name}" in ${relPath}`);
  }
  if (matches.length > 1) {
    throw new Error(
      `ambiguous record "${name}" in ${relPath} (${matches.length} records)`,
    );
  }
  const evidence = run.evidence.get(matches[0]);
  if (evidence === undefined) {
    throw new Error(
      `record "${name}" in ${relPath} has no evidence entry — totality violated`,
    );
  }
  return evidence;
}

// The same-name group lookup: every matching record's evidence, in
// record order. Records are sorted by (relPath, line, name), so a
// same-name group comes back in source-line order — the heritage
// fixtures rely on that to address the seven `area` records by class.
function evAll(run: EvidenceRun, relPath: string, name: string): RecordEvidence[] {
  const out: RecordEvidence[] = [];
  for (const record of run.records) {
    if (record.relPath !== relPath || record.name !== name) {
      continue;
    }
    const evidence = run.evidence.get(record);
    if (evidence === undefined) {
      throw new Error(
        `record "${name}" in ${relPath} has no evidence entry — totality violated`,
      );
    }
    out.push(evidence);
  }
  if (out.length === 0) {
    throw new Error(`no extraction record "${name}" in ${relPath}`);
  }
  return out;
}

// The assertion view of one RecordEvidence: every field except `record`
// (identity is asserted separately, by reference). toEqual against this
// projection pins all seven fields at once, so an unintended value
// anywhere — a component bleeding across records, a degradation
// zeroing a syntactic field — fails exactly one readable diff.
function project(evidence: RecordEvidence) {
  return {
    exportedFunction: evidence.exportedFunction,
    exportedReturnType: evidence.exportedReturnType,
    exportedReceiver: evidence.exportedReceiver,
    docText: evidence.docText,
    docTags: evidence.docTags,
    interfaceMember: evidence.interfaceMember,
    callerModuleCount: evidence.callerModuleCount,
  };
}

// The expected-projection builder for records whose non-overridden
// fields are all neutral: empty docs, no receiver, no checker hits, no
// callers. Every field is present in the returned object, so toEqual
// still compares all seven.
function expected(
  overrides: {
    exportedFunction?: boolean;
    exportedReturnType?: boolean;
    exportedReceiver?: boolean;
    docText?: string;
    docTags?: readonly { readonly tag: string; readonly text: string }[];
  } = {},
) {
  return {
    exportedFunction: false,
    exportedReturnType: false,
    exportedReceiver: false,
    docText: "",
    docTags: [] as readonly { readonly tag: string; readonly text: string }[],
    interfaceMember: false,
    callerModuleCount: 0,
    ...overrides,
  };
}

// The ESM exportedness tree: every export form the closed rule names
// (research R5), with the receiver-component split on class members.
//
//   named           export modifier on the declaration          → fires
//   notExported     plain module-scope function                 → no
//   defaultNamed    export default function declaration         → fires
//   default         export default arrow (export assignment)    → fires,
//                     and the assignment's JSDoc documents the record
//   rootVar         export const arrow (root variable statement)→ fires
//   plainVar        plain const arrow                           → no
//   method (×2)     class members — never the function component;
//                     ExportedClass.method takes the receiver component,
//                     PlainClass.method takes neither
const ESM_SOURCES: Readonly<Record<string, string>> = {
  "src/exports.ts": [
    "export function named(): number {",
    "  return 1;",
    "}",
    "",
    "function notExported(): number {",
    "  return 2;",
    "}",
    "",
    "export class ExportedClass {",
    "  method(): number {",
    "    return 3;",
    "  }",
    "}",
    "",
    "class PlainClass {",
    "  method(): number {",
    "    return 4;",
    "  }",
    "}",
    "",
  ].join("\n"),
  "src/default-function.ts": [
    "export default function defaultNamed(): number {",
    "  return 5;",
    "}",
    "",
  ].join("\n"),
  "src/default-arrow.ts": [
    "/** Returns six. */",
    "export default (): number => 6;",
    "",
  ].join("\n"),
  "src/root-var.ts": [
    "export const rootVar = (): number => 7;",
    "",
    "const plainVar = (): number => 8;",
    "",
  ].join("\n"),
};

describe("ESM exportedness forms (research R5)", () => {
  it("fires the function component for the export modifier on the declaration", async () => {
    const run = await runEvidence(withTsconfig(ESM_SOURCES));
    expect(project(evOf(run, "src/exports.ts", "named"))).toEqual(
      expected({ exportedFunction: true }),
    );
  });

  it("does not fire for unexported module-scope functions", async () => {
    const run = await runEvidence(withTsconfig(ESM_SOURCES));
    expect(project(evOf(run, "src/exports.ts", "notExported"))).toEqual(expected());
  });

  it("fires for export default function declarations", async () => {
    const run = await runEvidence(withTsconfig(ESM_SOURCES));
    expect(project(evOf(run, "src/default-function.ts", "defaultNamed"))).toEqual(
      expected({ exportedFunction: true }),
    );
  });

  it("fires for export-assignment default arrows and inherits the assignment's JSDoc", async () => {
    const run = await runEvidence(withTsconfig(ESM_SOURCES));
    // `export default () => 6` — the arrow's parent is the export
    // assignment itself, so the function component fires through the
    // assignment form, and the compiler's hosting walk reads the JSDoc
    // sitting on that assignment (ExportAssignment is one of the
    // walk's hosting parents).
    expect(project(evOf(run, "src/default-arrow.ts", "default"))).toEqual(
      expected({ exportedFunction: true, docText: "Returns six." }),
    );
  });

  it("fires for the root variable statement form", async () => {
    const run = await runEvidence(withTsconfig(ESM_SOURCES));
    // `export const rootVar = ...` — the export modifier sits on the
    // root variable statement, three parents above the arrow.
    expect(project(evOf(run, "src/root-var.ts", "rootVar"))).toEqual(
      expected({ exportedFunction: true }),
    );
    expect(project(evOf(run, "src/root-var.ts", "plainVar"))).toEqual(expected());
  });

  it("never fires the function component for class members — they take the receiver component", async () => {
    const run = await runEvidence(withTsconfig(ESM_SOURCES));
    // Two same-named `method` records, in source order: the member of
    // the exported class (receiver component only) then the member of
    // the plain class (neither component).
    const methods = evAll(run, "src/exports.ts", "method");
    expect(methods).toHaveLength(2);
    expect(project(methods[0])).toEqual(expected({ exportedReceiver: true }));
    expect(project(methods[1])).toEqual(expected());
    // The never-rule itself, stated independently of the projection: a
    // class body sits between the member and any module-level export
    // form, and the closed rule routes class members to the receiver
    // component only.
    expect(methods[0].exportedFunction).toBe(false);
    expect(methods[1].exportedFunction).toBe(false);
  });
});

// The CJS exportedness tree (spec edge case 5 — JavaScript-family
// sources are first-class): the three assignment forms, each targeting
// a same-file binding, plus the rooted-object form and the negatives.
//
//   saveConfig      module.exports.saveConfig = saveConfig   → fires
//   hiddenStep      targeted by no assignment                 → no
//   runTask         module.exports = runTask                  → fires
//   loadUser        exports.loadUser = loadUser               → fires
//   neverExported   targeted by no assignment                 → no
//   runJob          object-literal member rooted at `api`,
//                   and module.exports = api targets `api`      → fires
const CJS_SOURCES: Readonly<Record<string, string>> = {
  "src/props.cjs": [
    "function saveConfig(data) {",
    "  return true;",
    "}",
    "",
    "function hiddenStep() {",
    "  return 9;",
    "}",
    "",
    "module.exports.saveConfig = saveConfig;",
    "",
  ].join("\n"),
  "src/whole.cjs": [
    "function runTask() {",
    "  return 10;",
    "}",
    "",
    "module.exports = runTask;",
    "",
  ].join("\n"),
  "src/alias.cjs": [
    "function loadUser() {",
    "  return 11;",
    "}",
    "",
    "exports.loadUser = loadUser;",
    "",
    "function neverExported() {",
    "  return 12;",
    "}",
    "",
  ].join("\n"),
  "src/rooted.cjs": [
    "const api = {",
    "  runJob() {",
    "    return 13;",
    "  },",
    "};",
    "",
    "module.exports = api;",
    "",
  ].join("\n"),
};

describe("CJS exportedness forms (spec edge case 5)", () => {
  it("fires for module.exports.<name> assignments targeting the same-file binding", async () => {
    const run = await runEvidence(withTsconfig(CJS_SOURCES));
    expect(project(evOf(run, "src/props.cjs", "saveConfig"))).toEqual(
      expected({ exportedFunction: true }),
    );
  });

  it("does not fire for a binding no assignment targets", async () => {
    const run = await runEvidence(withTsconfig(CJS_SOURCES));
    // hiddenStep lives in the same file as an export assignment — but
    // the assignment's right-hand side targets saveConfig's binding,
    // not hiddenStep's. The rule is binding-targeted, never
    // file-scoped.
    expect(project(evOf(run, "src/props.cjs", "hiddenStep"))).toEqual(expected());
    expect(project(evOf(run, "src/alias.cjs", "neverExported"))).toEqual(expected());
  });

  it("fires for whole-module module.exports assignments targeting the binding", async () => {
    const run = await runEvidence(withTsconfig(CJS_SOURCES));
    expect(project(evOf(run, "src/whole.cjs", "runTask"))).toEqual(
      expected({ exportedFunction: true }),
    );
  });

  it("fires for exports.<name> alias assignments targeting the binding", async () => {
    const run = await runEvidence(withTsconfig(CJS_SOURCES));
    expect(project(evOf(run, "src/alias.cjs", "loadUser"))).toEqual(
      expected({ exportedFunction: true }),
    );
  });

  it("fires for object-literal members rooted at an exported binding", async () => {
    const run = await runEvidence(withTsconfig(CJS_SOURCES));
    // runJob is a method on the object literal bound to `api`, and
    // `module.exports = api` targets that binding — research R5's
    // rooted-object rule.
    expect(project(evOf(run, "src/rooted.cjs", "runJob"))).toEqual(
      expected({ exportedFunction: true }),
    );
  });
});

// The return-type tree: one file holding every firing and non-firing
// annotation form (research R5; data-model Section 5.1's
// "contains at least one type reference resolving to an exported or
// ambient symbol"), a second module exporting the imported type, and a
// caller module that gives exactly one record one distinct calling
// module for the callerModuleCount wiring pin.
//
//   usesImported    (): Result        — imported, exported in types.ts → fires
//   withExported    (): Exported      — same-file exported interface  → fires
//   withAmbient     (): Date          — ambient (platform lib .d.ts)  → fires
//   withUnion       (): Result | null — ≥1 exported ref inside union → fires
//   withInternal    (): Internal      — module-private interface      → no
//   withString      (): string        — primitive keyword             → no
//   withNumber      (): number        — primitive keyword             → no
//   withVoid        (): void          — primitive keyword             → no
//   withLiteral     (): "ok"          — literal type                  → no
//   withObject      (): { n: number } — object-literal type           → no
//   withMissing     (): Missing       — unresolved, error annotation  → no
//   implicit        (): (none)        — no annotation at all          → no
const RETURNS_SOURCES: Readonly<Record<string, string>> = {
  "src/types.ts": ["export interface Result {", "  ok: boolean;", "}", ""].join("\n"),
  "src/returns.ts": [
    'import { Result } from "./types";',
    "",
    "export interface Exported {",
    "  tag: string;",
    "}",
    "",
    "interface Internal {",
    "  n: number;",
    "}",
    "",
    "export function usesImported(): Result {",
    "  return { ok: true };",
    "}",
    "",
    "export function withExported(): Exported {",
    '  return { tag: "t" };',
    "}",
    "",
    "function withInternal(): Internal {",
    "  return { n: 1 };",
    "}",
    "",
    "export function withString(): string {",
    '  return "s";',
    "}",
    "",
    "export function withNumber(): number {",
    "  return 1;",
    "}",
    "",
    "export function withVoid(): void {",
    "  return;",
    "}",
    "",
    'export function withLiteral(): "ok" {',
    '  return "ok";',
    "}",
    "",
    "export function withObject(): { n: number } {",
    "  return { n: 1 };",
    "}",
    "",
    "export function withMissing(): Missing {",
    '  throw new Error("x");',
    "}",
    "",
    "export function withAmbient(): Date {",
    "  return new Date();",
    "}",
    "",
    "export function withUnion(): Result | null {",
    "  return null;",
    "}",
    "",
    "export function implicit() {",
    "  return 2;",
    "}",
    "",
  ].join("\n"),
  "src/main.ts": [
    'import { usesImported } from "./returns";',
    "",
    "export function mainRun(): boolean {",
    "  return usesImported();",
    "}",
    "",
  ].join("\n"),
};

// The return-type matrix as a table: [record name, expected].
const RETURN_TYPE_MATRIX: readonly (readonly [string, boolean])[] = [
  ["usesImported", true],
  ["withExported", true],
  ["withAmbient", true],
  ["withUnion", true],
  ["withInternal", false],
  ["withString", false],
  ["withNumber", false],
  ["withVoid", false],
  ["withLiteral", false],
  ["withObject", false],
  ["withMissing", false],
  ["implicit", false],
];

describe("exported return type matrix (research R5, program mode)", () => {
  it("fires exactly for annotations containing an exported or ambient type reference", async () => {
    const run = await runEvidence(withTsconfig(RETURNS_SOURCES));
    for (const [name, fires] of RETURN_TYPE_MATRIX) {
      expect(evOf(run, "src/returns.ts", name).exportedReturnType).toBe(fires);
    }
    // The caller module's own record has no annotation at all.
    expect(evOf(run, "src/main.ts", "mainRun").exportedReturnType).toBe(false);
  });

  it("fires for the imported reference without firing anything else on the record", async () => {
    const run = await runEvidence(withTsconfig(RETURNS_SOURCES));
    // The full projection for the sharpest firing form: usesImported
    // resolves through the import alias to types.ts's exported Result.
    // Every other field stays neutral — the component fires alone.
    expect(project(evOf(run, "src/returns.ts", "usesImported"))).toEqual(
      expected({ exportedFunction: true, exportedReturnType: true }),
    );
  });

  it("does not fire for unresolved references and keeps every other field neutral", async () => {
    const run = await runEvidence(withTsconfig(RETURNS_SOURCES));
    // withMissing names a type that resolves nowhere — semantic errors
    // are never a gate (FR-005), the record still extracts, and the
    // error annotation fires nothing.
    expect(project(evOf(run, "src/returns.ts", "withMissing"))).toEqual(
      expected({ exportedFunction: true }),
    );
    expect(project(evOf(run, "src/returns.ts", "implicit"))).toEqual(
      expected({ exportedFunction: true }),
    );
  });

  it("carries the caller index's distinct-module count in callerModuleCount", async () => {
    const run = await runEvidence(withTsconfig(RETURNS_SOURCES));
    // usesImported is called from exactly one in-scope module (main.ts,
    // inside mainRun) — the wiring pin's exact value. Every other
    // record in the tree is called by nobody.
    expect(evOf(run, "src/returns.ts", "usesImported").callerModuleCount).toBe(1);
    for (const record of run.records) {
      if (record.name === "usesImported") {
        continue;
      }
      expect(run.evidence.get(record)?.callerModuleCount).toBe(0);
    }
  });
});

// The heritage tree: interface vs class bases through both heritage
// tokens, the toString hazard and its declared positive, the composite
// class, the semantically-invalid extends-an-interface form, and the
// object literal that structurally satisfies an interface without any
// class at all.
//
//   Base.area            no heritage                          → no
//   ExtendsInterface.area extends Shape (interface — invalid,
//                        resolves through no checker route)     → no
//   Circle.area          implements Shape (declares area)      → fires
//   Circle.volume        implements Shape (no volume member)   → no
//   Ring.area            extends Base (class base)             → no
//   Struct.area          implements Base (class base, via
//                        the implements token)                 → no
//   Hazard.toString      implements Shape (no toString — the
//                        apparent-member hazard)               → no
//   Declared.toString    implements Labelled (DECLARES
//                        toString)                             → fires
//   Mixed.area           extends Base implements Shape — the
//                        interface clause fires alongside a
//                        class extends clause                  → fires
//   structural.area      object literal typed as Shape — no
//                        enclosing class, structural only       → no
const HERITAGE_SOURCES: Readonly<Record<string, string>> = {
  "src/heritage.ts": [
    "export interface Shape {",
    "  area(): number;",
    "}",
    "",
    "export interface Labelled {",
    "  toString(): string;",
    "}",
    "",
    "export class Base {",
    "  area(): number {",
    "    return 0;",
    "  }",
    "}",
    "",
    "export class ExtendsInterface extends Shape {",
    "  area(): number {",
    "    return 6;",
    "  }",
    "}",
    "",
    "export class Circle implements Shape {",
    "  area(): number {",
    "    return 1;",
    "  }",
    "",
    "  volume(): number {",
    "    return 2;",
    "  }",
    "}",
    "",
    "export class Ring extends Base {",
    "  area(): number {",
    "    return 3;",
    "  }",
    "}",
    "",
    "export class Struct implements Base {",
    "  area(): number {",
    "    return 4;",
    "  }",
    "}",
    "",
    "export class Hazard implements Shape {",
    "  toString(): string {",
    '    return "h";',
    "  }",
    "}",
    "",
    "export class Declared implements Labelled {",
    "  toString(): string {",
    '    return "d";',
    "  }",
    "}",
    "",
    "export class Mixed extends Base implements Shape {",
    "  area(): number {",
    "    return 5;",
    "  }",
    "}",
    "",
    "const structural: Shape = {",
    "  area() {",
    "    return 9;",
    "  },",
    "};",
    "export const shapeHolder = structural;",
    "",
  ].join("\n"),
};

describe("interface heritage satisfaction (research R6, program mode)", () => {
  it("fires for a class member an interface in the heritage declares", async () => {
    const run = await runEvidence(withTsconfig(HERITAGE_SOURCES));
    expect(evOf(run, "src/heritage.ts", "volume").interfaceMember).toBe(false);
    expect(evOf(run, "src/heritage.ts", "volume").exportedReceiver).toBe(true);
    // The seven `area` records in source order, each with the class it
    // belongs to — the same-name group is exactly what per-record
    // keying must keep distinct (a name-keyed map would collapse all
    // seven onto one value and fail this block).
    const [
      baseArea,
      extendsInterfaceArea,
      circleArea,
      ringArea,
      structArea,
      mixedArea,
      structuralArea,
    ] = evAll(run, "src/heritage.ts", "area");
    expect(baseArea.interfaceMember).toBe(false); // Base: no heritage
    expect(extendsInterfaceArea.interfaceMember).toBe(false); // see below
    expect(circleArea.interfaceMember).toBe(true); // implements Shape
    expect(ringArea.interfaceMember).toBe(false); // extends class Base
    expect(structArea.interfaceMember).toBe(false); // implements class Base
    expect(mixedArea.interfaceMember).toBe(true); // implements Shape wins
    expect(structuralArea.interfaceMember).toBe(false); // no class at all
  });

  it("does not fire for class bases, through either heritage token", async () => {
    const run = await runEvidence(withTsconfig(HERITAGE_SOURCES));
    const [, , , ringArea, structArea, , ,] = evAll(run, "src/heritage.ts", "area");
    // Ring extends Base; Struct implements Base. Both base symbols
    // resolve, both declare `area` in their member tables, and neither
    // is an InterfaceDeclaration — the declaration-kind gate is what
    // keeps a resolvable class base from firing (research R6).
    expect(ringArea.interfaceMember).toBe(false);
    expect(structArea.interfaceMember).toBe(false);
  });

  it("resolves unresolvable heritage to false, never an error", async () => {
    const run = await runEvidence(withTsconfig(HERITAGE_SOURCES));
    const [, extendsInterfaceArea] = evAll(run, "src/heritage.ts", "area");
    // `class ExtendsInterface extends Shape` with Shape an interface is
    // semantically invalid TypeScript, and every checker route comes
    // back empty (symbol null, type any, declared base types empty —
    // verified against 7.0.2). An untrusted tree can contain this
    // code; the seam's answer is absence of evidence (Constitution II),
    // never a throw and never a manufactured match.
    expect(extendsInterfaceArea.interfaceMember).toBe(false);
  });

  it("never suffers the toString apparent-member hazard", async () => {
    const run = await runEvidence(withTsconfig(HERITAGE_SOURCES));
    const [hazardToString, declaredToString] = evAll(
      run,
      "src/heritage.ts",
      "toString",
    );
    // Hazard implements Shape, which does NOT declare toString: an
    // apparent-member lookup (getPropertyOfType-style) would find
    // Object.prototype's toString on every interface and manufacture a
    // match here. Declared-member tables do not — the hazard this
    // fixture exists to pin.
    expect(hazardToString.interfaceMember).toBe(false);
    // Declared implements Labelled, which DOES declare toString — the
    // positive contrast that makes the hazard assertion meaningful:
    // the same method name fires only when declared.
    expect(declaredToString.interfaceMember).toBe(true);
  });

  it("keeps class members on the receiver component and structural satisfaction off the interface component", async () => {
    const run = await runEvidence(withTsconfig(HERITAGE_SOURCES));
    const [, , circleArea, , , , structuralArea] = evAll(
      run,
      "src/heritage.ts",
      "area",
    );
    // Circle's members: exported class → receiver component, never the
    // function component.
    expect(project(circleArea)).toEqual(
      expected({ exportedReceiver: true, interfaceMember: true }),
    );
    // structural.area satisfies Shape structurally through contextual
    // typing — explicitly out (research R6: the contract is not
    // declared at a class). It is an object-literal member rooted at
    // `structural`, a binding with no export modifier; the later
    // `export const shapeHolder` exports a DIFFERENT binding that
    // merely references the object, so no component fires at all.
    expect(project(structuralArea)).toEqual(expected());
  });
});

// The docs tree: every JSDoc hosting form and both walk boundaries.
//
//   doubleTotal   own JSDoc, two tags (document order) → tags + text
//   sumAll        statement JSDoc on an export const arrow
//                 (variable-declaration unification)  → tags + text
//   handle        property-assignment JSDoc hosting the function
//                 expression                          → tags + text
//   bare          no JSDoc                             → empty
//   runJob        object-literal method under a documented statement
//                 — the walk stops at the object literal → empty
//   count         own method JSDoc                     → tags + text
//   undocumented  method in a documented class — the walk stops at
//                 the class body                       → empty
const DOCS_SOURCES: Readonly<Record<string, string>> = {
  "src/docs.ts": [
    "/** Computes the doubled total. @param n the input @returns the doubled total */",
    "export function doubleTotal(n: number): number {",
    "  return n * 2;",
    "}",
    "",
    "/** Sums all values. @param xs the values */",
    "export const sumAll = (xs: number[]): number => xs.reduce((a, b) => a + b, 0);",
    "",
    "export const nested = {",
    "  /** Handles one item. @param x the item */",
    "  handle: function (x: number) {",
    "    return x;",
    "  },",
    "};",
    "",
    "export function bare() {",
    "  return 1;",
    "}",
    "",
    "/** Rooted doc. @param x ignored */",
    "export const rooted = {",
    "  runJob() {",
    "    return 13;",
    "  },",
    "};",
    "",
    "/** Class level. @author someone */",
    "export class Documented {",
    "  /** Method doc. @returns the count */",
    "  count(): number {",
    "    return 1;",
    "  }",
    "",
    "  undocumented(): number {",
    "    return 2;",
    "  }",
    "}",
    "",
  ].join("\n"),
};

describe("JSDoc attachment, unification, and inheritance (data-model Section 5.1)", () => {
  it("flattens the description and tag comments of the declaration's own JSDoc", async () => {
    const run = await runEvidence(withTsconfig(DOCS_SOURCES));
    // Bare tag names in document order; docText is the description and
    // each tag's comment text, single-space joined — the exact
    // getTextOfJSDocComment rendering of each part.
    expect(project(evOf(run, "src/docs.ts", "doubleTotal"))).toEqual(
      expected({
        exportedFunction: true,
        docText: "Computes the doubled total. the input the doubled total",
        docTags: [
          { tag: "param", text: "the input" },
          { tag: "returns", text: "the doubled total" },
        ],
      }),
    );
  });

  it("unifies variable declarations — the statement's JSDoc documents the arrow record", async () => {
    const run = await runEvidence(withTsconfig(DOCS_SOURCES));
    // The canonical unification form from the task letter:
    // `/** … */ const f = () => {}` documents the record. The arrow
    // itself carries no jsDoc; the compiler's hosting walk reaches the
    // root variable statement's comment (and getJSDocTags inherits its
    // tags — parent-node tag inheritance, accepted compiler semantics,
    // fixture-pinned).
    expect(project(evOf(run, "src/docs.ts", "sumAll"))).toEqual(
      expected({
        exportedFunction: true,
        docText: "Sums all values. the values",
        docTags: [{ tag: "param", text: "the values" }],
      }),
    );
  });

  it("inherits JSDoc from the property assignment hosting the function expression", async () => {
    const run = await runEvidence(withTsconfig(DOCS_SOURCES));
    // PropertyAssignment is one of the compiler's hosting parents: the
    // function expression's record reads the property's JSDoc — tags
    // and text both. And as an object-literal member rooted at the
    // exported binding `nested`, handle takes the function component.
    expect(project(evOf(run, "src/docs.ts", "handle"))).toEqual(
      expected({
        exportedFunction: true,
        docText: "Handles one item. the item",
        docTags: [{ tag: "param", text: "the item" }],
      }),
    );
  });

  it("stops at object literals — a statement's JSDoc does not document its members", async () => {
    const run = await runEvidence(withTsconfig(DOCS_SOURCES));
    // rooted is a documented statement whose object literal holds
    // runJob; the hosting walk does not cross the object literal, so
    // runJob carries no doc text and no tags. The export still fires
    // (the member is rooted at the exported binding `rooted`).
    expect(project(evOf(run, "src/docs.ts", "runJob"))).toEqual(
      expected({ exportedFunction: true }),
    );
  });

  it("stops at class bodies — a class's JSDoc does not document its methods", async () => {
    const run = await runEvidence(withTsconfig(DOCS_SOURCES));
    // count's OWN method JSDoc is read; undocumented, sitting in the
    // same documented class, gets nothing. Both are class members of
    // an exported class: receiver component, never the function one.
    expect(project(evOf(run, "src/docs.ts", "count"))).toEqual(
      expected({
        exportedReceiver: true,
        docText: "Method doc. the count",
        docTags: [{ tag: "returns", text: "the count" }],
      }),
    );
    expect(project(evOf(run, "src/docs.ts", "undocumented"))).toEqual(
      expected({ exportedReceiver: true }),
    );
    expect(project(evOf(run, "src/docs.ts", "bare"))).toEqual(
      expected({ exportedFunction: true }),
    );
  });
});

// The degradation tree: one .ts module holding every component form and
// one .cjs module, run twice — once with a tsconfig (program mode,
// where the checker components fire) and once without (parse-only,
// where they must degrade to false/0 while every syntactic component
// survives). The twin is what makes the degradation assertions
// non-vacuous: present and typed PROVE the checker components are
// computable over these exact sources, so their parse-only values are
// real degradations, not unreachable defaults.
const DEGRADE_SOURCES: Readonly<Record<string, string>> = {
  "src/mixed.ts": [
    "/** Mixed doc. @returns the flag */",
    "export function flagged(): boolean {",
    "  return true;",
    "}",
    "",
    "export const arrowVar = (): number => 1;",
    "",
    "const plainArrow = (): number => 2;",
    "",
    "export class Marked {",
    "  member(): number {",
    "    return 3;",
    "  }",
    "}",
    "",
    "interface Contract {",
    "  present(): void;",
    "}",
    "",
    "export class Honoring implements Contract {",
    "  present(): void {",
    "    return;",
    "  }",
    "}",
    "",
    "export interface PublicType {",
    "  ok: boolean;",
    "}",
    "",
    "export function typed(): PublicType {",
    "  return { ok: true };",
    "}",
    "",
  ].join("\n"),
  "src/cjs.cjs": [
    "function exportedFn() {",
    "  return 1;",
    "}",
    "",
    "module.exports.exportedFn = exportedFn;",
    "",
  ].join("\n"),
};

describe("parse-only degradation (research R5/R6/R7)", () => {
  it("fires the checker components in program mode over the same sources", async () => {
    const run = await runEvidence(withTsconfig(DEGRADE_SOURCES));
    // The program-mode twin: Honoring implements Contract (which
    // declares present) and typed returns the exported PublicType —
    // both checker components fire here and ONLY here.
    expect(evOf(run, "src/mixed.ts", "present").interfaceMember).toBe(true);
    expect(evOf(run, "src/mixed.ts", "typed").exportedReturnType).toBe(true);
    expect(project(evOf(run, "src/mixed.ts", "present"))).toEqual(
      expected({ exportedReceiver: true, interfaceMember: true }),
    );
  });

  it("keeps every syntactic component and zeroes every checker component", async () => {
    const run = await runEvidence(DEGRADE_SOURCES, "parse-only");
    // ESM exportedness, the receiver component, CJS exportedness, and
    // both doc fields survive the fallback identically...
    expect(project(evOf(run, "src/mixed.ts", "flagged"))).toEqual(
      expected({
        exportedFunction: true,
        docText: "Mixed doc. the flag",
        docTags: [{ tag: "returns", text: "the flag" }],
      }),
    );
    expect(project(evOf(run, "src/mixed.ts", "arrowVar"))).toEqual(
      expected({ exportedFunction: true }),
    );
    expect(project(evOf(run, "src/mixed.ts", "plainArrow"))).toEqual(expected());
    expect(project(evOf(run, "src/mixed.ts", "member"))).toEqual(
      expected({ exportedReceiver: true }),
    );
    expect(project(evOf(run, "src/cjs.cjs", "exportedFn"))).toEqual(
      expected({ exportedFunction: true }),
    );
    // ...while every checker component degrades: interfaceMember and
    // exportedReturnType false (both computable in the twin above),
    // callerModuleCount 0.
    expect(project(evOf(run, "src/mixed.ts", "present"))).toEqual(
      expected({ exportedReceiver: true }),
    );
    expect(project(evOf(run, "src/mixed.ts", "typed"))).toEqual(
      expected({ exportedFunction: true }),
    );
    for (const record of run.records) {
      expect(run.evidence.get(record)?.callerModuleCount).toBe(0);
    }
  });
});

describe("record keying, wiring, and single computation", () => {
  it("maps every record exactly once, keyed by the record reference", async () => {
    const run = await runEvidence(withTsconfig(HERITAGE_SOURCES));
    // Totality over the collision-heavy tree: ten records — seven of
    // them named `area` — each with exactly one entry, and each entry
    // carrying its own record by reference (the map key and the
    // `record` field agree, so lookups and fan-out can use either).
    expect(run.records.length).toBe(10);
    expect(run.evidence.size).toBe(run.records.length);
    for (const record of run.records) {
      const evidence = run.evidence.get(record);
      expect(evidence).toBeDefined();
      expect(evidence?.record).toBe(record);
    }
  });

  it("wires callerModuleCount from buildCallerIndex and produces identical snapshots on repeated builds", async () => {
    // Inline lifecycle: the parity check needs buildCallerIndex and two
    // buildRecordEvidence calls over the SAME live context — the same
    // discipline as the caller-index suite's own wiring tests.
    const tree = await createFixtureTree(withTsconfig(RETURNS_SOURCES));
    registerCleanup(tree.cleanup);
    const sink = memorySink();
    const prepared = await prepareAnalysis(tree.root, undefined, sink.stream);
    try {
      expect(prepared.context.mode).toBe("program");
      const index = buildCallerIndex(
        prepared.context,
        prepared.records,
        prepared.inScopePaths,
      );
      const first = buildRecordEvidence(
        prepared.context,
        prepared.records,
        prepared.inScopePaths,
      );
      const second = buildRecordEvidence(
        prepared.context,
        prepared.records,
        prepared.inScopePaths,
      );
      expect(first.size).toBe(prepared.records.length);
      for (const record of prepared.records) {
        const one = first.get(record);
        const two = second.get(record);
        expect(one).toBeDefined();
        expect(two).toBeDefined();
        // callerModuleCount is the caller index's count for that record
        // — wired from buildCallerIndex, never recomputed (T019).
        expect(one?.callerModuleCount).toBe(index.get(record) ?? 0);
        // Determinism: repeated builds over the same live inputs
        // produce identical snapshots — "computed once per record"
        // made observable as stability, never per-pair variance.
        expect(two).toEqual(one);
      }
    } finally {
      if (prepared.context.mode === "program") {
        prepared.context.dispose();
      }
    }
  });

  it("returns an empty map for an empty record list", async () => {
    // The empty-records branch runs against a LIVE program-mode context
    // (the caller-index suite's degenerate-input pattern): prepare a
    // real one-function tree, then hand buildRecordEvidence an empty
    // record list while the compiler is live.
    const tree = await createFixtureTree(
      withTsconfig({
        "src/one.ts": "export function one(): number {\n  return 1;\n}\n",
      }),
    );
    registerCleanup(tree.cleanup);
    const sink = memorySink();
    const prepared = await prepareAnalysis(tree.root, undefined, sink.stream);
    try {
      expect(prepared.context.mode).toBe("program");
      expect(prepared.records.length).toBeGreaterThan(0);
      const evidence = buildRecordEvidence(prepared.context, [], prepared.inScopePaths);
      expect(evidence.size).toBe(0);
    } finally {
      if (prepared.context.mode === "program") {
        prepared.context.dispose();
      }
    }
  });
});
