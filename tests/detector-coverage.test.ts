import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { analyze } from "../src/analysis.js";
import { createFixtureTree } from "./helpers/fixtures.js";

describe("probe full tree", () => {
  let root = "";
  let cleanup: (() => Promise<void>) | undefined;
  let result: readonly Record<string, unknown>[] = [];

  beforeAll(async () => {
    const tree = await createFixtureTree({
      "fs-family.ts": `import fs from "node:fs";
import fsp from "node:fs/promises";

export function writeSync(path: string): void {
  fs.writeFileSync(path, "data");
}

export function writePromise(path: string): void {
  fsp.writeFile(path, "data");
}

export function renameChain(path: string): void {
  fs.promises.rename(path, "backup");
}

export function appendChain(path: string): void {
  fsp.promises.appendFile(path, "data");
}

export function writeBareFileDescriptor(fd: number): void {
  fs.write(fd, null);
}

export function deleteEntries(path: string): void {
  fs.unlinkSync(path);
  fs.rmdirSync(path);
}

export function changeFileMeta(path: string): void {
  fs.chmodSync(path, 0o644);
  fs.utimesSync(path, 123, 456);
}

export function parenthesizedFsReceiver(path: string): void {
  (fs).mkdirSync(path);
}

export function shadowedImportNegative(): void {
  const fsp = makeLocalWriter();
  fsp.appendFile("log", "entry");
}
`,
      "writer-log-db.ts": `export function writeStream(message: string): void {
  const stream = makeLocalWriter();
  stream.write(message);
}

export function fauxStdio(message: string): void {
  proc.stdout.write(message);
}

export function logByName(message: string): void {
  logger.warn(message);
  log.info(message);
}

export function writeRows(collection: unknown): void {
  collection.insertOne({});
  collection.bulkWrite([]);
}

export function transactRows(session: unknown): void {
  session.beginTransaction();
  session.rollback();
}
`,
      "stdio-console.ts": `export function printOut(message: string): void {
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

export function consoleUnclaimed(message: string): void {
  console.table([message]);
}
`,
      "http-channels.ts": `export function sendBody(res: unknown): void {
  res.send("payload");
  res.json({ ok: true });
}

export function closePort(port: unknown): void {
  port.close();
}

export function closeHandle(handle: unknown): void {
  handle.close();
}

export function disposeHandle(handle: unknown): void {
  handle.dispose();
}

export function bareChannel(message: string): void {
  postMessage(message);
}

export function barePipeline(src: unknown): void {
  pipeline(src, src);
}

export function pipeStreams(src: unknown, dst: unknown): void {
  src.pipe(dst);
}
`,
      "cancellation-clock.ts": `export function abortWork(controller: unknown): void {
  controller.abort();
}

export function checkAborted(): void {
  AbortSignal.throwIfAborted();
}

export function readClock(): void {
  Date.now();
  performance.now();
  process.hrtime();
  process.hrtime.bigint();
}

export function makeDate(): Date {
  return new Date();
}
`,
      "async-gen.ts": `export async function* streamIds(): AsyncGenerator<number> {
  yield 1;
  yield* [2, 3];
}
`,
      "metaprogramming.ts": `export function reflectOps(target: object, key: string): void {
  Reflect.set(target, key, 1);
  Reflect.deleteProperty(target, key);
}

export function defineProp(target: object, key: string): void {
  Object.defineProperty(target, key, { value: 1 });
}

export function reflectRead(target: object, key: string): void {
  Reflect.get(target, key);
}
`,
      "resources.ts": `export function holdResource(): void {
  using handle = acquire();
}

export async function holdAsyncResource(): Promise<void> {
  await using asyncHandle = acquireAsync();
}
`,
      "imports-dynamic.ts": `export function loadLater(name: string): void {
  import(name);
}

export function requireLater(name: string): void {
  require(name);
}
`,
      "monkeypatch.ts": `import * as helpers from "./helpers-index.js";

export function patchPrototype(): void {
  String.prototype.greet = function (): string {
    return "hi";
  };
}

export function patchNamespace(): void {
  helpers.extra = 1;
}

export function shadowedNamespace(): void {
  const helpers = { extra: 0 };
  helpers.extra = 2;
}

export function chainWrite(config: { db: { url: string } }): void {
  config.db.url = "postgres";
}

export function callNamespace(): void {
  helpers.assist();
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
`,
      "clock-wasm.ts": `export function atomicAdd(buffer: SharedArrayBuffer): void {
  Atomics.add(new Int32Array(buffer), 0, 1);
}

export function instantiateWasm(bytes: unknown): void {
  WebAssembly.instantiate(bytes);
}

export function constructWasm(bytes: unknown): void {
  new WebAssembly.Instance(bytes);
}

export function registryConstruction(): void {
  new FinalizationRegistry(() => undefined);
}
`,
      "ambiguity-parse.ts": `export function pingUnresolved(): void {
  (mystery).ping();
}

export function chainReload(state: { config: { reload(): void } }): void {
  state.config.reload();
}

export function setUnresolved(k: string, v: number): void {
  mysteryMap.set(k, v);
}

export function computedCallback(handlers: Record<string, () => number>): void {
  handlers["pick"](() => 41);
}
`,
      "writes-misc.ts": `export class Dial {
  count = 10;
  items: number[] = [];

  decrement(): void {
    this.count--;
  }

  store(v: number): void {
    this.items[0] = v;
  }
}

export function negateValue(v: number): number {
  return -v;
}

export function parenCompound(p: { count: number }): void {
  (p.count) += 1;
}

export function parenPush(p: unknown[], v: unknown): void {
  (p).push(v);
}

export function putEntry(p: Record<string, number>, k: string, v: number): void {
  p[k] = v;
}

export function lengthParseOnly(p: { length: number }): void {
  p.length = 0;
}

export function writeUnresolved(): void {
  unsetBinding = 5;
}

export function destructureLocal(items: number[]): number {
  const [first, , third] = items;
  const { length } = items;
  return first + third + length;
}

export function destructureParam({ a, b }: { a: number; b: number }): number {
  return a + b;
}

export function makeHandlers(): Record<string, () => number> {
  return { pick: (): number => 41 };
}
`,
      "nested-decls.ts": `export function outerNested(): number {
  function inner(): number {
    return 1;
  }
  return inner();
}

export function overloadHolder(): number {
  function pick(x: number): number;
  function pick(x: number): number {
    return x;
  }
  return pick(1);
}

export function classHolder(): void {
  @component
  class Panel {
    @sealed
    render(): void {}

    plain(): void {}

    @readonly
    label = "x";

    @cached
    get value(): number {
      return 1;
    }

    @tracked
    set value(v: number) {}

    compute(x: number): number;
    compute(x: number): number {
      return x;
    }

    constructor() {}
  }
  new Panel();
}

export function classExpressionHolder(): number {
  const K = class {
    m(): number {
      return 1;
    }
  };
  return new K().m();
}
`,
      "throws-owned.ts": `export function dualThrow(x: boolean): void {
  if (x) { throw new Error("first"); } throw new Error("second");
}

export function throwPropertyOwned(err: { code: number }): void {
  throw new errors.ValidationFailure("bad input", err.code);
}
`,
      "sentinels.ts": `const E1 = new Error("one"), E2 = new TypeError("two");
let pending: unknown;
const { first, second } = { first: 1, second: 2 };
class ImplementsOnly implements Record<string, unknown> {}
class ForeignBase extends lib.Base {}
const notSentinel = new errors.Failure("nope");

export const reverse = { beta: function (): number { return 2; }, alpha: function (): number { return 1; } };
export const twins = { twin: function (): number { return 3; }, twin: function (): number { return 4; } };

export function sentinelCarrier(): number {
  return 7;
}
`,
      "closure-deferred.ts": `export function captureSync(): () => number {
  let total = 0;
  const bump = (): number => {
    total += 1;
    return total;
  };
  return bump;
}

export function thenChain(): Promise<number> {
  let total = 0;
  const later = fetchCount().then((v: number): number => {
    total = total + v;
    return total;
  });
  return later;
}

export function outerDeferred(): void {
  let counter = 0;
  setTimeout(() => {
    const tick = (): number => {
      counter += 1;
      return counter;
    };
    tick();
  }, 10);
}
`,
      "imports-shapes.ts": `import "side-effect-only";
import defaultBinding from "module-default";
import * as namespaceBinding from "module-namespace";
import { namedBinding } from "module-named";

export function importsHere(): void {
  return;
}
`,
    });
    cleanup = tree.cleanup;
    root = tree.root;
    result = (await analyze(root, undefined, process.stderr)) as readonly Record<
      string,
      unknown
    >[];
  }, 120_000);

  afterAll(async () => {
    await cleanup?.();
  });

  it("dumps parse-only tree", () => {
    for (const record of result as readonly Record<string, unknown>[]) {
      const effects = record.side_effects as ReadonlyArray<Record<string, unknown>>;
      console.log(
        `${record.file} :: ${record.name} -> ${JSON.stringify(effects.map((e) => [e.type, e.location, e.target ?? null, JSON.stringify(e.detail ?? null)]))}`,
      );
    }
    expect(result.length).toBeGreaterThan(0);
  });
});
