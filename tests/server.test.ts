import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Readable, Writable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { initializeResult } from "../src/protocol.js";
import { type Handler, RpcError, Server } from "../src/server.js";
import { createFixtureTree, type FixtureTree } from "./helpers/fixtures.js";
import { QUICKSTART_FEED, quickstartFiles } from "./helpers/quickstart.js";
import type { WireMapping, WireSignal } from "./helpers/wire.js";

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

function request(id: number | string | null, method: string, params?: unknown): string {
  const envelope: Record<string, unknown> = { jsonrpc: "2.0", id, method };
  if (params !== undefined) {
    envelope.params = params;
  }
  return JSON.stringify(envelope);
}

interface DriveResult {
  responses: Record<string, unknown>[];
  /** Raw non-empty stdout lines (pre-parse) for byte-level assertions. */
  rawLines: string[];
  stderr: string;
}

async function drive(
  lines: string[],
  dispatch?: Map<string, Handler>,
): Promise<DriveResult> {
  const out = sink();
  const err = sink();
  const server = new Server(
    Readable.from([lines.join("\n")]),
    out.stream,
    err.stream,
    dispatch,
  );
  await server.run();
  // The raw lines are kept pre-parse so byte-level determinism assertions
  // compare exactly what the server wrote (SC-006).
  const rawLines = out
    .text()
    .split("\n")
    .filter((line) => line.length > 0);
  const responses = rawLines.map((line) => JSON.parse(line) as Record<string, unknown>);
  return { responses, rawLines, stderr: err.text() };
}

function errorBody(response: Record<string, unknown>): {
  code: number;
  message: string;
} {
  return (response.error ?? {}) as { code: number; message: string };
}

// The classify_signals result's wire rows, projected to the five pinned
// fields (quickstart Section 4's jq shape) — the row type itself is
// WireSignal from tests/helpers/wire.js, shared with the pipeline suite
// and the canonical quickstart fixture. The result object must carry
// exactly one key — `signals` (contracts/classify-signals.md Section 3) —
// so an error response or a malformed result fails loud here, never a
// soft empty match: during the red phase (before T030 registered the
// handler) this surfaced the -32601 answers as the explicit absence of a
// result rather than a vacuous pass, and any future error answer still
// fails the same way.
function resultSignals(response: Record<string, unknown>): readonly WireSignal[] {
  const result = (response.result ?? {}) as Record<string, unknown>;
  expect(Object.keys(result).sort()).toEqual(["signals"]);
  expect(Array.isArray(result.signals)).toBe(true);
  return (result.signals as readonly Record<string, unknown>[]).map(
    (signal): WireSignal => ({
      function: signal.function as string,
      package: signal.package as string,
      side_effect_type: signal.side_effect_type as string,
      source: signal.source as string,
      weight: signal.weight as number,
    }),
  );
}

const INIT = request(1, "initialize", { root_path: "/abs/project" });

// chmod-based inaccessibility is meaningless for root, where mode bits do
// not restrict the owner (the same guard tests/discovery.test.ts uses).
const runningAsRoot = typeof process.getuid === "function" && process.getuid() === 0;

describe("server: initialize", () => {
  it("round-trips a valid initialize request", async () => {
    const { responses, stderr } = await drive([INIT]);
    expect(responses).toHaveLength(1);
    expect(responses[0]?.jsonrpc).toBe("2.0");
    expect(responses[0]?.id).toBe(1);
    expect(responses[0]?.result).toEqual(initializeResult());
    expect(stderr).toBe("");
  });

  it("echoes the falsy id 0", async () => {
    const { responses } = await drive([
      request(0, "initialize", { root_path: "/abs/project" }),
    ]);
    expect(responses[0]?.id).toBe(0);
    expect(responses[0]?.result).toEqual(initializeResult());
  });

  it("accepts a missing config key", async () => {
    const { responses } = await drive([
      request(2, "initialize", { root_path: "/abs/project" }),
    ]);
    expect(responses[0]?.result).toEqual(initializeResult());
  });

  it("is idempotent", async () => {
    const { responses } = await drive([INIT, INIT]);
    expect(responses).toHaveLength(2);
    expect(responses[0]?.result).toEqual(initializeResult());
    expect(responses[1]?.result).toEqual(initializeResult());
  });

  it.each([
    ["absent params", undefined],
    ["null params", null],
    ["array params", []],
  ])("rejects %s with -32602", async (_label, params) => {
    const { responses } = await drive([request(3, "initialize", params)]);
    expect(errorBody(responses[0] ?? {}).code).toBe(-32602);
    expect(errorBody(responses[0] ?? {}).message).toBe(
      "Invalid params: params must be an object",
    );
    expect(responses[0]?.id).toBe(3);
  });

  it.each([
    ["missing root_path", {}],
    ["non-string root_path", { root_path: 42 }],
  ])("rejects %s with -32602", async (_label, params) => {
    const { responses } = await drive([request(3, "initialize", params)]);
    expect(errorBody(responses[0] ?? {}).code).toBe(-32602);
    expect(errorBody(responses[0] ?? {}).message).toBe(
      "Invalid params: root_path must be a string",
    );
  });
});

describe("server: discover", () => {
  const activeFixtures: FixtureTree[] = [];
  const lockedDirectories: string[] = [];

  // Creates a fixture tree registered for afterEach cleanup; returns the
  // tree's root path to use as the discover request's root_path.
  async function fixtureTree(files: Readonly<Record<string, string>>): Promise<string> {
    const tree = await createFixtureTree(files);
    activeFixtures.push(tree);
    return tree.root;
  }

  afterEach(async () => {
    // Recursive cleanup cannot descend into a chmod-000 directory, so every
    // locked directory is unlocked before its fixture tree is removed.
    for (const directory of lockedDirectories.splice(0)) {
      await chmod(directory, 0o755);
    }
    await Promise.all(activeFixtures.splice(0).map((tree) => tree.cleanup()));
  });

  it("round-trips a valid discover request", async () => {
    // The fixture pins the wire-visible classification rules through the
    // dispatch surface: a name-signal test (src/a.test.ts), a
    // directory-signal test (tests/helper.ts), a declaration file and a
    // non-walked extension that appear in neither list, and a root-level
    // source with no directory component.
    const root = await fixtureTree({
      "main.ts": "export const main = 1;\n",
      "src/a.ts": "export const a = 1;\n",
      "src/a.test.ts": 'import { a } from "./a.js";\n',
      "src/notes.md": "# notes\n",
      "src/types.d.ts": "export type A = number;\n",
      "tests/helper.ts": "export const helper = 1;\n",
    });
    const { responses, stderr } = await drive([
      request(10, "discover", { root_path: root }),
    ]);
    expect(responses).toHaveLength(1);
    expect(responses[0]?.jsonrpc).toBe("2.0");
    expect(responses[0]?.id).toBe(10);
    expect(responses[0]?.result).toEqual({
      source_files: ["main.ts", "src/a.ts"],
      test_files: ["src/a.test.ts", "tests/helper.ts"],
      framework: "unknown",
    });
    expect(stderr).toBe("");
  });

  it.each([
    ["absent params", undefined],
    ["null params", null],
    ["array params", []],
  ])("rejects %s with -32602", async (_label, params) => {
    const { responses, stderr } = await drive([request(11, "discover", params)]);
    expect(errorBody(responses[0] ?? {}).code).toBe(-32602);
    expect(errorBody(responses[0] ?? {}).message).toBe(
      "Invalid params: params must be an object",
    );
    expect(responses[0]?.id).toBe(11);
    expect(stderr).toBe("");
  });

  it.each([
    ["missing root_path", {}],
    ["non-string root_path", { root_path: 42 }],
  ])("rejects %s with -32602", async (_label, params) => {
    const { responses, stderr } = await drive([request(12, "discover", params)]);
    expect(errorBody(responses[0] ?? {}).code).toBe(-32602);
    expect(errorBody(responses[0] ?? {}).message).toBe(
      "Invalid params: root_path must be a string",
    );
    expect(responses[0]?.id).toBe(12);
    expect(stderr).toBe("");
  });

  it("rejects an extra params key with -32602", async () => {
    const params = { root_path: "/abs/project", patterns: ["src/**/*.ts"] };
    const { responses, stderr } = await drive([request(13, "discover", params)]);
    expect(errorBody(responses[0] ?? {}).code).toBe(-32602);
    expect(errorBody(responses[0] ?? {}).message).toBe(
      "Invalid params: params must contain only root_path",
    );
    expect(responses[0]?.id).toBe(13);
    expect(stderr).toBe("");
  });

  it("rejects a nonexistent root_path with -32602", async () => {
    const root = await fixtureTree({});
    const missing = join(root, "does-not-exist");
    const { responses, stderr } = await drive([
      request(14, "discover", { root_path: missing }),
    ]);
    expect(errorBody(responses[0] ?? {}).code).toBe(-32602);
    expect(errorBody(responses[0] ?? {}).message).toBe(
      `Invalid params: root_path is not a directory: ${missing}`,
    );
    expect(responses[0]?.id).toBe(14);
    expect(stderr).toBe("");
  });

  it("rejects a non-directory root_path with -32602", async () => {
    const root = await fixtureTree({ "not-a-dir.ts": "export {};\n" });
    const file = join(root, "not-a-dir.ts");
    const { responses, stderr } = await drive([
      request(15, "discover", { root_path: file }),
    ]);
    expect(errorBody(responses[0] ?? {}).code).toBe(-32602);
    expect(errorBody(responses[0] ?? {}).message).toBe(
      `Invalid params: root_path is not a directory: ${file}`,
    );
    expect(responses[0]?.id).toBe(15);
    expect(stderr).toBe("");
  });

  it("rejects an inaccessible root_path with -32602", async () => {
    const root = await fixtureTree({ "locked/nested/a.ts": "export const a = 1;\n" });
    const locked = join(root, "locked");
    const nested = join(locked, "nested");
    await chmod(locked, 0o000);
    lockedDirectories.push(locked);
    const { responses, stderr } = await drive([
      request(16, "discover", { root_path: nested }),
    ]);
    expect(errorBody(responses[0] ?? {}).code).toBe(-32602);
    expect(errorBody(responses[0] ?? {}).message).toBe(
      `Invalid params: root_path is not a directory: ${nested}`,
    );
    expect(responses[0]?.id).toBe(16);
    expect(stderr).toBe("");
  });

  it("echoes the cwd-resolved path for a relative root_path", async () => {
    const relative = "no-such-directory-t005";
    const { responses, stderr } = await drive([
      request(17, "discover", { root_path: relative }),
    ]);
    expect(errorBody(responses[0] ?? {}).code).toBe(-32602);
    expect(errorBody(responses[0] ?? {}).message).toBe(
      `Invalid params: root_path is not a directory: ${resolve(relative)}`,
    );
    expect(responses[0]?.id).toBe(17);
    expect(stderr).toBe("");
  });
});

