import { derivePackage } from "../models.js";
import type { SideEffectType } from "../taxonomy.js";
import type { RecordEvidence } from "./evidence.js";
import {
  DIRECT_TAGS,
  INCIDENTAL_VERBS,
  INDIRECT_VERBS,
  ROUTING_TABLE,
  type RoutingBranch,
} from "./routing.js";
import type { Signal } from "./types.js";

/**
 * The documentation extractor (FR-006; research R4; Clarifications Q1/Q2;
 * data-model.md Sections 6–7) — the pure half of US1's `docstring`
 * signal, and one of the five extractors the adapter fans out per
 * (function record, canonical effect type) pair (FR-008).
 *
 * The rule is pinned tier selection, not tuning: three closed
 * vocabularies, each routed per effect type through the FR-007 table —
 * a `@returns` tag routed to the value family or a `@throws` tag routed
 * to the error family emits +15 (the direct tier: documentation
 * structurally naming the effect's contract, Clarification Q1); one of
 * the nine indirect verbs matched in the flattened doc text and routed
 * emits +5; one of the four incidental verbs matched and routed emits
 * −15 (research R2: incidental vocabulary routes only to the output
 * family, which is what makes negative documentation evidence possible
 * at all). A weight that drifts from data-model.md Section 7 is a bug —
 * the same posture as the sibling pure rules (interface, visibility,
 * caller, naming).
 *
 * At most ONE signal per pair, resolved to the strongest agreeing tier
 * present (direct > indirect > incidental) — the single `Signal |
 * undefined` return makes it structural, and it is what keeps one
 * extractor from ever emitting mixed polarities: the writeBanner-style
 * contradiction can only arise ACROSS sources, which is FR-011's model.
 * Resolution operates on ROUTED evidence only — a tag or verb present
 * but not routed to the pair's effect type neither emits nor suppresses;
 * the tier simply has no match and resolution falls through to the
 * weaker tier. Within a tier the FIRST token in the pinned closed-list
 * order names the match in the reasoning (the deterministic tie-break,
 * research R4) — never document order, so "Stores the data, then writes
 * it." names 'writes' and "Traces and prints the flow." names 'prints'
 * (Constitution Principle I). No effect type routes both a direct tag
 * and an incidental verb over today's table (the suite's tripwire), so
 * the direct-over-incidental step is arithmetically inert — implemented
 * anyway, the pinned-guard stance.
 *
 * The direct tier matches the compiler's own tag list: `getJSDocTags`
 * yields BARE names ('returns'), while the closed list and the routing
 * table's `docTags` column keep the FR-006 '@'-prefixed spelling, so the
 * matcher normalizes bare to '@'-prefixed — routing.ts's documented
 * contract. The tag's comment text is deliberately unread: the tag's
 * PRESENCE is the structural evidence, and a comment-less tag still
 * fires. Tags outside the closed vocabulary (@param, @deprecated) are
 * not evidence at all.
 *
 * The verb tiers match the flattened doc text case-insensitively with
 * word-boundary delimitation on both ends: boundaries are word
 * characters, not spaces, so a verb at either string edge or beside
 * punctuation matches (`writes` alone; "It writes, then flushes."),
 * while `Logs` matches `logs`, `debugging` does NOT match `debugs`, and
 * a verb inside a longer word never fires (`Resets` is not `sets`) —
 * the quickstart logMessage comment is the canonical fixture for the
 * pair. The incidental tier consults `RoutingBranch.docIncidental`,
 * routing.ts's shared incidental prefixes+verbs column: this extractor
 * matches the four VERBS against it, never the naming prefixes — the
 * token sets are disjoint, so iterating the closed vocabulary (not the
 * column) keeps 'log' and 'debug' as standalone words inert here.
 *
 * The emitted source string is `docstring` — the protocol's established
 * documentation-source value, NEVER 'jsdoc' (Clarification Q2: Gaze's
 * mergeClassifications copies the source verbatim into ComputeScore, so
 * a divergent string would leave the platform vocabulary; this module's
 * path, jsdoc.ts, is internal naming only).
 *
 * Evidence seam (research R12): the rule is a pure function of the
 * snapshot and the pair's effect type — no compiler interaction, no
 * I/O, no `ProgramContext`. It reads only the two documentation
 * components (`docText`, `docTags`) and the record's identity fields
 * (`name` is the signal's `function`; `relPath` feeds `derivePackage`),
 * which is what lets the adapter compute one snapshot per record for
 * all five extractors while this rule stays blind to every other
 * component. Unlike the checker-resolved components, documentation
 * evidence is syntactic (data-model.md Section 5.1 marks both fields
 * mode "both"), so this rule has NO parse-only degradation at all —
 * the same availability as naming.
 *
 * Effect-type sensitivity — the routing gate (FR-007): documentation
 * evidence agrees with effect types selectively, so the gate decides
 * per pair — the same "Writes the file to disk." yields +5 on a
 * `FileSystemWrite` effect and nothing on a `ReturnValue` effect. The
 * lookup is total by construction (routing.ts's compile-time
 * exhaustiveness), and an effect type with no agreeing vocabulary — the
 * explicitly-empty rows — emits nothing, never an exception.
 *
 * Determinism (Constitution Principle I; research R1): the emitted
 * `reasoning` is one of three fixed templates naming the matched tier
 * and its token in the CANONICAL closed-list spelling ('@returns',
 * 'writes', 'logs' — never the comment's own casing, so "Logs the
 * message" and "logs the message" carry identical reasoning), stable
 * per analyzer version and pinned by the test suite exactly like
 * effect `description` strings.
 */

