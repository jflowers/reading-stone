import type { SideEffectType } from "../taxonomy.js";

/**
 * The normative effect-type routing table (FR-005/FR-006/FR-007; research
 * R2; data-model.md Section 6, rendered verbatim) — the agreement gate
 * between matched classification vocabulary and canonical effect types.
 *
 * FR-007 pins the contract: the naming extractor (FR-005) and the
 * documentation extractor (FR-006) emit a signal only when the matched
 * prefix, tag, or verb agrees with the effect's canonical type through
 * this table. A match without agreement produces no signal; a type with no
 * agreeing vocabulary produces none either — never an exception. The gate
 * is the pipeline's false-positive control: ungated, a `Get` prefix would
 * +10 every effect on every getter (research R2).
 *
 * This module is pure fixed data — no compiler interaction, no I/O, no
 * logic. Every value is transcribed from data-model.md Section 6 (spec-
 * driven development: FR-007 pins the table as normative data precisely so
 * implementation-time discretion cannot reshape it; Constitution Principle
 * I — the table is deterministic, version-stable data). Safety mechanisms,
 * in the taxonomy.ts tradition:
 *
 * - Compile-time exhaustiveness: `ROUTING_TABLE` is keyed by the full
 *   `SideEffectType` union (the `TIER_MAP` pattern), so a missing row, an
 *   extra row, or a misspelled key cannot build. Totality is structural —
 *   every canonical type routes to a branch or explicitly to none.
 * - Conformance pin: tests/signals/routing.test.ts (T003) asserts the 48
 *   keys at runtime against `SIDE_EFFECT_TYPES`, checks every row's
 *   vocabulary against the exported closed lists, and diffs all 48 rows
 *   against data-model.md Section 6 itself (the disposition-table
 *   anti-drift pattern), so the code table and the normative prose cannot
 *   drift apart.
 *
 * Design decisions:
 *
 * - Rows are rendered one per canonical type, in data-model.md Section 6
 *   table order, with inline literals — normative data is transcribed, not
 *   factored into shared family constants: each row is independently
 *   pinned (a one-row data-model amendment edits one row here) and
 *   independently diffed by the conformance suite. Vocabulary order within
 *   each row follows the pinned closed-list order, so the doc-parity diff
 *   is exact, order included.
 * - `RoutingBranch.docIncidental` carries the incidental prefixes AND
 *   verbs in one list, per data-model.md Section 5.3 ("incidental
 *   prefixes+verbs"): both incidental columns route identically (only the
 *   output family — `LogWrite`, `StdoutWrite`, `StderrWrite`), and the
 *   token sets are disjoint (log/debug/trace/print vs
 *   logs/prints/traces/debugs), so the naming extractor matches the four
 *   prefixes against it (−10) and the documentation extractor the four
 *   verbs (−15) without ambiguity.
 * - The `Err` + `SentinelError` special case (+30, in place of the prefix
 *   rules) is NOT table data — it is a naming-extractor rule keyed on this
 *   table's `SentinelError` row (research R3). That row's naming list is
 *   empty because no closed-list prefix agrees with sentinel errors.
 */

/**
 * One row of the normative routing table (FR-007; data-model.md Section
 * 5.3) — the closed-list vocabulary that agrees with one canonical effect
 * type, split by the signal source that consumes it: naming prefixes feed
 * the naming extractor (FR-005), tags and verbs the documentation
 * extractor (FR-006).
 *
 * An immutable value record (convention pack AP-004): the table is fixed
 * normative data, constructed once, never mutated.
 */
export interface RoutingBranch {
  /**
   * Contractual naming prefixes that agree with the effect type (+10 via
   * `naming_convention` when the longest applicable prefix is listed
   * here). Drawn from `CONTRACTUAL_PREFIXES`.
   */
  readonly naming: readonly string[];
  /**
   * Direct JSDoc tags that agree with the effect type (+15 via
   * `docstring`). Entries keep their FR-006 `@`-prefixed form
   * (`@returns`, `@throws`); the documentation extractor normalizes the
   * compiler's bare tag names from `getJSDocTags` (e.g. `returns`) to
   * this form when matching. Drawn from `DIRECT_TAGS`.
   */
  readonly docTags: readonly string[];
  /**
   * Indirect prose verbs that agree with the effect type (+5 via
   * `docstring` when matched in the flattened doc text, case-insensitive
   * and word-boundary delimited). Drawn from `INDIRECT_VERBS`, in pinned
   * list order — the first routed verb in this order names the match in
   * the emitted reasoning (the deterministic tie-break, research R4).
   */
  readonly docIndirect: readonly string[];
  /**
   * Incidental prefixes AND verbs whose presence disagrees with the
   * effect being contractual (−10 via `naming_convention` for the
   * prefixes, −15 via `docstring` for the verbs). Data-model.md Section
   * 5.3 pins the combination; the token sets are disjoint, so one list
   * serves both extractors. Drawn from `INCIDENTAL_PREFIXES` and
   * `INCIDENTAL_VERBS`.
   */
  readonly docIncidental: readonly string[];
}