describe("server: analyze", () => {
  const activeFixtures: FixtureTree[] = [];
  const lockedDirectories: string[] = [];

  // Creates a fixture tree registered for afterEach cleanup; returns the
  // tree's root path to use as the analyze request's root_path.
  async function fixtureTree(files: Readonly<Record<string, string>>): Promise<string> {
    const tree = await createFixtureTree(files);
    activeFixtures.push(tree);
    return tree.root;
  }

  afterEach(async () => {
    // Recursive cleanup cannot descend into a chmod-000 directory, so every
    // locked directory is unlocked before its fixture tree is removed.
    for (const directory of lockedDirectories.splice(0)) {
      await chmod(directory, 0o755);
    }
    await Promise.all(activeFixtures.splice(0).map((tree) => tree.cleanup()));
  });

  // The canned tree (FR-020) pins the record wire shape without depending
  // on effect wording: research R6.6 makes description strings
  // implementation-defined (pinned by golden tests, not the contract), so
  // both fixture functions are pure by construction — `alpha`'s single
  // bare `return;` never matches ReturnValue (FR-011) and `beta`'s empty
  // body has no constructs to match — leaving `side_effects: []` (SC-002)
  // as the exact, spec-guaranteed prediction. Records order by
  // (file, line, name) per FR-020.
  const analyzedTree: Readonly<Record<string, string>> = {
    "src/alpha.ts": "export function alpha(): void {\n  return;\n}\n",
    "src/beta.ts": "export function beta(): void {}\n",
  };
  const expectedRecords = [
    {
      name: "alpha",
      package: "src.alpha",
      file: "src/alpha.ts",
      line: 1,
      side_effects: [],
    },
    {
      name: "beta",
      package: "src.beta",
      file: "src/beta.ts",
      line: 1,
      side_effects: [],
    },
  ];

  it("round-trips a valid analyze request", async () => {
    const root = await fixtureTree(analyzedTree);
    const { responses, stderr } = await drive([
      request(20, "analyze", { root_path: root }),
    ]);
    expect(responses).toHaveLength(1);
    expect(responses[0]?.jsonrpc).toBe("2.0");
    expect(responses[0]?.id).toBe(20);
    expect(responses[0]?.result).toEqual({ functions: expectedRecords });
    expect(stderr).toBe("");
  });

  it.each([
    ["absent params", undefined],
    ["null params", null],
    ["array params", []],
  ])("rejects %s with -32602", async (_label, params) => {
    const { responses, stderr } = await drive([request(21, "analyze", params)]);
    expect(errorBody(responses[0] ?? {}).code).toBe(-32602);
    expect(errorBody(responses[0] ?? {}).message).toBe(
      "Invalid params: params must be an object",
    );
    expect(responses[0]?.id).toBe(21);
    expect(stderr).toBe("");
  });

  it.each([
    ["missing root_path", {}],
    ["non-string root_path", { root_path: 42 }],
  ])("rejects %s with -32602", async (_label, params) => {
    const { responses, stderr } = await drive([request(22, "analyze", params)]);
    expect(errorBody(responses[0] ?? {}).code).toBe(-32602);
    expect(errorBody(responses[0] ?? {}).message).toBe(
      "Invalid params: root_path must be a string",
    );
    expect(responses[0]?.id).toBe(22);
    expect(stderr).toBe("");
  });

  it.each([
    ["non-array patterns", { root_path: "/abs/project", patterns: "src/**/*.ts" }],
    ["number patterns", { root_path: "/abs/project", patterns: 42 }],
    [
      "patterns array with a non-string element",
      { root_path: "/abs/project", patterns: ["src", 7] },
    ],
  ])("rejects %s with -32602", async (_label, params) => {
    const { responses, stderr } = await drive([request(23, "analyze", params)]);
    expect(errorBody(responses[0] ?? {}).code).toBe(-32602);
    expect(errorBody(responses[0] ?? {}).message).toBe(
      "Invalid params: patterns must be an array of strings",
    );
    expect(responses[0]?.id).toBe(23);
    expect(stderr).toBe("");
  });

  it.each([
    ["an extra key beside root_path", { root_path: "/abs/project", extra: true }],
    [
      "an extra key beside root_path and patterns",
      { root_path: "/abs/project", patterns: ["src/**"], extra: true },
    ],
  ])("rejects %s with -32602", async (_label, params) => {
    const { responses, stderr } = await drive([request(24, "analyze", params)]);
    expect(errorBody(responses[0] ?? {}).code).toBe(-32602);
    expect(errorBody(responses[0] ?? {}).message).toBe(
      "Invalid params: params must contain only root_path and patterns",
    );
    expect(responses[0]?.id).toBe(24);
    expect(stderr).toBe("");
  });

  it("rejects a nonexistent root_path with -32602", async () => {
    const root = await fixtureTree({});
    const missing = join(root, "does-not-exist");
    const { responses, stderr } = await drive([
      request(25, "analyze", { root_path: missing }),
    ]);
    expect(errorBody(responses[0] ?? {}).code).toBe(-32602);
    expect(errorBody(responses[0] ?? {}).message).toBe(
      `Invalid params: root_path is not a directory: ${missing}`,
    );
    expect(responses[0]?.id).toBe(25);
    expect(stderr).toBe("");
  });

  it("rejects a non-directory root_path with -32602", async () => {
    const root = await fixtureTree({ "not-a-dir.ts": "export {};\n" });
    const file = join(root, "not-a-dir.ts");
    const { responses, stderr } = await drive([
      request(26, "analyze", { root_path: file }),
    ]);
    expect(errorBody(responses[0] ?? {}).code).toBe(-32602);
    expect(errorBody(responses[0] ?? {}).message).toBe(
      `Invalid params: root_path is not a directory: ${file}`,
    );
    expect(responses[0]?.id).toBe(26);
    expect(stderr).toBe("");
  });

  it.skipIf(runningAsRoot)(
    "rejects an inaccessible root_path with -32602",
    async () => {
      const root = await fixtureTree({
        "locked/nested/a.ts": "export const a = 1;\n",
      });
      const locked = join(root, "locked");
      const nested = join(locked, "nested");
      await chmod(locked, 0o000);
      lockedDirectories.push(locked);
      const { responses, stderr } = await drive([
        request(27, "analyze", { root_path: nested }),
      ]);
      expect(errorBody(responses[0] ?? {}).code).toBe(-32602);
      expect(errorBody(responses[0] ?? {}).message).toBe(
        `Invalid params: root_path is not a directory: ${nested}`,
      );
      expect(responses[0]?.id).toBe(27);
      expect(stderr).toBe("");
    },
  );

  it("answers a repeated request with byte-identical response lines", async () => {
    const root = await fixtureTree(analyzedTree);
    const line = request(28, "analyze", { root_path: root });
    const { responses, rawLines, stderr } = await drive([line, line]);
    expect(responses).toHaveLength(2);
    expect(rawLines).toHaveLength(2);
    expect(rawLines[0]).toBe(rawLines[1]);
    expect(responses[0]?.id).toBe(28);
    expect(responses[0]?.result).toEqual({ functions: expectedRecords });
    expect(stderr).toBe("");
  });

  // FR-028: `analyze` is a core method, not gated by a capability flag, so
  // the initialize handshake must stay exactly as it was when the analyze
  // handler registers. The initialize tests above compare against
  // `initializeResult()` (tautologically green if the function drifts);
  // tests/protocol.test.ts pins the unit output — this literal pin makes a
  // capability flip visible through the server wire too. The pinned state
  // includes spec 003's classify_signals flip (FR-015; T030) and spec 004's
  // test_mapping flip (FR-014; T020 lands registration and flag as one
  // protocol-state unit), so this pin stays red with the 004 server suite
  // until T020 — the flip's visibility working exactly as designed.
  it("leaves the initialize capability response unchanged", async () => {
    const { responses } = await drive([INIT]);
    expect(responses[0]?.result).toEqual({
      analyzer_name: "reading-stone",
      language: "typescript",
      language_version: process.versions.node,
      protocol_version: "1.2.0",
      capabilities: {
        discover: true,
        test_mapping: true,
        classify_signals: true,
        streaming: false,
        doc_coverage: false,
        cognitive_complexity: false,
      },
    });
  });
});

