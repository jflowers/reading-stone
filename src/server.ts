import readline from "node:readline";
import type { Readable, Writable } from "node:stream";
import { analyze } from "./analysis.js";
import { computeComplexity } from "./complexity.js";
import { parseCoverage } from "./coverage.js";
import { discover, InvalidRootPathError } from "./discovery.js";
import {
  errorResponse,
  INTERNAL_ERROR,
  INVALID_PARAMS,
  INVALID_REQUEST,
  initializeResult,
  type JsonRpcResponse,
  METHOD_NOT_FOUND,
  normalizeId,
  PARSE_ERROR,
  serialize,
  shutdownResult,
  successResponse,
} from "./protocol.js";
import { classifySignals } from "./signals/adapter.js";

export class RpcError extends Error {
  readonly code: number;

  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

export type Handler = (params: object | null) => object | Promise<object>;

const MAX_LINE_CHARS = 16 * 1024 * 1024;
const MAX_METHOD_ECHO = 64;

function truncateMethodEcho(method: string): string {
  if (method.length <= MAX_METHOD_ECHO) {
    return method;
  }
  return `${method.slice(0, MAX_METHOD_ECHO - 3)}...`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Validates that JSON-RPC `params` is a JSON object — not absent,
 * `null`, or an array — and returns it as a record. Shared by every
 * params-carrying method (initialize, discover, and the analysis
 * methods) so the pinned message lives in exactly one place (FR-027).
 *
 * @param params The raw `params` value from the request envelope.
 * @returns The params object as a string-keyed record.
 * @throws RpcError `-32602` when params is absent, `null`, or an array.
 */
function requireParamsObject(params: object | null): Record<string, unknown> {
  if (params === null || Array.isArray(params) || typeof params !== "object") {
    throw new RpcError(INVALID_PARAMS, "Invalid params: params must be an object");
  }
  return params as Record<string, unknown>;
}

/**
 * Validates that `root_path` is present and a string. Shared by every
 * root-accepting method, always after `requireParamsObject` (FR-027).
 *
 * @param record The already-validated params record.
 * @returns The root path exactly as the request carried it.
 * @throws RpcError `-32602` when `root_path` is missing or not a string.
 */
function requireRootPath(record: Record<string, unknown>): string {
  const rootPath = record.root_path;
  if (typeof rootPath !== "string") {
    throw new RpcError(INVALID_PARAMS, "Invalid params: root_path must be a string");
  }
  return rootPath;
}

/**
 * The validated analysis-params shape (FR-027) shared by the analyze,
 * complexity, and coverage handlers.
 */
interface AnalysisParams {
  /** The request's `root_path`, exactly as carried. */
  readonly rootPath: string;
  /** The request's raw `patterns` value: `undefined`, `null`, or `string[]`. */
  readonly patterns: unknown;
}

/**
 * Validates the shared analysis-params surface (FR-027; research R12):
 * params must be an object carrying a string `root_path`, an optional
 * `patterns` that is `null` or an array of strings, and no other key —
 * checked in that order, with the message strings pinned by the
 * analyze/complexity/coverage contracts' error tables. The `patterns`
 * value passes through raw: normalization (`normalizePatterns`) is the
 * pipeline's concern, validation the dispatch layer's.
 *
 * @param params The raw `params` value from the request envelope.
 * @returns The root path and the raw patterns value.
 * @throws RpcError `-32602` for every params row of the contracts'
 * error tables.
 */
function validateAnalysisParams(params: object | null): AnalysisParams {
  const record = requireParamsObject(params);
  const rootPath = requireRootPath(record);
  const patterns = record.patterns;
  // `null` is a legal whole-tree marker (Pattern rules), so only a
  // non-null non-array or an array with a non-string element violates.
  if (
    patterns !== undefined &&
    patterns !== null &&
    (!Array.isArray(patterns) ||
      patterns.some((element) => typeof element !== "string"))
  ) {
    throw new RpcError(
      INVALID_PARAMS,
      "Invalid params: patterns must be an array of strings",
    );
  }
  for (const key of Object.keys(record)) {
    if (key !== "root_path" && key !== "patterns") {
      throw new RpcError(
        INVALID_PARAMS,
        "Invalid params: params must contain only root_path and patterns",
      );
    }
  }
  return { rootPath, patterns };
}

/**
 * Maps `InvalidRootPathError` — thrown by `resolveRoot` when the root
 * does not exist, is not a directory, or cannot be accessed — to the
 * one `-32602` root message every root-accepting method shares (FR-010;
 * the analyze contract's error table pins the same row). The echoed
 * path is the error's cwd-resolved rootPath — not the realpath form —
 * so the response stays a deterministic function of the request. Every
 * other error maps to `null`: the caller rethrows it so handleLine's
 * catch treats it as an analyzer bug (`-32603` with a stderr stack
 * trace), never a client error.
 *
 * @param error An error thrown from a root-accepting handler body.
 * @returns The shared `-32602` error, or `null` for anything else.
 */
function mapRootPathError(error: unknown): RpcError | null {
  if (!(error instanceof InvalidRootPathError)) {
    return null;
  }
  return new RpcError(
    INVALID_PARAMS,
    `Invalid params: root_path is not a directory: ${error.rootPath}`,
  );
}

export class Server {
  private readonly stdin: Readable;
  private readonly stdout: Writable;
  private readonly stderr: Writable;
  private readonly dispatch: Map<string, Handler>;
  private brokenPipe = false;
  private shuttingDown = false;

  constructor(
    stdin: Readable,
    stdout: Writable,
    stderr: Writable,
    dispatch?: Map<string, Handler>,
  ) {
    this.stdin = stdin;
    this.stdout = stdout;
    this.stderr = stderr;
    this.dispatch = dispatch ?? this.createDefaultDispatch();
  }

  async run(): Promise<void> {
    const rl = readline.createInterface({ input: this.stdin });
    try {
      for await (const line of rl) {
        const text = line.endsWith("\r") ? line.slice(0, -1) : line;
        await this.handleLine(text);
        if (this.brokenPipe || this.shuttingDown) {
          break;
        }
      }
    } finally {
      rl.close();
    }
  }

  private async handleLine(text: string): Promise<void> {
    if (text.trim().length === 0) {
      return;
    }
    if (text.length > MAX_LINE_CHARS) {
      this.writeResponse(errorResponse(null, INVALID_REQUEST, "Invalid Request"));
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      this.writeResponse(errorResponse(null, PARSE_ERROR, "Parse error"));
      return;
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      this.writeResponse(errorResponse(null, INVALID_REQUEST, "Invalid Request"));
      return;
    }
    const request = parsed as Record<string, unknown>;
    const id = normalizeId(request.id);
    if (request.jsonrpc !== "2.0" || typeof request.method !== "string") {
      this.writeResponse(errorResponse(id, INVALID_REQUEST, "Invalid Request"));
      return;
    }
    const method = request.method;
    const params = (request.params ?? null) as object | null;
    const handler = this.dispatch.get(method);
    if (handler === undefined) {
      this.writeResponse(
        errorResponse(
          id,
          METHOD_NOT_FOUND,
          `Method not found: ${truncateMethodEcho(method)}`,
        ),
      );
      return;
    }
    try {
      const result = await handler(params);
      this.writeResponse(successResponse(id, result));
    } catch (error) {
      if (error instanceof RpcError) {
        this.writeResponse(errorResponse(id, error.code, error.message));
        return;
      }
      if (error instanceof Error && error.stack) {
        this.stderr.write(`${error.stack}\n`);
      } else {
        this.stderr.write(`${String(error)}\n`);
      }
      this.writeResponse(errorResponse(id, INTERNAL_ERROR, errorMessage(error)));
    }
  }

  private writeResponse(response: JsonRpcResponse): void {
    try {
      this.stdout.write(`${serialize(response)}\n`);
    } catch {
      this.brokenPipe = true;
    }
  }

  private createDefaultDispatch(): Map<string, Handler> {
    const dispatch = new Map<string, Handler>();
    dispatch.set("initialize", (params) => {
      requireRootPath(requireParamsObject(params));
      return initializeResult();
    });
    dispatch.set("shutdown", () => {
      this.shuttingDown = true;
      return shutdownResult();
    });
    // `discover` (FR-009, FR-019): params must be an object carrying exactly
    // one string `root_path`; the validation order and message strings are
    // pinned by contracts/discover.md's error table and must not drift.
    dispatch.set("discover", async (params) => {
      const record = requireParamsObject(params);
      const rootPath = requireRootPath(record);
      const keys = Object.keys(record);
      if (keys.length !== 1 || keys[0] !== "root_path") {
        throw new RpcError(
          INVALID_PARAMS,
          "Invalid params: params must contain only root_path",
        );
      }
      try {
        // The server's stderr is forwarded (T024) so discover's
        // safe-reader skip diagnostics reach the process stderr — never
        // stdout, which is reserved for JSON-RPC responses (FR-017).
        return await discover(rootPath, this.stderr);
      } catch (error) {
        // Root failures take the shared -32602 message (mapRootPathError);
        // anything else rethrows for handleLine's -32603 mapping.
        throw mapRootPathError(error) ?? error;
      }
    });
    // `analyze` (FR-027, FR-020; contracts/analyze.md error table): the
    // shared analysis-params validation, then the T014 pipeline + T018
    // detector wrapped as `{"functions": [...]}`. The capability
    // response is unchanged — analyze is a core method, not gated
    // behind a capability flag (FR-028).
    dispatch.set("analyze", async (params) => {
      const { rootPath, patterns } = validateAnalysisParams(params);
      try {
        // The pipeline's skip diagnostics flow to the server's stderr —
        // never stdout, which is reserved for JSON-RPC responses
        // (FR-017). The result is already the serialized, wire-shaped
        // record array (T018), so the sorted-key envelope serializer
        // only re-orders keys — repeated requests stay byte-identical
        // (SC-003/SC-006).
        return { functions: await analyze(rootPath, patterns, this.stderr) };
      } catch (error) {
        throw mapRootPathError(error) ?? error;
      }
    });
    // `complexity` (FR-027, FR-022; research R12; contracts/complexity.md
    // error table): the SAME shared analysis-params validation as analyze,
    // then the T014 pipeline + T023 computation wrapped as
    // `{"functions": [...]}`. The capability response is unchanged —
    // complexity is a core method, not gated behind a capability flag
    // (FR-028).
    dispatch.set("complexity", async (params) => {
      const { rootPath, patterns } = validateAnalysisParams(params);
      try {
        // computeComplexity (T023) closes the same prepareAnalysis
        // pipeline (T014) analyze runs, so FR-022's parity is structural.
        // Its result is already the serialized, wire-shaped record array,
        // so the sorted-key envelope serializer only re-orders keys —
        // repeated requests stay byte-identical (SC-003/SC-006). Skip
        // diagnostics flow to the server's stderr, never stdout, which is
        // reserved for JSON-RPC responses (FR-017).
        return { functions: await computeComplexity(rootPath, patterns, this.stderr) };
      } catch (error) {
        throw mapRootPathError(error) ?? error;
      }
    });
    // `coverage` (FR-027, FR-023–FR-026; research R12; contracts/coverage.md
    // error table): the SAME shared analysis-params validation as
    // analyze/complexity, then the T028 Istanbul artifact parser wrapped
    // as `{"functions": [...]}`. The capability response is unchanged —
    // coverage is a core method, not gated behind a capability flag
    // (FR-028).
    dispatch.set("coverage", async (params) => {
      const { rootPath, patterns } = validateAnalysisParams(params);
      try {
        // parseCoverage (T028) returns the serialized, wire-shaped entry
        // array (empty on every degradation-ladder rung, never a
        // JSON-RPC error), so the sorted-key envelope serializer only
        // re-orders keys — repeated requests stay byte-identical
        // (SC-003/SC-006). Skip diagnostics flow to the server's stderr,
        // never stdout, which is reserved for JSON-RPC responses
        // (FR-017).
        return { functions: await parseCoverage(rootPath, patterns, this.stderr) };
      } catch (error) {
        throw mapRootPathError(error) ?? error;
      }
    });
    // `classify_signals` (FR-014/FR-015; research R11; contracts/
    // classify-signals.md error table): the SAME shared analysis-params
    // validation as analyze/complexity/coverage, then the T029 adapter
    // entry — the identical pipeline stages analyze runs, emitting the
    // raw pair-keyed signal feed — wrapped as `{"signals": [...]}`.
    // Unlike the core analysis methods, this one is capability-gated from
    // the platform's side (Gaze calls it when and only when the
    // initialize flag is true, FR-015), so initializeResult() advertises
    // `classify_signals: true` in the same protocol-state unit as this
    // registration — no commit advertises a capability the dispatch table
    // lacks. The method registers unconditionally: no runtime toggle.
    dispatch.set("classify_signals", async (params) => {
      const { rootPath, patterns } = validateAnalysisParams(params);
      try {
        // classifySignals (T029) runs the identical prepareAnalysis →
        // detectEffects → signal-core stages analyze runs (FR-013's
        // one-pipeline guarantee is structural), so the two methods can
        // never disagree about which functions or effects exist. Its
        // result is already the serialized, wire-shaped signal array
        // (T004), so the sorted-key envelope serializer only re-orders
        // keys — repeated requests stay byte-identical (SC-005). Skip
        // diagnostics flow to the server's stderr, never stdout, which
        // is reserved for JSON-RPC responses (FR-017).
        return { signals: await classifySignals(rootPath, patterns, this.stderr) };
      } catch (error) {
        throw mapRootPathError(error) ?? error;
      }
    });
    return dispatch;
  }
}
