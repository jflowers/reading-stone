# cli Specification
## Purpose

The command-line and packaging surface of reading-stone: the `reading-stone` npm package scaffold (`package.json`, `bin` entry, version constant), the `--stdio` flag parsing and module-entry behavior of `src/main.ts`, and the `NOTICE` attribution file. reading-stone has no user-facing CLI of its own — Gaze spawns it as a subprocess in stdio mode.

## Requirements

### Requirement: Package scaffold and entry point

The system SHALL provide a `reading-stone` package installable via `npm ci`, with `package.json` declaring name `reading-stone`, version `0.1.0`, `type: module`, `engines.node >=22`, license `Apache-2.0`, a `bin` entry `reading-stone` pointing to `dist/main.js`, and exactly one runtime dependency: `typescript` at `^7.0.2` (promoted from `devDependencies` per FR-029 in specs/002-analysis-engine — the TypeScript compiler API is required at runtime when Gaze spawns the analyzer). `src/index.ts` SHALL expose `export const VERSION = "0.1.0"`.

#### Scenario: Package metadata is correct

- **WHEN** `package.json` is inspected
- **THEN** name is `reading-stone`, version is `0.1.0`, `type` is `module`, `engines.node` is `>=22`, license is `Apache-2.0`, the `bin` entry `reading-stone` points to `dist/main.js`, and `dependencies` is exactly `{ "typescript": "^7.0.2" }`

#### Scenario: Version constant is exposed

- **WHEN** the package entry is imported
- **THEN** `VERSION` equals `"0.1.0"`

### Requirement: stdio flag parsing

The `main` module SHALL parse argv and support only the `--stdio` flag. With `--stdio` as the sole argument, it SHALL start the JSON-RPC server on stdin/stdout and block until the run loop resolves. With `--stdio` absent or accompanied by any other argument, it SHALL print the one-line usage `reading-stone --stdio` to stderr and return exit code 2. No other CLI behavior is supported. `main` SHALL accept an optional argv array and an optional `io` object with injected `stdin`/`stdout`/`stderr` streams (defaulting to the `process.*` counterparts) so tests can drive the entry point in-process. The module-entry guard SHALL compare `import.meta.url` with `pathToFileURL(process.argv[1]).href` and set `process.exitCode` to the returned code; it SHALL NOT call `process.exit()`.

#### Scenario: stdio starts the server

- **WHEN** `main` is invoked with `--stdio`
- **THEN** the server loop is started and blocks until stdin closes or `shutdown` arrives

#### Scenario: missing flag prints usage and exits 2

- **WHEN** `main` is invoked without `--stdio`
- **THEN** the usage line is written to stderr, nothing is written to stdout, and `main` returns 2

#### Scenario: extra arguments are rejected

- **WHEN** `main` is invoked with `--stdio` plus any additional argument
- **THEN** the usage line is written to stderr, nothing is written to stdout, and `main` returns 2

### Requirement: NOTICE attribution placeholder

The system SHALL include a `NOTICE` file recording zero-dot-force copyright and the attribution statement for software originally developed in snake-eyes under Apache License 2.0. The file SHALL contain the exact text:

```
reading-stone
Copyright 2026 zero-dot-force

This product includes software originally developed in snake-eyes
(https://github.com/zero-dot-force/snake-eyes), licensed under
Apache License 2.0. The JSON-RPC protocol layer is ported from
snake-eyes' Python implementation of the Gaze analyzer protocol.
```

#### Scenario: NOTICE present

- **WHEN** the repository root is inspected
- **THEN** a `NOTICE` file exists containing the exact snake-eyes attribution text above