describe("server: complexity", () => {
  const activeFixtures: FixtureTree[] = [];
  const lockedDirectories: string[] = [];

  // Creates a fixture tree registered for afterEach cleanup; returns the
  // tree's root path to use as the complexity request's root_path.
  async function fixtureTree(files: Readonly<Record<string, string>>): Promise<string> {
    const tree = await createFixtureTree(files);
    activeFixtures.push(tree);
    return tree.root;
  }

  afterEach(async () => {
    // Recursive cleanup cannot descend into a chmod-000 directory, so every
    // locked directory is unlocked before its fixture tree is removed.
    for (const directory of lockedDirectories.splice(0)) {
      await chmod(directory, 0o755);
    }
    await Promise.all(activeFixtures.splice(0).map((tree) => tree.cleanup()));
  });

  // The canned tree pins the five-field complexity entry (FR-022) with
  // every score computed by hand from the FR-021 closed decision-point
  // list: `grade` = 1 + if + else-if; `classify` = 1 + two case clauses
  // (a `default` arm never counts); `tally` = 1 + for, for-of, for-in,
  // while, do; `parse` = 1 + catch; `label` = 1 + && + || + ternary;
  // `pick` = 1 + two ??; `coalesce` = 1 because the logical assignments
  // &&=/||=/??= are the documented exclusion (Assumption 10); `noop` = 1
  // because an empty body scores 1. Entries order by (file, line, name)
  // per FR-020 over the extraction pipeline shared with analyze (FR-022).
  const complexityTree: Readonly<Record<string, string>> = {
    "src/branches.ts":
      'export function grade(score: number): string {\n  if (score >= 90) {\n    return "A";\n  } else if (score >= 80) {\n    return "B";\n  }\n  return "F";\n}\n\nexport function classify(code: number): string {\n  switch (code) {\n    case 1:\n      return "one";\n    case 2:\n      return "two";\n    default:\n      return "many";\n  }\n}\n',
    "src/loops.ts":
      "export function tally(count: number): number {\n  let total = 0;\n  for (let i = 0; i < count; i++) {\n    total += 1;\n  }\n  for (const value of [1, 2, 3]) {\n    total += value;\n  }\n  for (const key in { a: 1 }) {\n    total += 1;\n  }\n  while (total > 100) {\n    total -= 100;\n  }\n  do {\n    total += 1;\n  } while (total < 0);\n  return total;\n}\n\nexport function parse(text: string): number {\n  try {\n    return JSON.parse(text) as number;\n  } catch {\n    return 0;\n  }\n}\n",
    "src/operators.ts":
      'export function label(a: boolean, b: boolean, c: boolean): string {\n  return a && (b || c) ? "some" : "none";\n}\n\nexport function pick(a: string | null, b: string | null): string {\n  return a ?? b ?? "none";\n}\n\nexport function coalesce(a: boolean | null, b: boolean | null): boolean | null {\n  a ||= b;\n  a &&= b;\n  a ??= b;\n  return a;\n}\n\nexport function noop(): void {}\n',
  };
  const expectedEntries = [
    {
      name: "grade",
      package: "src.branches",
      file: "src/branches.ts",
      line: 1,
      complexity: 3,
    },
    {
      name: "classify",
      package: "src.branches",
      file: "src/branches.ts",
      line: 10,
      complexity: 3,
    },
    {
      name: "tally",
      package: "src.loops",
      file: "src/loops.ts",
      line: 1,
      complexity: 6,
    },
    {
      name: "parse",
      package: "src.loops",
      file: "src/loops.ts",
      line: 21,
      complexity: 2,
    },
    {
      name: "label",
      package: "src.operators",
      file: "src/operators.ts",
      line: 1,
      complexity: 4,
    },
    {
      name: "pick",
      package: "src.operators",
      file: "src/operators.ts",
      line: 5,
      complexity: 3,
    },
    {
      name: "coalesce",
      package: "src.operators",
      file: "src/operators.ts",
      line: 9,
      complexity: 1,
    },
    {
      name: "noop",
      package: "src.operators",
      file: "src/operators.ts",
      line: 16,
      complexity: 1,
    },
  ];

  it("round-trips a valid complexity request", async () => {
    const root = await fixtureTree(complexityTree);
    const { responses, stderr } = await drive([
      request(30, "complexity", { root_path: root }),
    ]);
    expect(responses).toHaveLength(1);
    expect(responses[0]?.jsonrpc).toBe("2.0");
    expect(responses[0]?.id).toBe(30);
    expect(responses[0]?.result).toEqual({ functions: expectedEntries });
    expect(stderr).toBe("");
  });

  it.each([
    ["absent params", undefined],
    ["null params", null],
    ["array params", []],
  ])("rejects %s with -32602", async (_label, params) => {
    const { responses, stderr } = await drive([request(31, "complexity", params)]);
    expect(errorBody(responses[0] ?? {}).code).toBe(-32602);
    expect(errorBody(responses[0] ?? {}).message).toBe(
      "Invalid params: params must be an object",
    );
    expect(responses[0]?.id).toBe(31);
    expect(stderr).toBe("");
  });

  it.each([
    ["missing root_path", {}],
    ["non-string root_path", { root_path: 42 }],
  ])("rejects %s with -32602", async (_label, params) => {
    const { responses, stderr } = await drive([request(32, "complexity", params)]);
    expect(errorBody(responses[0] ?? {}).code).toBe(-32602);
    expect(errorBody(responses[0] ?? {}).message).toBe(
      "Invalid params: root_path must be a string",
    );
    expect(responses[0]?.id).toBe(32);
    expect(stderr).toBe("");
  });

  it.each([
    ["non-array patterns", { root_path: "/abs/project", patterns: "src/**/*.ts" }],
    ["number patterns", { root_path: "/abs/project", patterns: 42 }],
    [
      "patterns array with a non-string element",
      { root_path: "/abs/project", patterns: ["src", 7] },
    ],
  ])("rejects %s with -32602", async (_label, params) => {
    const { responses, stderr } = await drive([request(33, "complexity", params)]);
    expect(errorBody(responses[0] ?? {}).code).toBe(-32602);
    expect(errorBody(responses[0] ?? {}).message).toBe(
      "Invalid params: patterns must be an array of strings",
    );
    expect(responses[0]?.id).toBe(33);
    expect(stderr).toBe("");
  });

  it.each([
    ["an extra key beside root_path", { root_path: "/abs/project", extra: true }],
    [
      "an extra key beside root_path and patterns",
      { root_path: "/abs/project", patterns: ["src/**"], extra: true },
    ],
  ])("rejects %s with -32602", async (_label, params) => {
    const { responses, stderr } = await drive([request(34, "complexity", params)]);
    expect(errorBody(responses[0] ?? {}).code).toBe(-32602);
    expect(errorBody(responses[0] ?? {}).message).toBe(
      "Invalid params: params must contain only root_path and patterns",
    );
    expect(responses[0]?.id).toBe(34);
    expect(stderr).toBe("");
  });

  it("rejects a nonexistent root_path with -32602", async () => {
    const root = await fixtureTree({});
    const missing = join(root, "does-not-exist");
    const { responses, stderr } = await drive([
      request(35, "complexity", { root_path: missing }),
    ]);
    expect(errorBody(responses[0] ?? {}).code).toBe(-32602);
    expect(errorBody(responses[0] ?? {}).message).toBe(
      `Invalid params: root_path is not a directory: ${missing}`,
    );
    expect(responses[0]?.id).toBe(35);
    expect(stderr).toBe("");
  });

  it("rejects a non-directory root_path with -32602", async () => {
    const root = await fixtureTree({ "not-a-dir.ts": "export {};\n" });
    const file = join(root, "not-a-dir.ts");
    const { responses, stderr } = await drive([
      request(36, "complexity", { root_path: file }),
    ]);
    expect(errorBody(responses[0] ?? {}).code).toBe(-32602);
    expect(errorBody(responses[0] ?? {}).message).toBe(
      `Invalid params: root_path is not a directory: ${file}`,
    );
    expect(responses[0]?.id).toBe(36);
    expect(stderr).toBe("");
  });

  it.skipIf(runningAsRoot)(
    "rejects an inaccessible root_path with -32602",
    async () => {
      const root = await fixtureTree({
        "locked/nested/a.ts": "export const a = 1;\n",
      });
      const locked = join(root, "locked");
      const nested = join(locked, "nested");
      await chmod(locked, 0o000);
      lockedDirectories.push(locked);
      const { responses, stderr } = await drive([
        request(37, "complexity", { root_path: nested }),
      ]);
      expect(errorBody(responses[0] ?? {}).code).toBe(-32602);
      expect(errorBody(responses[0] ?? {}).message).toBe(
        `Invalid params: root_path is not a directory: ${nested}`,
      );
      expect(responses[0]?.id).toBe(37);
      expect(stderr).toBe("");
    },
  );

  it("answers a repeated request with byte-identical response lines", async () => {
    const root = await fixtureTree(complexityTree);
    const line = request(38, "complexity", { root_path: root });
    const { responses, rawLines, stderr } = await drive([line, line]);
    expect(responses).toHaveLength(2);
    expect(rawLines).toHaveLength(2);
    expect(rawLines[0]).toBe(rawLines[1]);
    expect(responses[0]?.id).toBe(38);
    expect(responses[0]?.result).toEqual({ functions: expectedEntries });
    expect(stderr).toBe("");
  });
});

