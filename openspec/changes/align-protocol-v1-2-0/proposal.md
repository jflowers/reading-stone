# Proposal

## Why

Gaze's analyzer protocol has advanced to v1.2.0 — adding the `doc_coverage` and `cognitive_complexity` methods plus their capability flags — while reading-stone's constitution pins v1.1.0 and the handshake advertises only four capability flags. The v0.2.0 milestone (zero-dot-force/reading-stone#1 through #7) implements the complete analyzer; targeting v1.2.0 now avoids shipping a v1.1.0 implementation and immediately re-aligning. This is the alignment change the constitution's Upstream Alignment rule anticipates, filed proactively as issue #1 rather than reactively after a Gaze release.

## What Changes

- Amend the constitution's Upstream Alignment pin: protocol **v1.1.0 → v1.2.0** (constitution PATCH bump 1.0.0 → 1.0.1; no principle text changes).
- `src/protocol.ts`:
  - `PROTOCOL_VERSION` = `"1.2.0"`.
  - `Capabilities` gains `doc_coverage: boolean` and `cognitive_complexity: boolean` (six flags total, matching the v1.2.0 capabilities object).
  - `initializeResult()` advertises the two new flags as `false` until their methods land — later v0.2.0 issues flip flags as methods ship.
- `README.md`: protocol version references updated to v1.2.0; the status table gains `doc_coverage` and `cognitive_complexity` rows (Not implemented).
- `tests/protocol.test.ts`: handshake assertions updated to six capability flags and the `"1.2.0"` version pin.

Not a breaking change: v1.2.0 is backward compatible with v1.1.0, so no MAJOR version bump is triggered (reading-stone remains 0.1.0 until the v0.2.0 release issue).

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `protocol`: the `initialize result schema` requirement changes — `protocol_version` reports `"1.2.0"` and the `capabilities` object carries six keys (adds `doc_coverage` and `cognitive_complexity`, both `false` in this change). The `doc_coverage` capability gates the `doc_coverage` method and `cognitive_complexity` gates the `cognitive_complexity` method (both optional in v1.2.0, both unimplemented (`-32601`) in this change).

## Impact

- `src/protocol.ts` — `Capabilities` interface, `PROTOCOL_VERSION`, `initializeResult()`.
- `tests/protocol.test.ts` — handshake conformance assertions.
- `README.md` — status table, protocol version references.
- `.specify/memory/constitution.md` — pin amendment (governed by the constitution's amendment process; exempt from spec-first).
- No dependency changes, no changes to `server.ts`, `main.ts`, or the JSON-RPC envelope, dispatch, or error handling.

## Constitution Alignment

- **I. Protocol Fidelity — PASS**: This is a governed pin alignment, not drift. The changed handshake is byte-pinned by golden tests; v1.2.0 field names and capability keys are taken verbatim from the protocol spec.
- **II. Detection Accuracy — N/A**: no detection code changes in this change.
- **III. TypeScript-Native Analysis — N/A**: no analysis code changes in this change.
- **IV. Testability — PASS**: coverage strategy: `tests/protocol.test.ts` extends the existing handshake suite to assert the exact six-flag capability set, the `"1.2.0"` pin, and the byte-identical serialized handshake; aggregate 85% gate unchanged.
- **V. Analysis Safety — PASS**: no new dependencies; no analyzed-input handling changes.

Conflict resolution: none required — v1.2.0 is backward compatible with v1.1.0.
