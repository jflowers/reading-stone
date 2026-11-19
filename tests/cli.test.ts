import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { VERSION } from "../src/index.js";
import { main } from "../src/main.js";
import { createFixtureTree } from "./helpers/fixtures.js";

interface Sink {
  stream: Writable;
  text(): string;
}

function sink(): Sink {
  let buffer = "";
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      buffer += chunk.toString();
      callback();
    },
  });
  return { stream, text: () => buffer };
}

function io(lines: string[]): { stdin: Readable; stdout: Writable; stderr: Writable } {
  const out = sink();
  const err = sink();
  return { stdin: Readable.from(lines), stdout: out.stream, stderr: err.stream };
}

describe("main", () => {
  it("prints usage to stderr and returns 2 without --stdio", async () => {
    const streams = io([]);
    const err = sink();
    const code = await main([], {
      stdin: streams.stdin,
      stdout: streams.stdout,
      stderr: err.stream,
    });
    expect(code).toBe(2);
    expect(err.text()).toBe("reading-stone --stdio\n");
  });

  it.each([["--stdio", "extra"], ["--verbose"], ["stdio"]])(
    "rejects argv %p with usage and exit code 2",
    async (...argv) => {
      const streams = io([]);
      const err = sink();
      const code = await main(argv as string[], {
        stdin: streams.stdin,
        stdout: streams.stdout,
        stderr: err.stream,
      });
      expect(code).toBe(2);
      expect(err.text()).toBe("reading-stone --stdio\n");
    },
  );

  it("runs the server on --stdio and returns 0", async () => {
    const out = sink();
    const err = sink();
    const code = await main(["--stdio"], {
      stdin: Readable.from([
        '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"root_path":"/abs/project"}}\n{"jsonrpc":"2.0","id":2,"method":"shutdown"}',
      ]),
      stdout: out.stream,
      stderr: err.stream,
    });
    expect(code).toBe(0);
    const responses = out
      .text()
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(responses).toHaveLength(2);
    expect((responses[0]?.result as Record<string, unknown>)?.analyzer_name).toBe(
      "reading-stone",
    );
    expect(responses[1]?.result).toEqual({});
  });
});

describe("package metadata", () => {
  it("exposes VERSION 0.2.0", () => {
    expect(VERSION).toBe("0.2.0");
  });

  it("declares the expected package.json fields", () => {
    const pkg = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as Record<string, unknown>;
    expect(pkg.name).toBe("reading-stone");
    expect(pkg.version).toBe("0.2.0");
    expect(pkg.license).toBe("Apache-2.0");
    expect(pkg.type).toBe("module");
    expect(pkg.bin).toEqual({
      "reading-stone": "dist/main.js",
      "gaze-analyzer-typescript": "dist/main.js",
    });
    expect((pkg as { engines?: { node?: string } }).engines?.node).toBe(">=22");
    // Exact pin (review dispatch 44e85014): the runtime consumes the
    // typescript/unstable/* surface, which carries no semver stability
    // guarantee, so a caret range could resolve a breaking 7.x.
    expect(pkg.dependencies).toEqual({ typescript: "7.0.2" });
    // The registry surface (release-v0-2-0): the barrel is the only
    // exported entry (AP-001); NOTICE ships for Apache-2.0 §4(d)
    // attribution, which npm does not auto-include; source maps are
    // excluded because their `sources` point at the unshipped src/.
    expect(pkg.exports).toEqual({
      ".": { types: "./dist/index.d.ts", default: "./dist/index.js" },
      "./package.json": "./package.json",
    });
    expect(pkg.files).toEqual(["dist", "!dist/**/*.map", "NOTICE"]);
    expect(pkg.homepage).toBe("https://github.com/zero-dot-force/reading-stone#readme");
    expect(pkg.bugs).toEqual({
      url: "https://github.com/zero-dot-force/reading-stone/issues",
    });
  });

  it("ships the gaze-analyzer-typescript bin alias for PATH auto-discovery", () => {
    // Gaze's zero-config discovery tier spawns whatever
    // gaze-analyzer-<language> binary it finds on PATH (the snake-eyes
    // precedent: primary name plus convention alias). Both names must
    // launch the same --stdio server entry point.
    const pkg = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as { bin?: Record<string, string> };
    expect(pkg.bin?.["gaze-analyzer-typescript"]).toBe("dist/main.js");
    expect(pkg.bin?.["reading-stone"]).toBe("dist/main.js");
  });

  it("contains the exact NOTICE attribution text", () => {
    const notice = readFileSync(new URL("../NOTICE", import.meta.url), "utf8");
    expect(notice).toBe(`reading-stone
Copyright 2026 zero-dot-force

This product includes software originally developed in snake-eyes
(https://github.com/zero-dot-force/snake-eyes), licensed under
Apache License 2.0. The JSON-RPC protocol layer, the classification
signal pipeline design, and the test-mapping pipeline design (pairing
strategies and pinned confidences, matcher classification semantics,
fallback chains, provenance boundaries), and the doc-coverage
symbol-surface design (the exported-surface walk) are ported from
snake-eyes' Python implementation of the Gaze analyzer protocol.
`);
  });
});

