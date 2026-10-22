# Tasks

## 1. Constitution amendment

- [x] 1.1 Amend the Upstream Alignment section of `.specify/memory/constitution.md` to pin protocol v1.2.0 (referencing alignment issue zero-dot-force/reading-stone#1) and bump the constitution version footer to 1.0.1; verify the document still names all five principles unchanged
- [x] 1.2 Archive the completed scaffold-and-protocol change and materialize the main specs (`openspec/specs/{cli,protocol,server}/spec.md` — created with authored Purpose sections, v1.2.0 citation sweep, and requirement text pre-synced to this change's deltas so archive-time sync is idempotent); carried in this branch so the MODIFIED deltas validate against a real baseline

## 2. Protocol layer

- [x] 2.1 Update `src/protocol.ts` — `PROTOCOL_VERSION = "1.2.0"`, `Capabilities` gains `doc_coverage` and `cognitive_complexity`, `initializeResult()` emits both as `false` — and verify `npm run build` passes
- [x] 2.2 Update `tests/protocol.test.ts` — six-flag capability set, `"1.2.0"` version pin, golden test pinning the exact serialized `initialize` result — and verify `npx vitest run` passes
- [x] 2.3 Extend `tests/server.test.ts` reserved-method coverage with `doc_coverage` and `cognitive_complexity` — and verify `npx vitest run` passes

## 3. Documentation and gates

- [x] 3.1 Update `README.md` — protocol references to v1.2.0, status table rows for `doc_coverage` and `cognitive_complexity` (Not implemented) — and verify the documented local-development commands still run
- [x] 3.2 Run the CI parity gates — `npx biome check src/ tests/`, `npm run build`, `npx vitest run --coverage` — and verify all three pass with coverage at or above the 85% thresholds
- [x] 3.3 Sweep the AGENTS.md constitution summary to pin v1.2.0 (proposal Impact item; shipped alongside task 1.1)

## Workflow follow-up

- Run the spec review and code review gates; record `<!-- spec-review: passed -->` and `<!-- code-review: passed -->` markers when satisfied.
- Archive the change after review requirements are met and the change merges.

<!-- spec-review: passed -->
<!-- code-review: passed -->
