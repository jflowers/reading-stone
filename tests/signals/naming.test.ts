/**
 * Naming-convention rule conformance suite (T014, FR-005; research R3;
 * data-model.md Section 6 routing).
 *
 * src/signals/naming.ts (T022) is the pure half of US1's
 * `naming_convention` signal: `(evidence, effectType) → Signal | undefined`
 * — the longest applicable prefix over the union of the 22 closed prefixes
 * (18 contractual + 4 incidental), matched case-insensitively against the
 * record name's leading characters, emits +10 (contractual) or −10
 * (incidental) only when the FR-007 routing table lists it for the pair's
 * effect type; the `Err` + `SentinelError` special case (+30, in place of
 * the prefix rules) takes precedence; no applicable prefix, or a match
 * without routing agreement, emits nothing. A weight that drifts from
 * data-model.md Section 7 is a bug — the same posture as the sibling pure
 * rules (interface, visibility, caller).
 *
 * RED-FIRST: this suite was written and observed failing before
 * src/signals/naming.ts existed (the module-resolution failure is the red
 * observation), per the task-pairing discipline in tasks.md.
 *
 * Unlike its siblings, naming consumes no evidence component: the record's
 * NAME is the evidence, so the snapshot rides at neutral values in every
 * row (one test flips every other field to its firing value and asserts the
 * signal is unchanged — the rule is evidence-component-blind by contract).
 * The routing data the gate consults is src/signals/routing.ts's table,
 * conformance-pinned against data-model.md Section 6 by
 * tests/signals/routing.test.ts (T003); this suite pins the RULE over that
 * data — the selection, the polarity, the gate, and the sentinel precedence
 * — with hand-built records: no tree, no tsconfig, no checker.
 *
 * Scenario coverage (spec.md FR-005, assumptions 5/6, edge cases 2–3;
 * data-model.md Sections 6–7):
 *
 * - The routed-prefix tables: each of the 18 contractual prefixes emits +10
 *   for an effect type whose routing row lists it (Get → ReturnValue), each
 *   of the 4 incidental prefixes −10 (log → LogWrite) — every row a pinned
 *   literal pair, with a coverage guard requiring all 22 in the tables.
 * - Case-insensitive matching on the leading characters: getTotal/GetTotal
 *   match identically; the incidental list's lowercase spelling is
 *   representational, not a matching rule (LogMessage matches 'log').
 * - Longest-prefix selection over the union of the 22: over today's closed
 *   lists the rule is arithmetically inert — no prefix is a strict prefix
 *   of another (research R3) — pinned here as a tripwire exactly like the
 *   visibility suite's inert +20 clamp; the Lo-family rows pin that the
 *   match consumes the full prefix (diverging characters disqualify); and
 *   matching is leading-position-only (a contained prefix never fires).
 * - The routing gate: a matched prefix NOT listed for the effect type emits
 *   nothing — Handle agrees with HTTPResponseWrite, not StdoutWrite (the
 *   quickstart `handle` case, whose only signal is the interface +30).
 * - The sentinel special case: an Err-prefixed name on a SentinelError
 *   effect emits +30 in place of the prefix rules; an Err-prefixed name on
 *   any other effect falls back to the ordinary prefix rules (Err is in
 *   neither list — no closed prefix even begins with 'e', so no signal); a
 *   non-Err name on a SentinelError effect emits nothing (the row's naming
 *   list is empty).
 * - Stem-boundary imprecision: readyCheckout matches the Read stem —
 *   assumption 5's documented false-positive surface (ErrorMapper matching
 *   Err is the sentinel-side mirror, pinned in the sentinel describe).
 * - At most one signal per (function, effect-type) pair: the return type is
 *   `Signal | undefined` (structural — the interface suite's "exactly one
 *   signal, structurally" stance), and the rows pin that a name embedding
 *   additional stems never accumulates or flips evidence.
 *
 * Beyond the table: the emitted signal carries the identity fields verbatim
 * (`function` = record name, `package` = `derivePackage` of the record's
 * path), a non-empty fixed-template `reasoning` naming the matched rule and
 * token (pinned exactly — research R1's determinism discipline; this suite
 * is where the three templates are pinned), and round-trips through
 * `serializeSignal`, so the extractor's output is protocol-shaped by
 * construction.
 */