describe("server: coverage", () => {
  const activeFixtures: FixtureTree[] = [];
  const lockedDirectories: string[] = [];

  // Creates a fixture tree registered for afterEach cleanup; returns the
  // tree's root path to use as the coverage request's root_path.
  async function fixtureTree(files: Readonly<Record<string, string>>): Promise<string> {
    const tree = await createFixtureTree(files);
    activeFixtures.push(tree);
    return tree.root;
  }

  afterEach(async () => {
    // Recursive cleanup cannot descend into a chmod-000 directory, so every
    // locked directory is unlocked before its fixture tree is removed.
    for (const directory of lockedDirectories.splice(0)) {
      await chmod(directory, 0o755);
    }
    await Promise.all(activeFixtures.splice(0).map((tree) => tree.cleanup()));
  });

  // The canned artifact (FR-023; Assumption 14 — hand-authored, never the
  // product of executing the analyzed project's tests) pins the
  // seven-field entry (FR-024) with every count computed by hand from the
  // FR-023 attribution rule: all three `score.ts` statements start inside
  // `grade`'s loc range (lines 2-4 within lines 1-5) and carry `s` counts
  // 3, 3, 0, so `grade` = 2 covered of 3 total with percentage
  // 66.66666666666667 — the full-precision value quickstart.md pins for
  // the 2-of-3 case (Assumption 6; the exact double requires the
  // (covered * 100) / total association — (2 / 3) * 100 itself rounds to
  // 66.66666666666666). `math.ts`'s single statement starts inside
  // `add`'s range (line 2 within lines 1-3) with `s` count 5, so `add` =
  // 1 of 1 with percentage 100; `(anonymous_0)`'s range contains no
  // statement starts, so it reports total_stmts 0 with percentage exactly
  // 0.0 (never a division error) and its fnMap name verbatim — anonymous
  // form included. `f`, `branchMap`, and `b` mirror a real Istanbul
  // document and are ignored. Entries order by (file, start_line,
  // function) per FR-024.
  function coverageArtifact(root: string): string {
    return JSON.stringify({
      [join(root, "src/score.ts")]: {
        statementMap: {
          "0": { start: { line: 2, column: 2 }, end: { line: 4, column: 3 } },
          "1": { start: { line: 3, column: 4 }, end: { line: 3, column: 10 } },
          "2": { start: { line: 4, column: 2 }, end: { line: 4, column: 12 } },
        },
        fnMap: {
          "0": {
            name: "grade",
            decl: { start: { line: 1, column: 0 }, end: { line: 1, column: 41 } },
            loc: { start: { line: 1, column: 0 }, end: { line: 5, column: 1 } },
            line: 1,
          },
        },
        f: { "0": 3 },
        s: { "0": 3, "1": 3, "2": 0 },
        branchMap: {},
        b: {},
      },
      [join(root, "src/utils/math.ts")]: {
        statementMap: {
          "0": { start: { line: 2, column: 2 }, end: { line: 2, column: 14 } },
        },
        fnMap: {
          "0": {
            name: "add",
            decl: { start: { line: 1, column: 0 }, end: { line: 1, column: 35 } },
            loc: { start: { line: 1, column: 0 }, end: { line: 3, column: 1 } },
            line: 1,
          },
          "1": {
            name: "(anonymous_0)",
            decl: { start: { line: 5, column: 2 }, end: { line: 5, column: 18 } },
            loc: { start: { line: 5, column: 2 }, end: { line: 5, column: 20 } },
          },
        },
        s: { "0": 5 },
      },
    });
  }

  const expectedEntries = [
    {
      file: "src/score.ts",
      function: "grade",
      start_line: 1,
      end_line: 5,
      covered_stmts: 2,
      total_stmts: 3,
      percentage: 66.66666666666667,
    },
    {
      file: "src/utils/math.ts",
      function: "add",
      start_line: 1,
      end_line: 3,
      covered_stmts: 1,
      total_stmts: 1,
      percentage: 100,
    },
    {
      file: "src/utils/math.ts",
      function: "(anonymous_0)",
      start_line: 5,
      end_line: 5,
      covered_stmts: 0,
      total_stmts: 0,
      percentage: 0,
    },
  ];

  // The document's file keys are absolute paths under the analysis root
  // (the Istanbul shape), so the artifact cannot ride through the static
  // files map — it is written after the fixture tree exists, at the
  // conventional <root>/coverage/coverage-final.json location (FR-023).
  async function artifactTree(): Promise<string> {
    const root = await fixtureTree({});
    await mkdir(join(root, "coverage"), { recursive: true });
    await writeFile(
      join(root, "coverage", "coverage-final.json"),
      coverageArtifact(root),
      "utf8",
    );
    return root;
  }

  it("round-trips a valid coverage request", async () => {
    const root = await artifactTree();
    const { responses, stderr } = await drive([
      request(40, "coverage", { root_path: root }),
    ]);
    expect(responses).toHaveLength(1);
    expect(responses[0]?.jsonrpc).toBe("2.0");
    expect(responses[0]?.id).toBe(40);
    expect(responses[0]?.result).toEqual({ functions: expectedEntries });
    expect(stderr).toBe("");
  });

  it.each([
    ["absent params", undefined],
    ["null params", null],
    ["array params", []],
  ])("rejects %s with -32602", async (_label, params) => {
    const { responses, stderr } = await drive([request(41, "coverage", params)]);
    expect(errorBody(responses[0] ?? {}).code).toBe(-32602);
    expect(errorBody(responses[0] ?? {}).message).toBe(
      "Invalid params: params must be an object",
    );
    expect(responses[0]?.id).toBe(41);
    expect(stderr).toBe("");
  });

  it.each([
    ["missing root_path", {}],
    ["non-string root_path", { root_path: 42 }],
  ])("rejects %s with -32602", async (_label, params) => {
    const { responses, stderr } = await drive([request(42, "coverage", params)]);
    expect(errorBody(responses[0] ?? {}).code).toBe(-32602);
    expect(errorBody(responses[0] ?? {}).message).toBe(
      "Invalid params: root_path must be a string",
    );
    expect(responses[0]?.id).toBe(42);
    expect(stderr).toBe("");
  });

  it.each([
    ["non-array patterns", { root_path: "/abs/project", patterns: "src/**/*.ts" }],
    ["number patterns", { root_path: "/abs/project", patterns: 42 }],
    [
      "patterns array with a non-string element",
      { root_path: "/abs/project", patterns: ["src", 7] },
    ],
  ])("rejects %s with -32602", async (_label, params) => {
    const { responses, stderr } = await drive([request(43, "coverage", params)]);
    expect(errorBody(responses[0] ?? {}).code).toBe(-32602);
    expect(errorBody(responses[0] ?? {}).message).toBe(
      "Invalid params: patterns must be an array of strings",
    );
    expect(responses[0]?.id).toBe(43);
    expect(stderr).toBe("");
  });

  it.each([
    ["an extra key beside root_path", { root_path: "/abs/project", extra: true }],
    [
      "an extra key beside root_path and patterns",
      { root_path: "/abs/project", patterns: ["src/**"], extra: true },
    ],
  ])("rejects %s with -32602", async (_label, params) => {
    const { responses, stderr } = await drive([request(44, "coverage", params)]);
    expect(errorBody(responses[0] ?? {}).code).toBe(-32602);
    expect(errorBody(responses[0] ?? {}).message).toBe(
      "Invalid params: params must contain only root_path and patterns",
    );
    expect(responses[0]?.id).toBe(44);
    expect(stderr).toBe("");
  });

  it("rejects a nonexistent root_path with -32602", async () => {
    const root = await fixtureTree({});
    const missing = join(root, "does-not-exist");
    const { responses, stderr } = await drive([
      request(45, "coverage", { root_path: missing }),
    ]);
    expect(errorBody(responses[0] ?? {}).code).toBe(-32602);
    expect(errorBody(responses[0] ?? {}).message).toBe(
      `Invalid params: root_path is not a directory: ${missing}`,
    );
    expect(responses[0]?.id).toBe(45);
    expect(stderr).toBe("");
  });

  it("rejects a non-directory root_path with -32602", async () => {
    const root = await fixtureTree({ "not-a-dir.ts": "export {};\n" });
    const file = join(root, "not-a-dir.ts");
    const { responses, stderr } = await drive([
      request(46, "coverage", { root_path: file }),
    ]);
    expect(errorBody(responses[0] ?? {}).code).toBe(-32602);
    expect(errorBody(responses[0] ?? {}).message).toBe(
      `Invalid params: root_path is not a directory: ${file}`,
    );
    expect(responses[0]?.id).toBe(46);
    expect(stderr).toBe("");
  });

  it.skipIf(runningAsRoot)(
    "rejects an inaccessible root_path with -32602",
    async () => {
      const root = await fixtureTree({
        "locked/nested/a.ts": "export const a = 1;\n",
      });
      const locked = join(root, "locked");
      const nested = join(locked, "nested");
      await chmod(locked, 0o000);
      lockedDirectories.push(locked);
      const { responses, stderr } = await drive([
        request(47, "coverage", { root_path: nested }),
      ]);
      expect(errorBody(responses[0] ?? {}).code).toBe(-32602);
      expect(errorBody(responses[0] ?? {}).message).toBe(
        `Invalid params: root_path is not a directory: ${nested}`,
      );
      expect(responses[0]?.id).toBe(47);
      expect(stderr).toBe("");
    },
  );

  it("answers a repeated request with byte-identical response lines", async () => {
    const root = await artifactTree();
    const line = request(48, "coverage", { root_path: root });
    const { responses, rawLines, stderr } = await drive([line, line]);
    expect(responses).toHaveLength(2);
    expect(rawLines).toHaveLength(2);
    expect(rawLines[0]).toBe(rawLines[1]);
    expect(responses[0]?.id).toBe(48);
    expect(responses[0]?.result).toEqual({ functions: expectedEntries });
    expect(stderr).toBe("");
  });
});

