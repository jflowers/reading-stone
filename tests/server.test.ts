import { Readable, Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { initializeResult } from "../src/protocol.js";
import { type Handler, RpcError, Server } from "../src/server.js";

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
  const responses = out
    .text()
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  return { responses, stderr: err.text() };
}

function errorBody(response: Record<string, unknown>): {
  code: number;
  message: string;
} {
  return (response.error ?? {}) as { code: number; message: string };
}

const INIT = request(1, "initialize", { root_path: "/abs/project" });

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

  it.each([
    "analyze",
    "complexity",
    "coverage",
    "discover",
    "test_mapping",
    "classify_signals",
    "analyze/stream",
    "doc_coverage",
    "cognitive_complexity",
  ])("answers reserved method %s with -32601", async (method) => {
    const { responses } = await drive([request(6, method)]);
    expect(errorBody(responses[0] ?? {}).code).toBe(-32601);
  });

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