/**
 * The closed contractual-prefix vocabulary (FR-005) — exactly 18
 * leading-name prefixes, transcribed verbatim in data-model.md Section 6
 * order. A contractual prefix is positive naming evidence (+10 via
 * `naming_convention`) for exactly the effect types whose `ROUTING_TABLE`
 * row lists it. The naming extractor selects the longest applicable
 * prefix over this list united with `INCIDENTAL_PREFIXES` (the 22 closed
 * prefixes) before consulting the table; the conformance suite checks
 * every row's `naming` list against this list.
 */
export const CONTRACTUAL_PREFIXES: readonly string[] = [
  "Get",
  "Fetch",
  "Load",
  "Read",
  "Save",
  "Write",
  "Update",
  "Set",
  "Delete",
  "Remove",
  "Handle",
  "Process",
  "Compute",
  "Analyze",
  "Classify",
  "Parse",
  "Build",
  "New",
];

/**
 * The closed incidental-prefix vocabulary (FR-005) — exactly 4
 * leading-name prefixes whose presence DISAGREES with an effect being
 * contractual (−10 via `naming_convention` when routed). Incidental
 * prefixes are logging vocabulary, so they agree only with the output
 * family — routing them there is what makes negative naming evidence
 * possible at all (research R2). Like every prefix, they match
 * case-insensitively on the name's leading characters; the pinned
 * lowercase spelling is representational, not a matching rule.
 */
export const INCIDENTAL_PREFIXES: readonly string[] = [
  "log",
  "debug",
  "trace",
  "print",
];

/**
 * The closed direct-tag vocabulary (FR-006; Clarification Q1) — exactly 2
 * JSDoc tags, the strongest documentation tier (+15 via `docstring` when
 * routed to the effect type). Entries keep the FR-006 `@`-prefixed form;
 * the documentation extractor normalizes the compiler's bare tag names
 * from `getJSDocTags` (e.g. `returns`) to this form when matching.
 */
export const DIRECT_TAGS: readonly string[] = ["@returns", "@throws"];

/**
 * The closed indirect-verb vocabulary (FR-006) — exactly 9 prose verbs
 * matched in the flattened doc text (case-insensitive, word-boundary
 * delimited; +5 via `docstring` when routed). Order is pinned by the doc
 * and semantically meaningful: within the indirect tier, the first verb
 * in this order that both matches and routes names the match in the
 * emitted reasoning — the deterministic tie-break (research R4).
 */
export const INDIRECT_VERBS: readonly string[] = [
  "returns",
  "writes",
  "modifies",
  "updates",
  "sets",
  "persists",
  "stores",
  "deletes",
  "removes",
];

/**
 * The closed incidental-verb vocabulary (FR-006) — exactly 4 prose verbs
 * whose presence DISAGREES with the effect being contractual (−15 via
 * `docstring` when routed). Like the incidental prefixes, these are
 * logging vocabulary routed only to the output family. Order is pinned
 * (the same first-verb tie-break as the indirect tier).
 */
export const INCIDENTAL_VERBS: readonly string[] = [
  "logs",
  "prints",
  "traces",
  "debugs",
];

/**
 * The normative routing table (FR-007) — all 48 rows, transcribed
 * verbatim from data-model.md Section 6 in its table order.
 *
 * Compile-time exhaustiveness (the `TIER_MAP` pattern): the value type is
 * keyed by the full `SideEffectType` union, so the compiler rejects a
 * missing row, an extra row, or a misspelled key. Totality is structural:
 * every canonical type lookup finds a branch (possibly an explicitly
 * empty one), so the extractors never need a fallback path — FR-007's
 * "never an exception" holds by construction, runtime-asserted against
 * `SIDE_EFFECT_TYPES` by tests/signals/routing.test.ts (T003), which also
 * doc-parity-diffs every row and column against data-model.md.
 *
 * Lookups are typed-canonical: the extractors index with `SideEffectType`
 * values only. The table is a plain object literal (the TIER_MAP shape)
 * and therefore inherits `Object.prototype` — never index it with
 * unvalidated strings (the taxonomy module's prototype-chain stance).
 */
