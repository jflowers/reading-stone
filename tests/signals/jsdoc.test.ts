/**
 * Documentation-rule conformance suite (T015, FR-006; research R4;
 * Clarifications Q1/Q2; data-model.md Section 6 routing).
 *
 * src/signals/jsdoc.ts (T023) is the pure half of US1's `docstring`
 * signal: `(evidence, effectType) → Signal | undefined` over the two
 * documentation components of the evidence snapshot — `docTags` (the
 * compiler's `getJSDocTags` list, bare tag names) and `docText` (the
 * flattened comment text). Three tiers, each gated by FR-007 routing
 * agreement: a `@returns` tag routed to the value family or a `@throws`
 * tag routed to the error family emits +15 (the direct tier —
 * documentation structurally naming the effect's contract, Clarification
 * Q1); one of the nine indirect verbs matched in `docText`
 * (case-insensitive, word-boundary delimited) and routed emits +5; one of
 * the four incidental verbs matched and routed emits −15. At most ONE
 * signal per (function, effect-type) pair, resolved to the strongest
 * agreeing tier present (direct > indirect > incidental); within a tier
 * the first verb in the pinned list order names the match in the
 * reasoning (the deterministic tie-break, research R4). The emitted
 * source string is `docstring` — the protocol's established
 * documentation-source value, never `jsdoc` (Clarification Q2: the module
 * path jsdoc.ts is internal naming only). A weight that drifts from
 * data-model.md Section 7 is a bug — the same posture as the sibling
 * pure rules (interface, visibility, caller, naming).
 *
 * RED-FIRST: this suite was written and observed failing before
 * src/signals/jsdoc.ts existed (the module-resolution failure is the red
 * observation), per the task-pairing discipline in tasks.md.
 *
 * Evidence seam (research R12): the rule is a pure function of the
 * snapshot and the pair's effect type — no compiler interaction, no I/O,
 * no `ProgramContext`. Unlike naming (whose evidence is the record's
 * name), documentation evidence lives in the snapshot's `docText` and
 * `docTags` components; every other component is inert here, and the
 * record's name decides nothing. The compiler's own JSDoc attachment —
 * bare tag names, variable-declaration unification, parent-node tag
 * inheritance — is evidence.ts's concern (T011, pinned by
 * tests/signals/evidence.test.ts); this suite pins the RULE over
 * hand-built snapshots: no tree, no tsconfig, no checker. The expected
 * export follows the sibling convention of naming the wire source
 * (`interfaceSignal`, `visibilitySignal`, `callerSignal`,
 * `namingSignal`): `docstringSignal`.
 *
 * The routing data the gate consults is src/signals/routing.ts's table,
 * conformance-pinned against data-model.md Section 6 by
 * tests/signals/routing.test.ts (T003). One routing detail is
 * load-bearing here: `RoutingBranch.docIncidental` carries the incidental
 * prefixes AND verbs in one shared list (the token sets are disjoint);
 * the documentation extractor matches the four VERBS
 * (logs/prints/traces/debugs) against it — the prefixes are naming
 * vocabulary (FR-005) — pinned below by the singular-form rows.
 *
 * Scenario coverage (spec.md FR-006, Clarifications Q1/Q2; research R4;
 * data-model.md Sections 6–7):
 *
 * - The routed-tag and routed-verb tables: `@returns` routed to the value
 *   family and `@throws` to the error family emit +15; each of the nine
 *   indirect verbs +5 and each of the four incidental verbs −15 for an
 *   effect type whose routing row lists it — every row a pinned literal
 *   pair, with coverage guards requiring the closed 15 tokens in the
 *   tables.
 * - Word-boundary matching: `Logs` matches `logs` (case-insensitive)
 *   while `debugging` does NOT match `debugs` — the quickstart
 *   logMessage comment is the canonical fixture for both; substrings
 *   never fire (`Resets` against `sets`), and the singular prefixes
 *   (`log`, `debug`) never fire the incidental verb tier.
 * - Strongest-tier resolution: direct > indirect > incidental, over
 *   ROUTED evidence only — a tag present but not routed neither emits
 *   nor suppresses; within a tier the first verb in the pinned list order
 *   (not document order) names the match.
 * - The routing gate: `writes` agrees with `FileSystemWrite`, not with
 *   `ReturnValue` (the task's pinned example); incidental verbs route
 *   only to the output family; the explicitly-empty rows are total —
 *   never an exception.
 * - Identity fields verbatim, name-independence, purity, and
 *   round-tripping through `serializeSignal` with source `docstring`.
 */

