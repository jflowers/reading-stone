# Tasks

## 1. Constitution amendment

- [x] 1.1 Amend the Upstream Alignment section of `.specify/memory/constitution.md` to pin protocol v1.2.0 (referencing alignment issue zero-dot-force/reading-stone#1) and bump the constitution version footer to 1.0.1; verify the document still names all five principles unchanged

## 2. Protocol layer

- [ ] 2.1 Update `src/protocol.ts` — `PROTOCOL_VERSION = "1.2.0"`, `Capabilities` gains `doc_coverage` and `cognitive_complexity`, `initializeResult()` emits both as `false` — and verify `npm run build` passes
- [ ] 2.2 Update `tests/protocol.test.ts` — six-flag capability set, `"1.2.0"` version pin, golden test pinning the exact serialized `initialize` result — and verify `npx vitest run` passes

## 3. Documentation and gates

- [ ] 3.1 Update `README.md` — protocol references to v1.2.0, status table rows for `doc_coverage` and `cognitive_complexity` (Not implemented) — and verify the documented local-development commands still run
- [ ] 3.2 Run the CI parity gates — `npx biome check src/ tests/`, `npm run build`, `npx vitest run --coverage` — and verify all three pass with coverage at or above the 85% thresholds

## Workflow follow-up

- Run the spec review and code review gates; record `<!-- spec-review: passed -->` and `<!-- code-review: passed -->` markers when satisfied.
- Archive the change after review requirements are met and the change merges.
