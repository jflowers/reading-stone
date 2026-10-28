import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { analyze } from "../src/analysis.js";
import { createFixtureTree } from "./helpers/fixtures.js";

const TSCONFIG_STRICT = `{
  "compilerOptions": {
    "strict": true,
    "target": "ES2022",
    "module": "commonjs"
  }
}
`;

describe("probe typed tree", () => {
  let root = "";
  let cleanup: (() => Promise<void>) | undefined;
  let result: readonly Record<string, unknown>[] = [];

  beforeAll(async () => {
    const tree = await createFixtureTree({
      "tsconfig.json": TSCONFIG_STRICT,
      "typed-receivers.ts": `class Logger {
  info(message: string): void {
    console.log(message);
  }
}

class MessagePort {
  close(): void {}
}

class ServerResponse {
  send(body: string): void {}
}

export function typedLog(l: Logger): void {
  l.info("x");
}

export function typedClose(chan: MessagePort): void {
  chan.close();
}

export function typedSend(resp: ServerResponse): void {
  resp.send("x");
}

export function typedRegister(reg: FinalizationRegistry<object>): void {
  reg.register({});
}

export function parseJson(text: string): unknown {
  return JSON.parse(text);
}

function localHelper(v: number): number {
  return v + 1;
}

export function callsLocal(v: number): number {
  return localHelper(v);
}

export function objectKeys(target: object): string[] {
  return Object.keys(target);
}

export function tupleWrite(pair: [number, string], v: number): void {
  pair[0] = v;
}

export function unionWrite(maybe: string[] | [number, number], v: string): void {
  maybe[0] = v;
}

export function putEntryTyped(p: Record<string, number>, k: string, v: number): void {
  p[k] = v;
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

  it("dumps typed tree", () => {
    for (const record of result as readonly Record<string, unknown>[]) {
      const effects = record.side_effects as ReadonlyArray<Record<string, unknown>>;
      console.log(
        `${record.file} :: ${record.name} -> ${JSON.stringify(effects.map((e) => [e.type, e.location, e.target ?? null]))}`,
      );
    }
    expect(result.length).toBeGreaterThan(0);
  });
});