import type { Node } from "typescript/unstable/ast";
import { describe, expect, it } from "vitest";
import type { ExtractionRecord } from "../../src/extract.js";
import type { RecordEvidence } from "../../src/signals/evidence.js";
import { docstringSignal } from "../../src/signals/jsdoc.js";
import {
  DIRECT_TAGS,
  INCIDENTAL_VERBS,
  INDIRECT_VERBS,
  ROUTING_TABLE,
} from "../../src/signals/routing.js";
import { serializeSignal } from "../../src/signals/types.js";
import type { SideEffectType } from "../../src/taxonomy.js";

// The quickstart tree's canonical documentation pair: logMessage in
// src/noise.ts, whose doc comment — "Logs the message for debugging." —
// is the spec's own word-boundary example (`Logs` matches `logs`;
// `debugging` does not match `debugs`). The docstring row of the
// quickstart's 11-signal feed is this record's all-negative half: −15
// incidental on the LogWrite effect (quickstart.md Sections 4–5:
// 50−10−15 = 25 incidental, no contradiction — the naming −10 is the
// other source).
const FUNCTION = "logMessage";
const REL_PATH = "src/noise.ts";
const PACKAGE = "src.noise";
const EFFECT_TYPE = "LogWrite";

/**
 * Builds the hand-built rule-table record: the pure rule reads only the
 * identity fields (`name`, `relPath`) and the documentation components,
 * so the live compiler views (`node`, `scopeChain`) are inert filler. The
 * one `node` cast is the same localized escape hatch
 * tests/signals/types.test.ts documents for `untypedSignal` — the seam's
 * point is precisely that no rule touches the node — and the builder is
 * the pattern tests/signals/interface.test.ts established for the
 * sibling rule suites (visibility, naming, jsdoc).
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
 * value except the overrides under test. Documentation evidence lives in
 * `docText` and `docTags` — neutral means the undocumented record (empty
 * text, no tags) — and every other component is neutral because the rule
 * never reads it; the one override consumers are the table rows and the
 * component-blindness test.
 *
 * @param record The record the snapshot describes.
 * @param overrides The components under test; every other field is
 * neutral.
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

// The pinned reasoning templates (research R1): one per tier — direct,
// indirect, incidental — each naming the matched rule and its token in
// the CANONICAL closed-list spelling ('@returns', 'writes', 'logs' —
// never the comment's own casing, so "Logs the message" and "logs the
// message" carry identical reasoning). Implementation-defined wording,
// stable per analyzer version; this suite is where they are pinned (the
// naming suite's stance).

/**
 * One row of the routed direct-tag table: the canonical tag (the
 * closed-list `@`-prefixed spelling) and a canonical effect type whose
 * routing row lists it. The value family routes `@returns`; the error
 * family (SentinelError included) routes `@throws`.
 */
const DIRECT_ROWS: readonly (readonly [string, SideEffectType])[] = [
  ["@returns", "ReturnValue"],
  ["@returns", "GeneratorYield"],
  ["@returns", "AsyncGeneratorYield"],
  ["@throws", "ErrorReturn"],
  ["@throws", "ErrorSignal"],
  ["@throws", "SentinelError"],
];

/**
 * One row of the routed indirect-verb table: the canonical verb, a
 * canonical effect type whose routing row lists it, and a doc comment
 * whose prose embeds the verb as a standalone word. Each sentence embeds
 * ONLY its own verb — no earlier pinned-order verb — so every row's
 * reasoning names exactly the row's verb (the tie-break rows below
 * exercise multi-verb comments deliberately).
 */
const INDIRECT_ROWS: readonly (readonly [string, SideEffectType, string])[] = [
  ["returns", "ReturnValue", "Returns the computed total."],
  ["writes", "FileSystemWrite", "Writes the file to disk."],
  ["modifies", "ReceiverMutation", "Modifies the receiver's fields."],
  ["updates", "MapMutation", "Updates the map entry."],
  ["sets", "ContainerMutation", "Sets the container slot."],
  ["persists", "DatabaseWrite", "Persists the row to the database."],
  ["stores", "FileSystemWrite", "Stores the blob in the bucket."],
  ["deletes", "FileSystemDelete", "Deletes the file."],
  ["removes", "PointerArgMutation", "Removes the argument property."],
];

/**
 * One row of the routed incidental-verb table. The output family
 * (LogWrite, StdoutWrite, StderrWrite) is the only place negative
 * documentation evidence routes at all (research R2), so the rows span
 * its three members.
 */
const INCIDENTAL_ROWS: readonly (readonly [string, SideEffectType, string])[] = [
  ["logs", "LogWrite", "Logs the message."],
  ["prints", "StdoutWrite", "Prints the line."],
  ["traces", "StderrWrite", "Traces the call."],
  ["debugs", "LogWrite", "Debugs the state."],
];

