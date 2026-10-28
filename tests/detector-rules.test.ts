// Asserting detector rule suite for the disposition table's detected rows —
// the replacement for the deleted probe files (review dispatch 44e85014,
// Cluster B: "the P2-P4 'detected' disposition rows ... and the P1 rows
// (WriterOutput, HTTPResponseWrite, ChannelSend, ChannelClose, StreamOutput)
// have zero asserting tests anywhere in the suite").
//
// Scope: docs/effect-disposition.md rows with no asserting coverage elsewhere
// — the P1 name-form families (WriterOutput, HTTPResponseWrite, ChannelSend,
// ChannelClose, StreamOutput) and the P2/P3/P4 detected rows (FileSystem*,
// Database*, LogWrite, Stdout/StderrWrite, EnvVarMutation, MonkeyPatch,
// ResourceManagement, AtomicOp, TimeDependency, CgoCall,
// FinalizerRegistration, ContextCancellation, ImportSideEffect,
// MetaprogrammingMutation, DescriptorEffect, AsyncGeneratorYield,
// ClosureCaptureMutation, plus complementary DeferredReturnMutation and
// GeneratorYield arms). DeferredReturnMutation's setTimeout arm,
// GeneratorYield's function-declaration form, and the fr015 param-write
// splits are already pinned by tests/detector.test.ts and are not repeated.
//
// MODE BOUNDARY: this suite drives the public analyze entry over trees with
// NO tsconfig — parse-only mode. The program-mode receiver-typing arms live
// in tests/detector-rules-typed.test.ts; the SliceMutation /
// HTTPResponseWrite / ChannelClose / ContextCancellation program-mode
// receiver-typing edges are deliberately NOT pinned here or there (owned by
// the parallel mode-split delegation).
//
// ASSERTION DISCIPLINE: effects are projected to {type, location, target,
// detail} and compared with toEqual — exact canonical type, exact
// root-relative file:line:col, exact target where research R6.6 pins one
// (writes: the written path as written, the binding name for identifier
// writes), zero extra effects. `description` wording is implementation-
// defined and never asserted. Every family also carries a cheap negative —
// a lookalike that must NOT emit (a read, a shadowed binding, an
// out-of-family receiver) — pinned the same way: zero effects.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createFixtureTree } from "./helpers/fixtures.js";
import {
  analyzeTree,
  expectWireInvariants,
  locatedEffects,
  projectedEffects,
  recordFor,
  type WireRecord,
} from "./helpers/wire.js";

