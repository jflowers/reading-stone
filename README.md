# Reading Stone

**TypeScript analyzer backend for [Gaze](https://github.com/unbound-force/gaze).**

Reading Stone is a Gaze-spawned subprocess. It speaks JSON-RPC 2.0 over stdin/stdout
(protocol v1.2.0). Gaze owns the CLI, scoring, and reports.

## Current status (v0.1.0)

| Method | Status |
|--------|--------|
| `initialize` | Implemented |
| `shutdown` | Implemented |
| `discover` | Implemented (params `{root_path}`; result `{source_files, test_files, framework}`) |
| `analyze` | Implemented (params `{root_path, patterns}`; result `{"functions": [...]}` — FunctionRecords with `side_effects` arrays, every effect carrying `classification: {label, confidence}`) |
| `analyze/stream` | Not implemented (`-32601`) |
| `complexity` | Implemented (params `{root_path, patterns}`; result `{"functions": [...]}` — ComplexityEntry records) |
| `coverage` | Implemented (params `{root_path, patterns}`; result `{"functions": [...]}` — CoverageEntry records) |
| `classify_signals` | Implemented (params `{root_path, patterns}`; result `{"signals": [...]}` — the raw classification signal feed) |
| `test_mapping` | Not implemented (`-32601`) |
| `doc_coverage` | Not implemented (`-32601`) |
| `cognitive_complexity` | Not implemented (`-32601`) |

`discover` is implemented and advertised via `capabilities.discover: true`.
`analyze`, `complexity`, and `coverage` are implemented as core protocol
methods — not gated behind a capability flag — and share one params surface:
`root_path` plus an optional `patterns` array of path-prefix strings.
`classify_signals` is implemented and advertised via
`capabilities.classify_signals: true`; Gaze calls it only when that flag is
true, with the same params surface. The remaining capability flags
(`test_mapping`, `streaming`, `doc_coverage`, `cognitive_complexity`) are
`false` at handshake; their methods are the roadmap — see
`openspec/changes/`.

The side effects `analyze` reports are governed by the disposition table:
for each of the 48 canonical taxonomy types it records the tier, the
disposition (how completely Reading Stone detects it), the TypeScript
constructs detected, and the rationale for `N/A` rows — see
[docs/effect-disposition.md](docs/effect-disposition.md).

## Classification

Every effect in an `analyze` response carries a
`classification: {label, confidence}` computed by a deterministic signal
pipeline that runs per (function, effect-type) pair. Six signal sources
produce the evidence — five extractors plus one synthesized penalty:

- `interface` — the function satisfies a declared interface member (+30)
- `visibility` — exported function (+8), exported return type (+6), exported
  receiver (+6), clamped at +20
- `caller_count` — 1, 2–3, or 4+ distinct modules calling the function
  (+5/+10/+15; zero callers emits no signal)
- `naming_convention` — contractual or incidental name prefixes (±10), plus
  an `Err`-prefixed name on a `SentinelError` effect (+30)
- `docstring` — JSDoc `@returns`/`@throws` tags (+15), indirect prose verbs
  (+5), incidental verbs (−15)
- `contradiction` — synthesized (−20) when a pair's evidence mixes positive
  and negative weights

Confidence is `50 + tier_boost + Σ(signal weights) − 20` when a
contradiction is present (`tier_boost`: +25 for P0, +10 for P1, +0 for
P2–P4), clamped to [0, 100]. Labels derive from the clamped confidence:
`contractual` ≥ 80, `ambiguous` [50, 80), `incidental` < 50. An effect with
no matching signals is never dropped — it classifies at the ambiguous floor
(50 + tier_boost).

Without a usable `tsconfig.json` (parse-only mode), the three
checker-dependent components — the `interface` signal, the `caller_count`
signal, and the exported-return-type (+6) component of `visibility` — are
absent, so classifications drift toward `ambiguous`; every effect is still
classified (degradation reduces precision, never availability).

The `classify_signals` method returns the raw feed behind those
classifications: one signal per matched (function, effect-type, source)
triple — `function`, `package`, `side_effect_type`, `source`, integer
`weight`, and a short `reasoning` — deterministically ordered by
`(package, function, side_effect_type, source)`. Both methods share one
pipeline: summing a pair's emitted signal weights (the contradiction row
included) back into `50 + tier_boost` reproduces the confidence `analyze`
reports.

## Installation

Requires Node.js 22+.

### From a clone (local development)

```bash
npm install
npm run build
node dist/main.js --stdio
```

The package installs one bin entry point that launches the JSON-RPC analyzer
over stdin/stdout:

- `reading-stone` — the primary entry point.

## Configuration

Point Gaze at the entry point in `.gaze.yaml`:

```yaml
analyzers:
  typescript:
    command: node
    args: ["dist/main.js", "--stdio"]
```

## Project structure

```text
reading-stone/
├── src/
│   ├── index.ts          # Package surface (VERSION + taxonomy/model/signal re-exports)
│   ├── main.ts           # Entry point (reading-stone --stdio)
│   ├── server.ts         # JSON-RPC server (stdin/stdout)
│   ├── protocol.ts       # Request/response types
│   ├── taxonomy.ts       # Side-effect taxonomy (48 types, tiers, aliases)
│   ├── models.ts         # Effect/FunctionRecord/classification records, serializers, derivePackage
│   ├── safeio.ts         # Bounded safe file reader with skip diagnostics
│   ├── discovery.ts      # Project walking, file classification, framework detection, discover()
│   ├── analysis.ts       # Pattern rules + shared prepareAnalysis pipeline; analyze() and classifySignals() entries
│   ├── program.ts        # TypeScript analysis context (program mode with type checker; parse-only fallback)
│   ├── extract.ts        # Table-driven function extraction (ExtractionRecord set)
│   ├── detector.ts       # Side-effect detection rules + FunctionRecord assembly
│   ├── complexity.ts     # Cyclomatic complexity engine (ComplexityEntry)
│   ├── coverage.ts       # Istanbul coverage-final.json artifact parser (CoverageEntry)
│   └── signals/          # Classification signal pipeline (classify_signals + analyze wiring)
│       ├── adapter.ts       # Pair fan-out, contradiction synthesis, confidence formula (classifyPairs)
│       ├── caller-index.ts  # Import-graph caller index (distinct-module counts via the type checker)
│       ├── caller.ts        # caller_count bucket rule (+5/+10/+15)
│       ├── evidence.ts      # RecordEvidence snapshot (exportedness, JSDoc, interface, callers)
│       ├── interface.ts     # interface signal (+30)
│       ├── jsdoc.ts         # docstring signal (+15 tags / +5 indirect / -15 incidental)
│       ├── naming.ts        # naming_convention signal (prefix rules + Err sentinel case)
│       ├── routing.ts       # Effect-type routing table (48 types → agreeing vocabulary)
│       ├── types.ts         # Signal wire record + serializer (closed source set)
│       └── visibility.ts    # visibility signal (exported components, clamp +20)
├── tests/
├── docs/
│   └── effect-disposition.md  # 48-type disposition table (tier, disposition, TypeScript mapping, rationale)
├── openspec/
├── package.json
├── tsconfig.json
├── biome.json
└── NOTICE
```

## Limits & Troubleshooting

Reading Stone performs static analysis only on untrusted source and enforces
fixed transport bounds (not configurable in v1):

- **Line size cap** — request lines longer than 16 MiB (`MAX_LINE_CHARS`) are
  rejected with `-32600` before parsing.
- **Method echo cap** — the method name echoed in `-32601` responses is
  truncated to 64 characters.
- **Coverage semantics** — the `coverage` method reads a pre-existing
  Istanbul artifact at the fixed location
  `<root>/coverage/coverage-final.json`. When that artifact is absent,
  unreadable, or invalid, `coverage` returns `{"functions": []}` and never
  errors (FR-025). It never runs the project's tests.
- **Per-request pipeline cost** — each `analyze`, `complexity`, or
  `classify_signals` request
  boots a fresh TypeScript compiler context (tree walk, pre-read,
  bootstrap, extraction) and disposes it before responding; no pipeline
  state is reused across requests. `coverage` reads a pre-existing
  artifact and is cheap.

Empty `coverage` results usually mean no artifact exists yet: run the
project's own test command with an Istanbul reporter writing
`coverage/coverage-final.json` first, then request `coverage`. When the
document parses but no file entry matches the Istanbul shape, or entries
are skipped for size (per-file record caps, or the document-level
attribution work budget), Reading Stone says so on stderr — one line per
skipped document or file — while stdout still carries only the JSON-RPC
response.

The read-don't-run coverage behavior is a deliberate, recorded divergence
from the Gaze analyzer protocol (FR-025), which frames coverage as the
analyzer being responsible for running the project's tests. Reading Stone
is static-analysis-only (Constitution Principle V — analyzed code is never
executed), so it consumes the artifact the project's own test run produced
instead of producing one itself.

When input is malformed, Reading Stone emits a one-line diagnostic to
**stderr** and continues. **stdout carries only the JSON-RPC response.**

## License

Apache 2.0 -- see [LICENSE](LICENSE). The JSON-RPC protocol layer and the
classification signal pipeline design are ported from
[snake-eyes](https://github.com/zero-dot-force/snake-eyes) (zero-dot-force,
Apache 2.0); see [NOTICE](NOTICE) for attribution.