/**
 * One row of the routing-gate table: documentation evidence that IS
 * matched but NOT listed for the effect type — the false-positive
 * control FR-007 exists for. Rows carry the bare tag names present and
 * the doc text; the TimeDependency row is the totality row: its routing
 * row is explicitly empty, so NO vocabulary routes there, never an
 * exception.
 */
const GATE_ROWS: readonly (readonly [
  string,
  readonly string[],
  string,
  SideEffectType,
])[] = [
  ["a @returns tag on the error family", ["returns"], "", "ErrorReturn"],
  ["a @throws tag on the value family", ["throws"], "", "ReturnValue"],
  [
    "the writes verb on the value family",
    [],
    "Writes the file to disk.",
    "ReturnValue",
  ],
  [
    "the returns verb on the write family",
    [],
    "Returns the computed total.",
    "FileSystemWrite",
  ],
  ["the logs verb outside the output family", [], "Logs the message.", "ReturnValue"],
  [
    "any vocabulary on an explicitly-empty row",
    [],
    "Writes and logs the value.",
    "TimeDependency",
  ],
];

describe("FR-006 direct-tag table (pure, hand-built snapshots)", () => {
  it.each(DIRECT_ROWS)(
    "emits +15 for the routed direct tag %s on %s",
    (tag, effectType) => {
      // The rows hand the extractor the COMPILER-shaped tag list — bare
      // names, as getJSDocTags yields them ('returns', never '@returns')
      // — while routing.ts's docTags column keeps the FR-006
      // '@'-prefixed spelling; normalizing one to the other is the
      // extractor's job (routing.ts's documented contract), pinned here:
      // the bare-name row emits, and the reasoning names the canonical
      // '@'-prefixed spelling.
      const signal = docstringSignal(
        snapshotOf(recordOf(FUNCTION, REL_PATH), {
          docTags: [{ tag: tag.slice(1), text: "the value" }],
        }),
        effectType,
      );
      if (signal === undefined) {
        throw new Error(
          `the routed direct row (${tag} on ${effectType}) must emit a signal`,
        );
      }
      expect(signal).toEqual({
        function: FUNCTION,
        package: PACKAGE,
        side_effect_type: effectType,
        source: "docstring",
        weight: 15,
        reasoning: `documented with the direct tag '${tag}'`,
      });
    },
  );

  it("covers every tag of the closed 2 in its table", () => {
    // The task's "a @returns tag routed to the value family or a @throws
    // tag routed to the error family", made executable: every entry of
    // the exported closed list (itself conformance-pinned against
    // data-model.md Section 6 by tests/signals/routing.test.ts) must
    // appear in this suite's table, so a future list change cannot
    // silently shrink the coverage here.
    const covered = new Set(DIRECT_ROWS.map(([tag]) => tag));
    const missing = DIRECT_TAGS.filter((tag) => !covered.has(tag));
    expect(missing).toEqual([]);
  });

  it("fires on the tag alone — an empty comment text is still direct evidence", () => {
    // DocTag.text is the empty string when a tag carries no comment
    // (evidence.ts's contract); the tag's PRESENCE is the structural
    // evidence, so the direct tier fires without any prose at all.
    const signal = docstringSignal(
      snapshotOf(recordOf(FUNCTION, REL_PATH), {
        docTags: [{ tag: "returns", text: "" }],
      }),
      "ReturnValue",
    );
    if (signal === undefined) {
      throw new Error("the comment-less @returns tag must emit a signal");
    }
    expect(signal.weight).toBe(15);
    expect(signal.reasoning).toBe("documented with the direct tag '@returns'");
  });

  it("skips a present-but-unrouted tag within the tier — @throws beside a routed @returns", () => {
    // Both tags present on ReturnValue (deliberately in reverse document
    // order): only @returns routes (the value family), so the direct tier
    // resolves to it — the row doubles as the direct tier's tie-break
    // pin, DIRECT_TAGS ordering @returns before @throws with the
    // unrouted tag skipped, never emitted and never an error. No effect
    // type routes both tags, so the ordering itself is arithmetically
    // inert today — the pinned-guard stance.
    const signal = docstringSignal(
      snapshotOf(recordOf(FUNCTION, REL_PATH), {
        docTags: [
          { tag: "throws", text: "never" },
          { tag: "returns", text: "the total" },
        ],
      }),
      "ReturnValue",
    );
    if (signal === undefined) {
      throw new Error("the both-tags row must emit the routed @returns signal");
    }
    expect(signal.weight).toBe(15);
    expect(signal.reasoning).toBe("documented with the direct tag '@returns'");
  });
});

