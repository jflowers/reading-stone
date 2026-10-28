import { readFileSync } from "node:fs";
import { Writable } from "node:stream";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { detectEffects } from "../src/detector.js";
import { extractFunctions } from "../src/extract.js";
import { buildProgramContext } from "../src/program.js";
import { createFixtureTree } from "./helpers/fixtures.js";

const sink = new Writable({
  write(_chunk, _enc, cb) {
    cb();
  },
});

const TSCONFIG_STRICT = `{
  "compilerOptions": {
    "strict": true,
    "target": "ES2022",
    "module": "commonjs"
  }
}
`;

describe("probe checker types", () => {
  let root = "";
  let cleanup: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    const tree = await createFixtureTree({
      "tsconfig.json": TSCONFIG_STRICT,
      "tuple-probe.ts": `export function tupleWrite(pair: [number, string], v: number): void {
  pair[0] = v;
}

export function arrayWrite(items: string[], v: string): void {
  items[0] = v;
}
`,
    });
    cleanup = tree.cleanup;
    root = tree.root;
  }, 120_000);

  afterAll(async () => {
    await cleanup?.();
  });

  it("dumps type predicates at the write bases", async () => {
    const context = buildProgramContext(
      root,
      [["tuple-probe.ts", readFileSync(`${root}/tuple-probe.ts`, "utf8")]],
      sink,
    );
    try {
      const records = extractFunctions(root, context, sink);
      const effects = detectEffects(records, context);
      for (const record of records) {
        console.log(
          record.name,
          JSON.stringify((effects.get(record) ?? []).map((e) => e.type)),
        );
      }
      // Inspect the checker's answer for each parameter directly.
      const checker = context.mode === "program" ? context.checker : undefined;
      console.log("mode:", context.mode);
      if (checker) {
        for (const record of records) {
          const node = record.node as unknown as {
            parameters: ReadonlyArray<{
              name: { text: string };
              getStart(): number;
            }>;
          };
          for (const param of node.parameters) {
            const type = checker.getTypeAtLocation(param as never);
            console.log(
              `param ${param.name.text}: type=${String(type)} flags=${String(type.flags)} isTuple=${String(type.isTupleType?.())} isRef=${String(type.isTypeReference?.())} isUnion=${String(type.isUnionType?.())} symbol=${String(type.getSymbol?.()?.name)}`,
            );
          }
        }
      }
      expect(records.length).toBeGreaterThan(0);
    } finally {
      if (context.mode === "program") {
        context.dispose();
      }
    }
  });
});