// T026 (spec 003; US2 tests; FR-014/FR-015; SC-005/SC-006; contracts/
// classify-signals.md conformance requirements 1-6). Written red-first,
// exactly as the analyze/complexity/coverage blocks were before their
// handlers registered: every case below answered -32601 until T029
// landed the adapter entry and T030 registered the handler with the
// capability flip, then the whole block turned green without further
// edits. The -32602
// matrix pins the identical message strings the analyze block pins for
// the same input — one validator and one error table in src, so the same
// literals here, never re-derived.
describe("server: classify_signals", () => {
  const activeFixtures: FixtureTree[] = [];
  const lockedDirectories: string[] = [];

  // Creates a fixture tree registered for afterEach cleanup; returns the
  // tree's root path to use as the classify_signals request's root_path.
  async function fixtureTree(files: Readonly<Record<string, string>>): Promise<string> {
    const tree = await createFixtureTree(files);
    activeFixtures.push(tree);
    return tree.root;
  }

  afterEach(async () => {
    // Recursive cleanup cannot descend into a chmod-000 directory, so every
    // locked directory is unlocked before its fixture tree is removed.
    for (const directory of lockedDirectories.splice(0)) {
      await chmod(directory, 0o755);
    }
    await Promise.all(activeFixtures.splice(0).map((tree) => tree.cleanup()));
  });

  // The quickstart tree (specs/003-classify-signals/quickstart.md
  // Section 1) and its 11-row expected feed come from the shared
  // canonical fixture module, tests/helpers/quickstart.ts — one copy
  // asserted at both the pipeline surface (tests/analysis.test.ts) and
  // this dispatch surface, extracted from the former per-suite mirrors by
  // the review council's fixture-duplication finding (dispatch f4e5896a).
  // The expected feed is QUICKSTART_FEED — quickstart Section 4's exact
  // rows, every weight re-derivable from the Section 5 arithmetic.

  it("round-trips a valid classify_signals request", { timeout: 60_000 }, async () => {
    const root = await fixtureTree(quickstartFiles(true));
    const { responses, stderr } = await drive([
      request(50, "classify_signals", { root_path: root }),
    ]);
    expect(responses).toHaveLength(1);
    expect(responses[0]?.jsonrpc).toBe("2.0");
    expect(responses[0]?.id).toBe(50);
    expect(resultSignals(responses[0] ?? {})).toEqual(QUICKSTART_FEED);
    expect(stderr).toBe("");
  });

  it.each([
    ["absent params", undefined],
    ["null params", null],
    ["array params", []],
  ])("rejects %s with -32602", async (_label, params) => {
    const { responses, stderr } = await drive([
      request(51, "classify_signals", params),
    ]);
    expect(errorBody(responses[0] ?? {}).code).toBe(-32602);
    expect(errorBody(responses[0] ?? {}).message).toBe(
      "Invalid params: params must be an object",
    );
    expect(responses[0]?.id).toBe(51);
    expect(stderr).toBe("");
  });

  it.each([
    ["missing root_path", {}],
    ["non-string root_path", { root_path: 42 }],
  ])("rejects %s with -32602", async (_label, params) => {
    const { responses, stderr } = await drive([
      request(52, "classify_signals", params),
    ]);
    expect(errorBody(responses[0] ?? {}).code).toBe(-32602);
    expect(errorBody(responses[0] ?? {}).message).toBe(
      "Invalid params: root_path must be a string",
    );
    expect(responses[0]?.id).toBe(52);
    expect(stderr).toBe("");
  });

  it.each([
    ["non-array patterns", { root_path: "/abs/project", patterns: "src/**/*.ts" }],
    ["number patterns", { root_path: "/abs/project", patterns: 42 }],
    [
      "patterns array with a non-string element",
      { root_path: "/abs/project", patterns: ["src", 7] },
    ],
  ])("rejects %s with -32602", async (_label, params) => {
    const { responses, stderr } = await drive([
      request(53, "classify_signals", params),
    ]);
    expect(errorBody(responses[0] ?? {}).code).toBe(-32602);
    expect(errorBody(responses[0] ?? {}).message).toBe(
      "Invalid params: patterns must be an array of strings",
    );
    expect(responses[0]?.id).toBe(53);
    expect(stderr).toBe("");
  });

  it.each([
    ["an extra key beside root_path", { root_path: "/abs/project", extra: true }],
    [
      "an extra key beside root_path and patterns",
      { root_path: "/abs/project", patterns: ["src/**"], extra: true },
    ],
  ])("rejects %s with -32602", async (_label, params) => {
    const { responses, stderr } = await drive([
      request(54, "classify_signals", params),
    ]);
    expect(errorBody(responses[0] ?? {}).code).toBe(-32602);
    expect(errorBody(responses[0] ?? {}).message).toBe(
      "Invalid params: params must contain only root_path and patterns",
    );
    expect(responses[0]?.id).toBe(54);
    expect(stderr).toBe("");
  });

  it("rejects a nonexistent root_path with -32602", async () => {
    const root = await fixtureTree({});
    const missing = join(root, "does-not-exist");
    const { responses, stderr } = await drive([
      request(55, "classify_signals", { root_path: missing }),
    ]);
    expect(errorBody(responses[0] ?? {}).code).toBe(-32602);
    expect(errorBody(responses[0] ?? {}).message).toBe(
      `Invalid params: root_path is not a directory: ${missing}`,
    );
    expect(responses[0]?.id).toBe(55);
    expect(stderr).toBe("");
  });

  it("rejects a non-directory root_path with -32602", async () => {
    const root = await fixtureTree({ "not-a-dir.ts": "export {};\n" });
    const file = join(root, "not-a-dir.ts");
    const { responses, stderr } = await drive([
      request(56, "classify_signals", { root_path: file }),
    ]);
    expect(errorBody(responses[0] ?? {}).code).toBe(-32602);
    expect(errorBody(responses[0] ?? {}).message).toBe(
      `Invalid params: root_path is not a directory: ${file}`,
    );
    expect(responses[0]?.id).toBe(56);
    expect(stderr).toBe("");
  });

  it.skipIf(runningAsRoot)(
    "rejects an inaccessible root_path with -32602",
    async () => {
      const root = await fixtureTree({
        "locked/nested/a.ts": "export const a = 1;\n",
      });
      const locked = join(root, "locked");
      const nested = join(locked, "nested");
      await chmod(locked, 0o000);
      lockedDirectories.push(locked);
      const { responses, stderr } = await drive([
        request(57, "classify_signals", { root_path: nested }),
      ]);
      expect(errorBody(responses[0] ?? {}).code).toBe(-32602);
      expect(errorBody(responses[0] ?? {}).message).toBe(
        `Invalid params: root_path is not a directory: ${nested}`,
      );
      expect(responses[0]?.id).toBe(57);
      expect(stderr).toBe("");
    },
  );

  it("answers a repeated request with byte-identical response lines", {
    timeout: 60_000,
  }, async () => {
    const root = await fixtureTree(quickstartFiles(true));
    const line = request(58, "classify_signals", { root_path: root });
    const { responses, rawLines, stderr } = await drive([line, line]);
    expect(responses).toHaveLength(2);
    expect(rawLines).toHaveLength(2);
    expect(rawLines[0]).toBe(rawLines[1]);
    expect(responses[0]?.id).toBe(58);
    expect(resultSignals(responses[0] ?? {})).toEqual(QUICKSTART_FEED);
    expect(stderr).toBe("");
  });

  it("answers a pattern set matching nothing with an empty signals array", {
    timeout: 60_000,
  }, async () => {
    // FR-014 / spec edge case: a `patterns` set matching no file is a
    // success — `{"signals": []}` — never an error (the quickstart
    // Section 7 scope check). The tree still carries its tsconfig, so
    // the request genuinely runs the pipeline and answers an empty feed
    // rather than failing early.
    const root = await fixtureTree(quickstartFiles(true));
    const { responses, stderr } = await drive([
      request(59, "classify_signals", { root_path: root, patterns: ["nope"] }),
    ]);
    expect(responses).toHaveLength(1);
    expect(responses[0]?.jsonrpc).toBe("2.0");
    expect(responses[0]?.id).toBe(59);
    expect(resultSignals(responses[0] ?? {})).toEqual([]);
    expect(stderr).toBe("");
  });

  // SC-006 / FR-015: classify_signals is capability-gated from the
  // platform's side (Gaze calls it when and only when the flag is true),
  // so the initialize handshake must advertise it. The literal pin — not
  // `initializeResult()`, which would be tautologically green — makes a
  // flag drift visible through the server wire, mirroring the analyze
  // block's FR-028 pin above; tests/protocol.test.ts (T027) pins the
  // unit output the same way.
  it("advertises classify_signals in the initialize capability response", async () => {
    const { responses } = await drive([INIT]);
    const result = responses[0]?.result as Record<string, unknown> | undefined;
    expect(result?.capabilities).toEqual({
      discover: true,
      test_mapping: true,
      classify_signals: true,
      streaming: false,
      doc_coverage: false,
      cognitive_complexity: false,
    });
  });
});