// One fixture per family, each construct on its own line at a known
// indentation, so every location assertion is exact (1-based line:column).
const PARSE_RULES_FILES: Record<string, string> = {
  "writer-output.ts": `export function writeAll(stream: { write(s: string): void }, message: string): void {
  stream.write(message);
  stream.writeLine(message);
  stream.append(message);
}
`,
  "http-response.ts": `export function respond(res: { send(b: string): void }, body: string): void {
  res.send(body);
  res.json({ ok: true });
  res.writeHead(200);
  res.end();
}

export function writeThroughResponse(res: { write(s: string): void }, message: string): void {
  res.write(message);
}

export function sendOnPlainReceiver(writer: { send(s: string): void }, body: string): void {
  writer.send(body);
}
`,
  "channels.ts": `export function sendToPort(port: { postMessage(m: string): void }, message: string): void {
  port.postMessage(message);
}

export function sendFromWindow(message: string): void {
  postMessage(message);
}

export function closePort(port: unknown): void {
  port.close();
}

export function closeWorker(worker: unknown): void {
  worker.close();
}

export function sendOnPort(port: { send(m: string): void }, message: string): void {
  port.send(message);
}
`,
  "stream-output.ts": `export function pipeForward(src: { pipe(d: unknown): void }, dst: unknown): void {
  src.pipe(dst);
}

export function pipelineForward(src: unknown, dst: unknown): void {
  pipeline(src, dst);
}
`,
  "fs-family.ts": `import fs from "node:fs";
import fsp from "node:fs/promises";

export function writeFiles(path: string): void {
  fs.writeFileSync(path, "data");
  fsp.writeFile(path, "data");
  fs.promises.rename(path, "backup");
}

export function deleteEntries(path: string): void {
  fs.unlinkSync(path);
  fs.rmSync(path, { recursive: true });
  fs.rmdirSync(path);
}

export function changeMetadata(path: string): void {
  fs.chmodSync(path, 0o644);
  fs.utimesSync(path, 123, 456);
  fs.mkdirSync(path);
}

export function readEntries(path: string): void {
  fs.readFileSync(path);
  fs.statSync(path);
}

export function shadowedFsBinding(): void {
  const fsp = makeWriter();
  fsp.appendFile("log", "entry");
}
`,
  "database.ts": `export function writeRows(collection: unknown): void {
  collection.insertOne({});
  collection.updateMany({}, {});
  collection.deleteOne({});
  collection.findOneAndUpdate({}, {});
  collection.bulkWrite([]);
}

export function transactRows(session: unknown): void {
  session.beginTransaction();
  session.commit();
  session.rollback();
}

export function readRows(collection: unknown): void {
  collection.findOne({});
}
`,
  "logging.ts": `export function logByName(message: string): void {
  logger.warn(message);
  log.info(message);
}

export function logOnPlainReceiver(target: { info(m: string): void }, message: string): void {
  target.info(message);
}
`,
  "stdio.ts": `export function printOut(message: string): void {
  console.log(message);
  console.info(message);
  console.debug(message);
  console.trace(message);
}

export function printErr(message: string): void {
  console.error(message);
  console.warn(message);
}

export function writeProcessStdio(message: string): void {
  process.stdout.write(message);
  process.stderr.write(message);
}
`,
  "env-writes.ts": `export function setEnv(): void {
  process.env.DEBUG = "1";
}

export function appendEnv(): void {
  process.env.DEBUG += "2";
}

export function deleteEnv(): void {
  delete process.env.DEBUG;
}

export function readEnv(): void {
  const debug = process.env.DEBUG;
}
`,
  "monkeypatch.ts": `import * as helpers from "./helpers-index.js";

export function patchPrototype(): void {
  String.prototype.greet = "hi";
}

export function patchNamespace(): void {
  helpers.extra = 1;
}

export function shadowedNamespace(): void {
  const helpers = { extra: 0 };
  helpers.extra = 2;
}

export function chainedMemberWrite(config: { db: { url: string } }): void {
  config.db.url = "postgres";
}
`,
  "helpers-index.ts": `export const zero = 0;
`,
  "resources.ts": `export function holdResource(): void {
  using handle = acquire();
}

export async function holdAsyncResource(): Promise<void> {
  await using asyncHandle = acquire();
}

export function releaseByClose(handle: { close(): void }): void {
  handle.close();
}

export function releaseByDispose(handle: { dispose(): void }): void {
  handle.dispose();
}

export function plainConstDeclaration(): void {
  const handle = acquire();
}
`,
  "atomics.ts": `export function atomicAdd(buffer: SharedArrayBuffer): void {
  Atomics.add(new Int32Array(buffer), 0, 1);
}

export function atomicStore(buffer: SharedArrayBuffer): void {
  Atomics.store(new Int32Array(buffer), 0, 1);
}
`,
  "clock.ts": `export function readClock(): void {
  Date.now();
  performance.now();
  process.hrtime();
  process.hrtime.bigint();
}

export function makeDate(): Date {
  return new Date();
}

export function clockLookalike(target: { now(): number }): void {
  target.now();
}
`,
  "wasm.ts": `export function instantiateModule(bytes: unknown): void {
  WebAssembly.instantiate(bytes);
}

export function constructModule(bytes: unknown): void {
  new WebAssembly.Instance(bytes);
}
`,
  "finalizers.ts": `export function makeRegistry(): void {
  const registry = new FinalizationRegistry(() => {});
}

export function plainConstruction(): void {
  const marker = new Map();
}

export function registerUntyped(registry: unknown): void {
  registry.register({});
}
`,
  "cancellation.ts": `export function abortWork(controller: unknown): void {
  controller.abort();
}

export function checkAborted(): void {
  AbortSignal.throwIfAborted();
}
`,
  "imports-dynamic.ts": `export function loadLater(name: string): void {
  import(name);
}

export function requireLater(name: string): void {
  require(name);
}
`,
  "metaprogramming.ts": `export function reflectWrites(target: object, key: string): void {
  Reflect.set(target, key, 1);
  Reflect.deleteProperty(target, key);
}

export function defineProp(target: object, key: string): void {
  Object.defineProperty(target, key, { value: 1 });
}
`,
  "async-generators.ts": `export async function* streamIds(): AsyncGenerator<number> {
  yield 1;
  yield* [2, 3];
}

export async function* emptyStream(): AsyncGenerator<number> {
}
`,
  "generators.ts": `export class Numbers {
  values: number[] = [];

  *entries(): Generator<number> {
    yield this.values.length;
  }
}
`,
  "closure-capture.ts": `export function makeAccumulator(): () => void {
  let total = 0;
  const add = (): void => {
    total = total + 1;
  };
  return add;
}
`,
  "deferred.ts": `export function trackLater(promise: { then(cb: () => void): void }): void {
  let total = 0;
  promise.then(() => {
    total = total + 1;
  });
}
`,
  "descriptors.ts": `function sealed(target: unknown): void {}

export function buildDecorated(): unknown {
  @sealed
  class Decorated {
    @sealed
    greet(): string {
      return "hi";
    }
  }
  return new Decorated();
}
`,
};

