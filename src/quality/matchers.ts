import type { AssertionKind } from "./types.js";

/**
 * The normative matcher classification table (FR-007/FR-008; research R6;
 * data-model.md Section 4, rendered verbatim) — the total routing from
 * assertion forms to the closed `AssertionKind` vocabulary.
 *
 * FR-007 pins the table as normative data precisely so
 * implementation-time discretion cannot reshape it: every standard
 * vitest/jest `expect()` matcher and `node:assert` function is routed to
 * a kind or explicitly to none. This module is pure fixed data plus pure
 * classification functions — no compiler interaction, no I/O, no hidden
 * state (the src/signals/routing.ts precedent: normative data gets its
 * own module and a doc-parity test).
 *
 * Safety mechanisms, in the routing.ts and taxonomy.ts tradition:
 *
 * - Doc parity: tests/quality/matchers.test.ts (T004) parses
 *   data-model.md Section 4's tables and diffs every row against this
 *   module's entries, order included (the disposition-table anti-drift
 *   pattern), so the code table and the normative prose cannot drift
 *   apart.
 * - Total miss path: a form absent from the table routes to `custom` —
 *   never an exception, never a drop (US3-6). An unknown matcher (custom
 *   `expect.extend` vocabulary) and an unknown `assert` member are
 *   recognized assertions of an unrecognized kind, not errors.
 *
 * The kind set is Gaze's assertion-type set (porting contract
 * `docs/porting/taxonomy-reference.md`; the report-schema enum), and the
 * routing principle is parity with Gaze's Go-native detector: each form
 * takes the kind Gaze assigns its testify analog (data-model Section 3,
 * amended by OpenSpec change `align-assertion-types`):
 *
 * - `equality` — value checks of every shape: exact and structural
 *   equality, closeness, object shape, with-argument mock forms, ordered
 *   relations (testify `Greater`/`Less`), containment and patterns
 *   (`Contains`/`Regexp`), truthiness (`True`/`False`), length (`Len`),
 *   type and instance checks (`IsType`).
 * - `error_check` — the error channel: the `toThrow` family, every
 *   matcher under `.rejects`, the `assert.throws` family, and
 *   `assert.ifError` (testify `NoError`).
 * - `nil_check` — null/undefined presence (testify `Nil`/`NotNil`).
 * - `diff_check` — snapshot matchers (go-cmp `Diff`).
 * - `custom` — mock occurrence/count forms, predicate matchers,
 *   `assert.fail`, and unknown or custom matchers.
 *
 * Negation never changes the kind: `.not.` and `not`-prefixed assert
 * functions preserve it.
 *
 * `node:assert/strict` changes call semantics, not routing (data-model
 * Section 4.2): the syntactic form routes identically, which is why the
 * table keys on member names alone.
 */

/**
 * The Section 4.1 expect-matcher routing table, transcribed verbatim in
 * data-model.md table order: matcher name → classification kind. An
 * immutable `Map` (own-data lookups, never the prototype chain) whose
 * insertion order IS the document order — the doc-parity suite diffs
 * entries in order, so a reordered or missing row fails conformance.
 *
 * Rows are rendered one per matcher with inline literals — normative
 * data is transcribed, not factored into per-kind family constants: each
 * row is independently pinned (a one-row data-model amendment edits one
 * row here) and independently diffed by the conformance suite (the
 * routing.ts transcription discipline).
 */
export const EXPECT_MATCHER_KINDS: ReadonlyMap<string, AssertionKind> = new Map<
  string,
  AssertionKind
>([
  // --- equality: value forms ---
  ["toBe", "equality"],
  ["toEqual", "equality"],
  ["toStrictEqual", "equality"],
  ["toBeCloseTo", "equality"],
  ["toMatchObject", "equality"],
  // --- equality: with-args mock forms ---
  ["toHaveBeenCalledWith", "equality"],
  ["toHaveBeenLastCalledWith", "equality"],
  ["toHaveBeenNthCalledWith", "equality"],
  ["toHaveReturnedWith", "equality"],
  ["toHaveLastReturnedWith", "equality"],
  ["toHaveNthReturnedWith", "equality"],
  // --- equality: legacy jest aliases ---
  ["toBeCalledWith", "equality"],
  ["lastCalledWith", "equality"],
  ["nthCalledWith", "equality"],
  // --- equality: ordered relations (testify Greater/Less) ---
  ["toBeGreaterThan", "equality"],
  ["toBeGreaterThanOrEqual", "equality"],
  ["toBeLessThan", "equality"],
  ["toBeLessThanOrEqual", "equality"],
  // --- equality: containment and patterns (testify Contains/Regexp) ---
  ["toContain", "equality"],
  ["toContainEqual", "equality"],
  ["toMatch", "equality"],
  // --- error_check: the error channel ---
  ["toThrow", "error_check"],
  ["toThrowError", "error_check"],
  ["toThrowErrorMatchingSnapshot", "error_check"],
  ["toThrowErrorMatchingInlineSnapshot", "error_check"],
  // --- formerly unclassified, routed by testify analog ---
  ["toBeTruthy", "equality"],
  ["toBeFalsy", "equality"],
  ["toBeNull", "nil_check"],
  ["toBeUndefined", "nil_check"],
  ["toBeDefined", "nil_check"],
  ["toBeNaN", "equality"],
  ["toBeInstanceOf", "equality"],
  ["toHaveBeenCalled", "custom"],
  ["toHaveBeenCalledTimes", "custom"],
  ["toHaveReturned", "custom"],
  ["toHaveReturnedTimes", "custom"],
  ["toBeCalled", "custom"],
  ["toBeCalledTimes", "custom"],
  ["toHaveProperty", "equality"],
  ["toHaveLength", "equality"],
  ["toMatchSnapshot", "diff_check"],
  ["toMatchInlineSnapshot", "diff_check"],
  ["toBeTypeOf", "equality"],
  ["toSatisfy", "custom"],
]);