// The test_mapping result's wire rows, projected to the eight pinned
// fields (004 FR-001; contracts/test-mapping.md Section 6) — WireMapping
// from tests/helpers/wire.js, shared with the pipeline suite. The result
// object must carry exactly one key — `mappings` — so an error response or
// a malformed result fails loud here, never a soft empty match: during the
// red phase (before T020 registered the handler) this surfaced the -32601
// answers as the explicit absence of a result rather than a vacuous pass,
// and any future error answer still fails the same way.
function resultMappings(response: Record<string, unknown>): readonly WireMapping[] {
  const result = (response.result ?? {}) as Record<string, unknown>;
  expect(Object.keys(result).sort()).toEqual(["mappings"]);
  expect(Array.isArray(result.mappings)).toBe(true);
  return (result.mappings as readonly Record<string, unknown>[]).map(
    (row): WireMapping => ({
      test_function: row.test_function as string,
      test_file: row.test_file as string,
      assertion_location: row.assertion_location as string,
      assertion_type: row.assertion_type as string,
      target_function: row.target_function as string,
      target_package: row.target_package as string,
      side_effect_type: row.side_effect_type as string,
      confidence: row.confidence as number,
    }),
  );
}

describe("server: test_mapping", () => {
  const activeFixtures: FixtureTree[] = [];
  const lockedDirectories: string[] = [];

  // Creates a fixture tree registered for afterEach cleanup; returns the
  // tree's root path to use as the test_mapping request's root_path.
  async function fixtureTree(files: Readonly<Record<string, string>>): Promise<string> {
    const tree = await createFixtureTree(files);
    activeFixtures.push(tree);
    return tree.root;
  }

  afterEach(async () => {
    // Recursive cleanup cannot descend into a chmod-000 directory, so every
    // locked directory is unlocked before its fixture tree is removed.
    for (const directory of lockedDirectories.splice(0)) {
      await chmod(directory, 0o755);
    }
    await Promise.all(activeFixtures.splice(0).map((tree) => tree.cleanup()));
  });

  // The canned US1 tree: a tsconfig (program mode — the mapping pipeline
  // boots and disposes a fresh compiler context exactly as the analysis
  // handlers do), one production target, one naming-paired test with a
  // single expect. The expected row is contracts/test-mapping.md
  // Section 3's example shape over this tree — every field auditable in
  // place (SC-001's exact-row discipline). The multi-strategy quickstart
  // tree (75/90/90/80) is US2's golden (T024); US1's dispatch conformance
  // pins the naming-strategy surface.
  const TSCONFIG = '{"compilerOptions": {"strict": true, "target": "ES2022"}}';
  const MAPPING_SOURCES: Readonly<Record<string, string>> = {
    "tsconfig.json": TSCONFIG,
    "src/math.ts":
      "export function add(a: number, b: number): number {\n  return a + b;\n}\n",
    "tests/math.test.ts": [
      'import { add } from "../src/math.js";', // 1
      "", // 2
      'describe("math", () => {', // 3
      '  it("add", () => {', // 4
      "    expect(add(1, 2)).toBe(3);", // 5
      "  });", // 6
      "});", // 7
    ].join("\n"),
  };
  const EXPECTED_MAPPINGS: readonly WireMapping[] = [
    {
      test_function: "math > add",
      test_file: "tests/math.test.ts",
      assertion_location: "tests/math.test.ts:5",
      assertion_type: "equality",
      target_function: "add",
      target_package: "src.math",
      side_effect_type: "ReturnValue",
      confidence: 90,
    },
  ];

  it("round-trips a valid test_mapping request with the exact row set", {
    timeout: 60_000,
  }, async () => {
    const root = await fixtureTree(MAPPING_SOURCES);
    const { responses, stderr } = await drive([
      request(60, "test_mapping", { root_path: root }),
    ]);
    expect(responses).toHaveLength(1);
    expect(responses[0]?.jsonrpc).toBe("2.0");
    expect(responses[0]?.id).toBe(60);
    expect(resultMappings(responses[0] ?? {})).toEqual(EXPECTED_MAPPINGS);
    expect(stderr).toBe("");
  });

  it.each([
    ["absent params", undefined],
    ["null params", null],
    ["array params", []],
  ])("rejects %s with -32602", async (_label, params) => {
    const { responses, stderr } = await drive([request(61, "test_mapping", params)]);
    expect(errorBody(responses[0] ?? {}).code).toBe(-32602);
    expect(errorBody(responses[0] ?? {}).message).toBe(
      "Invalid params: params must be an object",
    );
    expect(responses[0]?.id).toBe(61);
    expect(stderr).toBe("");
  });

  it.each([
    ["missing root_path", {}],
    ["non-string root_path", { root_path: 42 }],
  ])("rejects %s with -32602", async (_label, params) => {
    const { responses, stderr } = await drive([request(62, "test_mapping", params)]);
    expect(errorBody(responses[0] ?? {}).code).toBe(-32602);
    expect(errorBody(responses[0] ?? {}).message).toBe(
      "Invalid params: root_path must be a string",
    );
    expect(responses[0]?.id).toBe(62);
    expect(stderr).toBe("");
  });

  it.each([
    ["non-array patterns", { root_path: "/abs/project", patterns: "src/**/*.ts" }],
    ["number patterns", { root_path: "/abs/project", patterns: 42 }],
    [
      "patterns array with a non-string element",
      { root_path: "/abs/project", patterns: ["src", 7] },
    ],
  ])("rejects %s with -32602", async (_label, params) => {
    const { responses, stderr } = await drive([request(63, "test_mapping", params)]);
    expect(errorBody(responses[0] ?? {}).code).toBe(-32602);
    expect(errorBody(responses[0] ?? {}).message).toBe(
      "Invalid params: patterns must be an array of strings",
    );
    expect(responses[0]?.id).toBe(63);
    expect(stderr).toBe("");
  });

  it.each([
    ["an extra key beside root_path", { root_path: "/abs/project", extra: true }],
    [
      "an extra key beside root_path and patterns",
      { root_path: "/abs/project", patterns: ["src/**"], extra: true },
    ],
  ])("rejects %s with -32602", async (_label, params) => {
    const { responses, stderr } = await drive([request(64, "test_mapping", params)]);
    expect(errorBody(responses[0] ?? {}).code).toBe(-32602);
    expect(errorBody(responses[0] ?? {}).message).toBe(
      "Invalid params: params must contain only root_path and patterns",
    );
    expect(responses[0]?.id).toBe(64);
    expect(stderr).toBe("");
  });

  it("rejects a nonexistent root_path with -32602", async () => {
    const root = await fixtureTree({});
    const missing = join(root, "does-not-exist");
    const { responses, stderr } = await drive([
      request(65, "test_mapping", { root_path: missing }),
    ]);
    expect(errorBody(responses[0] ?? {}).code).toBe(-32602);
    expect(errorBody(responses[0] ?? {}).message).toBe(
      `Invalid params: root_path is not a directory: ${missing}`,
    );
    expect(responses[0]?.id).toBe(65);
    expect(stderr).toBe("");
  });

  it("rejects a non-directory root_path with -32602", async () => {
    const root = await fixtureTree({ "not-a-dir.ts": "export {};\n" });
    const file = join(root, "not-a-dir.ts");
    const { responses, stderr } = await drive([
      request(66, "test_mapping", { root_path: file }),
    ]);
    expect(errorBody(responses[0] ?? {}).code).toBe(-32602);
    expect(errorBody(responses[0] ?? {}).message).toBe(
      `Invalid params: root_path is not a directory: ${file}`,
    );
    expect(responses[0]?.id).toBe(66);
    expect(stderr).toBe("");
  });

  it.skipIf(runningAsRoot)(
    "rejects an inaccessible root_path with -32602",
    async () => {
      const root = await fixtureTree({
        "locked/nested/a.ts": "export const a = 1;\n",
      });
      const locked = join(root, "locked");
      const nested = join(locked, "nested");
      await chmod(locked, 0o000);
      lockedDirectories.push(locked);
      const { responses, stderr } = await drive([
        request(67, "test_mapping", { root_path: nested }),
      ]);
      expect(errorBody(responses[0] ?? {}).code).toBe(-32602);
      expect(errorBody(responses[0] ?? {}).message).toBe(
        `Invalid params: root_path is not a directory: ${nested}`,
      );
      expect(responses[0]?.id).toBe(67);
      expect(stderr).toBe("");
    },
  );

  it("answers a repeated request with byte-identical response lines", {
    timeout: 60_000,
  }, async () => {
    // SC-005 / Constitution I: two full pipeline runs over the same tree
    // produce identical response bytes — no timestamps, no
    // environment-dependent data.
    const root = await fixtureTree(MAPPING_SOURCES);
    const line = request(68, "test_mapping", { root_path: root });
    const { responses, rawLines, stderr } = await drive([line, line]);
    expect(responses).toHaveLength(2);
    expect(rawLines).toHaveLength(2);
    expect(rawLines[0]).toBe(rawLines[1]);
    expect(responses[0]?.id).toBe(68);
    expect(resultMappings(responses[0] ?? {})).toEqual(EXPECTED_MAPPINGS);
    expect(stderr).toBe("");
  });

  it("answers a pattern set matching nothing with an empty mappings array", {
    timeout: 60_000,
  }, async () => {
    // FR-013 / US1-8: a `patterns` set matching no TARGET file is
    // a success — `{"mappings": []}` — never an error (the test arm is
    // never narrowed, but with no targets there are no pairs).
    const root = await fixtureTree(MAPPING_SOURCES);
    const { responses, stderr } = await drive([
      request(69, "test_mapping", { root_path: root, patterns: ["nope"] }),
    ]);
    expect(responses).toHaveLength(1);
    expect(responses[0]?.jsonrpc).toBe("2.0");
    expect(responses[0]?.id).toBe(69);
    expect(resultMappings(responses[0] ?? {})).toEqual([]);
    expect(stderr).toBe("");
  });

  // SC-005 / FR-014: test_mapping is capability-gated from the platform's
  // side (Gaze calls it when and only when the flag is true), so the
  // initialize handshake must advertise it. The literal pin — not
  // `initializeResult()`, which would be tautologically green — makes a
  // flag drift visible through the server wire, mirroring the analyze
  // block's FR-028 pin and the classify_signals pin above;
  // tests/protocol.test.ts (T014) pins the unit output the same way.
  it("advertises test_mapping in the initialize capability response", async () => {
    const { responses } = await drive([INIT]);
    const result = responses[0]?.result as Record<string, unknown> | undefined;
    expect(result?.capabilities).toEqual({
      discover: true,
      test_mapping: true,
      classify_signals: true,
      streaming: false,
      doc_coverage: false,
      cognitive_complexity: false,
    });
  });
});