import type { Node } from "typescript/unstable/ast";
import { describe, expect, it } from "vitest";
import type { ExtractionRecord } from "../../src/extract.js";
import type { RecordEvidence } from "../../src/signals/evidence.js";
import { namingSignal } from "../../src/signals/naming.js";
import {
  CONTRACTUAL_PREFIXES,
  INCIDENTAL_PREFIXES,
} from "../../src/signals/routing.js";
import { serializeSignal } from "../../src/signals/types.js";
import type { SideEffectType } from "../../src/taxonomy.js";

// The quickstart tree's canonical naming pair: getTotal in src/calc.ts — a
// module-private function whose `Get` prefix agrees with its ReturnValue
// effect through the routing table, +10 on the P0 tier (quickstart.md
// Sections 4–5: the naming_convention row of the 11-signal feed). The pure
// half's identity fixture mirrors it exactly.
const FUNCTION = "getTotal";
const REL_PATH = "src/calc.ts";
const PACKAGE = "src.calc";
const EFFECT_TYPE = "ReturnValue";

/**
 * Builds the hand-built rule-table record: the pure rule reads only the
 * identity fields (`name`, `relPath`), so the live compiler views (`node`,
 * `scopeChain`) are inert filler. The one `node` cast is the same localized
 * escape hatch tests/signals/types.test.ts documents for `untypedSignal` —
 * the seam's point is precisely that no rule touches the node — and the
 * builder is the pattern tests/signals/interface.test.ts established for
 * the sibling rule suites (visibility, naming, jsdoc).
 *
 * @param name The record's unqualified name — the signal's `function`.
 * @param relPath The record's root-relative path — the signal's `package`
 * source.
 * @returns A minimal extraction record carrying the identity fields.
 */
function recordOf(name: string, relPath: string): ExtractionRecord {
  return {
    name,
    relPath,
    line: 1,
    node: undefined as unknown as Node,
    scopeChain: [],
    deferred: false,
  };
}

/**
 * Builds a hand-built evidence snapshot: every component at its neutral
 * value except the overrides under test. Naming reads no evidence component
 * — the record's name is the evidence — so every table row rides at the
 * all-neutral snapshot, which itself pins that the rule never reads the
 * other fields; the one override consumer is the ignores-components test.
 *
 * @param record The record the snapshot describes.
 * @param overrides The components under test; every other field is neutral.
 * @returns A complete evidence snapshot.
 */
function snapshotOf(
  record: ExtractionRecord,
  overrides: Partial<Omit<RecordEvidence, "record">> = {},
): RecordEvidence {
  return {
    record,
    exportedFunction: false,
    exportedReturnType: false,
    exportedReceiver: false,
    docText: "",
    docTags: [],
    interfaceMember: false,
    callerModuleCount: 0,
    ...overrides,
  };
}

// The pinned reasoning templates (research R1): one per rule arm —
// contractual, incidental, sentinel — each naming the matched rule and its
// token (data-model.md Section 2). Implementation-defined wording, stable
// per analyzer version; this suite is where they are pinned (the interface
// and visibility suites' stance). The token is the CANONICAL closed-list
// spelling ('Get', 'log'), never the name's own casing — so getTotal and
// GetTotal carry identical reasoning, and the sentinel names 'Err' itself.

/**
 * One row of the routed contractual-prefix table: the canonical prefix (the
 * closed-list spelling), a record name whose leading characters match it,
 * and a canonical effect type whose routing row lists the prefix. The
 * effect types deliberately span the routing families (value, import,
 * write, mutation, delete, handler, construction) so every row's agreement
 * is a different table row of data-model.md Section 6.
 */