describe("FR-006 indirect-verb table (pure, hand-built snapshots)", () => {
  it.each(INDIRECT_ROWS)(
    "emits +5 for the routed indirect verb %s on %s",
    (verb, effectType, docText) => {
      // The full six-field shape: identity fields verbatim, the closed
      // source, the pinned weight, and the fixed-template reasoning
      // naming the canonical verb spelling. The sentences capitalize
      // their verb, so every row also exercises the case-insensitive
      // match; the word-boundary describe pins the boundary discipline
      // itself.
      const signal = docstringSignal(
        snapshotOf(recordOf(FUNCTION, REL_PATH), { docText }),
        effectType,
      );
      if (signal === undefined) {
        throw new Error(
          `the routed indirect row (${verb} on ${effectType}) must emit a signal`,
        );
      }
      expect(signal).toEqual({
        function: FUNCTION,
        package: PACKAGE,
        side_effect_type: effectType,
        source: "docstring",
        weight: 5,
        reasoning: `documented with the indirect verb '${verb}'`,
      });
    },
  );

  it("covers every verb of the closed 9 in its table", () => {
    const covered = new Set(INDIRECT_ROWS.map(([verb]) => verb));
    const missing = INDIRECT_VERBS.filter((verb) => !covered.has(verb));
    expect(missing).toEqual([]);
  });
});

describe("FR-006 incidental-verb table (pure, hand-built snapshots)", () => {
  it.each(INCIDENTAL_ROWS)(
    "emits -15 for the routed incidental verb %s on %s",
    (verb, effectType, docText) => {
      // Negative documentation evidence exists only where the incidental
      // vocabulary routes — the output family (research R2). The
      // quickstart's all-negative record is logMessage (50−10−15 = 25
      // incidental, no contradiction); the writeBanner row below is the
      // cross-source contradiction's negative half.
      const signal = docstringSignal(
        snapshotOf(recordOf(FUNCTION, REL_PATH), { docText }),
        effectType,
      );
      if (signal === undefined) {
        throw new Error(
          `the routed incidental row (${verb} on ${effectType}) must emit a signal`,
        );
      }
      expect(signal).toEqual({
        function: FUNCTION,
        package: PACKAGE,
        side_effect_type: effectType,
        source: "docstring",
        weight: -15,
        reasoning: `documented with the incidental verb '${verb}'`,
      });
    },
  );

  it("covers every verb of the closed 4 in its table", () => {
    const covered = new Set(INCIDENTAL_ROWS.map(([verb]) => verb));
    const missing = INCIDENTAL_VERBS.filter((verb) => !covered.has(verb));
    expect(missing).toEqual([]);
  });

  it("emits the quickstart writeBanner row — the cross-source contradiction's negative half", () => {
    // writeBanner in src/banner.ts: doc comment "Logs the banner to
    // stdout." on the StdoutWrite effect — the docstring −15 half of the
    // quickstart's contradiction fixture (the naming +10 from the Write
    // prefix is the OTHER source; 50+10−15−20 = 25 incidental,
    // quickstart.md Sections 4–5). The strongest-tier rule keeps one
    // extractor from ever emitting mixed polarities: this comment
    // carries no routed indirect verb, so the incidental tier stands
    // alone — the contradiction can only arise ACROSS sources, which is
    // FR-011's model.
    const signal = docstringSignal(
      snapshotOf(recordOf("writeBanner", "src/banner.ts"), {
        docText: "Logs the banner to stdout.",
      }),
      "StdoutWrite",
    );
    if (signal === undefined) {
      throw new Error("the writeBanner comment must emit the incidental signal");
    }
    expect(signal).toEqual({
      function: "writeBanner",
      package: "src.banner",
      side_effect_type: "StdoutWrite",
      source: "docstring",
      weight: -15,
      reasoning: "documented with the incidental verb 'logs'",
    });
  });
});