describe("server: request validation", () => {
  it("answers malformed JSON with -32700 and stays alive", async () => {
    const { responses } = await drive([
      "{not json",
      request(2, "initialize", { root_path: "/abs/project" }),
    ]);
    expect(responses).toHaveLength(2);
    expect(errorBody(responses[0] ?? {}).code).toBe(-32700);
    expect(errorBody(responses[0] ?? {}).message).toBe("Parse error");
    expect(responses[0]?.id).toBeNull();
    expect(responses[1]?.result).toEqual(initializeResult());
  });

  it.each([
    ["missing method", '{"jsonrpc":"2.0","id":4}'],
    ["missing jsonrpc", '{"id":4,"method":"initialize"}'],
    ["wrong jsonrpc version", '{"jsonrpc":"1.0","id":4,"method":"initialize"}'],
  ])("answers %s with -32600 echoing the id", async (_label, line) => {
    const { responses } = await drive([line]);
    expect(errorBody(responses[0] ?? {}).code).toBe(-32600);
    expect(errorBody(responses[0] ?? {}).message).toBe("Invalid Request");
    expect(responses[0]?.id).toBe(4);
  });

  it.each([
    ["json array", "[1,2,3]"],
    ["json string", '"hello"'],
    ["json number", "123"],
    ["json null", "null"],
  ])("answers a %s request with -32600 and null id", async (_label, line) => {
    const { responses } = await drive([line]);
    expect(errorBody(responses[0] ?? {}).code).toBe(-32600);
    expect(responses[0]?.id).toBeNull();
  });

  it("treats invalid id types as null", async () => {
    const { responses } = await drive([
      request(true, "initialize", { root_path: "/abs/project" }),
      request(1.5, "initialize", { root_path: "/abs/project" }),
      request([1], "initialize", { root_path: "/abs/project" }),
    ]);
    for (const response of responses) {
      expect(response.id).toBeNull();
    }
  });

  it("rejects an oversize line with -32600 before parsing and stays alive", async () => {
    const huge = `{"x":"${"a".repeat(16 * 1024 * 1024)}"}`;
    const { responses } = await drive([
      huge,
      request(2, "initialize", { root_path: "/abs/project" }),
    ]);
    expect(errorBody(responses[0] ?? {}).code).toBe(-32600);
    expect(responses[0]?.id).toBeNull();
    expect(responses[1]?.result).toEqual(initializeResult());
  });
});