const CONTRACTUAL_ROWS: readonly (readonly [string, string, SideEffectType])[] = [
  ["Get", "getTotal", "ReturnValue"],
  ["Fetch", "FetchUserInfo", "ReturnValue"],
  ["Load", "LoadModule", "ImportSideEffect"],
  ["Read", "ReadConfig", "ReturnValue"],
  ["Save", "SaveDocument", "FileSystemWrite"],
  ["Write", "WriteBanner", "StdoutWrite"],
  ["Update", "UpdateProfile", "ReceiverMutation"],
  ["Set", "SetFlag", "ReceiverMutation"],
  ["Delete", "DeleteRecord", "FileSystemDelete"],
  ["Remove", "RemoveItem", "ReceiverMutation"],
  ["Handle", "HandleEvent", "HTTPResponseWrite"],
  ["Process", "ProcessQueue", "ChannelSend"],
  ["Compute", "ComputeTotal", "ReturnValue"],
  ["Analyze", "AnalyzeData", "ReturnValue"],
  ["Classify", "ClassifyImage", "ReturnValue"],
  ["Parse", "ParseInput", "ReturnValue"],
  ["Build", "BuildReport", "GoroutineSpawn"],
  ["New", "NewClient", "DescriptorEffect"],
];

/**
 * One row of the routed incidental-prefix table. The output family is the
 * only place negative naming evidence routes at all (research R2), so the
 * rows span its three members — LogWrite, StdoutWrite, StderrWrite.
 */
const INCIDENTAL_ROWS: readonly (readonly [string, string, SideEffectType])[] = [
  ["log", "logMessage", "LogWrite"],
  ["debug", "debugState", "StdoutWrite"],
  ["trace", "traceFlow", "StderrWrite"],
  ["print", "printLine", "StdoutWrite"],
];

/**
 * One row of the routing-gate table: a record name whose leading prefix IS
 * matched but NOT listed for the effect type — the false-positive control
 * FR-007 exists for.getTime is the totality row: TimeDependency's routing
 * row is explicitly empty, so NO vocabulary routes there, never an
 * exception.
 */
const GATE_ROWS: readonly (readonly [string, string, SideEffectType])[] = [
  ["getTotal", "src/calc.ts", "LogWrite"],
  ["logMessage", "src/noise.ts", "ReturnValue"],
  ["getTime", "src/sched.ts", "TimeDependency"],
];