const mainJs = fileURLToPath(new URL("../dist/main.js", import.meta.url));

// One doc_coverage wire row as observed across the subprocess boundary —
// the WireSymbol/WireRow shape shared by tests/server.test.ts and
// tests/doc-coverage.test.ts.
interface SubprocessSymbol {
  readonly name: string;
  readonly package: string;
  readonly kind: string;
  readonly file: string;
  readonly line: number;
  readonly documented: boolean;
  readonly doc_snippet?: string;
}

// One cognitive_complexity wire row as observed across the subprocess
// boundary — the CognitiveRow shape shared by tests/server.test.ts and
// tests/cognitive.test.ts, with the identity key spelled `function`,
// never `name` (spec 005 FR-005 / Assumption 6).
interface SubprocessFunction {
  readonly package: string;
  readonly function: string;
  readonly file: string;
  readonly line: number;
  readonly cognitive_complexity: number;
}

// One cyclomatic `complexity` wire row as observed across the same
// boundary — the ComplexityEntry shape, identity key `name` — carried
// only for the US2-2 parity diff: its (file, line, name) tuples must
// match the cognitive rows' (file, line, function) row for row.
interface SubprocessComplexityEntry {
  readonly name: string;
  readonly package: string;
  readonly file: string;
  readonly line: number;
  readonly complexity: number;
}

// The full-lifecycle fixture (release-v0-2-0 task 3.1): one documented,
// exported source function carrying a stdout write, a parameter mutation,
// a branch, and a return value; one vitest test asserting on it; a
// tsconfig so program mode (checker-dependent signals) is exercised; and
// a hand-authored Istanbul artifact so `coverage` answers rows without
// any test execution (Constitution Principle V). Every analysis method
// returns at least one row over it, so a regression that empties any
// method fails the lifecycle test loudly.
const LIFECYCLE_SOURCES: Readonly<Record<string, string>> = {
  "package.json": '{"name":"fixture","devDependencies":{"vitest":"*"}}\n',
  "tsconfig.json":
    '{"compilerOptions":{"strict":true,"module":"NodeNext","moduleResolution":"NodeNext"},"include":["src","tests"]}\n',
  "src/store.ts": [
    "/** Records a value in the cache and returns the previous one. */", // 1
    "export function remember(cache: Map<string, number>, key: string, value: number): number | undefined {", // 2
    "  const previous = cache.get(key);", // 3
    "  if (previous === undefined) {", // 4
    '    console.log("first write", key);', // 5
    "  }", // 6
    "  cache.set(key, value);", // 7
    "  return previous;", // 8
    "}", // 9
    "",
  ].join("\n"),
  "tests/store.test.ts": [
    'import { expect, it } from "vitest";',
    'import { remember } from "../src/store";',
    "",
    'it("returns the previous value", () => {',
    "  const cache = new Map<string, number>();",
    '  expect(remember(cache, "a", 1)).toBeUndefined();',
    '  expect(remember(cache, "a", 2)).toBe(1);',
    "});",
    "",
  ].join("\n"),
  "coverage/coverage-final.json": JSON.stringify({
    "src/store.ts": {
      path: "src/store.ts",
      statementMap: {
        "0": { start: { line: 3, column: 2 }, end: { line: 3, column: 35 } },
        "1": { start: { line: 4, column: 2 }, end: { line: 6, column: 3 } },
        "2": { start: { line: 5, column: 4 }, end: { line: 5, column: 36 } },
        "3": { start: { line: 7, column: 2 }, end: { line: 7, column: 24 } },
        "4": { start: { line: 8, column: 2 }, end: { line: 8, column: 18 } },
      },
      fnMap: {
        "0": {
          name: "remember",
          decl: { start: { line: 2, column: 16 }, end: { line: 2, column: 24 } },
          loc: { start: { line: 2, column: 101 }, end: { line: 9, column: 1 } },
        },
      },
      branchMap: {},
      s: { "0": 2, "1": 2, "2": 1, "3": 2, "4": 2 },
      f: { "0": 2 },
      b: {},
    },
  }),
};

