export const PARSE_ERROR = -32700;
export const INVALID_REQUEST = -32600;
export const METHOD_NOT_FOUND = -32601;
export const INVALID_PARAMS = -32602;
export const INTERNAL_ERROR = -32603;

export const PROTOCOL_VERSION = "1.2.0";
export const ANALYZER_NAME = "reading-stone";
export const LANGUAGE = "typescript";

export type JsonRpcId = number | string | null;

export interface JsonRpcRequest {
  jsonrpc: string;
  id: JsonRpcId;
  method: string;
  params: object | null;
}

export interface JsonRpcSuccess {
  jsonrpc: string;
  id: JsonRpcId;
  result: object | null;
}

export interface JsonRpcErrorBody {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcError {
  jsonrpc: string;
  id: JsonRpcId;
  error: JsonRpcErrorBody;
}

export type JsonRpcResponse = JsonRpcSuccess | JsonRpcError;

export interface Capabilities {
  discover: boolean;
  test_mapping: boolean;
  classify_signals: boolean;
  streaming: boolean;
  doc_coverage: boolean;
  cognitive_complexity: boolean;
}

export interface InitializeResult {
  analyzer_name: string;
  language: string;
  language_version: string;
  protocol_version: string;
  capabilities: Capabilities;
}

/**
 * The `doc_coverage` result shape (spec 005 FR-001): a single `symbols`
 * key holding the serialized symbol rows — exactly one key, with an empty
 * analysis a `{"symbols": []}` success rather than an error (US1 scenario
 * 6). plan.md pins both new methods' result interfaces here in
 * protocol.ts, following the `ClassifySignalsResult`/`TestMappingResult`
 * one-key envelope pattern.
 *
 * The pin is load-bearing end to end: the `docCoverage` entry
 * (src/doc-coverage.ts) returns this interface's `symbols` payload and
 * the server handler constructs its wrapper against this interface, so
 * the `{"symbols": [...]}` wire shape is compile-time enforced rather
 * than merely declared (spec 005 FR-012).
 */
export interface DocCoverageResult {
  /** The serialized SymbolRow wire records, in (file, line, name) order. */
  readonly symbols: readonly Record<string, unknown>[];
}

/**
 * The `cognitive_complexity` result shape (spec 005 FR-005): a single
 * `functions` key holding the serialized cognitive rows — exactly one key,
 * with an empty analysis a `{"functions": []}` success rather than an error
 * (US2 scenario 3). plan.md pins both new methods' result interfaces here in
 * protocol.ts, following the `ClassifySignalsResult`/`TestMappingResult`
 * one-key envelope pattern.
 *
 * The pin is load-bearing end to end: the `cognitiveComplexity` entry
 * (src/cognitive.ts) returns this interface's `functions` payload and the
 * server handler constructs its wrapper against this interface, so the
 * `{"functions": [...]}` wire shape is compile-time enforced rather than
 * merely declared (spec 005 FR-012).
 */
export interface CognitiveComplexityResult {
  /** The serialized CognitiveRow wire records, in (file, line, name) order. */
  readonly functions: readonly Record<string, unknown>[];
}

export function normalizeId(value: unknown): JsonRpcId {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" && Number.isInteger(value)) {
    return value;
  }
  return null;
}

export function successResponse(id: JsonRpcId, result: object | null): JsonRpcSuccess {
  return { jsonrpc: "2.0", id, result };
}

export function errorResponse(
  id: JsonRpcId,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcError {
  const body: JsonRpcErrorBody =
    data === null || data === undefined ? { code, message } : { code, message, data };
  return { jsonrpc: "2.0", id, error: body };
}

export function initializeResult(): InitializeResult {
  return {
    analyzer_name: ANALYZER_NAME,
    language: LANGUAGE,
    language_version: process.versions.node,
    protocol_version: PROTOCOL_VERSION,
    capabilities: {
      discover: true,
      // test_mapping flipped true with the src/server.ts dispatch
      // registration in one protocol-state unit (T020, FR-014): no
      // commit advertises a capability the dispatch table lacks.
      test_mapping: true,
      classify_signals: true,
      streaming: false,
      // doc_coverage flipped true with the src/server.ts dispatch
      // registration in one protocol-state unit (T009, spec 005
      // FR-013): no commit advertises a capability the dispatch table
      // lacks. The capabilities object is the single source of truth
      // for method availability.
      doc_coverage: true,
      // cognitive_complexity flipped true with the src/server.ts dispatch
      // registration in one protocol-state unit (T017, spec 005
      // FR-013): no commit advertises a capability the dispatch table
      // lacks. With both v1.2.0 methods registered, the reserved -32601
      // set is exactly analyze/stream — only streaming remains false.
      cognitive_complexity: true,
    },
  };
}

export function shutdownResult(): Record<string, never> {
  return {};
}

function sortedValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortedValue);
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      out[key] = sortedValue(record[key]);
    }
    return out;
  }
  return value;
}

export function serialize(value: unknown): string {
  return JSON.stringify(sortedValue(value));
}
