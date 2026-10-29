import { describe, expect, it } from "vitest";
import {
  ANALYZER_NAME,
  errorResponse,
  INTERNAL_ERROR,
  INVALID_PARAMS,
  INVALID_REQUEST,
  initializeResult,
  type JsonRpcRequest,
  LANGUAGE,
  METHOD_NOT_FOUND,
  normalizeId,
  PARSE_ERROR,
  PROTOCOL_VERSION,
  serialize,
  shutdownResult,
  successResponse,
} from "../src/protocol.js";

describe("error code constants", () => {
  it("pins the JSON-RPC 2.0 standard codes", () => {
    expect(PARSE_ERROR).toBe(-32700);
    expect(INVALID_REQUEST).toBe(-32600);
    expect(METHOD_NOT_FOUND).toBe(-32601);
    expect(INVALID_PARAMS).toBe(-32602);
    expect(INTERNAL_ERROR).toBe(-32603);
  });
});

describe("envelope serialization", () => {
  it("round-trips a request with the exact keys", () => {
    const request: JsonRpcRequest = {
      jsonrpc: "2.0",
      id: 7,
      method: "initialize",
      params: { root_path: "/abs/project" },
    };
    const parsed = JSON.parse(serialize(request));
    expect(Object.keys(parsed).sort()).toEqual(["id", "jsonrpc", "method", "params"]);
    expect(parsed).toEqual(request);
  });

  it("preserves the falsy id 0", () => {
    const parsed = JSON.parse(serialize(successResponse(0, shutdownResult())));
    expect(parsed.id).toBe(0);
  });

  it("preserves string ids", () => {
    const parsed = JSON.parse(serialize(successResponse("abc", shutdownResult())));
    expect(parsed.id).toBe("abc");
  });

  it("serializes a success envelope", () => {
    const parsed = JSON.parse(serialize(successResponse(3, { answer: 42 }))) as Record<
      string,
      unknown
    >;
    expect(parsed.jsonrpc).toBe("2.0");
    expect(parsed.id).toBe(3);
    expect(parsed.result).toEqual({ answer: 42 });
  });

  it("serializes a nested error body with data", () => {
    const parsed = JSON.parse(
      serialize(errorResponse(5, INVALID_REQUEST, "nope", { detail: "x" })),
    ) as {
      jsonrpc: string;
      id: number;
      error: { code: number; message: string; data: unknown };
    };
    expect(parsed.jsonrpc).toBe("2.0");
    expect(parsed.id).toBe(5);
    expect(parsed.error.code).toBe(-32600);
    expect(parsed.error.message).toBe("nope");
    expect(parsed.error.data).toEqual({ detail: "x" });
  });

  it("omits the data key when data is undefined", () => {
    const parsed = JSON.parse(serialize(errorResponse(5, INVALID_REQUEST, "nope"))) as {
      error: Record<string, unknown>;
    };
    expect("data" in parsed.error).toBe(false);
  });

  it("omits the data key when data is null", () => {
    const parsed = JSON.parse(
      serialize(errorResponse(5, INVALID_REQUEST, "nope", null)),
    ) as { error: Record<string, unknown> };
    expect("data" in parsed.error).toBe(false);
  });

  it("sorts object keys at every nesting level", () => {
    expect(serialize({ b: 1, a: { d: 4, c: 3 } })).toBe('{"a":{"c":3,"d":4},"b":1}');
  });

  it("leaves arrays ordered", () => {
    expect(serialize({ b: [3, 1, 2] })).toBe('{"b":[3,1,2]}');
  });
});

describe("normalizeId", () => {
  it("echoes integers including zero", () => {
    expect(normalizeId(0)).toBe(0);
    expect(normalizeId(41)).toBe(41);
  });

  it("echoes strings", () => {
    expect(normalizeId("abc")).toBe("abc");
    expect(normalizeId("")).toBe("");
  });

  it("treats non-string non-integer ids as null", () => {
    expect(normalizeId(true)).toBeNull();
    expect(normalizeId(1.5)).toBeNull();
    expect(normalizeId([1, 2])).toBeNull();
    expect(normalizeId({ id: 1 })).toBeNull();
    expect(normalizeId(null)).toBeNull();
    expect(normalizeId(undefined)).toBeNull();
  });
});

describe("initialize result", () => {
  it("returns the exact field set", () => {
    const result = initializeResult();
    expect(Object.keys(result).sort()).toEqual([
      "analyzer_name",
      "capabilities",
      "language",
      "language_version",
      "protocol_version",
    ]);
    expect(result.analyzer_name).toBe("reading-stone");
    expect(result.analyzer_name).toBe(ANALYZER_NAME);
    expect(result.language).toBe("typescript");
    expect(result.language).toBe(LANGUAGE);
    expect(result.protocol_version).toBe("1.2.0");
    expect(result.protocol_version).toBe(PROTOCOL_VERSION);
  });

  it("reports the running node version", () => {
    expect(initializeResult().language_version).toBe(process.versions.node);
  });

  it("exposes exactly six capability flags, discover and classify_signals true", () => {
    const capabilities = initializeResult().capabilities;
    expect(Object.keys(capabilities).sort()).toEqual([
      "classify_signals",
      "cognitive_complexity",
      "discover",
      "doc_coverage",
      "streaming",
      "test_mapping",
    ]);
    expect(capabilities.discover).toBe(true);
    expect(capabilities.classify_signals).toBe(true);
    expect(capabilities.test_mapping).toBe(false);
    expect(capabilities.streaming).toBe(false);
    expect(capabilities.doc_coverage).toBe(false);
    expect(capabilities.cognitive_complexity).toBe(false);
  });

  it("serializes the initialize handshake to pinned golden bytes", () => {
    const expected =
      `{"id":1,"jsonrpc":"2.0","result":{"analyzer_name":"reading-stone",` +
      `"capabilities":{"classify_signals":true,"cognitive_complexity":false,` +
      `"discover":true,"doc_coverage":false,"streaming":false,"test_mapping":false},` +
      `"language":"typescript","language_version":"${process.versions.node}",` +
      `"protocol_version":"1.2.0"}}`;
    expect(serialize(successResponse(1, initializeResult()))).toBe(expected);
  });
});

describe("shutdown result", () => {
  it("returns an empty object", () => {
    expect(shutdownResult()).toEqual({});
  });
});
