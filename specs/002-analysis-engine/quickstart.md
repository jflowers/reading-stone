# Quickstart: Analysis Engine (analyze, complexity, coverage)

**Feature Branch**: `002-analysis-engine`

Runnable validation scenarios that prove the feature works end-to-end.
Field-level rules live in [contracts/analyze.md](contracts/analyze.md),
[contracts/complexity.md](contracts/complexity.md),
[contracts/coverage.md](contracts/coverage.md), and
[data-model.md](data-model.md); the disposition table is not duplicated
here. Effect `description` wording is implementation-defined (stable
per analyzer version, pinned by the test suite) — the checks below
assert the contract-pinned fields (`type`, `location`, `target`,
counts, orderings) rather than description text.

## Prerequisites

- Node.js 22+ (`node --version`)
- npm (lockfile-driven: `npm ci`)
- `jq` (for the field projections below)

## Setup

```bash
npm ci                  # install pinned dependencies (typescript now runtime)
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
- Vitest passes all suites — including the six P0 conformance fixtures
  (zero false negatives/positives, SC-001), purity fixtures (SC-002),
  the golden byte-identical response tests for all three methods
  (SC-003/SC-006), the vitest- and jest-shaped coverage documents plus
  missing/invalid fallbacks (SC-004), test/generated-file exclusion
  (SC-005), and the disposition-table conformance suite (48 rows,
  closed-set dispositions, non-empty N/A rationale — SC-008) — with
  lines/statements/functions/branches coverage at or above 85%.

## Manual end-to-end validation (stdio protocol)

### 1. Build a scratch project tree

```bash
TREE=$(mktemp -d)/demo
mkdir -p "$TREE/src/utils" "$TREE/tests"
cat > "$TREE/src/utils/math.ts" <<'EOF'
export function add(a: number, b: number): number {
  return a + b;
}
EOF
cat > "$TREE/src/score.ts" <<'EOF'
export function grade(score: number): string {
  if (score >= 90) {
    return "A";
  }
  return "F";
}
EOF
cat > "$TREE/src/mutate.ts" <<'EOF'
export class Counter {
  count = 0;

  bump(): void {
    this.count = this.count + 1;
  }
}

export function reset(counter: Counter): void {
  counter.count = 0;
}
EOF
cat > "$TREE/tests/math.test.ts" <<'EOF'
import { expect, it } from "vitest";
import { add } from "../src/utils/math.js";
it("adds", () => {
  expect(add(1, 2)).toBe(3);
});
EOF
```

Note: this tree has **no `tsconfig.json`** — it exercises the
parse-only fallback (FR-004). Adding a valid `tsconfig.json` exercises
the `ts.Program` bootstrap path (FR-003); both must produce the same
records for this tree.

### 2. Drive `analyze` over stdio

```bash
printf '%s\n%s\n%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"root_path":"'"$TREE"'"}}' \
  '{"jsonrpc":"2.0","id":2,"method":"analyze","params":{"root_path":"'"$TREE"'"}}' \
  '{"jsonrpc":"2.0","id":3,"method":"shutdown","params":null}' \
  | node dist/main.js --stdio
```

### 3. Expected `analyze` result

Three response lines. id 1 — unchanged capability response
(`discover: true`, five flags `false`, FR-028). id 2 — project the
contract fields:

```bash
printf '%s\n' '{"jsonrpc":"2.0","id":2,"method":"analyze","params":{"root_path":"'"$TREE"'"}}' \
  | node dist/main.js --stdio \
  | jq '.result.functions | map({name, file, line, effects: [.side_effects[] | {type, location, target}]})'
```

Expected (records ordered by `(file, line, name)`; effects by
`(line, column, type)`):

```json
[
  {"name": "bump",  "file": "src/mutate.ts", "line": 4,
   "effects": [{"type": "ReceiverMutation",    "location": "src/mutate.ts:5:5",  "target": "this.count"}]},
  {"name": "reset", "file": "src/mutate.ts", "line": 9,
   "effects": [{"type": "PointerArgMutation",  "location": "src/mutate.ts:10:3", "target": "counter.count"}]},
  {"name": "grade", "file": "src/score.ts",   "line": 1,
   "effects": [{"type": "ReturnValue", "location": "src/score.ts:3:5", "target": null},
               {"type": "ReturnValue", "location": "src/score.ts:5:3", "target": null}]},
  {"name": "add",   "file": "src/utils/math.ts", "line": 1,
   "effects": [{"type": "ReturnValue", "location": "src/utils/math.ts:2:3", "target": null}]}
]
```

Checks this proves: P0 detection with exact types/locations/targets
(SC-001 — receiver vs param-write split per FR-014/FR-015);
`tests/math.test.ts` produces no records (SC-005 — test files excluded
per FR-002); the wire records carry no `classification` field
(FR-019). A function with no returns/throws/writes reports an empty
`effects` array (SC-002) — e.g. adding `export function noop() {}`
yields `"effects": []`.

### 4. Expected `complexity` result

```bash
printf '%s\n' '{"jsonrpc":"2.0","id":2,"method":"complexity","params":{"root_path":"'"$TREE"'"}}' \
  | node dist/main.js --stdio | jq '.result.functions'