describe("FR-005 routed-prefix table (pure, hand-built snapshots)", () => {
  it.each(CONTRACTUAL_ROWS)(
    "emits +10 for the routed contractual prefix %s (%s on %s)",
    (prefix, name, effectType) => {
      // The full six-field shape: identity fields verbatim, the closed
      // source, the pinned weight, and the fixed-template reasoning naming
      // the canonical prefix spelling — the quickstart's naming-only row is
      // Get/getTotal/ReturnValue (50+25+10 = 85 contractual).
      const signal = namingSignal(snapshotOf(recordOf(name, REL_PATH)), effectType);
      if (signal === undefined) {
        throw new Error(
          `the routed contractual row (${name} on ${effectType}) must emit a signal`,
        );
      }
      expect(signal).toEqual({
        function: name,
        package: PACKAGE,
        side_effect_type: effectType,
        source: "naming_convention",
        weight: 10,
        reasoning: `name starts with the contractual prefix '${prefix}'`,
      });
    },
  );

  it.each(INCIDENTAL_ROWS)(
    "emits -10 for the routed incidental prefix %s (%s on %s)",
    (prefix, name, effectType) => {
      // Negative naming evidence exists only where the incidental
      // vocabulary routes — the output family (research R2). The quickstart's
      // all-negative row is log/logMessage/LogWrite (50-10-15 = 25
      // incidental, no contradiction).
      const signal = namingSignal(snapshotOf(recordOf(name, REL_PATH)), effectType);
      if (signal === undefined) {
        throw new Error(
          `the routed incidental row (${name} on ${effectType}) must emit a signal`,
        );
      }
      expect(signal).toEqual({
        function: name,
        package: PACKAGE,
        side_effect_type: effectType,
        source: "naming_convention",
        weight: -10,
        reasoning: `name starts with the incidental prefix '${prefix}'`,
      });
    },
  );

  it("covers every prefix of the closed 22 in its tables", () => {
    // The task's "each contractual prefix" and "each incidental prefix",
    // made executable: every entry of the exported closed lists (themselves
    // conformance-pinned against data-model.md Section 6 by
    // tests/signals/routing.test.ts) must appear in this suite's tables, so
    // a future list change cannot silently shrink the coverage here.
    const covered = new Set(
      [...CONTRACTUAL_ROWS, ...INCIDENTAL_ROWS].map(([prefix]) => prefix),
    );
    const missing = [...CONTRACTUAL_PREFIXES, ...INCIDENTAL_PREFIXES].filter(
      (prefix) => !covered.has(prefix),
    );
    expect(missing).toEqual([]);
  });

  it("matches a name exactly as long as the prefix", () => {
    // The boundary where the name IS the prefix: the leading characters
    // match with nothing left over. A shorter-than-prefix name simply
    // matches nothing (unobservable apart from any other no-match row).
    const signal = namingSignal(
      snapshotOf(recordOf("parse", "src/reader.ts")),
      EFFECT_TYPE,
    );
    if (signal === undefined) {
      throw new Error("the exact-prefix name must emit a signal");
    }
    expect(signal.weight).toBe(10);
    expect(signal.reasoning).toBe("name starts with the contractual prefix 'Parse'");
  });

  it("emits nothing for names matching no closed prefix", () => {
    // tweak and formatLabel: the quickstart tree's no-naming-signal records
    // — tweak's PointerArgMutation sits at the ambiguous floor (75), and
    // formatLabel's evidence is caller_count + visibility only. Neither name
    // begins with any of the 22 prefixes.
    expect(
      namingSignal(snapshotOf(recordOf("tweak", "src/quiet.ts")), "PointerArgMutation"),
    ).toBeUndefined();
    expect(
      namingSignal(snapshotOf(recordOf("formatLabel", "src/util.ts")), "ReturnValue"),
    ).toBeUndefined();
  });
});

describe("case-insensitive leading-character matching (FR-005)", () => {
  it("matches getTotal and GetTotal identically", () => {
    // The pinned example: prefix matching is case-insensitive on the name's
    // leading characters, so the camelCase and PascalCase spellings select
    // the same prefix with the same polarity and the same fixed-template
    // reasoning (which names the canonical 'Get' spelling, never the name's
    // own casing) — only the `function` identity field differs, because
    // they are different records.
    const camel = namingSignal(snapshotOf(recordOf("getTotal", REL_PATH)), EFFECT_TYPE);
    const pascal = namingSignal(
      snapshotOf(recordOf("GetTotal", REL_PATH)),
      EFFECT_TYPE,
    );
    if (camel === undefined || pascal === undefined) {
      throw new Error("both casings of the Get stem must emit a signal");
    }
    expect(camel.source).toBe(pascal.source);
    expect(camel.weight).toBe(pascal.weight);
    expect(camel.reasoning).toBe(pascal.reasoning);
    expect(camel.weight).toBe(10);
    expect(camel.reasoning).toBe("name starts with the contractual prefix 'Get'");
    expect(camel.function).toBe("getTotal");
    expect(pascal.function).toBe("GetTotal");
  });

  it("matches LogMessage and logMessage identically — the lowercase spelling is representational", () => {
    // The incidental list is pinned lowercase ('log'), but routing.ts
    // documents the spelling as representational, not a matching rule: a
    // PascalCase name matches it exactly as the camelCase quickstart name
    // does (FR-005 pins case-insensitivity for the match as a whole —
    // JavaScript naming conventions mix logMessage/LogMessage freely).
    const pascal = namingSignal(
      snapshotOf(recordOf("LogMessage", "src/noise.ts")),
      "LogWrite",
    );
    const camel = namingSignal(
      snapshotOf(recordOf("logMessage", "src/noise.ts")),
      "LogWrite",
    );
    if (pascal === undefined || camel === undefined) {
      throw new Error("both casings of the log stem must emit a signal");
    }
    expect(pascal.source).toBe(camel.source);
    expect(pascal.weight).toBe(camel.weight);
    expect(pascal.reasoning).toBe(camel.reasoning);
    expect(pascal.weight).toBe(-10);
    expect(pascal.reasoning).toBe("name starts with the incidental prefix 'log'");
  });
});