/**
 * The Section 4.2 `node:assert` routing table, transcribed verbatim in
 * data-model.md table order (flattened over the document's
 * ` / `-separated two-form rows): assert member name → classification
 * kind. The memberless bare call `assert(value)` is not an entry — it is
 * the `undefined` member in `classifyAssertCall`, routed to `equality`
 * like `assert.ok` (testify `True`).
 *
 * `not`-prefixed functions carry their base kind (US3-7: negation flips
 * polarity, never the kind).
 */
export const ASSERT_FUNCTION_KINDS: ReadonlyMap<string, AssertionKind> = new Map<
  string,
  AssertionKind
>([
  // --- truthiness, error, and unconditional-failure forms ---
  ["ok", "equality"],
  ["ifError", "error_check"],
  ["fail", "custom"],
  // --- equality (each with its not-sibling) ---
  ["equal", "equality"],
  ["notEqual", "equality"],
  ["strictEqual", "equality"],
  ["notStrictEqual", "equality"],
  ["deepEqual", "equality"],
  ["notDeepEqual", "equality"],
  ["deepStrictEqual", "equality"],
  ["notDeepStrictEqual", "equality"],
  // --- equality: patterns (testify Regexp) ---
  ["match", "equality"],
  ["doesNotMatch", "equality"],
  // --- error_check ---
  ["throws", "error_check"],
  ["doesNotThrow", "error_check"],
  ["rejects", "error_check"],
  ["doesNotReject", "error_check"],
]);

/**
 * The chain modifier that reroutes classification to the error channel
 * (data-model Section 4.1's modifier table): `.rejects.` asserts about
 * the rejection channel, so the row is an `error_check` regardless of
 * the invoked matcher.
 */
const ERROR_CHANNEL_MODIFIER = "rejects";

/**
 * Classifies one `expect()` chain invocation (FR-008; data-model Section
 * 4.1's matcher table plus its modifier table) — a pure function over
 * the chain's spelled form.
 *
 * Modifier semantics, applied to the invoked matcher's kind:
 *
 * - `.not.` anywhere in the chain preserves the kind (negation flips
 *   polarity, never the relation's family).
 * - `.resolves.` preserves the kind.
 * - `.rejects.` routes to `error_check` regardless of matcher — checked
 *   first, so it wins in any combination.
 * - Any other intermediate property is inert chain context: the
 *   classification follows the invoked matcher alone.
 * - `await` wrappers are transparent BY CONSTRUCTION: the chain
 *   reconstructor (src/quality/assertions.ts) unwraps
 *   `AwaitExpression`s before the modifier list reaches this function,
 *   so an awaited chain classifies identically (US3-10). This function
 *   never sees an await.
 *
 * The miss path is total: an unknown or custom matcher name (the
 * `expect.extend` vocabulary) routes to `custom` — never an exception,
 * never a drop.
 *
 * @param matcher The invoked property's name — the matcher (`"toBe"` in
 * `expect(x).not.toBe(y)`).
 * @param modifiers The intermediate property names between the `expect`
 * call and the invoked matcher, in chain order (`["not"]` in
 * `expect(x).not.toBe(y)`; `[]` for a bare `expect(x).toBe(y)`).
 * @returns The classified `AssertionKind` (`custom` on a miss).
 */
export function classifyExpectChain(
  matcher: string,
  modifiers: readonly string[],
): AssertionKind {
  if (modifiers.includes(ERROR_CHANNEL_MODIFIER)) {
    return "error_check";
  }
  return EXPECT_MATCHER_KINDS.get(matcher) ?? "custom";
}

/**
 * Classifies one `node:assert` call form (FR-008; data-model Section
 * 4.2's table) — a pure function over the call's spelled form.
 *
 * `node:assert/strict` changes call semantics, not routing: the member
 * name routes identically, so the binding's module specifier never
 * reaches this table (the closed specifier set and binding forms are the
 * assert-binding table's concern in src/quality/assertions.ts).
 *
 * The miss path is total: an unknown member call on an assert binding
 * routes to `custom` — never an exception, never a drop.
 *
 * @param member The invoked member's name (`"equal"` for
 * `assert.equal(a, b)`), or `undefined` for the memberless bare
 * truthiness call `assert(value)`, which routes to `equality` like
 * `assert.ok` (testify `True`).
 * @returns The classified `AssertionKind` (`custom` on a miss).
 */
export function classifyAssertCall(member: string | undefined): AssertionKind {
  if (member === undefined) {
    return "equality";
  }
  return ASSERT_FUNCTION_KINDS.get(member) ?? "custom";
}