describe("P1 name-form rule families in parse-only mode (disposition table P1 rows; research R6.4)", () => {
  let root = "";
  let result: readonly WireRecord[] = [];
  let cleanup: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    const tree = await createFixtureTree(PARSE_RULES_FILES);
    cleanup = tree.cleanup;
    root = tree.root;
    const run = await analyzeTree(root);
    result = run.functions;
  }, 120_000);

  afterAll(async () => {
    await cleanup?.();
  });

  it("WriterOutput: write/writeLine/append on a writer-like receiver each emit exactly one effect (name-form row)", () => {
    const record = recordFor(result, "writeAll", "writer-output.ts");
    expect(locatedEffects(record)).toEqual([
      { type: "WriterOutput", location: "writer-output.ts:2:3" },
      { type: "WriterOutput", location: "writer-output.ts:3:3" },
      { type: "WriterOutput", location: "writer-output.ts:4:3" },
    ]);
  });

  it("HTTPResponseWrite: send/json/writeHead/end on a res-named receiver each emit exactly one effect (name-form row)", () => {
    const record = recordFor(result, "respond", "http-response.ts");
    expect(locatedEffects(record)).toEqual([
      { type: "HTTPResponseWrite", location: "http-response.ts:2:3" },
      { type: "HTTPResponseWrite", location: "http-response.ts:3:3" },
      { type: "HTTPResponseWrite", location: "http-response.ts:4:3" },
      { type: "HTTPResponseWrite", location: "http-response.ts:5:3" },
    ]);
  });

  it("WriterOutput exclusion: res.write is claimed by the HTTP family, never WriterOutput (research R6.4 precedence)", () => {
    const record = recordFor(result, "writeThroughResponse", "http-response.ts");
    expect(locatedEffects(record)).toEqual([
      { type: "HTTPResponseWrite", location: "http-response.ts:9:3" },
    ]);
  });

  it("HTTPResponseWrite negative: send on a plain receiver claims nothing", () => {
    const record = recordFor(result, "sendOnPlainReceiver", "http-response.ts");
    expect(projectedEffects(record)).toEqual([]);
  });

  it("ChannelSend: port.postMessage emits at the call (name-form row)", () => {
    const record = recordFor(result, "sendToPort", "channels.ts");
    expect(locatedEffects(record)).toEqual([
      { type: "ChannelSend", location: "channels.ts:2:3" },
    ]);
  });

  it("ChannelSend: the bare postMessage global form emits too (Worker/window spelling)", () => {
    const record = recordFor(result, "sendFromWindow", "channels.ts");
    expect(locatedEffects(record)).toEqual([
      { type: "ChannelSend", location: "channels.ts:6:3" },
    ]);
  });

  it("ChannelSend negative: a port.send call is not a channel send", () => {
    const record = recordFor(result, "sendOnPort", "channels.ts");
    expect(projectedEffects(record)).toEqual([]);
  });

  it("ChannelClose: .close() on port- and worker-named receivers emits ChannelClose (name-form row)", () => {
    const port = recordFor(result, "closePort", "channels.ts");
    expect(locatedEffects(port)).toEqual([
      { type: "ChannelClose", location: "channels.ts:10:3" },
    ]);
    const worker = recordFor(result, "closeWorker", "channels.ts");
    expect(locatedEffects(worker)).toEqual([
      { type: "ChannelClose", location: "channels.ts:14:3" },
    ]);
  });

  it("StreamOutput: .pipe on a stream receiver emits at the call (name-form row)", () => {
    const record = recordFor(result, "pipeForward", "stream-output.ts");
    expect(locatedEffects(record)).toEqual([
      { type: "StreamOutput", location: "stream-output.ts:2:3" },
    ]);
  });

  it("StreamOutput: the bare pipeline(...) global form (node:stream/promises spelling) emits too", () => {
    const record = recordFor(result, "pipelineForward", "stream-output.ts");
    expect(locatedEffects(record)).toEqual([
      { type: "StreamOutput", location: "stream-output.ts:6:3" },
    ]);
  });
});