describe("longest-prefix selection over the union of the 22 closed prefixes (FR-005)", () => {
  it("holds the closed-list property that keeps longest-wins inert today", () => {
    // Research R3: longest-wins is "nearly moot over the closed lists (no
    // prefix is a strict prefix of another) but is pinned anyway and
    // fixture-tested — it is the rule that governs if the lists ever grow."
    // This row is the pin, exactly like the visibility suite's arithmetically
    // inert +20 clamp: over the union of the 22 (case-insensitively — a
    // case-variant twin would be the degenerate overlap), no prefix may be a
    // strict prefix of another, because two prefixes of one name would
    // otherwise both be applicable. If the lists ever grow an overlapping
    // pair, this row fails LOUD — and the selection fixture must then become
    // discriminating (the pinned-guard discipline: never removed to simplify
    // tests).
    const union = [...CONTRACTUAL_PREFIXES, ...INCIDENTAL_PREFIXES];
    const overlaps: string[] = [];
    for (const [i, shorter] of union.entries()) {
      for (const [j, longer] of union.entries()) {
        if (i !== j && longer.toLowerCase().startsWith(shorter.toLowerCase())) {
          overlaps.push(`'${shorter}' is a prefix of '${longer}'`);
        }
      }
    }
    expect(overlaps).toEqual([]);
  });

  it("resolves the Lo family by its diverging character — the match consumes the full prefix", () => {
    // 'log' (3, incidental) and 'Load' (4, contractual) share only 'Lo' and
    // diverge at the third character: each name resolves to exactly its own
    // prefix, observable through the opposite routing outcomes — a Load
    // misresolution of LogSink would emit nothing (Load is not listed for
    // LogWrite), and a log misresolution of LoadModule would emit nothing
    // (log is not listed for ImportSideEffect). The full-prefix match is
    // the mechanism that keeps at most one prefix applicable, which is what
    // longest-wins governs.
    const logSink = namingSignal(
      snapshotOf(recordOf("LogSink", "src/noise.ts")),
      "LogWrite",
    );
    if (logSink === undefined) {
      throw new Error("LogSink must resolve to the log prefix");
    }
    expect(logSink.weight).toBe(-10);
    expect(logSink.reasoning).toBe("name starts with the incidental prefix 'log'");
    const loadModule = namingSignal(
      snapshotOf(recordOf("LoadModule", "src/boot.ts")),
      "ImportSideEffect",
    );
    if (loadModule === undefined) {
      throw new Error("LoadModule must resolve to the Load prefix");
    }
    expect(loadModule.weight).toBe(10);
    expect(loadModule.reasoning).toBe("name starts with the contractual prefix 'Load'");
  });

  it("matches only the name's leading characters — a contained prefix never fires", () => {
    // GetLoaded on ImportSideEffect: 'Load' is the row's routed prefix, but
    // it sits mid-name; the leading 'Get' match is not routed for
    // ImportSideEffect — so nothing. A contains-based match would fire the
    // +10; FR-005 pins the name's LEADING characters.
    expect(
      namingSignal(
        snapshotOf(recordOf("GetLoaded", "src/boot.ts")),
        "ImportSideEffect",
      ),
    ).toBeUndefined();
  });
});