export const ROUTING_TABLE: Readonly<Record<SideEffectType, RoutingBranch>> = {
  // Value family: Get/Fetch/Load/Read/Compute/Analyze/Classify/Parse/
  // Build/New + @returns + "returns" (research R2).
  ReturnValue: {
    naming: [
      "Get",
      "Fetch",
      "Load",
      "Read",
      "Compute",
      "Analyze",
      "Classify",
      "Parse",
      "Build",
      "New",
    ],
    docTags: ["@returns"],
    docIndirect: ["returns"],
    docIncidental: [],
  },
  GeneratorYield: {
    naming: [
      "Get",
      "Fetch",
      "Load",
      "Read",
      "Compute",
      "Analyze",
      "Classify",
      "Parse",
      "Build",
      "New",
    ],
    docTags: ["@returns"],
    docIndirect: ["returns"],
    docIncidental: [],
  },
  AsyncGeneratorYield: {
    naming: [
      "Get",
      "Fetch",
      "Load",
      "Read",
      "Compute",
      "Analyze",
      "Classify",
      "Parse",
      "Build",
      "New",
    ],
    docTags: ["@returns"],
    docIndirect: ["returns"],
    docIncidental: [],
  },
  // ImportSideEffect routes the Load prefix alone: module evaluation is
  // triggered by loading, not by reading values out of the module.
  ImportSideEffect: {
    naming: ["Load"],
    docTags: [],
    docIndirect: [],
    docIncidental: [],
  },
  // Error family: @throws only — no closed-list prefix agrees with error
  // effects (research R2).
  ErrorReturn: {
    naming: [],
    docTags: ["@throws"],
    docIndirect: [],
    docIncidental: [],
  },
  ErrorSignal: {
    naming: [],
    docTags: ["@throws"],
    docIndirect: [],
    docIncidental: [],
  },
  // No closed-list prefix: the doc's "Err special case only" cell means
  // the +30 sentinel rule is a naming-extractor rule keyed on this row
  // (research R3) — it replaces the prefix rules; it is not stored here.
  SentinelError: {
    naming: [],
    docTags: ["@throws"],
    docIndirect: [],
    docIncidental: [],
  },
  // Mutation family: the eleven state-mutation types share
  // Update/Set/Delete/Remove and the five mutation verbs.
  ReceiverMutation: {
    naming: ["Update", "Set", "Delete", "Remove"],
    docTags: [],
    docIndirect: ["modifies", "updates", "sets", "deletes", "removes"],
    docIncidental: [],
  },
  PointerArgMutation: {
    naming: ["Update", "Set", "Delete", "Remove"],
    docTags: [],
    docIndirect: ["modifies", "updates", "sets", "deletes", "removes"],
    docIncidental: [],
  },
  SliceMutation: {
    naming: ["Update", "Set", "Delete", "Remove"],
    docTags: [],
    docIndirect: ["modifies", "updates", "sets", "deletes", "removes"],
    docIncidental: [],
  },
  MapMutation: {
    naming: ["Update", "Set", "Delete", "Remove"],
    docTags: [],
    docIndirect: ["modifies", "updates", "sets", "deletes", "removes"],
    docIncidental: [],
  },
  GlobalMutation: {
    naming: ["Update", "Set", "Delete", "Remove"],
    docTags: [],
    docIndirect: ["modifies", "updates", "sets", "deletes", "removes"],
    docIncidental: [],
  },
  ContainerMutation: {
    naming: ["Update", "Set", "Delete", "Remove"],
    docTags: [],
    docIndirect: ["modifies", "updates", "sets", "deletes", "removes"],
    docIncidental: [],
  },
  EnvVarMutation: {
    naming: ["Update", "Set", "Delete", "Remove"],
    docTags: [],
    docIndirect: ["modifies", "updates", "sets", "deletes", "removes"],
    docIncidental: [],
  },
  DeferredReturnMutation: {
    naming: ["Update", "Set", "Delete", "Remove"],
    docTags: [],
    docIndirect: ["modifies", "updates", "sets", "deletes", "removes"],
    docIncidental: [],
  },
  ClosureCaptureMutation: {
    naming: ["Update", "Set", "Delete", "Remove"],
    docTags: [],
    docIndirect: ["modifies", "updates", "sets", "deletes", "removes"],
    docIncidental: [],
  },
  MonkeyPatch: {
    naming: ["Update", "Set", "Delete", "Remove"],
    docTags: [],
    docIndirect: ["modifies", "updates", "sets", "deletes", "removes"],
    docIncidental: [],
  },
  MetaprogrammingMutation: {
    naming: ["Update", "Set", "Delete", "Remove"],
    docTags: [],
    docIndirect: ["modifies", "updates", "sets", "deletes", "removes"],
    docIncidental: [],
  },
  // File-system metadata: the narrowed mutation vocabulary
  // (Update/Set, modifies/updates).
  FileSystemMeta: {
    naming: ["Update", "Set"],
    docTags: [],
    docIndirect: ["modifies", "updates"],
    docIncidental: [],
  },
  // Write family: Save/Write + writes, with persists/stores on the two
  // durable stores (research R2).
  FileSystemWrite: {
    naming: ["Save", "Write"],
    docTags: [],
    docIndirect: ["writes", "persists", "stores"],
    docIncidental: [],
  },
  DatabaseWrite: {
    naming: ["Save", "Write"],
    docTags: [],
    docIndirect: ["writes", "persists", "stores"],
    docIncidental: [],
  },
  WriterOutput: {
    naming: ["Save", "Write"],
    docTags: [],
    docIndirect: ["writes"],
    docIncidental: [],
  },
  // HTTP responses also take the handler prefixes (Handle/Process).
  HTTPResponseWrite: {
    naming: ["Save", "Write", "Handle", "Process"],
    docTags: [],
    docIndirect: ["writes"],
    docIncidental: [],
  },
  // StreamOutput routes to the write family, not the return-like branch:
  // TypeScript's construct is `.pipe(...)`, writing to a stream (research
  // R2's deliberate deviation from snake-eyes).
  StreamOutput: {
    naming: ["Save", "Write"],
    docTags: [],
    docIndirect: ["writes"],
    docIncidental: [],
  },
  // Output family: Write + writes plus the incidental vocabulary — the
  // only rows negative evidence routes to (research R2). docIncidental
  // holds the incidental prefixes then the incidental verbs.
  StdoutWrite: {
    naming: ["Write"],
    docTags: [],
    docIndirect: ["writes"],
    docIncidental: [
      "log",
      "debug",
      "trace",
      "print",
      "logs",
      "prints",
      "traces",
      "debugs",
    ],
  },
  StderrWrite: {
    naming: ["Write"],
    docTags: [],
    docIndirect: ["writes"],
    docIncidental: [
      "log",
      "debug",
      "trace",
      "print",
      "logs",
      "prints",
      "traces",
      "debugs",
    ],
  },
  LogWrite: {
    naming: ["Write"],
    docTags: [],
    docIndirect: ["writes"],
    docIncidental: [
      "log",
      "debug",
      "trace",
      "print",
      "logs",
      "prints",
      "traces",
      "debugs",
    ],
  },
  // Delete family: Delete/Remove + deletes/removes.
  FileSystemDelete: {
    naming: ["Delete", "Remove"],
    docTags: [],
    docIndirect: ["deletes", "removes"],
    docIncidental: [],
  },
  // AtomicOp: the narrowed mutation vocabulary (Update/Set,
  // modifies/updates/sets).
  AtomicOp: {
    naming: ["Update", "Set"],
    docTags: [],
    docIndirect: ["modifies", "updates", "sets"],
    docIncidental: [],
  },
  // Handler family: Handle/Process.
  ChannelSend: {
    naming: ["Handle", "Process"],
    docTags: [],
    docIndirect: [],
    docIncidental: [],
  },
  // Construction family: Build/New.
  GoroutineSpawn: {
    naming: ["Build", "New"],
    docTags: [],
    docIndirect: [],
    docIncidental: [],
  },
  DescriptorEffect: {
    naming: ["Build", "New"],
    docTags: [],
    docIndirect: [],
    docIncidental: [],
  },
  FinalizerRegistration: {
    naming: ["Build", "New"],
    docTags: [],
    docIndirect: [],
    docIncidental: [],
  },
  CgoCall: {
    naming: ["Build", "New"],
    docTags: [],
    docIndirect: [],
    docIncidental: [],
  },
  // Explicitly-empty rows: no closed-list vocabulary agrees with these
  // types — routed to none, never an exception (FR-007 totality). The
  // seven never-emitted N/A types (research R2) route to none because
  // their routing is moot, not because agreement was evaluated.
  ChannelClose: { naming: [], docTags: [], docIndirect: [], docIncidental: [] },
  DatabaseTransaction: { naming: [], docTags: [], docIndirect: [], docIncidental: [] },
  CallbackInvocation: { naming: [], docTags: [], docIndirect: [], docIncidental: [] },
  ContextCancellation: { naming: [], docTags: [], docIndirect: [], docIncidental: [] },
  ResourceManagement: { naming: [], docTags: [], docIndirect: [], docIncidental: [] },
  TimeDependency: { naming: [], docTags: [], docIndirect: [], docIncidental: [] },
  ProcessExit: { naming: [], docTags: [], docIndirect: [], docIncidental: [] },
  Panic: { naming: [], docTags: [], docIndirect: [], docIncidental: [] },
  MutexOp: { naming: [], docTags: [], docIndirect: [], docIncidental: [] },
  WaitGroupOp: { naming: [], docTags: [], docIndirect: [], docIncidental: [] },
  RecoverBehavior: { naming: [], docTags: [], docIndirect: [], docIncidental: [] },
  ReflectionMutation: { naming: [], docTags: [], docIndirect: [], docIncidental: [] },
  UnsafeMutation: { naming: [], docTags: [], docIndirect: [], docIncidental: [] },
  SyncPoolOp: { naming: [], docTags: [], docIndirect: [], docIncidental: [] },
};