describe("word-boundary, case-insensitive prose matching", () => {
  it("matches Logs and rejects debugging — the quickstart logMessage comment", () => {
    // The task's pinned pair, and the quickstart's own fixture text:
    // "Logs the message for debugging." — `Logs` matches the incidental
    // verb `logs` case-insensitively, while `debugging` does NOT match
    // `debugs` (word-boundary delimitation). One signal, −15, reasoning
    // naming the canonical lowercase spelling — never the comment's own
    // casing. The full six-field shape is the quickstart's docstring row
    // for logMessage.
    const signal = docstringSignal(
      snapshotOf(recordOf(FUNCTION, REL_PATH), {
        docText: "Logs the message for debugging.",
      }),
      EFFECT_TYPE,
    );
    if (signal === undefined) {
      throw new Error("the logMessage comment must emit the incidental signal");
    }
    expect(signal).toEqual({
      function: FUNCTION,
      package: PACKAGE,
      side_effect_type: EFFECT_TYPE,
      source: "docstring",
      weight: -15,
      reasoning: "documented with the incidental verb 'logs'",
    });
  });

  it("emits nothing for debugging alone — the word-boundary negative half isolated", () => {
    // The same vocabulary family with no whole-word match: 'debugging'
    // shares a stem with 'debugs' but is a different word, so no tier has
    // evidence — neutral absence, never an error (Constitution Principle
    // II).
    expect(
      docstringSignal(
        snapshotOf(recordOf(FUNCTION, REL_PATH), {
          docText: "Debugging the message flow.",
        }),
        EFFECT_TYPE,
      ),
    ).toBeUndefined();
  });

  it("matches upper- and mixed-case verbs identically — the canonical spelling names the match", () => {
    // Case-insensitivity is pinned for the match as a whole (research
    // R4): LOGS / logs / Logs all select the same incidental verb with
    // the same polarity and the same fixed-template reasoning (which
    // names the closed-list spelling 'logs' regardless of the comment's
    // casing) — only the identity fields could differ, and here the
    // record is the same one.
    const upper = docstringSignal(
      snapshotOf(recordOf(FUNCTION, REL_PATH), {
        docText: "LOGS THE MESSAGE.",
      }),
      EFFECT_TYPE,
    );
    const lower = docstringSignal(
      snapshotOf(recordOf(FUNCTION, REL_PATH), {
        docText: "logs the message.",
      }),
      EFFECT_TYPE,
    );
    if (upper === undefined || lower === undefined) {
      throw new Error("both casings of the logs verb must emit a signal");
    }
    expect(upper.source).toBe(lower.source);
    expect(upper.weight).toBe(lower.weight);
    expect(upper.reasoning).toBe(lower.reasoning);
    expect(upper.weight).toBe(-15);
    expect(upper.reasoning).toBe("documented with the incidental verb 'logs'");
  });

  it("never matches a verb inside a longer word — Resets is not sets", () => {
    // Word-boundary delimitation cuts both directions: 'sets' as a
    // substring of 'Resets' never fires (no boundary between 'Re' and
    // 'sets'), exactly as 'debugging' never fires 'debugs'. A
    // contains-based match would emit the +5.
    expect(
      docstringSignal(
        snapshotOf(recordOf("applyPatch", "src/quiet.ts"), {
          docText: "Resets the counter.",
        }),
        "ContainerMutation",
      ),
    ).toBeUndefined();
  });

  it("matches a verb at the string edges and beside punctuation", () => {
    // The whole text being the verb (both edges are boundaries) and a
    // comma-adjacent occurrence both match — boundary delimitation is
    // about word characters, not spaces.
    const bare = docstringSignal(
      snapshotOf(recordOf(FUNCTION, REL_PATH), { docText: "writes" }),
      "FileSystemWrite",
    );
    if (bare === undefined) {
      throw new Error("the bare verb text must emit a signal");
    }
    expect(bare.weight).toBe(5);
    const punctuated = docstringSignal(
      snapshotOf(recordOf(FUNCTION, REL_PATH), {
        docText: "It writes, then flushes.",
      }),
      "FileSystemWrite",
    );
    if (punctuated === undefined) {
      throw new Error("the comma-adjacent verb must emit a signal");
    }
    expect(punctuated.weight).toBe(5);
    expect(punctuated.reasoning).toBe("documented with the indirect verb 'writes'");
  });

  it("never fires the incidental tier on the singular prefixes — log and debug are naming vocabulary", () => {
    // RoutingBranch.docIncidental is the SHARED column: it carries the
    // four incidental prefixes (log/debug/trace/print — naming
    // vocabulary, FR-005) alongside the four incidental verbs
    // (logs/prints/traces/debugs — FR-006). The documentation extractor
    // matches the verbs only: 'log' and 'debug' as standalone words are
    // not incidental verbs, so no docstring signal fires — the
    // disjointness routing.ts documents, pinned against a naive
    // iterate-the-column implementation.
    expect(
      docstringSignal(
        snapshotOf(recordOf(FUNCTION, REL_PATH), { docText: "log the value" }),
        EFFECT_TYPE,
      ),
    ).toBeUndefined();
    expect(
      docstringSignal(
        snapshotOf(recordOf(FUNCTION, REL_PATH), { docText: "debug the flow" }),
        "StdoutWrite",
      ),
    ).toBeUndefined();
  });
});