describe("P2 detected rows in parse-only mode (disposition table partial tier)", () => {
  let result: readonly WireRecord[] = [];
  let cleanup: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    const tree = await createFixtureTree(PARSE_RULES_FILES);
    cleanup = tree.cleanup;
    const run = await analyzeTree(tree.root);
    result = run.functions;
  }, 120_000);

  afterAll(async () => {
    await cleanup?.();
  });

  it("FileSystemWrite: sync, promises-import, and .promises-chain spellings each emit exactly one effect", () => {
    const record = recordFor(result, "writeFiles", "fs-family.ts");
    expect(locatedEffects(record)).toEqual([
      { type: "FileSystemWrite", location: "fs-family.ts:5:3" },
      { type: "FileSystemWrite", location: "fs-family.ts:6:3" },
      { type: "FileSystemWrite", location: "fs-family.ts:7:3" },
    ]);
  });

  it("FileSystemDelete: unlink/rm/rmdir spellings each emit exactly one effect", () => {
    const record = recordFor(result, "deleteEntries", "fs-family.ts");
    expect(locatedEffects(record)).toEqual([
      { type: "FileSystemDelete", location: "fs-family.ts:11:3" },
      { type: "FileSystemDelete", location: "fs-family.ts:12:3" },
      { type: "FileSystemDelete", location: "fs-family.ts:13:3" },
    ]);
  });

  it("FileSystemMeta: chmod/utimes/mkdir spellings each emit exactly one effect", () => {
    const record = recordFor(result, "changeMetadata", "fs-family.ts");
    expect(locatedEffects(record)).toEqual([
      { type: "FileSystemMeta", location: "fs-family.ts:17:3" },
      { type: "FileSystemMeta", location: "fs-family.ts:18:3" },
      { type: "FileSystemMeta", location: "fs-family.ts:19:3" },
    ]);
  });

  it("FileSystem negative: reads (readFile/stat) claim nothing — stat is deliberately unmapped", () => {
    const record = recordFor(result, "readEntries", "fs-family.ts");
    expect(projectedEffects(record)).toEqual([]);
  });

  it("FileSystem negative: a function-scope local shadowing an imported fs binding is not an fs receiver", () => {
    const record = recordFor(result, "shadowedFsBinding", "fs-family.ts");
    expect(projectedEffects(record)).toEqual([]);
  });

  it("static imports carry no ImportSideEffect — module-level imports have no carrier record (Assumption 11)", () => {
    const staticImportFiles = ["fs-family.ts", "monkeypatch.ts"];
    const types = result
      .filter((record) => staticImportFiles.includes(record.file))
      .flatMap((record) => record.side_effects.map((effect) => effect.type));
    expect(types).not.toContain("ImportSideEffect");
  });

  it("DatabaseWrite: the five write name-forms on any receiver each emit exactly one effect (documented FP surface)", () => {
    const record = recordFor(result, "writeRows", "database.ts");
    expect(locatedEffects(record)).toEqual([
      { type: "DatabaseWrite", location: "database.ts:2:3" },
      { type: "DatabaseWrite", location: "database.ts:3:3" },
      { type: "DatabaseWrite", location: "database.ts:4:3" },
      { type: "DatabaseWrite", location: "database.ts:5:3" },
      { type: "DatabaseWrite", location: "database.ts:6:3" },
    ]);
  });

  it("DatabaseWrite negative: findOne is a read and claims nothing", () => {
    const record = recordFor(result, "readRows", "database.ts");
    expect(projectedEffects(record)).toEqual([]);
  });

  it("DatabaseTransaction: beginTransaction/commit/rollback each emit exactly one effect", () => {
    const record = recordFor(result, "transactRows", "database.ts");
    expect(locatedEffects(record)).toEqual([
      { type: "DatabaseTransaction", location: "database.ts:10:3" },
      { type: "DatabaseTransaction", location: "database.ts:11:3" },
      { type: "DatabaseTransaction", location: "database.ts:12:3" },
    ]);
  });

  it("LogWrite: logger.warn and log.info name-form receivers each emit exactly one effect", () => {
    const record = recordFor(result, "logByName", "logging.ts");
    expect(locatedEffects(record)).toEqual([
      { type: "LogWrite", location: "logging.ts:2:3" },
      { type: "LogWrite", location: "logging.ts:3:3" },
    ]);
  });

  it("LogWrite negative: info on a receiver that is neither log nor logger claims nothing", () => {
    const record = recordFor(result, "logOnPlainReceiver", "logging.ts");
    expect(projectedEffects(record)).toEqual([]);
  });

  it("ContextCancellation: .abort() emits at the call (name-form row)", () => {
    const record = recordFor(result, "abortWork", "cancellation.ts");
    expect(locatedEffects(record)).toEqual([
      { type: "ContextCancellation", location: "cancellation.ts:2:3" },
    ]);
  });

  it("ContextCancellation: the static AbortSignal.throwIfAborted() form emits too", () => {
    const record = recordFor(result, "checkAborted", "cancellation.ts");
    expect(locatedEffects(record)).toEqual([
      { type: "ContextCancellation", location: "cancellation.ts:6:3" },
    ]);
  });

  it("AsyncGeneratorYield: yield and yield* inside an async generator each emit one effect at the yield", () => {
    const record = recordFor(result, "streamIds", "async-generators.ts");
    expect(locatedEffects(record)).toEqual([
      { type: "AsyncGeneratorYield", location: "async-generators.ts:2:3" },
      { type: "AsyncGeneratorYield", location: "async-generators.ts:3:3" },
    ]);
  });

  it("AsyncGeneratorYield negative: an async generator with no yields reports no effects", () => {
    const record = recordFor(result, "emptyStream", "async-generators.ts");
    expect(projectedEffects(record)).toEqual([]);
  });

  it("MetaprogrammingMutation: Reflect.set and Reflect.deleteProperty each emit one effect — never ContainerMutation (research R6.4 precedence)", () => {
    const record = recordFor(result, "reflectWrites", "metaprogramming.ts");
    expect(locatedEffects(record)).toEqual([
      { type: "MetaprogrammingMutation", location: "metaprogramming.ts:2:3" },
      { type: "MetaprogrammingMutation", location: "metaprogramming.ts:3:3" },
    ]);
  });

  it("MetaprogrammingMutation: Object.defineProperty emits one effect", () => {
    const record = recordFor(result, "defineProp", "metaprogramming.ts");
    expect(locatedEffects(record)).toEqual([
      { type: "MetaprogrammingMutation", location: "metaprogramming.ts:7:3" },
    ]);
  });

  it("DescriptorEffect: a class decorator and a member decorator inside a function body each emit at the decorator", () => {
    const record = recordFor(result, "buildDecorated", "descriptors.ts");
    expect(record.line).toBe(3);
    expect(locatedEffects(record)).toEqual([
      { type: "DescriptorEffect", location: "descriptors.ts:4:3" },
      { type: "DescriptorEffect", location: "descriptors.ts:6:5" },
      { type: "ReturnValue", location: "descriptors.ts:11:3" },
    ]);
    // The decorated method's own record is separate (FR-009) and carries only
    // its own return — the decorator itself never lands on the method.
    const greet = recordFor(result, "greet", "descriptors.ts");
    expect(locatedEffects(greet)).toEqual([
      { type: "ReturnValue", location: "descriptors.ts:8:7" },
    ]);
  });

  it("ResourceManagement: a using declaration emits at the statement (declaration arm)", () => {
    const record = recordFor(result, "holdResource", "resources.ts");
    expect(locatedEffects(record)).toEqual([
      { type: "ResourceManagement", location: "resources.ts:2:3" },
    ]);
  });

  it("ResourceManagement: the await using declaration form emits too", () => {
    const record = recordFor(result, "holdAsyncResource", "resources.ts");
    expect(locatedEffects(record)).toEqual([
      { type: "ResourceManagement", location: "resources.ts:6:3" },
    ]);
  });

  it("ResourceManagement: .close() on a non-channel receiver is a resource release — below ChannelClose in precedence (research R6.4)", () => {
    const record = recordFor(result, "releaseByClose", "resources.ts");
    expect(locatedEffects(record)).toEqual([
      { type: "ResourceManagement", location: "resources.ts:10:3" },
    ]);
  });

  it("ResourceManagement: the .dispose() name-form emits at the call", () => {
    const record = recordFor(result, "releaseByDispose", "resources.ts");
    expect(locatedEffects(record)).toEqual([
      { type: "ResourceManagement", location: "resources.ts:14:3" },
    ]);
  });

  it("ResourceManagement negative: a const declaration is not a using-scoped resource", () => {
    const record = recordFor(result, "plainConstDeclaration", "resources.ts");
    expect(projectedEffects(record)).toEqual([]);
  });

  it("ImportSideEffect: a dynamic import(...) inside a function body emits at the call", () => {
    const record = recordFor(result, "loadLater", "imports-dynamic.ts");
    expect(locatedEffects(record)).toEqual([
      { type: "ImportSideEffect", location: "imports-dynamic.ts:2:3" },
    ]);
  });

  it("ImportSideEffect: a require(...) call inside a function body emits too", () => {
    const record = recordFor(result, "requireLater", "imports-dynamic.ts");
    expect(locatedEffects(record)).toEqual([
      { type: "ImportSideEffect", location: "imports-dynamic.ts:6:3" },
    ]);
  });

  it("MonkeyPatch: an X.prototype.* write targets the written path (research R6.6) and takes precedence over GlobalMutation", () => {
    const record = recordFor(result, "patchPrototype", "monkeypatch.ts");
    expect(projectedEffects(record)).toEqual([
      {
        type: "MonkeyPatch",
        location: "monkeypatch.ts:4:3",
        target: "String.prototype.greet",
      },
    ]);
  });

  it("MonkeyPatch: a property write on an imported namespace object targets the written path", () => {
    const record = recordFor(result, "patchNamespace", "monkeypatch.ts");
    expect(projectedEffects(record)).toEqual([
      {
        type: "MonkeyPatch",
        location: "monkeypatch.ts:8:3",
        target: "helpers.extra",
      },
    ]);
  });

  it("MonkeyPatch negative: a function-scope local shadowing the namespace keeps its own classification", () => {
    const record = recordFor(result, "shadowedNamespace", "monkeypatch.ts");
    expect(projectedEffects(record)).toEqual([]);
  });

  it("MonkeyPatch negative: a chained member write (config.db.url) is the documented method-form boundary and claims nothing", () => {
    const record = recordFor(result, "chainedMemberWrite", "monkeypatch.ts");
    expect(projectedEffects(record)).toEqual([]);
  });
});