describe("server: dispatch", () => {
  it("answers an unknown method with -32601", async () => {
    const { responses } = await drive([request(5, "foo/bar")]);
    expect(errorBody(responses[0] ?? {}).code).toBe(-32601);
    expect(errorBody(responses[0] ?? {}).message).toBe("Method not found: foo/bar");
    expect(responses[0]?.id).toBe(5);
  });

  it("truncates the echoed method name to 64 characters", async () => {
    const method = "m".repeat(80);
    const { responses } = await drive([request(5, method)]);
    expect(errorBody(responses[0] ?? {}).message).toBe(
      `Method not found: ${"m".repeat(61)}...`,
    );
  });

  // `discover` is implemented (see "server: discover" above), so it is no
  // longer part of the reserved-but-unimplemented surface (SC-007).
  // `analyze` is pinned by the "server: analyze" block above — those cases
  // stayed red until the handler registered (T019) — so it is dropped here
  // rather than double-pinned as reserved once it landed (FR-028).
  // `complexity` is pinned the same way by the "server: complexity" block
  // — red until T024 registered the handler — and is dropped for the same
  // reason.
  // `coverage` is pinned the same way by the "server: coverage" block
  // — red until T029 registered the handler — and is dropped for the same
  // reason, leaving the FR-028 terminal set.
  // `classify_signals` is pinned the same way by the "server:
  // classify_signals" block above — red until T029/T030 landed the method
  // (adapter entry, then registration with the capability flip) — and is
  // dropped for the same reason.
  // `test_mapping` is pinned the same way by the "server: test_mapping"
  // block above — red until T020 landed registration with the capability
  // flip as one protocol-state unit — and is dropped for the same reason,
  // shrinking the reserved set to spec 004 FR-014's terminal three.
  it.each(["analyze/stream", "doc_coverage", "cognitive_complexity"])(
    "answers reserved method %s with -32601",
    async (method) => {
      const { responses } = await drive([request(6, method)]);
      expect(errorBody(responses[0] ?? {}).code).toBe(-32601);
    },
  );

  it("converts a thrown Error into -32603 with the message", async () => {
    const dispatch = new Map<string, Handler>([
      [
        "boom",
        () => {
          throw new Error("kaboom");
        },
      ],
    ]);
    const { responses, stderr } = await drive([request(9, "boom", null)], dispatch);
    expect(errorBody(responses[0] ?? {}).code).toBe(-32603);
    expect(errorBody(responses[0] ?? {}).message).toBe("kaboom");
    expect(responses[0]?.id).toBe(9);
    expect(stderr).toContain("kaboom");
  });

  it("converts a thrown non-Error into -32603 with String(value)", async () => {
    const dispatch = new Map<string, Handler>([
      [
        "boom",
        () => {
          throw "plain string";
        },
      ],
    ]);
    const { responses, stderr } = await drive([request(9, "boom", null)], dispatch);
    expect(errorBody(responses[0] ?? {}).code).toBe(-32603);
    expect(errorBody(responses[0] ?? {}).message).toBe("plain string");
    expect(stderr).toContain("plain string");
  });

  it("passes RpcError code and message through without stderr noise", async () => {
    const dispatch = new Map<string, Handler>([
      [
        "denied",
        () => {
          throw new RpcError(-32602, "Invalid params: custom");
        },
      ],
    ]);
    const { responses, stderr } = await drive([request(9, "denied", null)], dispatch);
    expect(errorBody(responses[0] ?? {}).code).toBe(-32602);
    expect(errorBody(responses[0] ?? {}).message).toBe("Invalid params: custom");
    expect(stderr).toBe("");
  });
});

describe("server: transport behavior", () => {
  it("ignores empty and whitespace-only lines", async () => {
    const { responses } = await drive(["", "   ", "\t", INIT]);
    expect(responses).toHaveLength(1);
    expect(responses[0]?.result).toEqual(initializeResult());
  });

  it("accepts CRLF line endings", async () => {
    const { responses } = await drive([`${INIT}\r\n`]);
    expect(responses).toHaveLength(1);
    expect(responses[0]?.result).toEqual(initializeResult());
  });

  it("preserves request order", async () => {
    const { responses } = await drive([
      request(1, "initialize", { root_path: "/a" }),
      request(2, "nope"),
      request(3, "initialize", { root_path: "/b" }),
    ]);
    expect(responses.map((r) => r.id)).toEqual([1, 2, 3]);
    expect(responses[1] && errorBody(responses[1]).code).toBe(-32601);
  });

  it("answers shutdown with {} and resolves the run loop", async () => {
    const { responses } = await drive([INIT, request(2, "shutdown")]);
    expect(responses).toHaveLength(2);
    expect(responses[1]?.id).toBe(2);
    expect(responses[1]?.result).toEqual({});
  });

  it("resolves cleanly on EOF without shutdown", async () => {
    const { responses } = await drive([INIT]);
    expect(responses).toHaveLength(1);
  });

  it("treats a throwing stdout write as clean teardown", async () => {
    const err = sink();
    const stdout = new Writable();
    stdout.write = () => {
      throw new Error("broken pipe");
    };
    const server = new Server(
      Readable.from([`${INIT}\n${request(2, "shutdown")}`]),
      stdout,
      err.stream,
    );
    await expect(server.run()).resolves.toBeUndefined();
  });
});
