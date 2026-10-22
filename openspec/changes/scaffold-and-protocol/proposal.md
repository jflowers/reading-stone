## Why

reading-stone is the TypeScript Gaze external analyzer backend, but the repository is empty — no source, no `package.json`, no tests, and no CI. Gaze (Go) spawns it as a subprocess and speaks JSON-RPC 2.0 over stdin/stdout (protocol v1.1.0), so the project cannot even boot without a scaffold and a working `initialize`/`shutdown` lifecycle. snake-eyes (Python) established the analyzer platform pattern; this change ports that foundation to TypeScript, validating the pattern's portability.

## What Changes

- Add a TypeScript package scaffold: `package.json`, `tsconfig.json`, `biome.json`, `vitest.config.ts`, `src/index.ts`, `src/main.ts`, and a `NOTICE` file for snake-eyes attribution.
- Add `src/protocol.ts` with TypeScript types for the JSON-RPC 2.0 envelope and the `initialize`/`shutdown` method contracts, plus standard error codes and deterministic serialization.
- Add `src/server.ts`: a line-delimited JSON-RPC server loop over stdin/stdout with sequential dispatch and graceful error handling.
- Add `.github/workflows/ci.yml` running biome, tsc, and vitest-with-coverage on Node 22 and 24.
- Add `tests/protocol.test.ts`, `tests/server.test.ts`, and `tests/cli.test.ts` driving the server through injected streams.

Out of scope (later issues): analysis, complexity, coverage, discovery, test mapping, classify signals, streaming, TypeScript compiler API integration, and any runtime third-party dependency.

## Capabilities

### New Capabilities

- `protocol`: JSON-RPC 2.0 envelope types and the `initialize`/`shutdown` method contracts (request params, result schemas, error codes, serialization).
- `server`: the line-delimited JSON-RPC stdio server loop — request parsing, sequential dispatch, and error handling.
- `cli`: package scaffold and the `reading-stone --stdio` entry point (usage-on-error behavior).

### Modified Capabilities

None — this is the first implementation; no existing OpenSpec specs exist yet.

### Removed Capabilities

None.

## Impact

- New files under `src/`, `tests/`, and `.github/workflows/`.
- No changes to existing code (there is none) and no runtime third-party dependencies — Node.js stdlib only.
- Dev-only dependencies added: `typescript`, `vitest`, `@vitest/coverage-v8`, `@biomejs/biome`, `@types/node`.
- Establishes the project CI gate: biome lint/format, tsc strict build, vitest with 85% coverage thresholds.

## Constitution Alignment

- **I. Protocol Fidelity** — Implemented directly: exact v1.1.0 handshake (`protocol_version = "1.1.0"`), exact envelope/result field names, the standard JSON-RPC error taxonomy, deterministic sorted-key serialization, and `data`-omission, all pinned by tests.
- **II. Detection Accuracy** — N/A: no analysis/detection code is introduced in this change (scaffold + `initialize`/`shutdown` lifecycle only).
- **III. TypeScript-Native Analysis** — N/A: no analysis/detection code is introduced in this change; the TypeScript compiler API arrives in later issues.
- **IV. Testability** — The coverage strategy is implemented now, not deferred: effectively 100% statement-and-branch coverage of `protocol.ts`, `server.ts`, and `main.ts`; the enforced governance gate is the 85% aggregate (v8 provider, all four metrics).
- **V. Analysis Safety** — No analyzed source is processed in this change; no runtime dependencies are added (Node stdlib only), and CI actions are pinned to full commit SHAs.
