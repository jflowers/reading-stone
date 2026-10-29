# Quickstart: Classification Signal Pipeline (classify_signals)

**Feature Branch**: `003-classify-signals`

Runnable validation scenarios that prove the feature works end-to-end.
Field-level rules live in
[contracts/classify-signals.md](contracts/classify-signals.md),
[contracts/analyze-classification.md](contracts/analyze-classification.md),
and [data-model.md](data-model.md); the 48-row routing table is not
duplicated here. Signal `reasoning` wording is implementation-defined
(stable per analyzer version, pinned by the test suite) — the checks
below assert the contract-pinned fields (`function`, `package`,
`side_effect_type`, `source`, `weight`, and classification
`{label, confidence}`) rather than reasoning text.

## Prerequisites

- Node.js 22+ (`node --version`)
- npm (lockfile-driven: `npm ci`)
- `jq` (for the field projections below)

## Setup

```bash
npm ci                  # install pinned dependencies
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
- Vitest passes all suites — including the new `tests/signals/` suites:
  the routing conformance suite (48 rows, closed-list vocabulary,
  data-model doc parity), the pure-rule table tests for all five
  extractors and the formula (SC-001 boundaries 80/79/50/49, clamp,
  longest-prefix, sentinel special case, strongest docstring tier,
  visibility component sums and clamp, caller buckets 0/1/2/3/4), the
  compiler-seam fixtures (exportedness forms, heritage resolution
  including the `toString` apparent-member hazard, caller index
  US3-1..7), the controlled-signal-profile fixtures asserting exact
  `{label, confidence}` arithmetic (SC-001), the analyze wiring tests
  (every effect classified, SC-004; sum-invariant consistency,
  FR-011/FR-013; parse-only degradation), and the server conformance
  tests for `classify_signals` (golden byte-identical repeats SC-005,
  capability response SC-006, shared `-32602` error table) — with
  lines/statements/functions/branches coverage at or above 85%.

## Manual end-to-end validation (stdio protocol)

### 1. Build a scratch project tree

Unlike the spec 002 quickstart tree, this tree **has a
`tsconfig.json`** — the classification signals depend on program mode
(interface heritage, caller index). Section 8 removes it to exercise
parse-only degradation.

```bash
TREE=$(mktemp -d)/demo
mkdir -p "$TREE/src"
cat > "$TREE/tsconfig.json" <<'EOF'
{
  "compilerOptions": {
    "strict": true
  }
}
EOF
cat > "$TREE/src/calc.ts" <<'EOF'
function getTotal(input: number): number {
  return input * 2;
}
EOF
cat > "$TREE/src/noise.ts" <<'EOF'
/**
 * Logs the message for debugging.
 */
function logMessage(message: string, logger: { info(m: string): void }): void {
  logger.info(message);
}
EOF
cat > "$TREE/src/banner.ts" <<'EOF'
/**
 * Logs the banner to stdout.
 */
function writeBanner(banner: string): void {
  console.log(banner);
}
EOF
cat > "$TREE/src/quiet.ts" <<'EOF'
function tweak(counter: { n: number }): void {
  counter.n = counter.n + 1;
}
EOF
cat > "$TREE/src/print.ts" <<'EOF'
interface Handler {
  handle(event: string): void;
}

class PrintHandler implements Handler {
  handle(event: string): void {
    console.log(event);
  }
}
EOF
cat > "$TREE/src/util.ts" <<'EOF'
export function formatLabel(value: string): string {
  return `[${value}]`;
}
EOF
cat > "$TREE/src/main1.ts" <<'EOF'
import { formatLabel } from "./util";

export function main1(): string {
  return formatLabel("one");
}
EOF
cat > "$TREE/src/main2.ts" <<'EOF'
import { formatLabel } from "./util";

export function main2(): string {
  return formatLabel("two");
}
EOF
```

The tree is a controlled signal profile (SC-001): one fixture per
signal category, deliberately minimal. The interface in `print.ts` is
module-local so the `+6` exported-receiver component does not fire;
`handle`'s `Handle` prefix is deliberately routed away from
`StdoutWrite` (the routing gate), leaving the interface signal alone at
the contractual boundary.

### 2. Drive `analyze` over stdio

```bash
printf '%s\n%s\n%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"root_path":"'"$TREE"'"}}' \
  '{"jsonrpc":"2.0","id":2,"method":"analyze","params":{"root_path":"'"$TREE"'"}}' \
  '{"jsonrpc":"2.0","id":3,"method":"shutdown","params":null}' \
  | node dist/main.js --stdio
```

Three response lines. id 1 — capability response now advertises
`classify_signals: true` (FR-015; SC-006):

```bash
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"root_path":"'"$TREE"'"}}' \
  | node dist/main.js --stdio | jq '.result.capabilities'