/**
 * Escapes regular-expression metacharacters in a literal token before it
 * is interpolated into a pattern. Today's closed verb lists are plain
 * alphabetic words, so the escape is inert — but a future verb carrying
 * a metacharacter must match as a literal, never as syntax: the
 * pinned-guard stance, exactly like naming's longest-prefix selection.
 *
 * @param literal The canonical closed-list token.
 * @returns The token with every regex metacharacter backslash-escaped.
 */
function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The compiled whole-word pattern for each of the 13 closed verbs (9
 * indirect + 4 incidental), folded once at module load rather than per
 * pair — the same discipline as naming's folded prefixes. Case-
 * insensitive and word-boundary delimited on both ends (see the module
 * header for the boundary semantics).
 */
const VERB_PATTERNS: ReadonlyMap<string, RegExp> = new Map(
  [...INDIRECT_VERBS, ...INCIDENTAL_VERBS].map((verb) => [
    verb,
    new RegExp(`\\b${escapeRegExp(verb)}\\b`, "i"),
  ]),
);

/**
 * Whether the snapshot's tag list carries the canonical direct tag —
 * the compiler-shaped bare name normalized to the closed list's
 * '@'-prefixed spelling (see the module header). The tag's comment text
 * is deliberately unread: presence is the evidence.
 *
 * @param evidence The record's evidence snapshot; reads `docTags` only.
 * @param tag The canonical '@'-prefixed closed-list tag.
 * @returns Whether any snapshot tag normalizes to the canonical one.
 */
function hasDirectTag(evidence: RecordEvidence, tag: string): boolean {
  return evidence.docTags.some((docTag) => `@${docTag.tag.toLowerCase()}` === tag);
}

/**
 * Whether the flattened doc text carries the canonical verb as a whole
 * word. The map lookup is total by construction — the tier vocabularies
 * ARE the map's keys — so the fallback branch is a type-level formality,
 * never a behavioral path.
 *
 * @param evidence The record's evidence snapshot; reads `docText` only.
 * @param verb The canonical closed-list verb.
 * @returns Whether the text carries the verb as a whole word.
 */
function matchesVerb(evidence: RecordEvidence, verb: string): boolean {
  return VERB_PATTERNS.get(verb)?.test(evidence.docText) ?? false;
}

/**
 * One documentation tier (FR-006) — the canonical vocabulary, pinned
 * weight, routing column, and matcher shared by every token of one
 * closed list. Three tiers exist: direct (+15, tags, the `docTags`
 * column), indirect (+5, verbs, the `docIndirect` column), and
 * incidental (−15, verbs, the shared `docIncidental` column).
 * Alternatives considered: three independent matched-list walks with
 * the weight and reasoning word inline at each emit site were rejected
 * because the weight, the template words, and the gate column would
 * then live at a distance from the lists they govern — one table is the
 * single source of truth for all of them, the same consolidation as
 * naming's prefix families and visibility's component table (DRY).
 */