describe("at most one signal per pair — strongest agreeing tier (direct > indirect > incidental)", () => {
  it("resolves direct over indirect — the @returns tag wins over the returns verb", () => {
    // The value family routes BOTH tiers: @returns (direct, +15) and
    // returns (indirect, +5). A comment carrying both — the tag and the
    // prose verb — yields ONE signal at +15 naming the tag: the return
    // type is a single Signal | undefined, so at-most-one-per-pair is
    // structural, and the tier ordering is the pinned resolution.
    const signal = docstringSignal(
      snapshotOf(recordOf(FUNCTION, REL_PATH), {
        docText: "Returns the computed total.",
        docTags: [{ tag: "returns", text: "the computed total" }],
      }),
      "ReturnValue",
    );
    if (signal === undefined) {
      throw new Error("the direct-plus-indirect comment must emit the direct signal");
    }
    expect(signal.weight).toBe(15);
    expect(signal.reasoning).toBe("documented with the direct tag '@returns'");
  });

  it("resolves indirect over incidental — writes beats logs on the output family", () => {
    // The output family routes both prose tiers: writes (indirect, +5)
    // and the incidental verbs (−15). One signal at +5 naming 'writes' —
    // a single extractor never emits mixed polarities, so the
    // writeBanner-style contradiction can only arise ACROSS sources,
    // which is FR-011's model.
    const signal = docstringSignal(
      snapshotOf(recordOf("writeBanner", "src/banner.ts"), {
        docText: "Writes the banner and logs the result.",
      }),
      "StdoutWrite",
    );
    if (signal === undefined) {
      throw new Error(
        "the indirect-plus-incidental comment must emit the indirect signal",
      );
    }
    expect(signal.weight).toBe(5);
    expect(signal.reasoning).toBe("documented with the indirect verb 'writes'");
  });

  it("resolves tiers over ROUTED evidence only — an unrouted tag neither emits nor suppresses", () => {
    // A @returns tag on FileSystemWrite is present but unrouted (the
    // write family's docTags column is empty), while the writes verb
    // routes: the signal is the indirect +5. Tier resolution considers
    // only agreeing evidence — the task's "a tag present but not routed
    // to the effect type emits nothing" as a resolution fact, not just a
    // gate fact.
    const signal = docstringSignal(
      snapshotOf(recordOf("saveReport", "src/store.ts"), {
        docText: "Writes the file to disk.",
        docTags: [{ tag: "returns", text: "the path" }],
      }),
      "FileSystemWrite",
    );
    if (signal === undefined) {
      throw new Error("the unrouted-tag comment must emit the indirect signal");
    }
    expect(signal.weight).toBe(5);
    expect(signal.reasoning).toBe("documented with the indirect verb 'writes'");
  });

  it("skips unrouted verbs the same way — logs stands where returns does not route", () => {
    // StdoutWrite routes 'writes' (indirect) and the incidental verbs,
    // but NOT 'returns' (value-family vocabulary): the comment's
    // 'returns' is skipped and the incidental 'logs' stands — resolution
    // and tie-break both operate on the routed intersection only.
    const signal = docstringSignal(
      snapshotOf(recordOf(FUNCTION, REL_PATH), {
        docText: "logs the value and returns nothing",
      }),
      "StdoutWrite",
    );
    if (signal === undefined) {
      throw new Error("the unrouted-verb comment must emit the incidental signal");
    }
    expect(signal.weight).toBe(-15);
    expect(signal.reasoning).toBe("documented with the incidental verb 'logs'");
  });

  it("lets a routed direct tag stand over an unrouted incidental verb", () => {
    // The mirror of the unrouted-tag row: 'logs' on ReturnValue is
    // present but unrouted (incidental vocabulary routes only to the
    // output family), so the routed @returns tag's +15 stands — unrouted
    // evidence never disturbs resolution in either direction.
    const signal = docstringSignal(
      snapshotOf(recordOf(FUNCTION, REL_PATH), {
        docText: "logs the value it returns",
        docTags: [{ tag: "returns", text: "the value" }],
      }),
      "ReturnValue",
    );
    if (signal === undefined) {
      throw new Error("the unrouted-verb comment must emit the direct signal");
    }
    expect(signal.weight).toBe(15);
    expect(signal.reasoning).toBe("documented with the direct tag '@returns'");
  });

  it("names the first verb in the pinned list order within the indirect tier — not document order", () => {
    // The deterministic tie-break: both 'stores' and 'writes' match and
    // route for FileSystemWrite, and the comment mentions 'stores' first
    // — but INDIRECT_VERBS pins 'writes' before 'persists' before
    // 'stores', so the reasoning names 'writes'. Document order never
    // decides anything (Constitution Principle I).
    const signal = docstringSignal(
      snapshotOf(recordOf("persistBlob", "src/store.ts"), {
        docText: "Stores the data, then writes it.",
      }),
      "FileSystemWrite",
    );
    if (signal === undefined) {
      throw new Error("the two-verb comment must emit the indirect signal");
    }
    expect(signal.weight).toBe(5);
    expect(signal.reasoning).toBe("documented with the indirect verb 'writes'");
  });

  it("names the first verb in the pinned list order within the incidental tier", () => {
    // The same tie-break on the negative vocabulary: INCIDENTAL_VERBS
    // pins logs, prints, traces, debugs — so 'prints' (second) names the
    // match even though the comment mentions 'traces' (third) first.
    const signal = docstringSignal(
      snapshotOf(recordOf("emitFlow", "src/tap.ts"), {
        docText: "Traces and prints the flow.",
      }),
      "StderrWrite",
    );
    if (signal === undefined) {
      throw new Error("the two-verb comment must emit the incidental signal");
    }
    expect(signal.weight).toBe(-15);
    expect(signal.reasoning).toBe("documented with the incidental verb 'prints'");
  });

  it("holds the routing-table property that keeps direct-over-incidental inert today", () => {
    // Over the current 48-row table no effect type routes both a direct
    // tag and an incidental verb — the tag rows (value and error
    // families) carry empty docIncidental lists; the incidental rows
    // (the output family) carry empty docTags lists — so the
    // direct > incidental ordering is arithmetically inert today, with
    // no discriminating fixture possible. Pinned as a tripwire exactly
    // like the naming suite's no-overlap property: if the table ever
    // grows a row routing both, this fails LOUD and a discriminating
    // fixture must land.
    const bothRouted: string[] = [];
    for (const [type, branch] of Object.entries(ROUTING_TABLE)) {
      if (branch.docTags.length > 0 && branch.docIncidental.length > 0) {
        bothRouted.push(type);
      }
    }
    expect(bothRouted).toEqual([]);
  });
});

