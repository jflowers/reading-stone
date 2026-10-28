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
| `analyze` | Implemented (params `{root_path, patterns}`; result `{"functions": [...]}` — FunctionRecords with `side_effects` arrays) |
| `analyze/stream` | Not implemented (`-32601`) |
| `complexity` | Implemented (params `{root_path, patterns}`; result `{"functions": [...]}` — ComplexityEntry records) |
| `coverage` | Implemented (params `{root_path, patterns}`; result `{"functions": [...]}` — CoverageEntry records) |
| `classify_signals` | Not implemented (`-32601`) |
| `test_mapping` | Not implemented (`-32601`) |
| `doc_coverage` | Not implemented (`-32601`) |
| `cognitive_complexity` | Not implemented (`-32601`) |

`discover` is implemented and advertised via `capabilities.discover: true`.
`analyze`, `complexity`, and `coverage` are implemented as core protocol
methods — not gated behind a capability flag — and share one params surface:
`root_path` plus an optional `patterns` array of path-prefix strings. The
remaining capability flags (`test_mapping`, `classify_signals`, `streaming`,
`doc_coverage`, `cognitive_complexity`) are `false` at handshake; their
methods are the roadmap — see `openspec/changes/`.

The side effects `analyze` reports are governed by the disposition table:
for each of the 48 canonical taxonomy types it records the tier, the
disposition (how completely Reading Stone detects it), the TypeScript
constructs detected, and the rationale for `N/A` rows — see
[docs/effect-disposition.md](docs/effect-disposition.md).

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
│   ├── index.ts          # Package surface (VERSION + taxonomy/model re-exports)
│   ├── main.ts           # Entry point (reading-stone --stdio)
│   ├── server.ts         # JSON-RPC server (stdin/stdout)
│   ├── protocol.ts       # Request/response types
│   ├── taxonomy.ts       # Side-effect taxonomy (48 types, tiers, aliases)
│   ├── models.ts         # Effect/FunctionRecord/classification records, serializers, derivePackage
│   ├── safeio.ts         # Bounded safe file reader with skip diagnostics
│   ├── discovery.ts      # Project walking, file classification, framework detection, discover()
│   ├── analysis.ts       # Pattern rules + shared prepareAnalysis pipeline; analyze() response assembly
│   ├── program.ts        # TypeScript analysis context (program mode with type checker; parse-only fallback)
│   ├── extract.ts        # Table-driven function extraction (ExtractionRecord set)
│   ├── detector.ts       # Side-effect detection rules + FunctionRecord assembly
│   ├── complexity.ts     # Cyclomatic complexity engine (ComplexityEntry)
│   └── coverage.ts       # Istanbul coverage-final.json artifact parser (CoverageEntry)
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

Empty `coverage` results usually mean no artifact exists yet: run the
project's own test command with an Istanbul reporter writing
`coverage/coverage-final.json` first, then request `coverage`.

The read-don't-run coverage behavior is a deliberate, recorded divergence
from the Gaze analyzer protocol (FR-025), which frames coverage as the
analyzer being responsible for running the project's tests. Reading Stone
is static-analysis-only (Constitution Principle V — analyzed code is never
executed), so it consumes the artifact the project's own test run produced
instead of producing one itself.

When input is malformed, Reading Stone emits a one-line diagnostic to
**stderr** and continues. **stdout carries only the JSON-RPC response.**

## License

Apache 2.0 -- see [LICENSE](LICENSE). The JSON-RPC protocol layer is ported
from [snake-eyes](https://github.com/zero-dot-force/snake-eyes) (zero-dot-force,
Apache 2.0); see [NOTICE](NOTICE) for attribution.