interface DocTier {
  /** The tier's name in the fixed reasoning template. */
  readonly label: "direct" | "indirect" | "incidental";
  /** The matched token's kind in the fixed reasoning template. */
  readonly noun: "tag" | "verb";
  /** The tier's pinned contribution to the emitted weight (+15/+5/−15). */
  readonly weight: number;
  /** The closed list of canonical tokens, in pinned tie-break order. */
  readonly vocabulary: readonly string[];
  /** The routing-table column listing the tokens agreeing with a type. */
  readonly routedIn: (branch: RoutingBranch) => readonly string[];
  /** Whether the pair's evidence carries the canonical token. */
  readonly matches: (evidence: RecordEvidence, token: string) => boolean;
}

/**
 * The three documentation tiers in STRONGEST-TIER RESOLUTION ORDER — the
 * array order IS the rule: the first tier with a token that both matches
 * the pair's evidence and is routed for the pair's effect type emits the
 * pair's one signal (direct > indirect > incidental). Drawn from
 * routing.ts's exported closed lists so the conformance suite's
 * closed-list pins and this selection table cannot drift apart.
 */
const DOC_TIERS: readonly DocTier[] = [
  {
    label: "direct",
    noun: "tag",
    weight: 15,
    vocabulary: DIRECT_TAGS,
    routedIn: (branch) => branch.docTags,
    matches: hasDirectTag,
  },
  {
    label: "indirect",
    noun: "verb",
    weight: 5,
    vocabulary: INDIRECT_VERBS,
    routedIn: (branch) => branch.docIndirect,
    matches: matchesVerb,
  },
  {
    label: "incidental",
    noun: "verb",
    weight: -15,
    vocabulary: INCIDENTAL_VERBS,
    routedIn: (branch) => branch.docIncidental,
    matches: matchesVerb,
  },
];

/**
 * Maps one (function record, canonical effect type) pair's evidence
 * snapshot to FR-006's `docstring` signal.
 *
 * The identity fields pass through verbatim — `function` is the record's
 * unqualified name and `package` its `derivePackage` value — and the
 * rule reads no snapshot field beyond the two documentation components
 * (see the module header): the same comment yields the same signal for
 * a given effect type regardless of the record's name and every other
 * evidence component.
 *
 * @param evidence The record's evidence snapshot; the rule reads only
 * `docText`, `docTags`, and the record's identity fields.
 * @param effectType The pair's canonical effect type — the signal's
 * `side_effect_type` identity field and the routing gate's key.
 * @returns The strongest agreeing tier's routed signal — +15 direct tag,
 * +5 indirect verb, or −15 incidental verb — with the first routed
 * token in the pinned list order naming the match; `undefined` when no
 * tier has routed evidence (the undocumented record, vocabulary outside
 * the closed lists, the unrouted gate rows, and the explicitly-empty
 * routing rows all land here): at most one signal per (function,
 * effect-type) pair, structurally, and never an exception.
 */
export function docstringSignal(
  evidence: RecordEvidence,
  effectType: SideEffectType,
): Signal | undefined {
  const { record } = evidence;
  // The routing gate is total by construction (routing.ts's compile-time
  // exhaustiveness), so the typed-canonical lookup has no fallback path.
  const branch = ROUTING_TABLE[effectType];
  // Strongest agreeing tier first, then first ROUTED token in the pinned
  // list order — never document order (Constitution Principle I). The
  // routing check sits INSIDE the vocabulary loop on purpose: a
  // matching-but-unrouted token is skipped, not selected, which is what
  // makes resolution operate on agreeing evidence only (a present but
  // unrouted tag or verb neither emits nor suppresses).
  for (const tier of DOC_TIERS) {
    const routed = tier.routedIn(branch);
    for (const token of tier.vocabulary) {
      if (routed.includes(token) && tier.matches(evidence, token)) {
        return {
          function: record.name,
          package: derivePackage(record.relPath),
          side_effect_type: effectType,
          source: "docstring",
          weight: tier.weight,
          reasoning: `documented with the ${tier.label} ${tier.noun} '${token}'`,
        };
      }
    }
  }
  // No tier has routed evidence — neutral absence, never an error
  // (Constitution Principle II): the confidence arithmetic simply
  // proceeds without a documentation term.
  return undefined;
}