describe("the routing gate (FR-007 through FR-005)", () => {
  it("emits nothing for handle on StdoutWrite — the quickstart routing-gate case", () => {
    // The quickstart's deliberate fixture: `handle`'s `Handle` prefix is
    // routed away from StdoutWrite (Handle agrees with HTTPResponseWrite
    // only), so the naming extractor stays silent and the interface +30
    // signal stands alone at the contractual boundary (quickstart.md
    // Sections 1, 5: handle = 50+30 = 80).
    expect(
      namingSignal(snapshotOf(recordOf("handle", "src/print.ts")), "StdoutWrite"),
    ).toBeUndefined();
  });

  it("emits +10 for the same handle name on HTTPResponseWrite — the agreeing type", () => {
    const signal = namingSignal(
      snapshotOf(recordOf("handle", "src/print.ts")),
      "HTTPResponseWrite",
    );
    if (signal === undefined) {
      throw new Error("handle must emit for the agreeing HTTPResponseWrite");
    }
    expect(signal.weight).toBe(10);
    expect(signal.reasoning).toBe("name starts with the contractual prefix 'Handle'");
  });

  it.each(GATE_ROWS)(
    "emits nothing for %s on %s — matched but not routed",
    (name, relPath, effectType) => {
      // The gate decides per (function, effect-type) pair: research R3's own
      // sentence — "the same getTotal name yields +10 on its ReturnValue
      // effect and nothing on a hypothetical LogWrite effect". logMessage on
      // ReturnValue is the incidental direction (incidental vocabulary
      // routes only to the output family); getTime on TimeDependency is the
      // explicitly-empty row — totality, never an exception.
      expect(
        namingSignal(snapshotOf(recordOf(name, relPath)), effectType),
      ).toBeUndefined();
    },
  );
});

describe("the Err + SentinelError special case (FR-005 precedence)", () => {
  it("emits +30 in place of the prefix rules for an Err-prefixed name on SentinelError", () => {
    // The full six-field shape of the sentinel arm: the +30 replaces the
    // prefix rules for that effect entirely (research R3's rejected
    // alternative is emitting it alongside a routed prefix — "in place of"
    // is explicit), and because the return type is a single Signal, the
    // replacement is structural.
    const signal = namingSignal(
      snapshotOf(recordOf("ErrNotFound", "src/errors.ts")),
      "SentinelError",
    );
    if (signal === undefined) {
      throw new Error("the Err-prefixed name must emit the sentinel signal");
    }
    expect(signal).toEqual({
      function: "ErrNotFound",
      package: "src.errors",
      side_effect_type: "SentinelError",
      source: "naming_convention",
      weight: 30,
      reasoning: "name starts with 'Err', the SentinelError special case",
    });
  });

  it("matches the Err prefix case-insensitively", () => {
    // FR-005 pins case-insensitivity for the match as a whole, and research
    // R3 states it for the Err check specifically — a lowercase err-prefixed
    // name fires the same +30 with the same fixed-template reasoning.
    const signal = namingSignal(
      snapshotOf(recordOf("errTimedOut", "src/errors.ts")),
      "SentinelError",
    );
    if (signal === undefined) {
      throw new Error("the lowercase err stem must emit the sentinel signal");
    }
    expect(signal.weight).toBe(30);
    expect(signal.reasoning).toBe(
      "name starts with 'Err', the SentinelError special case",
    );
  });

  it("matches the Err stem across a word boundary — ErrorMapper", () => {
    // Research R3's documented imprecision example (ErrorMapper matching
    // Err): the sentinel check is leading-character matching with no word
    // boundary — the same false-positive surface as readyCheckout/Read
    // (assumption 5), pinned here on the sentinel side.
    const signal = namingSignal(
      snapshotOf(recordOf("ErrorMapper", "src/errors.ts")),
      "SentinelError",
    );
    if (signal === undefined) {
      throw new Error("ErrorMapper must match the Err stem");
    }
    expect(signal.weight).toBe(30);
  });

  it("falls back to the ordinary prefix rules on non-SentinelError effects", () => {
    // Spec edge case 2: the special case does not fire, and Err is in
    // neither closed list — in fact no closed prefix begins with 'e', so an
    // Err-prefixed name can never match one: the fallback is structurally
    // silent (the spec's "typically no signal" is an always for the closed
    // lists). ReturnValue carries the full value-family vocabulary,
    // ErrorReturn the error family's empty naming row — both nothing.
    expect(
      namingSignal(snapshotOf(recordOf("ErrNotFound", "src/errors.ts")), "ReturnValue"),
    ).toBeUndefined();
    expect(
      namingSignal(snapshotOf(recordOf("ErrNotFound", "src/errors.ts")), "ErrorReturn"),
    ).toBeUndefined();
  });

  it("emits nothing for a non-Err name on a SentinelError effect", () => {
    // The SentinelError routing row's naming list is empty — "Err special
    // case only" (data-model.md Section 6): the special case is the sole
    // naming evidence a sentinel effect can carry, and a non-Err name gets
    // none of it.
    expect(
      namingSignal(snapshotOf(recordOf(FUNCTION, REL_PATH)), "SentinelError"),
    ).toBeUndefined();
  });
});

