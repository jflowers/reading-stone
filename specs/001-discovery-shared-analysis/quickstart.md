# Quickstart: Discovery and Shared Analysis Infrastructure

**Feature Branch**: `001-discovery-shared-analysis`

Runnable validation scenarios that prove the feature works end-to-end.
Field-level rules live in [contracts/discover.md](contracts/discover.md)
and [data-model.md](data-model.md); taxonomy conformance details are
not duplicated here.

## Prerequisites

- Node.js 22+ (`node --version`)
- npm (lockfile-driven: `npm ci`)

## Setup

```bash
npm ci                  # install pinned dev dependencies
npm run build           # tsc strict build -> dist/
```

## Automated validation (CI parity)

Run the same gates CI runs (derived from `.github/workflows/ci.yml`):

```bash
npx biome check src/ tests/     # lint + format must pass
npm run build                   # strict type check + emit
npx vitest run --coverage       # full suite at 85% thresholds
```

Expected outcomes:

- Biome exits 0 with no findings.
- `tsc` emits without errors.
- Vitest passes all suites — including the new taxonomy conformance
  (48 types, tier sizes 6/11/16/9/6, 11 alias resolutions), model
  serialization (omit-unset optionals), discovery classification,
  safety fixtures (oversized / FIFO / unreadable / symlink-escape
  skip-and-continue), and the discover protocol conformance cases —
  with lines/statements/functions/branches coverage at or above 85%.

## Manual end-to-end validation (stdio protocol)

### 1. Build a scratch project tree

```bash
TREE=$(mktemp -d)/demo
mkdir -p "$TREE/src/utils" "$TREE/tests" "$TREE/node_modules/junk"
cat > "$TREE/src/utils/math.ts" <<'EOF'
export function add(a: number, b: number): number {
  return a + b;
}
EOF
cat > "$TREE/src/index.ts" <<'EOF'
export { add } from "./utils/math.js";
EOF
cat > "$TREE/tests/math.test.ts" <<'EOF'
import { expect, it } from "vitest";
import { add } from "../src/index.js";
it("adds", () => {
  expect(add(1, 2)).toBe(3);
});
EOF
cat > "$TREE/vitest.config.ts" <<'EOF'
import { defineConfig } from "vitest/config";
export default defineConfig({});
EOF
cat > "$TREE/node_modules/junk/hidden.ts" <<'EOF'
export const x = 1;
EOF
```

### 2. Drive the analyzer over stdio

```bash
printf '%s\n%s\n%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"root_path":"'"$TREE"'"}}' \
  '{"jsonrpc":"2.0","id":2,"method":"discover","params":{"root_path":"'"$TREE"'"}}' \
  '{"jsonrpc":"2.0","id":3,"method":"shutdown","params":null}' \
  | node dist/main.js --stdio
```

### 3. Expected output (exact)

Three response lines; keys sorted by the deterministic serializer:

- id 1 — result with `protocol_version: "1.2.0"` and
  `capabilities.discover: true` (the other five flags `false`).
- id 2 — result:

  ```json
  {"jsonrpc":"2.0","id":2,"result":{
    "framework":"vitest",
    "source_files":["src/index.ts","src/utils/math.ts","vitest.config.ts"],
    "test_files":["tests/math.test.ts"]}}
  ```

  (on one line, keys sorted: `framework` < `source_files` <
  `test_files`). Note: `node_modules/junk/hidden.ts` is absent
  (pruned), `tests/math.test.ts` is a test (directory component +
  `.test.` segment), and `vitest.config.ts` is a source file (no
  special casing).

- id 3 — `{"jsonrpc":"2.0","id":3,"result":{}}` and the process exits
  0.

### 4. Determinism check (SC-003)

Run the discover request twice and byte-compare:

```bash
REQ='{"jsonrpc":"2.0","id":2,"method":"discover","params":{"root_path":"'"$TREE"'"}}'
printf '%s\n%s\n' "$REQ" "$REQ" | node dist/main.js --stdio \
  | sed -n '1p;2p' | uniq -c    # expect: "2 <line>" — identical responses
```

### 5. Error-surface checks

```bash
# Nonexistent root -> -32602
echo '{"jsonrpc":"2.0","id":9,"method":"discover","params":{"root_path":"/no/such/dir"}}' \
  | node dist/main.js --stdio
# Extra param key -> -32602
echo '{"jsonrpc":"2.0","id":9,"method":"discover","params":{"root_path":"/tmp","patterns":[]}}' \
  | node dist/main.js --stdio
# Reserved method still unimplemented -> -32601
echo '{"jsonrpc":"2.0","id":9,"method":"analyze","params":{"root_path":"/tmp"}}' \
  | node dist/main.js --stdio
```

Expected: `-32602`, `-32602`, `-32601` respectively, one line each.

### 6. Safety-skip check (stderr diagnostics)

Create a tree containing an oversized file and an unreadable file:

```bash
SAFE=$(mktemp -d)
truncate -s 17825793 "$SAFE/big.ts"        # 16 MiB + 1 byte, sparse
echo 'export const x = 1;' > "$SAFE/locked.ts"
chmod 000 "$SAFE/locked.ts"
echo '{"jsonrpc":"2.0","id":2,"method":"discover","params":{"root_path":"'"$SAFE"'"}}' \
  | node dist/main.js --stdio 2>diagnostics.txt
cat diagnostics.txt                        # exactly two skip lines, one per file
```

Expected: a success response with empty `source_files`/`test_files`
and `framework: "unknown"` on stdout, and exactly two one-line
diagnostics on stderr (one for the oversized file, one for the
unreadable file). The request completes; nothing but the response is
written to stdout.

## Cleanup

```bash
rm -rf "$(dirname "$TREE")" "$SAFE" diagnostics.txt
```
