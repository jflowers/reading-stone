import readline from "node:readline";
import type { Readable, Writable } from "node:stream";
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
      if (params === null || Array.isArray(params) || typeof params !== "object") {
        throw new RpcError(INVALID_PARAMS, "Invalid params: params must be an object");
      }
      const rootPath = (params as Record<string, unknown>).root_path;
      if (typeof rootPath !== "string") {
        throw new RpcError(
          INVALID_PARAMS,
          "Invalid params: root_path must be a string",
        );
      }
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
      if (params === null || Array.isArray(params) || typeof params !== "object") {
        throw new RpcError(INVALID_PARAMS, "Invalid params: params must be an object");
      }
      const record = params as Record<string, unknown>;
      const rootPath = record.root_path;
      if (typeof rootPath !== "string") {
        throw new RpcError(
          INVALID_PARAMS,
          "Invalid params: root_path must be a string",
        );
      }
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
        // Every root failure (nonexistent, non-directory, inaccessible) maps
        // to one shared -32602 message (FR-010). The path is the error's
        // cwd-resolved rootPath — not the realpath form — so the echoed path
        // is a deterministic function of the request (InvalidRootPathError).
        if (error instanceof InvalidRootPathError) {
          throw new RpcError(
            INVALID_PARAMS,
            `Invalid params: root_path is not a directory: ${error.rootPath}`,
          );
        }
        // Anything else is an analyzer bug, not a client error: rethrow so
        // handleLine's catch maps it to -32603 with a stderr stack trace.
        throw error;
      }
    });
    return dispatch;
  }
}