describe("P3/P4 detected rows in parse-only mode (disposition table best-effort tier)", () => {
  let result: readonly WireRecord[] = [];
  let cleanup: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    const tree = await createFixtureTree(PARSE_RULES_FILES);
    cleanup = tree.cleanup;
    const run = await analyzeTree(tree.root);
    result = run.functions;
  }, 120_000);

  afterAll(async () => {
    await cleanup?.();
  });

  it("StdoutWrite: console.log/info/debug/trace each emit exactly one effect", () => {
    const record = recordFor(result, "printOut", "stdio.ts");
    expect(locatedEffects(record)).toEqual([
      { type: "StdoutWrite", location: "stdio.ts:2:3" },
      { type: "StdoutWrite", location: "stdio.ts:3:3" },
      { type: "StdoutWrite", location: "stdio.ts:4:3" },
      { type: "StdoutWrite", location: "stdio.ts:5:3" },
    ]);
  });

  it("StderrWrite: console.error/warn each emit exactly one effect", () => {
    const record = recordFor(result, "printErr", "stdio.ts");
    expect(locatedEffects(record)).toEqual([
      { type: "StderrWrite", location: "stdio.ts:9:3" },
      { type: "StderrWrite", location: "stdio.ts:10:3" },
    ]);
  });

  it("stdio exclusion: process.stdout.write and process.stderr.write are Stdout/StderrWrite — never WriterOutput (research R6.4)", () => {
    const record = recordFor(result, "writeProcessStdio", "stdio.ts");
    expect(locatedEffects(record)).toEqual([
      { type: "StdoutWrite", location: "stdio.ts:14:3" },
      { type: "StderrWrite", location: "stdio.ts:15:3" },
    ]);
  });

  it("EnvVarMutation: assignment to process.env.X targets the written path (research R6.6)", () => {
    const record = recordFor(result, "setEnv", "env-writes.ts");
    expect(projectedEffects(record)).toEqual([
      {
        type: "EnvVarMutation",
        location: "env-writes.ts:2:3",
        target: "process.env.DEBUG",
      },
    ]);
  });

  it("EnvVarMutation: the compound assignment form", () => {
    const record = recordFor(result, "appendEnv", "env-writes.ts");
    expect(projectedEffects(record)).toEqual([
      {
        type: "EnvVarMutation",
        location: "env-writes.ts:6:3",
        target: "process.env.DEBUG",
      },
    ]);
  });

  it("EnvVarMutation: the delete form anchors at the delete expression", () => {
    const record = recordFor(result, "deleteEnv", "env-writes.ts");
    expect(projectedEffects(record)).toEqual([
      {
        type: "EnvVarMutation",
        location: "env-writes.ts:10:3",
        target: "process.env.DEBUG",
      },
    ]);
  });

  it("EnvVarMutation negative: reading process.env.X into a local is not a mutation", () => {
    const record = recordFor(result, "readEnv", "env-writes.ts");
    expect(projectedEffects(record)).toEqual([]);
  });

  it("AtomicOp: Atomics.add emits exactly one effect — the nested Int32Array construction stays inert (research R6.4 precedence over membership add)", () => {
    const record = recordFor(result, "atomicAdd", "atomics.ts");
    expect(locatedEffects(record)).toEqual([
      { type: "AtomicOp", location: "atomics.ts:2:3" },
    ]);
  });

  it("AtomicOp: Atomics.store emits too", () => {
    const record = recordFor(result, "atomicStore", "atomics.ts");
    expect(locatedEffects(record)).toEqual([
      { type: "AtomicOp", location: "atomics.ts:6:3" },
    ]);
  });

  it("TimeDependency: Date.now, performance.now, process.hrtime, and process.hrtime.bigint each emit one effect", () => {
    const record = recordFor(result, "readClock", "clock.ts");
    expect(locatedEffects(record)).toEqual([
      { type: "TimeDependency", location: "clock.ts:2:3" },
      { type: "TimeDependency", location: "clock.ts:3:3" },
      { type: "TimeDependency", location: "clock.ts:4:3" },
      { type: "TimeDependency", location: "clock.ts:5:3" },
    ]);
  });

  it("TimeDependency: new Date() inside a return pairs with the record's own ReturnValue, anchored at the construction", () => {
    const record = recordFor(result, "makeDate", "clock.ts");
    expect(locatedEffects(record)).toEqual([
      { type: "ReturnValue", location: "clock.ts:9:3" },
      { type: "TimeDependency", location: "clock.ts:9:10" },
    ]);
  });

  it("TimeDependency negative: now() on a receiver that is neither Date nor performance claims nothing", () => {
    const record = recordFor(result, "clockLookalike", "clock.ts");
    expect(projectedEffects(record)).toEqual([]);
  });

  it("CgoCall: WebAssembly.instantiate emits at the call (the WebAssembly FFI surface)", () => {
    const record = recordFor(result, "instantiateModule", "wasm.ts");
    expect(locatedEffects(record)).toEqual([
      { type: "CgoCall", location: "wasm.ts:2:3" },
    ]);
  });

  it("CgoCall: new WebAssembly.Instance emits at the construction", () => {
    const record = recordFor(result, "constructModule", "wasm.ts");
    expect(locatedEffects(record)).toEqual([
      { type: "CgoCall", location: "wasm.ts:6:3" },
    ]);
  });

  it("FinalizerRegistration: the construction form is the parse-only surface, anchored at the construction", () => {
    const record = recordFor(result, "makeRegistry", "finalizers.ts");
    expect(locatedEffects(record)).toEqual([
      { type: "FinalizerRegistration", location: "finalizers.ts:2:20" },
    ]);
  });

  it("FinalizerRegistration negative: a plain Map construction claims nothing", () => {
    const record = recordFor(result, "plainConstruction", "finalizers.ts");
    expect(projectedEffects(record)).toEqual([]);
  });

  it("FinalizerRegistration parse-only boundary: .register on an untyped receiver claims nothing — the typed arm needs the checker (program mode)", () => {
    const record = recordFor(result, "registerUntyped", "finalizers.ts");
    expect(projectedEffects(record)).toEqual([]);
  });

  it("ClosureCaptureMutation: a synchronous write to an enclosing function-scope binding targets the binding name (research R6.6) and never GlobalMutation", () => {
    const add = recordFor(result, "add", "closure-capture.ts");
    expect(add.line).toBe(3);
    expect(projectedEffects(add)).toEqual([
      {
        type: "ClosureCaptureMutation",
        location: "closure-capture.ts:4:5",
        target: "total",
      },
    ]);
    // FR-009: the enclosing record carries only its own return, never the
    // nested extracted record's closure write.
    const outer = recordFor(result, "makeAccumulator", "closure-capture.ts");
    expect(projectedEffects(outer)).toEqual([
      { type: "ReturnValue", location: "closure-capture.ts:6:3" },
    ]);
  });

  it("DeferredReturnMutation: a write to an enclosing binding from inside a .then continuation is deferred (research R6.5 promise arm)", () => {
    const record = recordFor(result, "trackLater", "deferred.ts");
    expect(projectedEffects(record)).toEqual([
      {
        type: "DeferredReturnMutation",
        location: "deferred.ts:4:5",
        target: "total",
      },
    ]);
  });

  it("GeneratorYield: a generator class method's yield emits on the method's own record (FR-009 attribution)", () => {
    const record = recordFor(result, "entries", "generators.ts");
    expect(record.line).toBe(4);
    expect(locatedEffects(record)).toEqual([
      { type: "GeneratorYield", location: "generators.ts:5:5" },
    ]);
  });
});

describe("wire shape and determinism over the rules tree (FR-018, FR-019, FR-020, SC-006)", () => {
  let root = "";
  let result: readonly WireRecord[] = [];
  let stderr: () => string = () => "";
  let cleanup: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    const tree = await createFixtureTree(PARSE_RULES_FILES);
    cleanup = tree.cleanup;
    root = tree.root;
    const run = await analyzeTree(root);
    result = run.functions;
    stderr = run.stderr;
  }, 120_000);

  afterAll(async () => {
    await cleanup?.();
  });

  it("canonical types, no classification, key sets, and both documented orders hold over every record", () => {
    expectWireInvariants(result);
  });

  it("a clean tree writes no stderr diagnostics", () => {
    expect(stderr()).toBe("");
  });

  it("repeated analysis of the same tree produces identical serialized records", {
    timeout: 120_000,
  }, async () => {
    const again = await analyzeTree(root);
    expect(JSON.stringify(again.functions)).toBe(JSON.stringify(result));
    expect(again.stderr()).toBe("");
  });
});