```

Expected: `discover: true`, `classify_signals: true`, and the other
four flags (`test_mapping`, `streaming`, `doc_coverage`,
`cognitive_complexity`) `false`.

### 3. Expected `analyze` result — every effect classified (FR-012, SC-004)

```bash
printf '%s\n' '{"jsonrpc":"2.0","id":2,"method":"analyze","params":{"root_path":"'"$TREE"'"}}' \
  | node dist/main.js --stdio \
  | jq '.result.functions | map({name, file, effects: [.side_effects[] | {type, classification}]})'
```

Expected (records ordered by `(file, line, name)`; effects by
`(line, column, type)`; the interface method signature in `print.ts`
is body-less and never extracted):

```json
[
  {"name": "writeBanner", "file": "src/banner.ts",
   "effects": [{"type": "StdoutWrite", "classification": {"label": "incidental", "confidence": 25}}]},
  {"name": "getTotal", "file": "src/calc.ts",
   "effects": [{"type": "ReturnValue", "classification": {"label": "contractual", "confidence": 85}}]},
  {"name": "main1", "file": "src/main1.ts",
   "effects": [{"type": "ReturnValue", "classification": {"label": "contractual", "confidence": 83}}]},
  {"name": "main2", "file": "src/main2.ts",
   "effects": [{"type": "ReturnValue", "classification": {"label": "contractual", "confidence": 83}}]},
  {"name": "logMessage", "file": "src/noise.ts",
   "effects": [{"type": "LogWrite", "classification": {"label": "incidental", "confidence": 25}}]},
  {"name": "handle", "file": "src/print.ts",
   "effects": [{"type": "StdoutWrite", "classification": {"label": "contractual", "confidence": 80}}]},
  {"name": "tweak", "file": "src/quiet.ts",
   "effects": [{"type": "PointerArgMutation", "classification": {"label": "ambiguous", "confidence": 75}}]},
  {"name": "formatLabel", "file": "src/util.ts",
   "effects": [{"type": "ReturnValue", "classification": {"label": "contractual", "confidence": 93}}]}
]
```

Checks this proves: every effect carries a `classification` (SC-004);
the label boundaries land exactly (80 → contractual, 75 → ambiguous,
25 → incidental); same-type effects share one classification per
record; detection fields (`type`, `location`, `target`, `description`,
`evidence`) are unchanged from the 002 contract.

### 4. Expected `classify_signals` result — 11 signals (FR-014 ordering)

```bash
printf '%s\n' '{"jsonrpc":"2.0","id":2,"method":"classify_signals","params":{"root_path":"'"$TREE"'"}}' \
  | node dist/main.js --stdio \
  | jq '.result.signals | map({function, package, side_effect_type, source, weight})'
```

Expected (ordered by `(package, function, side_effect_type, source)`;
`package` is the dotted module path from `derivePackage`):

```json
[
  {"function": "writeBanner", "package": "src.banner", "side_effect_type": "StdoutWrite", "source": "contradiction", "weight": -20},
  {"function": "writeBanner", "package": "src.banner", "side_effect_type": "StdoutWrite", "source": "docstring", "weight": -15},
  {"function": "writeBanner", "package": "src.banner", "side_effect_type": "StdoutWrite", "source": "naming_convention", "weight": 10},
  {"function": "getTotal", "package": "src.calc", "side_effect_type": "ReturnValue", "source": "naming_convention", "weight": 10},
  {"function": "main1", "package": "src.main1", "side_effect_type": "ReturnValue", "source": "visibility", "weight": 8},
  {"function": "main2", "package": "src.main2", "side_effect_type": "ReturnValue", "source": "visibility", "weight": 8},
  {"function": "logMessage", "package": "src.noise", "side_effect_type": "LogWrite", "source": "docstring", "weight": -15},
  {"function": "logMessage", "package": "src.noise", "side_effect_type": "LogWrite", "source": "naming_convention", "weight": -10},
  {"function": "handle", "package": "src.print", "side_effect_type": "StdoutWrite", "source": "interface", "weight": 30},
  {"function": "formatLabel", "package": "src.util", "side_effect_type": "ReturnValue", "source": "caller_count", "weight": 10},
  {"function": "formatLabel", "package": "src.util", "side_effect_type": "ReturnValue", "source": "visibility", "weight": 8}
]
```

### 5. Classification arithmetic walkthrough (SC-001, FR-011)

`confidence = clamp(0, 100, 50 + tierBoost + Σ(extractor weights) − 20·contradiction)`:

| Function | Effect (tier) | Signals | Arithmetic | Result |
|---|---|---|---|---|
| `getTotal` | ReturnValue (P0 +25) | naming `Get` +10 | 50+25+10 | 85 contractual |
| `logMessage` | LogWrite (P2 +0) | naming `log` −10, docstring `Logs` −15 | 50−10−15 | 25 incidental |
| `writeBanner` | StdoutWrite (P3 +0) | naming `Write` +10, docstring `Logs` −15, contradiction −20 | 50+10−15−20 | 25 incidental |
| `tweak` | PointerArgMutation (P0 +25) | none | 50+25 | 75 ambiguous |
| `handle` | StdoutWrite (P3 +0) | interface +30 | 50+30 | 80 contractual (boundary) |
| `formatLabel` | ReturnValue (P0 +25) | caller_count +10 (2 modules), visibility +8 | 50+25+10+8 | 93 contractual |
| `main1`/`main2` | ReturnValue (P0 +25) | visibility +8 | 50+25+8 | 83 contractual |

Note the polarity mechanics: `logMessage` is all-negative (no
contradiction); `writeBanner` mixes the positive naming signal with the
negative docstring signal (contradiction fires, exactly once);
`handle`'s `Handle` prefix is routed away from StdoutWrite so it emits
no naming signal at all. Each confidence equals `50 + tierBoost +
Σ(emitted signal weights for the pair)` — the contradiction row
included in the sum as a negative-weight entry — the FR-011
sum-invariant a Gaze consumer relies on; the conformance suite asserts
it for every pair.

### 6. Determinism check (SC-005)

```bash
for M in analyze classify_signals; do
  REQ='{"jsonrpc":"2.0","id":2,"method":"'"$M"'","params":{"root_path":"'"$TREE"'"}}'
  printf '%s\n%s\n' "$REQ" "$REQ" | node dist/main.js --stdio \
    | sed -n '1p;2p' | uniq -c   # expect: "2 <line>" per method