describe("the routing gate (FR-007 through FR-006)", () => {
  it("gates the task's pinned example both ways — writes on FileSystemWrite, not ReturnValue", () => {
    // The task's own pinned gate pair: 'writes' agrees with
    // FileSystemWrite (+5) and not with ReturnValue (nothing) — the same
    // docText, two routing outcomes, decided per (function,
    // effect-type) pair exactly as research R3 states it for naming.
    const agreeing = docstringSignal(
      snapshotOf(recordOf("saveReport", "src/store.ts"), {
        docText: "Writes the file to disk.",
      }),
      "FileSystemWrite",
    );
    if (agreeing === undefined) {
      throw new Error("writes must emit for the agreeing FileSystemWrite");
    }
    expect(agreeing.weight).toBe(5);
    expect(
      docstringSignal(
        snapshotOf(recordOf("saveReport", "src/store.ts"), {
          docText: "Writes the file to disk.",
        }),
        "ReturnValue",
      ),
    ).toBeUndefined();
  });

  it.each(GATE_ROWS)(
    "emits nothing for %s — matched but not routed",
    (_label, tags, docText, effectType) => {
      // The gate decides per pair over both documentation surfaces —
      // tags and prose. The tag rows carry bare compiler-shaped names
      // with no comment text; the prose rows carry their sentence; the
      // last row is the explicitly-empty routing row — totality, never
      // an exception (FR-007).
      expect(
        docstringSignal(
          snapshotOf(recordOf(FUNCTION, REL_PATH), {
            docText,
            docTags: tags.map((tag) => ({ tag, text: "" })),
          }),
          effectType,
        ),
      ).toBeUndefined();
    },
  );
});

