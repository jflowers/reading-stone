// The canonical quickstart conformance fixture (spec 003;
// specs/003-classify-signals/quickstart.md) — one shared copy for every
// suite that asserts the controlled-signal profile.
//
// The review council's test-fixture-duplication finding (dispatch
// f4e5896a) called out the tree and feed being mirrored in full between
// tests/analysis.test.ts (the pipeline surface) and tests/server.test.ts
// (the dispatch surface); this module is that consolidation, the same
// extraction tests/helpers/fixtures.ts and tests/helpers/wire.ts made for
// their shared scaffolding (dispatch 44e85014). The anti-drift goal is
// preserved with the mirror removed: the exact-value pins below are
// transcribed from quickstart.md Sections 1 and 4, so an implementation
// drift from the documented profile fails every importing suite, and the
// suites can no longer drift from each other — one copy, one authority.
import { createFixtureTree, type FixtureTree } from "./fixtures.js";
import type { WireSignal } from "./wire.js";

// The quickstart tree (quickstart.md Section 1), verbatim — deliberately
// minimal, one signal category per function, WITH a tsconfig because the
// profile's interface and caller-count signals need program mode. The
// interface in print.ts is module-local so the +6 exported-receiver
// component does not fire; handle's `Handle` prefix is deliberately
// routed away from StdoutWrite (the routing gate), leaving the interface
// signal alone at the contractual boundary. Section 8's parse-only
// variant reuses the same sources without the tsconfig.
export const QUICKSTART_TSCONFIG = `{
  "compilerOptions": {
    "strict": true
  }
}`;

export const QUICKSTART_SOURCES: Readonly<Record<string, string>> = {
  "src/calc.ts": `function getTotal(input: number): number {
  return input * 2;
}
`,
  "src/noise.ts": `/**
 * Logs the message for debugging.
 */
function logMessage(message: string, logger: { info(m: string): void }): void {
  logger.info(message);
}
`,
  "src/banner.ts": `/**
 * Logs the banner to stdout.
 */
function writeBanner(banner: string): void {
  console.log(banner);
}
`,
  "src/quiet.ts": `function tweak(counter: { n: number }): void {
  counter.n = counter.n + 1;
}
`,
  "src/print.ts": `interface Handler {
  handle(event: string): void;
}

class PrintHandler implements Handler {
  handle(event: string): void {
    console.log(event);
  }
}
`,
  "src/util.ts": `export function formatLabel(value: string): string {
  return \`[\${value}]\`;
}
`,
  "src/main1.ts": `import { formatLabel } from "./util";

export function main1(): string {
  return formatLabel("one");
}
`,
  "src/main2.ts": `import { formatLabel } from "./util";

export function main2(): string {
  return formatLabel("two");
}
`,
};

/**
 * The quickstart tree's file map: the Section 1 sources plus the tsconfig
 * (program mode) or alone (the Section 8 parse-only variant). A fresh map
 * per call, so callers can spread or extend it without mutating the
 * fixture.
 */
export function quickstartFiles(withTsconfig: boolean): Record<string, string> {
  return withTsconfig
    ? { ...QUICKSTART_SOURCES, "tsconfig.json": QUICKSTART_TSCONFIG }
    : { ...QUICKSTART_SOURCES };
}

/**
 * Writes the quickstart tree to a fresh mkdtemp fixture tree through the
 * createFixtureTree mechanism every suite shares. `withTsconfig` selects
 * the Section 1 program-mode tree (true) or the Section 8 parse-only
 * variant (the same sources without the tsconfig).
 */
export async function writeQuickstartTree(withTsconfig: boolean): Promise<FixtureTree> {
  return createFixtureTree(quickstartFiles(withTsconfig));
}

// The quickstart signal feed (quickstart.md Section 4) — the exact 11 rows
// in the FR-014 (package, function, side_effect_type, source) codepoint
// order, every weight re-derivable from the Section 5 arithmetic: tweak
// contributes no row (its PointerArgMutation pair matches no extractor —
// the no-signal P0 floor), and writeBanner's pair is the tree's one
// mixed-polarity set, so it alone carries the contradiction.
export const QUICKSTART_FEED: readonly WireSignal[] = [
  // src.banner — writeBanner's StdoutWrite pair is the tree's one
  // mixed-polarity set: naming `Write` +10, docstring `Logs` −15, and
  // exactly one synthesized contradiction row (source order within the
  // pair is codepoint order: contradiction < docstring <
  // naming_convention).
  {
    function: "writeBanner",
    package: "src.banner",
    side_effect_type: "StdoutWrite",
    source: "contradiction",
    weight: -20,
  },
  {
    function: "writeBanner",
    package: "src.banner",
    side_effect_type: "StdoutWrite",
    source: "docstring",
    weight: -15,
  },
  {
    function: "writeBanner",
    package: "src.banner",
    side_effect_type: "StdoutWrite",
    source: "naming_convention",
    weight: 10,
  },
  // src.calc — getTotal's ReturnValue pair: the lone `Get` prefix +10,
  // the tree's only agreeing naming row.
  {
    function: "getTotal",
    package: "src.calc",
    side_effect_type: "ReturnValue",
    source: "naming_convention",
    weight: 10,
  },
  // src.main1 / src.main2 — the two exported call sites (visibility +8).
  {
    function: "main1",
    package: "src.main1",
    side_effect_type: "ReturnValue",
    source: "visibility",
    weight: 8,
  },
  {
    function: "main2",
    package: "src.main2",
    side_effect_type: "ReturnValue",
    source: "visibility",
    weight: 8,
  },
  // src.noise — logMessage's LogWrite pair is the tree's one
  // fully-discordant set (docstring `Logs` −15 + naming `log` −10, single
  // polarity, no contradiction row).
  {
    function: "logMessage",
    package: "src.noise",
    side_effect_type: "LogWrite",
    source: "docstring",
    weight: -15,
  },
  {
    function: "logMessage",
    package: "src.noise",
    side_effect_type: "LogWrite",
    source: "naming_convention",
    weight: -10,
  },
  // src.print — handle's StdoutWrite pair: interface satisfaction +30
  // (program mode — the checker-dependent row parse-only drops); the
  // `Handle` prefix is routed away from StdoutWrite, so no naming row
  // fires.
  {
    function: "handle",
    package: "src.print",
    side_effect_type: "StdoutWrite",
    source: "interface",
    weight: 30,
  },
  // src.util — formatLabel's ReturnValue pair: caller_count +10 (main1
  // and main2 — two distinct in-scope modules; the checker-dependent row
  // parse-only drops) and visibility +8 (exported, syntactic).
  {
    function: "formatLabel",
    package: "src.util",
    side_effect_type: "ReturnValue",
    source: "caller_count",
    weight: 10,
  },
  {
    function: "formatLabel",
    package: "src.util",
    side_effect_type: "ReturnValue",
    source: "visibility",
    weight: 8,
  },
];