done
```

Expected: each method reports `2 <identical line>` — byte-identical
repeat responses, classifications and signals included.

### 7. Error-surface and scope checks

```bash
# Nonexistent root -> -32602 (shared message with analyze)
echo '{"jsonrpc":"2.0","id":9,"method":"classify_signals","params":{"root_path":"/no/such/dir"}}' \
  | node dist/main.js --stdio
# patterns not an array of strings -> -32602
echo '{"jsonrpc":"2.0","id":9,"method":"classify_signals","params":{"root_path":"'"$TREE"'","patterns":"src"}}' \
  | node dist/main.js --stdio
# Extra param key -> -32602
echo '{"jsonrpc":"2.0","id":9,"method":"classify_signals","params":{"root_path":"'"$TREE"'","verbose":true}}' \
  | node dist/main.js --stdio
# Reserved method still unimplemented -> -32601 (four names remain reserved)
echo '{"jsonrpc":"2.0","id":9,"method":"test_mapping","params":{"root_path":"'"$TREE"'"}}' \
  | node dist/main.js --stdio
# Pattern set matching nothing -> empty result, never an error
echo '{"jsonrpc":"2.0","id":9,"method":"classify_signals","params":{"root_path":"'"$TREE"'","patterns":["nope"]}}' \
  | node dist/main.js --stdio | jq -c '.result'
```

Expected: `-32602`, `-32602`, `-32602`, `-32601`, and
`{"signals":[]}` respectively. `classify_signals` adds no error codes
or messages of its own — its error surface is exactly the shared
analysis-method surface.

### 8. Parse-only degradation (precision, never availability)

```bash
rm "$TREE/tsconfig.json"
printf '%s\n' '{"jsonrpc":"2.0","id":2,"method":"analyze","params":{"root_path":"'"$TREE"'"}}' \
  | node dist/main.js --stdio \
  | jq '.result.functions | map({name, effects: [.side_effects[] | .classification]})'
printf '%s\n' '{"jsonrpc":"2.0","id":2,"method":"classify_signals","params":{"root_path":"'"$TREE"'"}}' \
  | node dist/main.js --stdio | jq '.result.signals | length'
```

Expected: every effect still carries a classification (SC-004 holds in
both modes), and the signal count drops from 11 to 9 — the
checker-dependent `interface` and `caller_count` signals are absent.
The two visible classification shifts: `handle` 80 → 50 (`ambiguous`,
the P3 floor with no signals) and `formatLabel` 93 → 83 (caller signal
gone; the syntactic visibility +8 survives). All other classifications
are unchanged: naming, docstring, and the syntactic visibility
components do not need the checker. Degradation reduces precision,
never availability (Assumption 10, extended to caller_count — see
[research.md](research.md) R7).

## Cleanup

```bash
rm -rf "$(dirname "$TREE")"
```
