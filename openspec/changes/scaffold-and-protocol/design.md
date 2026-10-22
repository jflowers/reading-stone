## Context

reading-stone is the TypeScript backend for Gaze's external analyzer protocol (JSON-RPC 2.0 over stdin/stdout, protocol v1.1.0). The repository is currently empty — no source, no packaging, no tests, and no CI. snake-eyes (Python) established the analyzer platform pattern via its `scaffold-and-protocol` change; this change ports that foundation to TypeScript. Authoritative protocol source: unbound-force/gaze `docs/protocol.md` (v1.1.0). Port reference: zero-dot-force/snake-eyes `openspec/changes/scaffold-and-protocol/`.

Constitution I (Protocol Fidelity) requires every JSON-RPC response to match the v1.1.0 schema exactly, with deterministic byte-identical output. Constitution IV (Testability) requires the coverage strategy to be implemented now, not deferred.

## Goals / Non-Goals

**Goals:**

- A minimal `reading-stone` TypeScript package (Node stdlib only at runtime) buildable via `npm run build`.
- A JSON-RPC 2.0 stdio server implementing `initialize` and `shutdown` correctly per protocol v1.1.0.
- A CI pipeline (biome, tsc, vitest with 85% coverage thresholds) on Node 22 and 24.
- Tests that drive the server through injected stdin/stdout streams and assert JSON field values.

**Non-Goals:**

- `analyze`, `complexity`, `coverage`, `discover`, `test_mapping`, `classify_signals`, or `analyze/stream` — these are later issues.
- TypeScript compiler API integration (`ts.createSourceFile`, `ts.Program`, `ts.TypeChecker`).
- Any runtime third-party dependency.
- Logging library, config-file parsing, or npm publishing.

## Decisions

1. **Transport is line-delimited JSON, not LSP Content-Length headers.**
   One JSON object per line over stdin/stdout. This matches Gaze protocol v1.1.0 and keeps the server trivially streamable. Alternative (LSP framing) rejected: the protocol spec mandates line-delimited JSON.

2. **Plain TypeScript types + a deterministic sorted-key serializer.**
   No zod or schema-validation dependency. The envelope is small and fixed; a validation dependency buys nothing at this scope and violates the "prefer stdlib" default. Envelopes are built by explicit helper functions that construct plain objects; serialization uses `JSON.stringify` fed through a recursive key-sorting replacer so output is byte-identical across runs (constitution I determinism). The protocol forbids emitting `null` for omitted fields; the error-body builder omits the `data` key when it is `null`/`undefined`.

3. **Server reads injected `Readable`/`Writable` streams and accepts an injectable dispatch table.**
   A `Server` class takes `stdin` (`Readable`), `stdout` (`Writable`), and `stderr` (`Writable`) as constructor args so tests can inject `Readable.from([...])` and a capturing `Writable` sink and drive the loop deterministically (`await server.run()` resolves at EOF/shutdown). It also accepts an injectable dispatch table (`Map<string, Handler>`), replacing the default built-in `initialize`/`shutdown` table, so a test can register a raising handler to exercise the `-32603` internal-error path through stdin/stdout. This satisfies the "drive through stdin/stdout, not private helpers" test mandate. The broken-pipe test injects a minimal stub whose `write` throws.

4. **Sequential request processing.**
   Read a line, handle it, repeat. No pipelining or concurrency — Gaze issues requests sequentially, and ordering matters for `shutdown`. Lines are read via `readline` over the injected `Readable` (handles `\n` and `\r\n`); a trailing `\r` is stripped defensively.

5. **Error taxonomy is the standard JSON-RPC 2.0 set.**
   `-32700` parse error (id `null`), `-32600` invalid request, `-32601` method not found, `-32602` invalid params (fired when `initialize` `params` is absent, non-object, or lacks a string `root_path`), `-32603` internal error. On handler exception, write `-32603` with the message and log stack traces only to stderr (stdout is the protocol channel).

6. **`initialize` is idempotent; `shutdown` resolves the run loop.**
   A second `initialize` returns a valid result. `shutdown` writes `{}` then `run()` resolves and `main()` returns 0. Empty and whitespace-only lines are ignored; stdin EOF without `shutdown` also resolves cleanly. Exit codes are surfaced as the return value of `main()`; the module-entry guard sets `process.exitCode`. `process.exit()` is never called — it truncates pending asynchronous stdout writes. Tests drive `main()` in-process with injected streams; a subprocess smoke test pins the real process-boundary behavior.

7. **`--stdio` is the only CLI flag.**
   With `--stdio`, start the server and block. Without it, print `reading-stone --stdio` to stderr and return 2. No config files, no subcommands. `main(argv, io)` defaults `argv` to `process.argv.slice(2)` and each stream to its `process.*` counterpart, mirroring the `Server` seam so tests drive the entry point in-process. The module-entry guard compares `import.meta.url` against `pathToFileURL(process.argv[1]).href`.

8. **CI: `actions/setup-node` + `npm ci`, matrix 22/24, three gates.**
   `npx biome check src/ tests/`, `npm run build` (tsc strict), and `npx vitest run --coverage` (85% thresholds on lines, statements, functions, branches). The 85% gate is a governance value and is not lowered. The `actions/checkout` and `actions/setup-node` actions SHALL be pinned to full commit SHAs (tags recorded as trailing comments) for supply-chain integrity, and the workflow SHALL declare an explicit `permissions: contents: read` block (least privilege).

9. **Transport hardening bounds: 16 MiB line cap, 64-char method echo, EPIPE-safe teardown.**
   Request lines longer than 16 MiB (`MAX_LINE_CHARS`) are rejected `-32600` before parsing; undecodable input yields `-32700` while the loop stays alive (V8's `JSON.parse` is iterative and has no practical nesting depth limit, so Python's recursion-limit failure mode does not apply); the `-32601` method echo is truncated to 64 characters (`MAX_METHOD_ECHO`). Real-process EPIPE is handled by attaching an `error` listener to `process.stdout` in `main.ts` (EPIPE → destroy stdin) so the read loop ends and the process exits 0 — Node has no Python-style devnull-redirect need, and `process.exit()` is avoided so pending writes drain.

## Risks / Trade-offs

- [Protocol drift vs. Gaze v1.1.0] → Pin `protocol_version` to the literal `"1.1.0"` and assert it in tests; keep the envelope field names verbatim from the protocol spec.
- [stdlib-only serialization emits `data` as null] → Centralize in one error-body builder with a null-omission rule and unit-test the exact JSON output.
- [stdout contamination from stack traces] → Route all diagnostics to stderr; tests assert stdout contains only protocol JSON.
- [Coverage gate vs. small surface area] → `main.ts`, `protocol.ts`, and `server.ts` are covered at effectively 100% (statements and branches); the enforced governance gate is the aggregate 85%.