// The lifecycle order issue #7 names, each analysis method paired with
// the single result key its v1.2.0 schema defines.
const LIFECYCLE_METHODS: ReadonlyArray<readonly [string, string]> = [
  ["analyze", "functions"],
  ["complexity", "functions"],
  ["coverage", "functions"],
  ["test_mapping", "mappings"],
  ["classify_signals", "signals"],
  ["doc_coverage", "symbols"],
  ["cognitive_complexity", "functions"],
];

describe.skipIf(!existsSync(mainJs))("subprocess", () => {
  function readLine(stream: Readable): Promise<string> {
    return new Promise((resolve, reject) => {
      let buffer = "";
      const onData = (chunk: Buffer) => {
        buffer += chunk.toString();
        const index = buffer.indexOf("\n");
        if (index >= 0) {
          stream.off("data", onData);
          resolve(buffer.slice(0, index));
        }
      };
      stream.on("data", onData);
      stream.on("error", reject);
    });
  }

  it("runs the initialize/shutdown lifecycle over real stdio", async () => {
    const child = spawn(process.execPath, [mainJs, "--stdio"]);
    child.stdin.write(
      '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"root_path":"/abs/project"}}\n',
    );
    const line = await readLine(child.stdout);
    const response = JSON.parse(line) as {
      result: { analyzer_name: string };
    };
    expect(response.result.analyzer_name).toBe("reading-stone");
    child.stdin.write('{"jsonrpc":"2.0","id":2,"method":"shutdown"}\n');
    const exitCode = await new Promise<number | null>((resolve) => {
      child.on("exit", (code) => resolve(code));
    });
    expect(exitCode).toBe(0);
  });

  it("exits 2 with usage when --stdio is missing", async () => {
    const child = spawn(process.execPath, [mainJs]);
    const stderr = await new Promise<string>((resolve) => {
      let buffer = "";
      child.stderr.on("data", (chunk: Buffer) => {
        buffer += chunk.toString();
      });
      child.stderr.on("end", () => resolve(buffer));
    });
    expect(stderr).toBe("reading-stone --stdio\n");
    const exitCode = await new Promise<number | null>((resolve) => {
      child.on("exit", (code) => resolve(code));
    });
    expect(exitCode).toBe(2);
  });

  // Release-v0-2-0 task 2.2: the tarball npm would publish, read with
  // `npm pack --dry-run --json` (honors `files`, its negation, and npm's
  // auto-includes) without writing a tarball. Gated with this suite
  // because the list only contains dist/ once it is built.
  it("packs NOTICE and the compiled surface, never source maps", {
    timeout: 60_000,
  }, () => {
    const packed = spawnSync(
      "npm",
      ["pack", "--dry-run", "--json", "--ignore-scripts"],
      {
        cwd: fileURLToPath(new URL("..", import.meta.url)),
        encoding: "utf8",
        shell: process.platform === "win32",
      },
    );
    expect(packed.status).toBe(0);
    const [manifest] = JSON.parse(packed.stdout) as Array<{
      files: Array<{ path: string }>;
    }>;
    const paths = (manifest?.files ?? []).map((file) => file.path);
    for (const required of [
      "NOTICE",
      "LICENSE",
      "README.md",
      "package.json",
      "dist/main.js",
      "dist/index.js",
      "dist/index.d.ts",
    ]) {
      expect(paths).toContain(required);
    }
    expect(paths.filter((path) => path.endsWith(".map"))).toEqual([]);
    expect(
      paths.filter((path) => path.startsWith("src/") || path.startsWith("tests/")),
    ).toEqual([]);
  });

  // Release-v0-2-0 task 3.1 (issue #7): the whole protocol lifecycle in
  // ONE session against the BUILT server Gaze spawns — initialize,
  // discover, the seven analysis methods, shutdown. Every response must
  // be a success echoing its id; every analysis method must answer its
  // single schema key with a non-empty row array over the fixture.
  it("serves the full v1.2.0 lifecycle in one session", {
    timeout: 120_000,
  }, async () => {
    const tree = await createFixtureTree(LIFECYCLE_SOURCES);
    const child = spawn(process.execPath, [mainJs, "--stdio"]);
    try {
      const rootParam = `{"root_path":${JSON.stringify(tree.root)}}`;
      const methods = [
        "initialize",
        "discover",
        ...LIFECYCLE_METHODS.map(([method]) => method),
        "shutdown",
      ];
      const lines: string[] = [];
      let buffer = "";
      child.stdout.on("data", (chunk: Buffer) => {
        buffer += chunk.toString();
        let index = buffer.indexOf("\n");
        while (index >= 0) {
          lines.push(buffer.slice(0, index));
          buffer = buffer.slice(index + 1);
          index = buffer.indexOf("\n");
        }
      });
      const exited = new Promise<number | null>((resolve) => {
        child.on("exit", (code) => resolve(code));
      });
      child.stdin.write(
        methods
          .map(
            (method, index) =>
              `{"jsonrpc":"2.0","id":${index + 1},"method":"${method}","params":${rootParam}}\n`,
          )
          .join(""),
      );
      const exitCode = await exited;

      // Assertions run only after the child exits, so a failure can
      // never strand the subprocess.
      expect(exitCode).toBe(0);
      expect(lines).toHaveLength(methods.length);
      const responses = lines.map(
        (line) =>
          JSON.parse(line) as {
            jsonrpc: string;
            id: number;
            result?: Record<string, unknown>;
            error?: unknown;
          },
      );
      responses.forEach((response, index) => {
        expect(response.jsonrpc).toBe("2.0");
        expect(response.id).toBe(index + 1);
        expect(response.error).toBeUndefined();
        expect(response.result).toBeTypeOf("object");
      });

      const [initialize, discover] = responses;
      expect(initialize?.result?.protocol_version).toBe("1.2.0");
      expect(initialize?.result?.capabilities).toEqual({
        classify_signals: true,
        cognitive_complexity: true,
        discover: true,
        doc_coverage: true,
        streaming: false,
        test_mapping: true,
      });
      expect(discover?.result?.source_files).toEqual(["src/store.ts"]);
      expect(discover?.result?.test_files).toEqual(["tests/store.test.ts"]);

      LIFECYCLE_METHODS.forEach(([method, key], offset) => {
        const result = responses[offset + 2]?.result ?? {};
        expect(Object.keys(result), method).toEqual([key]);
        const rows = result[key];
        expect(Array.isArray(rows), method).toBe(true);
        expect((rows as unknown[]).length, method).toBeGreaterThan(0);
      });

      expect(responses.at(-1)?.result).toEqual({});
    } finally {
      child.kill();
      await tree.cleanup();
    }
  });

  // The closed kind set (005 FR-001): the gaze protocol's doc_coverage
  // schema enumeration, mirrored so this black-box check validates the
  // same six values the serializer enforces (the tests/helpers/wire.ts
  // stance).
  const SYMBOL_KINDS: readonly string[] = [
    "class",
    "constant",
    "function",
    "method",
    "type",
    "variable",
  ];

  // The spec's exact US1-1 fixture (005 spec.md US1 scenario 1): divide
  // carries the one-line JSDoc summary, add carries none. Declaration
  // lines are auditable in place against the expected rows below. No
  // tsconfig, so the subprocess answers from the parse-only arm; program
  // mode is pinned at the pipeline and dispatch surfaces
  // (tests/doc-coverage.test.ts, tests/server.test.ts).
  const US1_SOURCES: Readonly<Record<string, string>> = {
    "src/math.ts": [
      "/** Divide two numbers, raising an error for a zero divisor. */", // 1
      "export function divide(dividend: number, divisor: number): number {", // 2
      "  if (divisor === 0) {", // 3
      '    throw new Error("zero divisor");', // 4
      "  }", // 5
      "  return dividend / divisor;", // 6
      "}", // 7
      "", // 8
      "export function add(left: number, right: number): number {", // 9
      "  return left + right;", // 10
      "}", // 11
      "", // 12
    ].join("\n"),
  };

  // US1-1's exact row set: divide documented with its summary line as
  // doc_snippet, add undocumented with no doc_snippet key (omitted, never
  // empty — spec 001 FR-013), in (file, line, name) order with package
  // from the shared derivation.
  const US1_SYMBOLS: readonly SubprocessSymbol[] = [
    {
      name: "divide",
      package: "src.math",
      kind: "function",
      file: "src/math.ts",
      line: 2,
      documented: true,
      doc_snippet: "Divide two numbers, raising an error for a zero divisor.",
    },
    {
      name: "add",
      package: "src.math",
      kind: "function",
      file: "src/math.ts",
      line: 9,
      documented: false,
    },
  ];

  // T007 — the US1 independent test (005 FR-015; spec.md US1 Independent
  // Test): a black-box request/response round against the BUILT server,
  // the artifact Gaze itself spawns. The suite is skipped when dist/ is
  // absent (CI builds before vitest; locally `npm run build` first).
  it("serves doc_coverage over real stdio (US1 independent test)", {
    timeout: 60_000,
  }, async () => {
    const tree = await createFixtureTree(US1_SOURCES);
    const child = spawn(process.execPath, [mainJs, "--stdio"]);
    try {
      // Handshake over the fixture root: the initialize response must
      // advertise the doc_coverage capability (FR-013) — Gaze gates its
      // doc_coverage calls on this flag.
      child.stdin.write(
        `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"root_path":${JSON.stringify(tree.root)}}}\n`,
      );
      const initializeLine = await readLine(child.stdout);

      // The identical request line, written twice — the two response
      // lines must be byte-identical (US1 scenario 3 / Constitution I).
      const docCoverageRequest = `{"jsonrpc":"2.0","id":2,"method":"doc_coverage","params":{"root_path":${JSON.stringify(tree.root)}}}\n`;
      child.stdin.write(docCoverageRequest);
      const firstLine = await readLine(child.stdout);
      child.stdin.write(docCoverageRequest);
      const secondLine = await readLine(child.stdout);

      child.stdin.write('{"jsonrpc":"2.0","id":3,"method":"shutdown"}\n');
      const exitCode = await new Promise<number | null>((resolve) => {
        child.on("exit", (code) => resolve(code));
      });

      // Assertions run only after the child exits, so a failure can
      // never strand the subprocess.
      expect(exitCode).toBe(0);
      const initialize = JSON.parse(initializeLine) as {
        result: { capabilities: Record<string, unknown> };
      };
      expect(initialize.result.capabilities.doc_coverage).toBe(true);

      const first = JSON.parse(firstLine) as {
        jsonrpc: string;
        id: number;
        result: Record<string, unknown> | undefined;
      };
      expect(first.jsonrpc).toBe("2.0");
      expect(first.id).toBe(2);
      // Fail-loud extraction (the resultSymbols discipline): an error
      // response (-32601/-32602) surfaces as the explicit absence of the
      // symbols key, never a soft pass.
      const result: Record<string, unknown> = first.result ?? {};
      expect(Object.keys(result).sort()).toEqual(["symbols"]);
      expect(Array.isArray(result.symbols)).toBe(true);
      const rows = result.symbols as readonly SubprocessSymbol[];

      // The Independent Test's structural contract: every row carries
      // the six required fields, with kind inside the closed set.
      for (const row of rows) {
        expect(row.name).toBeTypeOf("string");
        expect(row.package).toBeTypeOf("string");
        expect(row.file).toBeTypeOf("string");
        expect(Number.isInteger(row.line)).toBe(true);
        expect(row.documented).toBeTypeOf("boolean");
        expect(SYMBOL_KINDS).toContain(row.kind);
      }

      // US1-1: the documented/undocumented pair, exactly.
      expect(rows).toEqual(US1_SYMBOLS);

      // US1-3: the repeated request answers byte-identical.
      expect(secondLine).toBe(firstLine);
    } finally {
      child.kill();
      await tree.cleanup();
    }
  });

  // The US2 fixture (005 FR-005): one source file exporting four
  // functions of varying cognitive complexity — grade's if/else-if
  // chain (score 2), countPositive's nested for-of > if (3), label's
  // ternary (1), identity's construct-free body (0) — so the
  // integer-score assertion below has teeth (non-zero rows exist) and
  // the parity diff spans a non-trivial surface. No tsconfig, so the
  // subprocess answers from the parse-only arm; program mode is pinned
  // at the pipeline and dispatch surfaces (tests/cognitive.test.ts,
  // tests/server.test.ts). Declaration lines are auditable in place
  // against the parity diff below.
  const US2_SOURCES: Readonly<Record<string, string>> = {
    "src/grades.ts": [
      "export function grade(score: number): string {", // 1
      "  if (score >= 90) {", // 2
      '    return "A";', // 3
      "  } else if (score >= 80) {", // 4
      '    return "B";', // 5
      "  }", // 6
      '  return "C";', // 7
      "}", // 8
      "", // 9
      "export function countPositive(values: number[]): number {", // 10
      "  let total = 0;", // 11
      "  for (const value of values) {", // 12
      "    if (value > 0) {", // 13
      "      total += 1;", // 14
      "    }", // 15
      "  }", // 16
      "  return total;", // 17
      "}", // 18
      "", // 19
      "export function label(value: number): string {", // 20
      '  return value > 0 ? "positive" : "zero";', // 21
      "}", // 22
      "", // 23
      "export function identity(value: number): number {", // 24
      "  return value;", // 25
      "}", // 26
      "", // 27
    ].join("\n"),
  };

  // T015 — the US2 independent test (005 FR-015; spec.md US2 Independent
  // Test): a black-box request/response round against the BUILT server,
  // the artifact Gaze itself spawns. The suite is skipped when dist/ is
  // absent (CI builds before vitest; locally `npm run build` first).
  it("serves cognitive_complexity over real stdio (US2 independent test)", {
    timeout: 60_000,
  }, async () => {
    const tree = await createFixtureTree(US2_SOURCES);
    const child = spawn(process.execPath, [mainJs, "--stdio"]);
    try {
      // Handshake over the fixture root: the initialize response must
      // advertise the cognitive_complexity capability (FR-013) — Gaze
      // gates its cognitive_complexity calls (GazeCRAP-CC and the
      // --max-cognitive-complexity gate) on this flag.
      child.stdin.write(
        `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"root_path":${JSON.stringify(tree.root)}}}\n`,
      );
      const initializeLine = await readLine(child.stdout);

      // The identical request line, written twice — the two response
      // lines must be byte-identical (US2 scenario 1 / Constitution I).
      const cognitiveRequest = `{"jsonrpc":"2.0","id":2,"method":"cognitive_complexity","params":{"root_path":${JSON.stringify(tree.root)}}}\n`;
      child.stdin.write(cognitiveRequest);
      const firstLine = await readLine(child.stdout);
      child.stdin.write(cognitiveRequest);
      const secondLine = await readLine(child.stdout);

      // US2-2's parity witness: the cyclomatic `complexity` method
      // driven over the SAME root in the SAME session, so the identity
      // diff below asserts extraction parity through the real wire —
      // never against a stale or hand-copied row set.
      child.stdin.write(
        `{"jsonrpc":"2.0","id":3,"method":"complexity","params":{"root_path":${JSON.stringify(tree.root)}}}\n`,
      );
      const complexityLine = await readLine(child.stdout);

      child.stdin.write('{"jsonrpc":"2.0","id":4,"method":"shutdown"}\n');
      const exitCode = await new Promise<number | null>((resolve) => {
        child.on("exit", (code) => resolve(code));
      });

      // Assertions run only after the child exits, so a failure can
      // never strand the subprocess.
      expect(exitCode).toBe(0);
      const initialize = JSON.parse(initializeLine) as {
        result: { capabilities: Record<string, unknown> };
      };
      expect(initialize.result.capabilities.cognitive_complexity).toBe(true);

      const first = JSON.parse(firstLine) as {
        jsonrpc: string;
        id: number;
        result: Record<string, unknown> | undefined;
      };
      expect(first.jsonrpc).toBe("2.0");
      expect(first.id).toBe(2);
      // Fail-loud extraction (the resultSymbols discipline): an error
      // response (-32601/-32602) surfaces as the explicit absence of
      // the functions key, never a soft pass.
      const result: Record<string, unknown> = first.result ?? {};
      expect(Object.keys(result).sort()).toEqual(["functions"]);
      expect(Array.isArray(result.functions)).toBe(true);
      const rows = result.functions as readonly SubprocessFunction[];

      // The Independent Test's structural contract: every row carries
      // exactly the five required fields (FR-005) — the identity key
      // spelled `function`, never `name` — with integer scores.
      for (const row of rows) {
        expect(Object.keys(row).sort()).toEqual([
          "cognitive_complexity",
          "file",
          "function",
          "line",
          "package",
        ]);
        expect("name" in row).toBe(false);
        expect(row.function).toBeTypeOf("string");
        expect(row.package).toBeTypeOf("string");
        expect(row.file).toBeTypeOf("string");
        expect(Number.isInteger(row.line)).toBe(true);
        expect(Number.isInteger(row.cognitive_complexity)).toBe(true);
      }

      // The fixture's cognitive surface is non-vacuous: at least one
      // non-zero score, so the integer assertions above have teeth (a
      // server answering all zeros would fail here).
      expect(rows.some((row) => row.cognitive_complexity > 0)).toBe(true);

      // US2-2: extraction parity with the cyclomatic complexity method,
      // asserted not assumed — both methods answer over the same
      // fixture root in this session, and their (file, line, name)
      // identity tuples must match row for row (both row sets ride the
      // shared (file, line, name) order, so the ordered diff is the
      // set identity). Non-vacuous: the fixture's four functions.
      const cyclomatic = JSON.parse(complexityLine) as {
        jsonrpc: string;
        id: number;
        result: Record<string, unknown> | undefined;
      };
      expect(cyclomatic.jsonrpc).toBe("2.0");
      expect(cyclomatic.id).toBe(3);
      const cyclomaticResult: Record<string, unknown> = cyclomatic.result ?? {};
      expect(Object.keys(cyclomaticResult).sort()).toEqual(["functions"]);
      expect(Array.isArray(cyclomaticResult.functions)).toBe(true);
      const cyclomaticRows =
        cyclomaticResult.functions as readonly SubprocessComplexityEntry[];
      expect(rows).toHaveLength(4);
      expect(cyclomaticRows).toHaveLength(4);
      expect(rows.map((row) => [row.file, row.line, row.function])).toEqual(
        cyclomaticRows.map((row) => [row.file, row.line, row.name]),
      );

      // US2 scenario 1: the repeated request answers byte-identical.
      expect(secondLine).toBe(firstLine);
    } finally {
      child.kill();
      await tree.cleanup();
    }
  });
});
