# Reading Stone

**TypeScript analyzer backend for [Gaze](https://github.com/unbound-force/gaze).**

Reading Stone is a Gaze-spawned subprocess. It speaks JSON-RPC 2.0 over stdin/stdout
(protocol v1.1.0). Gaze owns the CLI, scoring, and reports.

## Current status (v0.1.0)

| Method | Status |
|--------|--------|
| `initialize` | Implemented |
| `shutdown` | Implemented |
| `discover` | Not implemented (`-32601`) |
| `analyze` | Not implemented (`-32601`) |
| `complexity` | Not implemented (`-32601`) |
| `coverage` | Not implemented (`-32601`) |
| `classify_signals` | Not implemented (`-32601`) |
| `test_mapping` | Not implemented (`-32601`) |

All capability flags are advertised as `false` at handshake. TypeScript side-effect
detection is the roadmap; see `openspec/changes/`.

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
│   ├── index.ts          # Package surface (VERSION export)
│   ├── main.ts           # Entry point (reading-stone --stdio)
│   ├── server.ts         # JSON-RPC server (stdin/stdout)
│   └── protocol.ts       # Request/response types
├── tests/
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

When input is malformed, Reading Stone emits a one-line diagnostic to
**stderr** and continues. **stdout carries only the JSON-RPC response.**

## License

Apache 2.0 -- see [LICENSE](LICENSE). The JSON-RPC protocol layer is ported
from [snake-eyes](https://github.com/zero-dot-force/snake-eyes) (zero-dot-force,
Apache 2.0); see [NOTICE](NOTICE) for attribution.