```

Expected — same extraction set and ordering as `analyze` (FR-022);
`grade` = 1 + one `if` = 2 (FR-021); `bump`'s class-property
initializer `count = 0` is not a function and contributes nothing:

```json
[
  {"name": "bump",  "file": "src/mutate.ts", "line": 4, "complexity": 1},
  {"name": "reset", "file": "src/mutate.ts", "line": 9, "complexity": 1},
  {"name": "grade", "file": "src/score.ts",  "line": 1, "complexity": 2},
  {"name": "add",   "file": "src/utils/math.ts", "line": 1, "complexity": 1}
]
```

(with `package` fields present; `jq` shows them alongside — the five
fields per entry are exactly `name`, `package`, `file`, `line`,
`complexity`.)

### 5. Expected `coverage` result

Author an Istanbul-format artifact (the conventional location; the
`coverage/` directory is only pruned from *walking*, the artifact is
read directly — FR-023/FR-025):

```bash
mkdir -p "$TREE/coverage"
cat > "$TREE/coverage/coverage-final.json" <<EOF
{"$TREE/src/score.ts": {
  "statementMap": {
    "0": {"start": {"line": 1, "column": 0}, "end": {"line": 5, "column": 1}},
    "1": {"start": {"line": 2, "column": 2}, "end": {"line": 4, "column": 3}},
    "2": {"start": {"line": 4, "column": 2}, "end": {"line": 5, "column": 12}}
  },
  "fnMap": {
    "0": {"name": "grade",
          "decl": {"start": {"line": 1, "column": 0}, "end": {"line": 1, "column": 41}},
          "loc":  {"start": {"line": 1, "column": 0}, "end": {"line": 5, "column": 1}},
          "line": 1}
  },
  "f": {"0": 3}, "s": {"0": 3, "1": 3, "2": 0}, "branchMap": {}, "b": {}
}}
EOF
printf '%s\n' '{"jsonrpc":"2.0","id":2,"method":"coverage","params":{"root_path":"'"$TREE"'"}}' \
  | node dist/main.js --stdio | jq '.result.functions'
```

Expected — all three statements attribute to `grade`'s range (innermost
rule, FR-023); two covered (`s` > 0), one not; full-precision
percentage (Assumption 6):

```json
[{"file": "src/score.ts", "function": "grade", "start_line": 1, "end_line": 5,
  "covered_stmts": 2, "total_stmts": 3, "percentage": 66.66666666666667}]
```

Empty-artifact fallback (FR-025): `rm "$TREE/coverage/coverage-final.json"`
and re-run — the result is `{"functions": []}` with **no** error.

### 6. Determinism check (SC-006)

```bash
for M in analyze complexity coverage; do
  REQ='{"jsonrpc":"2.0","id":2,"method":"'"$M"'","params":{"root_path":"'"$TREE"'"}}'
  printf '%s\n%s\n' "$REQ" "$REQ" | node dist/main.js --stdio \
    | sed -n '1p;2p' | uniq -c   # expect: "2 <line>" per method
done
```

Expected: each method reports `2 <identical line>` — byte-identical
repeat responses.

### 7. Error-surface and scope checks

```bash
# Nonexistent root -> -32602 (shared message with discover)
echo '{"jsonrpc":"2.0","id":9,"method":"analyze","params":{"root_path":"/no/such/dir"}}' \
  | node dist/main.js --stdio
# patterns not an array of strings -> -32602
echo '{"jsonrpc":"2.0","id":9,"method":"analyze","params":{"root_path":"'"$TREE"'","patterns":"src"}}' \
  | node dist/main.js --stdio
# Extra param key -> -32602
echo '{"jsonrpc":"2.0","id":9,"method":"complexity","params":{"root_path":"'"$TREE"'","verbose":true}}' \
  | node dist/main.js --stdio
# Reserved method still unimplemented -> -32601
echo '{"jsonrpc":"2.0","id":9,"method":"test_mapping","params":{"root_path":"'"$TREE"'"}}' \
  | node dist/main.js --stdio
# Pattern set matching nothing -> empty result, never an error (FR-001)
echo '{"jsonrpc":"2.0","id":9,"method":"analyze","params":{"root_path":"'"$TREE"'","patterns":["nope"]}}' \
  | node dist/main.js --stdio | jq -c '.result'
# Pattern subtree scoping -> only src/utils records
echo '{"jsonrpc":"2.0","id":9,"method":"analyze","params":{"root_path":"'"$TREE"'","patterns":["src/utils/..."]}}' \
  | node dist/main.js --stdio | jq -c '.result.functions | map(.file)'
```

Expected: `-32602`, `-32602`, `-32602`, `-32601`, `{"functions":[]}`,
and `["src/utils/math.ts"]` respectively.

### 8. Type-error tolerance (FR-005)

```bash
cat > "$TREE/src/broken.ts" <<'EOF'
export function wrong(x: number): string {
  return x * "not a number";
}
EOF
printf '%s\n' '{"jsonrpc":"2.0","id":2,"method":"analyze","params":{"root_path":"'"$TREE"'"}}' \
  | node dist/main.js --stdio | jq '.result.functions | map(select(.file == "src/broken.ts"))'
```

Expected: `wrong` still reports its `ReturnValue` effect — type errors
never abort analysis (a valid `tsconfig.json` in the tree exercises the
same guarantee through the `ts.Program` path).

## Cleanup

```bash
rm -rf "$(dirname "$TREE")"
```
