# Quickstart: Test-to-Assertion Mapping (test_mapping)

**Feature Branch**: `004-test-mapping`

**Date**: 2026-10-29

Runnable validation scenarios proving the feature end-to-end. Field
constraints, the matcher table, and the ordering key live in
[data-model.md](data-model.md); the wire contract and error table in
[contracts/test-mapping.md](contracts/test-mapping.md) — this guide
references them rather than duplicating.

## Prerequisites

- Node.js 22+
- A checkout of `reading-stone` at this feature's merge state

## Setup

```bash
cd reading-stone
npm ci
npm run build
```

## Automated validation (CI parity)

The same gates CI runs (protected — see AGENTS.md):

```bash
npx biome check src/ tests/          # lint + format
npm run build                        # tsc strict
npx vitest run --coverage            # 85% thresholds (lines/statements/functions/branches)
```

The feature's own suites: `tests/quality/` (types, matchers, collect,
assertions, pairing, inference, pipeline) plus the `test_mapping`
dispatch and capability cases in `tests/server.test.ts` and the
`prepareAnalysis` widening cases in `tests/analysis.test.ts`.

## Manual end-to-end validation (stdio protocol)

### 1. Build a scratch project tree

```bash
DEMO=$(mktemp -d /tmp/rs-mapping-demo.XXXXXX)
mkdir -p "$DEMO/src" "$DEMO/tests"
cat > "$DEMO/tsconfig.json" <<'EOF'
{"compilerOptions": {"strict": true}}
EOF
cat > "$DEMO/src/math.ts" <<'EOF'
export function add(a: number, b: number): number {
  return a + b;
}
EOF
cat > "$DEMO/tests/math.test.ts" <<'EOF'
import { add } from "../src/math";

function double(n: number): number {
  return add(n, n);
}

describe("math", () => {
  it("add", () => {
    expect(add(1, 2)).toBe(3);
    expect(add(2, 2)).toBe(4);
  });

  it("sums two numbers", () => {
    const result = add(3, 4);
    expect(result).toBe(7);
  });
});

it("delegates through a helper", () => {
  expect(double(2)).toBe(4);
});
EOF
```

The tree exercises all three pairing strategies and one provenance
pass per pair:

- `"math > add"` — test title exactly equals the target name `add` →
  **naming (exact), confidence 90**; two `expect(...).toBe(...)`
  assertions (lines 9 and 10) → two rows; asserted expressions are
  direct `add(...)` calls (provenance pass 1) → `ReturnValue`.
- `"math > sums two numbers"` — no title match; the callback calls
  `add(3, 4)` → **direct calls, confidence 80**; one assertion (line
  15) whose root identifier `result` is locally bound to the target
  call (provenance pass 2) → `ReturnValue`.
- `"delegates through a helper"` — no title match, no target call in
  the callback (the call sits in the file-local `double` helper); the
  file imports `add` and references it outside the import clause →
  **import graph, confidence 75**; one assertion (line 20) whose root
  resolves through the single helper bridge (provenance pass 3) →
  `ReturnValue`.

### 2. Drive `test_mapping` over stdio

```bash
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"root_path":"'"$DEMO"'"}}' \
  '{"jsonrpc":"2.0","id":2,"method":"test_mapping","params":{"root_path":"'"$DEMO"'"}}' \
  | node dist/main.js --stdio
```

### 3. Expected `initialize` result — capability flip (FR-014, SC-005)

`capabilities.test_mapping` is `true`; `discover` and
`classify_signals` remain `true`; `streaming`, `doc_coverage`, and
`cognitive_complexity` remain `false`.

### 4. Expected `test_mapping` result — four rows (FR-013 ordering)

Rows appear in the stable-key order
[data-model.md](data-model.md) Section 8 pins — here: by
`test_function` UTF-16 code-unit order (`"delegates through a helper"` <
`"math > add"` < `"math > sums two numbers"`), then by assertion
line. Keys are sorted by the envelope serializer:

