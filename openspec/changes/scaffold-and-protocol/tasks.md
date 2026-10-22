## 1. Package scaffold

- [x] 1.1 Create `package.json` (name `reading-stone`, version `0.1.0`, `type: module`, `engines.node >=22`, Apache-2.0, `bin` `reading-stone` → `dist/main.js`, dev deps `typescript`/`vitest`/`@vitest/coverage-v8`/`@biomejs/biome`/`@types/node`, scripts `build`/`check`/`format`/`test`/`prepublishOnly`) and commit the generated `package-lock.json` for reproducible CI
- [x] 1.2 Create `tsconfig.json` (ES2023, NodeNext, strict, `outDir dist`, `rootDir src`), `biome.json` (line width 88), and `vitest.config.ts` (v8 coverage, 85% thresholds on lines/statements/functions/branches)
- [x] 1.3 Create `src/index.ts` with `export const VERSION = "0.1.0"`
- [x] 1.4 Create `NOTICE` with the exact attribution content specified in `specs/cli/spec.md`

## 2. Protocol types

- [x] 2.1 Create `src/protocol.ts` with `JsonRpcRequest`, `JsonRpcSuccess`, `JsonRpcErrorBody`, and `JsonRpcError` types plus builder functions
- [x] 2.2 Add standard error code constants (`PARSE_ERROR`, `INVALID_REQUEST`, `METHOD_NOT_FOUND`, `INVALID_PARAMS`, `INTERNAL_ERROR`)
- [x] 2.3 Implement `initialize` result construction (`analyzer_name`, `language`, `language_version` from `process.versions.node`, `protocol_version = "1.1.0"`, four `false` capability flags)
- [x] 2.4 Implement `shutdown` result (`{}`)
- [x] 2.5 Implement deterministic serialization via a recursive sorted-key stringify helper with the `data`-omitted-when-null rule

## 3. Server loop

- [x] 3.1 Create `src/server.ts` with a `Server` class accepting injected `stdin`/`stdout`/`stderr` streams and an injectable dispatch table (`Map` from method name to handler), defaulting to `initialize`/`shutdown`
- [x] 3.2 Implement line-delimited read/write via `readline` with trailing `\r` stripped
- [x] 3.3 Implement sequential dispatch table (`initialize`, `shutdown`) and `-32601` fallback
- [x] 3.4 Implement error handling: `-32700` parse error (id null), `-32600` invalid request, `-32603` internal error (stack traces to stderr only)
- [x] 3.5 Implement idempotent `initialize` and `shutdown` resolving the run loop; empty-line ignore and EOF clean exit
- [x] 3.6 Implement transport hardening: 16 MiB line cap (`-32600` before parsing), 64-char method echo truncation, and clean teardown on write failure

## 4. CLI entry point

- [x] 4.1 Create `src/main.ts` with `main()` parsing `--stdio`
- [x] 4.2 `--stdio` present → start server and block; absent or extra args → usage to stderr and return 2; module-entry guard sets `process.exitCode` (never `process.exit`)

## 5. Tests

- [x] 5.1 Create `tests/protocol.test.ts` covering envelope serialization, falsy/string `id` round-trip, error codes, initialize result schema, shutdown result, and `data`-omission
- [x] 5.2 Create `tests/server.test.ts` covering all `specs/server/spec.md` scenarios (initialize roundtrip, unknown method, malformed JSON, missing method, missing `jsonrpc`, wrong `jsonrpc` version, non-object request, empty-line ignore, CRLF line endings, order preservation, repeated initialize, invalid-params `-32602`, reserved methods → `-32601`, shutdown, EOF, broken-pipe clean teardown, `-32603` internal error via an injected raising handler, oversize line, method echo truncation) driving through injected stdin/stdout
- [x] 5.3 Create `tests/cli.test.ts` covering `main()` for `--stdio` present (starts server) and absent (usage + exit 2), `VERSION`, package metadata, and `NOTICE` exact-text content

## 6. CI

- [x] 6.1 Create `.github/workflows/ci.yml` (push+PR to main, ubuntu-latest, Node 22/24 matrix, `actions/checkout` and `actions/setup-node` pinned to full commit SHAs resolved from the upstream repos at authoring time, `npm ci`, explicit `permissions: contents: read` block, and a header comment block describing the workflow's purpose)
- [x] 6.2 Add the three gate steps: `npx biome check src/ tests/`, `npm run build`, `npx vitest run --coverage` (85% thresholds)

## 7. Verification

- [x] 7.1 Run `npm ci` from a clean checkout and confirm it succeeds
- [x] 7.2 Run `npx biome check src/ tests/`
- [x] 7.3 Run `npm run build`
- [x] 7.4 Run `npx vitest run --coverage`
- [x] 7.5 Manually verify `node dist/main.js --stdio` waits on stdin and the initialize→shutdown lifecycle works

<!-- spec-review: passed -->
<!-- code-review: passed -->