describe("stem-boundary imprecision (spec assumption 5)", () => {
  it("matches readyCheckout against the Read stem — the documented false-positive surface", () => {
    // The task's pinned example: 'ready' begins with the Read stem's
    // characters, so the name matches — a documented, fixture-pinned
    // false-positive surface acceptable for a heuristic signal (assumption
    // 5). The gate still applies: Read must be routed (it is, for
    // ReturnValue) for the imprecision to surface as a +10.
    const signal = namingSignal(
      snapshotOf(recordOf("readyCheckout", "src/cart.ts")),
      EFFECT_TYPE,
    );
    if (signal === undefined) {
      throw new Error("readyCheckout must match the Read stem");
    }
    expect(signal.weight).toBe(10);
    expect(signal.reasoning).toBe("name starts with the contractual prefix 'Read'");
  });

  it("matches LogisticsManifest against the log stem — the incidental side of the same surface", () => {
    // The same leading-character rule on the negative vocabulary:
    // 'logistics' is not logging, but 'LogisticsManifest' begins with the
    // log stem and the stem is routed for LogWrite — assumption 5's
    // imprecision cuts both polarities.
    const signal = namingSignal(
      snapshotOf(recordOf("LogisticsManifest", "src/shipping.ts")),
      "LogWrite",
    );
    if (signal === undefined) {
      throw new Error("LogisticsManifest must match the log stem");
    }
    expect(signal.weight).toBe(-10);
  });
});