describe("identity fields and purity", () => {
  it("passes any pair's identity fields through unchanged", () => {
    // A different function, path, and effect type ride along verbatim:
    // `function` is the record's unqualified name and `package` its
    // derivePackage value — here a top-level file, whose dotted path is
    // the bare stem (the sibling suites' identity fixture shape).
    const signal = docstringSignal(
      snapshotOf(recordOf("persist", "db.ts"), {
        docText: "Persists the row.",
      }),
      "DatabaseWrite",
    );
    if (signal === undefined) {
      throw new Error("the persist record must emit a signal");
    }
    expect(signal.function).toBe("persist");
    expect(signal.package).toBe("db");
    expect(signal.side_effect_type).toBe("DatabaseWrite");
    expect(signal.weight).toBe(5);
  });

  it("is name-independent — the doc evidence, not the record name, decides", () => {
    // The mirror of the naming suite's evidence-blindness row: here the
    // documentation components are the evidence and the record's NAME is
    // inert. Two records with different names (one of which would fire
    // the naming extractor's own incidental prefix) yield identical
    // docstring signals apart from the `function` identity field.
    const noisy = docstringSignal(
      snapshotOf(recordOf("logDebugTrace", "src/noise.ts"), {
        docText: "Logs the message for debugging.",
      }),
      EFFECT_TYPE,
    );
    const quiet = docstringSignal(
      snapshotOf(recordOf("tweak", "src/quiet.ts"), {
        docText: "Logs the message for debugging.",
      }),
      EFFECT_TYPE,
    );
    if (noisy === undefined || quiet === undefined) {
      throw new Error("both records must emit the incidental signal");
    }
    expect(noisy.source).toBe(quiet.source);
    expect(noisy.weight).toBe(quiet.weight);
    expect(noisy.reasoning).toBe(quiet.reasoning);
    expect(noisy.function).toBe("logDebugTrace");
    expect(quiet.function).toBe("tweak");
  });

  it("ignores every evidence component beyond the documentation fields", () => {
    // A snapshot with every other field at its firing value yields the
    // exact signal the documentation-only snapshot yields: the rule
    // reads only docText, docTags, and the record's identity fields,
    // which is what lets the adapter compute one snapshot per record for
    // all five extractors.
    const noisy = snapshotOf(recordOf(FUNCTION, REL_PATH), {
      docText: "Logs the message for debugging.",
      exportedFunction: true,
      exportedReturnType: true,
      exportedReceiver: true,
      interfaceMember: true,
      callerModuleCount: 4,
    });
    expect(docstringSignal(noisy, EFFECT_TYPE)).toEqual(
      docstringSignal(
        snapshotOf(recordOf(FUNCTION, REL_PATH), {
          docText: "Logs the message for debugging.",
        }),
        EFFECT_TYPE,
      ),
    );
  });

  it("is pure — the same inputs produce the deep-equal signal", () => {
    expect(
      docstringSignal(
        snapshotOf(recordOf(FUNCTION, REL_PATH), {
          docText: "Logs the message for debugging.",
        }),
        EFFECT_TYPE,
      ),
    ).toEqual(
      docstringSignal(
        snapshotOf(recordOf(FUNCTION, REL_PATH), {
          docText: "Logs the message for debugging.",
        }),
        EFFECT_TYPE,
      ),
    );
  });

  it("emits nothing for the undocumented record", () => {
    // docText "" and docTags [] — the snapshot's neutral documentation
    // values (an undocumented function): no tier has evidence, and the
    // neutral absence is never an error (Constitution Principle II) —
    // tweak in the quickstart tree is the canonical undocumented record
    // (its PointerArgMutation sits at the P0 ambiguous floor, 75).
    expect(
      docstringSignal(
        snapshotOf(recordOf("tweak", "src/quiet.ts")),
        "PointerArgMutation",
      ),
    ).toBeUndefined();
  });

  it("emits nothing for tags outside the direct vocabulary", () => {
    // @param and @deprecated are real JSDoc tags the compiler attaches,
    // but neither is in the closed direct-tag list — tag presence alone
    // is not evidence; only the routed closed vocabulary fires.
    expect(
      docstringSignal(
        snapshotOf(recordOf(FUNCTION, REL_PATH), {
          docTags: [
            { tag: "param", text: "the input" },
            { tag: "deprecated", text: "" },
          ],
        }),
        "ReturnValue",
      ),
    ).toBeUndefined();
  });
});

describe("wire validity (FR-001; Clarification Q2)", () => {
  it("round-trips every tier's emitted signal through serializeSignal with source 'docstring'", () => {
    // The serializer is the fail-loud wire gate (closed source set,
    // canonical type, integer weight, non-empty reasoning); an extractor
    // output that survives it unchanged is protocol-shaped by
    // construction. The source string is 'docstring' on every tier —
    // the protocol's established documentation-source value, NEVER
    // 'jsdoc' (Clarification Q2: Gaze's mergeClassifications copies the
    // Source verbatim into ComputeScore, so a divergent string would
    // leave the platform vocabulary; the module path jsdoc.ts is
    // internal naming only). One representative per tier: direct +15
    // (@returns on the value family), indirect +5 (writes on the write
    // family), incidental −15 (logs on the output family — the
    // quickstart logMessage row).
    const rows = [
      docstringSignal(
        snapshotOf(recordOf(FUNCTION, REL_PATH), {
          docTags: [{ tag: "returns", text: "the total" }],
        }),
        "ReturnValue",
      ),
      docstringSignal(
        snapshotOf(recordOf(FUNCTION, REL_PATH), {
          docText: "Writes the file to disk.",
        }),
        "FileSystemWrite",
      ),
      docstringSignal(
        snapshotOf(recordOf(FUNCTION, REL_PATH), {
          docText: "Logs the message for debugging.",
        }),
        EFFECT_TYPE,
      ),
    ];
    for (const signal of rows) {
      if (signal === undefined) {
        throw new Error("each tier's representative row must emit");
      }
      expect(signal.source).toBe("docstring");
      expect(signal.source).not.toBe("jsdoc");
      expect(serializeSignal(signal)).toEqual(signal);
    }
  });
});