```json
{"jsonrpc":"2.0","id":2,"result":{"mappings":[
  {"assertion_location":"tests/math.test.ts:20","assertion_type":"equality","confidence":75,"side_effect_type":"ReturnValue","target_function":"add","target_package":"src.math","test_file":"tests/math.test.ts","test_function":"delegates through a helper"},
  {"assertion_location":"tests/math.test.ts:9","assertion_type":"equality","confidence":90,"side_effect_type":"ReturnValue","target_function":"add","target_package":"src.math","test_file":"tests/math.test.ts","test_function":"math > add"},
  {"assertion_location":"tests/math.test.ts:10","assertion_type":"equality","confidence":90,"side_effect_type":"ReturnValue","target_function":"add","target_package":"src.math","test_file":"tests/math.test.ts","test_function":"math > add"},
  {"assertion_location":"tests/math.test.ts:15","assertion_type":"equality","confidence":80,"side_effect_type":"ReturnValue","target_function":"add","target_package":"src.math","test_file":"tests/math.test.ts","test_function":"math > sums two numbers"}
]}}
```

Every row carries the eight pinned keys; each pair's assertions share
the pair's confidence (assumption 17).

### 5. Determinism check (US1-6, SC-005)

```bash
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"test_mapping","params":{"root_path":"'"$DEMO"'"}}' \
  | node dist/main.js --stdio > /tmp/rs-map-a.json
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"test_mapping","params":{"root_path":"'"$DEMO"'"}}' \
  | node dist/main.js --stdio > /tmp/rs-map-b.json
diff /tmp/rs-map-a.json /tmp/rs-map-b.json && echo "byte-identical"
```

Expected: `byte-identical` — two full pipeline runs (separate walks,
bootstraps, and pairings) serialize to the same bytes.

### 6. Error-surface and scope checks

```bash
# Nonexistent root -> -32602 (the shared message, root spelling echoed)
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"test_mapping","params":{"root_path":"/tmp/rs-does-not-exist"}}' \
  | node dist/main.js --stdio

# patterns not an array of strings -> -32602
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"test_mapping","params":{"root_path":"'"$DEMO"'","patterns":"src"}}' \
  | node dist/main.js --stdio

# Extra param key -> -32602
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"test_mapping","params":{"root_path":"'"$DEMO"'","extra":1}}' \
  | node dist/main.js --stdio

# Reserved method still unimplemented -> -32601 (three names remain reserved)
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"analyze/stream","params":{"root_path":"'"$DEMO"'"}}' \
  | node dist/main.js --stdio

# Pattern set matching nothing -> empty result, never an error (US1-8, edge case 10)
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"test_mapping","params":{"root_path":"'"$DEMO"'","patterns":["nonexistent-dir"]}}' \
  | node dist/main.js --stdio
```

Expected codes and messages: the
[contracts/test-mapping.md](contracts/test-mapping.md) Section 4 table
(the shared analysis-params error table — identical to `analyze`'s);
the last call returns `{"mappings":[]}`.

### 7. Parse-only degradation (precision, never availability)

```bash
DEMO2=$(mktemp -d /tmp/rs-mapping-nocfg.XXXXXX)
mkdir -p "$DEMO2/src" "$DEMO2/tests"
cp "$DEMO/src/math.ts" "$DEMO2/src/"
cp "$DEMO/tests/math.test.ts" "$DEMO2/tests/"
# No tsconfig.json: parse-only mode — lexical import/call resolution
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"test_mapping","params":{"root_path":"'"$DEMO2"'"}}' \
  | node dist/main.js --stdio
```

Expected: the same four rows with the same confidences (90/80/75) —
import-graph and call resolution degrade to lexical name matching
(edge case 1); row shape, ordering, and pairing confidences are
unchanged.

## Cleanup

```bash
rm -rf "$DEMO" "$DEMO2" /tmp/rs-map-a.json /tmp/rs-map-b.json
```
