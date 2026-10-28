// Program-mode (checker available) rule suite for the disposition table rows
// whose detection DIFFERS between the two bootstrap modes — the second half
// of the asserting replacement for the deleted probe files (review dispatch
// 44e85014, Cluster B).
//
// Scope, deliberately narrow:
// - FinalizerRegistration's typed `.register(...)` arm — parse-only reports
//   the construction form alone; only the checker can prove a
//   FinalizationRegistry receiver (the row's program-mode surface).
// - LogWrite's typed Logger receiver arm (the name-form log/logger spellings
//   are pinned in tests/detector-rules.test.ts).
// - Name-form persistence: the disposition table's global note says name-form
//   rules match in BOTH modes, so one pin per family (WriterOutput,
//   ChannelSend, StreamOutput, DatabaseWrite, DatabaseTransaction) guards
//   against name-form families silently going checker-gated.
//
// DELIBERATE EXCLUSIONS (coordination with the parallel mode-split
// delegation): SliceMutation, HTTPResponseWrite, ChannelClose, and
// ContextCancellation program-mode receiver-typing edges are NOT pinned
// here. The fr015 param-write splits (MapMutation vs ContainerMutation on
// typed parameters) are already pinned by tests/detector.test.ts's
// program-mode section and are not repeated.
//
// ASSERTION DISCIPLINE: identical to tests/detector-rules.test.ts — effects
// projected to {type, location, target, detail}, exact locations, zero
// extra effects, descriptions never asserted.
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

// The same tsconfig shape tests/program.test.ts and tests/detector.test.ts
// use to exercise the program bootstrap (a valid config whose root set the
// pipeline overrides anyway).
const TSCONFIG_STRICT =
  '{"compilerOptions": {"strict": true, "target": "ES2022", "module": "commonjs"}}';

const TYPED_RULES_FILES: Record<string, string> = {
  "tsconfig.json": TSCONFIG_STRICT,
  "typed-finalizers.ts": `export function registerFinalizer(registry: FinalizationRegistry<object>, target: object): void {
  registry.register(target, target);
}

export function registerOnPlainReceiver(config: { register(s: string): void }): void {
  config.register("x");
}

export function makeRegistry(): void {
  const registry = new FinalizationRegistry(() => {});
}
`,
  "typed-logging.ts": `class Logger {
  info(message: string): void {}
}

export function logTypedReceiver(audit: Logger, message: string): void {
  audit.info(message);
}
`,
  "typed-nameforms.ts": `export function writeThrough(stream: { write(s: string): void }, message: string): void {
  stream.write(message);
}

export function sendToPort(port: { postMessage(m: string): void }, message: string): void {
  port.postMessage(message);
}

export function pipeForward(src: { pipe(d: unknown): void }, dst: unknown): void {
  src.pipe(dst);
}

export function writeRows(collection: { insertOne(doc: object): void }): void {
  collection.insertOne({});
}

export function transactRows(session: { beginTransaction(): void }): void {
  session.beginTransaction();
}
`,
};

describe("program-mode receiver-typing arms and name-form persistence (FR-003 checker; disposition table)", () => {
  let result: readonly WireRecord[] = [];
  let stderr: () => string = () => "";
  let cleanup: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    const tree = await createFixtureTree(TYPED_RULES_FILES);
    cleanup = tree.cleanup;
    const run = await analyzeTree(tree.root);
    result = run.functions;
    stderr = run.stderr;
  }, 120_000);

  afterAll(async () => {
    await cleanup?.();
  });

  it("FinalizerRegistration: .register on a FinalizationRegistry-typed receiver emits at the call — the program-mode-only arm", () => {
    const record = recordFor(result, "registerFinalizer", "typed-finalizers.ts");
    expect(locatedEffects(record)).toEqual([
      { type: "FinalizerRegistration", location: "typed-finalizers.ts:2:3" },
    ]);
  });

  it("FinalizerRegistration negative: .register on a plain object-typed receiver claims nothing — the typing is the rule", () => {
    const record = recordFor(result, "registerOnPlainReceiver", "typed-finalizers.ts");
    expect(projectedEffects(record)).toEqual([]);
  });

  it("FinalizerRegistration: the construction form still reports under the checker (both-mode surface)", () => {
    const record = recordFor(result, "makeRegistry", "typed-finalizers.ts");
    expect(locatedEffects(record)).toEqual([
      { type: "FinalizerRegistration", location: "typed-finalizers.ts:10:20" },
    ]);
  });

  it("LogWrite: a checker-proven Logger receiver emits at the call — the typed arm, on a receiver no name-form spelling matches", () => {
    const record = recordFor(result, "logTypedReceiver", "typed-logging.ts");
    expect(locatedEffects(record)).toEqual([
      { type: "LogWrite", location: "typed-logging.ts:6:3" },
    ]);
    // The Logger class's own method record stays clean.
    const method = recordFor(result, "info", "typed-logging.ts");
    expect(projectedEffects(method)).toEqual([]);
  });

  it("name-form persistence: stream.write emits WriterOutput under the checker (name-form rules match in both modes)", () => {
    const record = recordFor(result, "writeThrough", "typed-nameforms.ts");
    expect(locatedEffects(record)).toEqual([
      { type: "WriterOutput", location: "typed-nameforms.ts:2:3" },
    ]);
  });

  it("name-form persistence: port.postMessage emits ChannelSend under the checker", () => {
    const record = recordFor(result, "sendToPort", "typed-nameforms.ts");
    expect(locatedEffects(record)).toEqual([
      { type: "ChannelSend", location: "typed-nameforms.ts:6:3" },
    ]);
  });

  it("name-form persistence: .pipe emits StreamOutput under the checker", () => {
    const record = recordFor(result, "pipeForward", "typed-nameforms.ts");
    expect(locatedEffects(record)).toEqual([
      { type: "StreamOutput", location: "typed-nameforms.ts:10:3" },
    ]);
  });

  it("name-form persistence: the database write and transaction names emit under the checker", () => {
    const write = recordFor(result, "writeRows", "typed-nameforms.ts");
    expect(locatedEffects(write)).toEqual([
      { type: "DatabaseWrite", location: "typed-nameforms.ts:14:3" },
    ]);
    const transact = recordFor(result, "transactRows", "typed-nameforms.ts");
    expect(locatedEffects(transact)).toEqual([
      { type: "DatabaseTransaction", location: "typed-nameforms.ts:18:3" },
    ]);
  });

  it("wire shape over the typed tree: canonical types, no classification, key sets, and both documented orders (FR-018, FR-019, FR-020)", () => {
    expectWireInvariants(result);
  });

  it("a clean tree writes no stderr diagnostics", () => {
    expect(stderr()).toBe("");
  });
});