describe("at most one naming signal per (function, effect-type) pair", () => {
  it("emits exactly one signal for a name embedding several stems — the leading prefix only", () => {
    // logDebugTrace: the leading 'log' matches; 'debug' and 'trace' are
    // contained but never match (leading position only) — one signal, −10,
    // naming 'log'. The return type admits no second signal structurally
    // (the interface suite's stance), and the row pins that embedded stems
    // never accumulate.
    const signal = namingSignal(
      snapshotOf(recordOf("logDebugTrace", "src/noise.ts")),
      "LogWrite",
    );
    if (signal === undefined) {
      throw new Error("logDebugTrace must resolve to the leading log stem");
    }
    expect(signal).toEqual({
      function: "logDebugTrace",
      package: "src.noise",
      side_effect_type: "LogWrite",
      source: "naming_convention",
      weight: -10,
      reasoning: "name starts with the incidental prefix 'log'",
    });
  });

  it("never mixes polarities from one name — WriteDebugLog resolves to Write alone", () => {
    // 'Write' matches the leading characters (+10, routed for StdoutWrite);
    // the contained 'debug' stem is incidental vocabulary but not leading,
    // so it contributes nothing — one positive signal, never a
    // self-contradiction from a single extractor (FR-011's model: polarity
    // conflicts arise only across sources).
    const signal = namingSignal(
      snapshotOf(recordOf("WriteDebugLog", "src/banner.ts")),
      "StdoutWrite",
    );
    if (signal === undefined) {
      throw new Error("WriteDebugLog must resolve to the leading Write stem");
    }
    expect(signal.weight).toBe(10);
    expect(signal.reasoning).toBe("name starts with the contractual prefix 'Write'");
  });
});

describe("identity fields and purity", () => {
  it("passes any pair's identity fields through unchanged", () => {
    // A different function, path, and effect type ride along verbatim:
    // `function` is the record's unqualified name and `package` its
    // derivePackage value — here a top-level file, whose dotted path is the
    // bare stem (the interface and visibility suites' identity fixture
    // shape).
    const signal = namingSignal(
      snapshotOf(recordOf("save", "repo.ts")),
      "FileSystemWrite",
    );
    if (signal === undefined) {
      throw new Error("the save record must emit a signal");
    }
    expect(signal.function).toBe("save");
    expect(signal.package).toBe("repo");
    expect(signal.side_effect_type).toBe("FileSystemWrite");
    expect(signal.weight).toBe(10);
  });

  it("ignores every evidence component beyond the record's identity", () => {
    // Naming has no evidence component — the record's name is the evidence.
    // A snapshot with every other field at its firing value yields the
    // exact signal the all-neutral snapshot yields: the rule is
    // evidence-component-blind by contract, which is what lets the adapter
    // compute one snapshot per record for all five extractors.
    const noisy = snapshotOf(recordOf(FUNCTION, REL_PATH), {
      exportedFunction: true,
      exportedReturnType: true,
      exportedReceiver: true,
      docText: "logs the writes it returns",
      docTags: [{ tag: "returns", text: "the total" }],
      interfaceMember: true,
      callerModuleCount: 4,
    });
    expect(namingSignal(noisy, EFFECT_TYPE)).toEqual(
      namingSignal(snapshotOf(recordOf(FUNCTION, REL_PATH)), EFFECT_TYPE),
    );
  });

  it("is pure — the same inputs produce the deep-equal signal", () => {
    expect(namingSignal(snapshotOf(recordOf(FUNCTION, REL_PATH)), EFFECT_TYPE)).toEqual(
      namingSignal(snapshotOf(recordOf(FUNCTION, REL_PATH)), EFFECT_TYPE),
    );
  });
});

describe("wire validity (FR-001)", () => {
  it("round-trips every rule arm's emitted signal through serializeSignal", () => {
    // The serializer is the fail-loud wire gate (closed source set,
    // canonical type, integer weight, non-empty reasoning); an extractor
    // output that survives it unchanged is protocol-shaped by construction.
    // One representative row per arm: contractual +10 (the quickstart's
    // getTotal), incidental −10 (logMessage), sentinel +30 (ErrNotFound).
    const rows = [
      namingSignal(snapshotOf(recordOf("getTotal", "src/calc.ts")), "ReturnValue"),
      namingSignal(snapshotOf(recordOf("logMessage", "src/noise.ts")), "LogWrite"),
      namingSignal(
        snapshotOf(recordOf("ErrNotFound", "src/errors.ts")),
        "SentinelError",
      ),
    ];
    for (const signal of rows) {
      if (signal === undefined) {
        throw new Error("each rule arm's representative row must emit");
      }
      expect(serializeSignal(signal)).toEqual(signal);
    }
  });
});
