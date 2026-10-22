# Design

## Context

reading-stone's handshake currently pins `protocol_version = "1.1.0"` and advertises a four-key `capabilities` object (`discover`, `test_mapping`, `classify_signals`, `streaming`, all `false`). The upstream protocol has advanced to v1.2.0, which adds two optional methods (`doc_coverage`, `cognitive_complexity`) and their capability flags. The protocol layer (`src/protocol.ts`) is a constants-and-helpers module with deterministic sorted-key serialization; the server and CLI are untouched by this change. See `proposal.md` — Why for motivation.

## Goals / Non-Goals

**Goals:**

- A truthful v1.2.0 handshake: `protocol_version = "1.2.0"`, six capability keys, all `false`.
- A governed constitution amendment recording the pin change (PATCH 1.0.0 → 1.0.1).
- Documentation (README) reflecting the new target and the two additional method rows.

**Non-Goals:**

- Implementing any analysis method — `doc_coverage`, `cognitive_complexity`, and all v1.1.0 analysis methods stay `-32601` (later milestone issues).
- Flipping any capability flag to `true`.
- Changes to the JSON-RPC envelope, server dispatch, error handling, packaging, or dependencies.

## Decisions

1. **Constants-only protocol change.**
   `PROTOCOL_VERSION` becomes the literal `"1.2.0"`; `Capabilities` gains `doc_coverage` and `cognitive_complexity` booleans; `initializeResult()` emits both as `false`. No schema machinery, validation, or serialization changes — v1.2.0 adds keys to the capabilities object and does not alter any existing field. Alternative (a version-negotiation layer keyed on the incoming request) rejected: the protocol has no request-side version field to negotiate on; the analyzer declares its version unilaterally. The main specs' v1.1.0 citations (`JSON-RPC envelope types`, `initialize request schema`) are swept to v1.2.0 in the same delta — wording only, except that `initialize request schema` additionally gains a normative Principle V traversal-check clause (constitution-aligned, replacing the archived change's time-bound "not validated in this change" deferral); that clause is the delta's only semantic addition.

2. **New flags advertise `false` until their methods exist.**
   Capability flags are the truth mechanism Gaze relies on for graceful degradation; advertising an unimplemented optional method would violate Principle I. Each later v0.2.0 issue flips exactly its own flag(s) alongside the method it ships, so the handshake is truthful at every commit.

3. **Constitution amendment is a PATCH (1.0.0 → 1.0.1).**
   The Upstream Alignment pin is a reference value, not principle text: no principle is added, removed, or redefined, so the constitution's own versioning rules place this in PATCH (clarifications, wording, or non-semantic refinements). The amendment references alignment issue zero-dot-force/reading-stone#1, satisfying the "open an alignment issue within one release cycle" rule proactively rather than reactively.

4. **Golden test pins the serialized handshake bytes.**
   Determinism (Principle I) is enforced by asserting the exact serialized `initialize` result string. Sorted-key serialization already yields a fixed key order (`capabilities` keys sort lexicographically), so the golden string is stable across runs and Node versions for every field except `language_version` (which the golden test therefore excludes by asserting the parsed object rather than a full literal, or by building the expected string with `process.versions.node` interpolated — the test chooses the latter to keep byte-exactness).
   Principle I note (conflict resolution): `language_version` is environment-dependent by protocol design — it is reported once in the `initialize` handshake and never participates in analysis output. Principle I determinism targets analysis results and byte-identical serialization of the same logical response; the golden test interpolates `process.versions.node` into the expected string so the assertion stays byte-exact without pinning the environment.

5. **No version bump for the package in this change.**
   The protocol pin is not a package-level API break (v1.2.0 is backward compatible); `VERSION` stays `0.1.0` and moves to `0.2.0` only in the release issue (#7) that completes the milestone.

## Risks / Trade-offs

- [Older Gaze builds pinned to v1.1.0 negotiate against a v1.2.0 analyzer] → v1.2.0 is additive only (no removed or renamed fields) per the upstream protocol specification at `unbound-force/gaze/docs/protocol.md` (v1.2.0), so no field an older build reads changes meaning. How a v1.1.0-era Gaze client decodes the two unknown capability keys is not specified by that document (Gaze is Go and `encoding/json` ignores unknown fields by default, but this change does not verify that against a pinned older build); the claim is therefore scoped to the wire format, and a conformance check against a v1.1.0 Gaze consumer is deferred to the v0.2.0 release issue (#7). The handshake golden test pins the exact shape reading-stone emits.
- [Flag drift as later issues land] → Each milestone issue flips only its own flag and updates the handshake assertions in the same change; the golden test fails on any unintended flag change.
- [`protocol_version` says 1.2.0 while `doc_coverage`/`cognitive_complexity` return `-32601`] → Intentional and protocol-conformant: optional-method errors degrade gracefully in Gaze, and `false` capability flags are the advertised signal. The requirement's scenario pins the `-32601` behavior.

## Migration Plan

None required — the change is additive at the wire level. Rollback is a plain revert of the three commits (amendment, spec, implementation).
