# server Specification
## Purpose

Runtime behavior of the line-delimited stdio JSON-RPC server: line reading and writing, sequential request dispatch through an injectable handler table, parse/invalid/method-not-found/internal error responses, size bounds, and clean lifecycle teardown. Covers `src/server.ts`.

## Requirements

### Requirement: Line-delimited stdio transport

The system SHALL read one JSON object per line from stdin and write one JSON object per line to stdout. The system SHALL NOT use LSP Content-Length headers. Trailing `\r` on request lines SHALL be stripped so Windows `\r\n` line endings are accepted. A synchronous write failure (e.g. a `write` that throws when Gaze has closed the pipe) SHALL be treated as clean teardown — the run loop resolves and the process exits 0 without a stack trace on stdout.

#### Scenario: One response per request line

- **WHEN** a single request line is written to stdin
- **THEN** exactly one response line is written to stdout

#### Scenario: CRLF line endings accepted

- **WHEN** a request line terminated with `\r\n` is written
- **THEN** exactly one response line is written, identical to a `\n`-terminated request

#### Scenario: Write failure is clean teardown

- **WHEN** a response is written to a stdout whose `write` throws
- **THEN** the run loop resolves without an unhandled rejection and nothing further is written to stdout

### Requirement: Sequential processing

The system SHALL process requests sequentially, one at a time, and SHALL NOT pipeline or process requests concurrently.

#### Scenario: Multiple requests handled in order

- **WHEN** two valid request lines are written
- **THEN** two responses are produced in the same order as the requests

### Requirement: Empty line and EOF handling

The system SHALL ignore empty and whitespace-only lines. On stdin EOF without a prior `shutdown`, the run loop SHALL resolve cleanly with no response written. Signal-based termination (SIGTERM/SIGINT) falls back to default Node behavior; no deterministic teardown is required for a Gaze-managed subprocess.

#### Scenario: Empty line ignored

- **WHEN** an empty line is written between requests
- **THEN** no response is produced for the empty line

#### Scenario: EOF exits cleanly

- **WHEN** stdin is closed without a `shutdown` request
- **THEN** the run loop resolves and writes no response

### Requirement: Parse error handling

The system SHALL respond to malformed JSON with a parse error (`-32700`) using `id` of `null`, and SHALL remain alive to process subsequent requests. (Unlike Python's `json.loads`, V8's `JSON.parse` is iterative and has no practical nesting depth limit, so the Python recursion-limit failure mode does not apply here.)

#### Scenario: Malformed JSON yields parse error

- **WHEN** a line containing invalid JSON (e.g. `{not json`) is written
- **THEN** a `-32700` error with `id: null` is written and the process remains alive for a subsequent valid request

### Requirement: Invalid request handling

The system SHALL respond with `-32600` when a line is valid JSON but is not an object, is missing `jsonrpc` or `method`, or has a `jsonrpc` value other than `"2.0"`. The error SHALL use the request `id` if it is a valid string or integer, otherwise `null`. A line exceeding the 16 MiB size bound (`MAX_LINE_CHARS`) SHALL be rejected with `-32600` and `id` of `null` without being parsed, and the server SHALL remain alive.

#### Scenario: Missing method field

- **WHEN** a JSON object without a `method` field is written
- **THEN** a `-32600` error is written using the request `id` if present, otherwise `null`

#### Scenario: Missing jsonrpc field

- **WHEN** a JSON object without a `jsonrpc` field is written
- **THEN** a `-32600` error is written using the request `id` if present, otherwise `null`

#### Scenario: Non-object request

- **WHEN** a line that is valid JSON but not an object (e.g. a JSON array) is written
- **THEN** a `-32600` error is written using the request `id` if present, otherwise `null`

#### Scenario: Wrong jsonrpc version

- **WHEN** a request with `jsonrpc` present but not equal to `"2.0"` is written
- **THEN** a `-32600` error is written using the request `id` if present, otherwise `null`

#### Scenario: Oversize line rejected before parsing

- **WHEN** a line longer than 16 MiB is written
- **THEN** a `-32600` error with `id: null` is written and the server remains alive

### Requirement: Method not found

The system SHALL respond to an unknown method with `-32601` and message `Method not found: <method>`. The echoed method name SHALL be truncated to 64 characters (`MAX_METHOD_ECHO`).

#### Scenario: Unknown method

- **WHEN** a request with an unrecognized method name is written
- **THEN** a `-32601` error with message `Method not found: <method>` is written

#### Scenario: Long method name truncated

- **WHEN** a request with a method name longer than 64 characters is written
- **THEN** the echoed method name in the `-32601` message is truncated to 64 characters with a trailing ellipsis

### Requirement: Injectable dispatch table

The system SHALL accept an injectable dispatch table (`Map` from method name to handler callable) via the `Server` constructor, replacing the default built-in `initialize`/`shutdown`/`discover` table. Tests SHALL be able to register a handler — including a raising handler — to exercise dispatch and error paths through stdin/stdout without altering the built-in method set.

#### Scenario: Raising handler registered via injected dispatch

- **WHEN** a handler that throws is registered through the injected dispatch table and a request for that method is written
- **THEN** the `-32603` internal-error response is produced through the normal stdin/stdout loop

### Requirement: Internal error handling

When a handler throws an exception, the system SHALL respond with `-32603` and the exception message. Stack traces SHALL NOT be written to stdout; they SHALL be written to stderr.

#### Scenario: Handler exception yields internal error

- **WHEN** a handler registered via the injected dispatch table throws
- **THEN** a `-32603` error with the exception message is written to stdout and the stack trace is written to stderr only

### Requirement: initialize dispatch and idempotency

The system SHALL dispatch `initialize` and MAY be called more than once; a second `initialize` SHALL be answered with a valid result without error.

#### Scenario: Repeated initialize succeeds

- **WHEN** `initialize` is sent twice
- **THEN** both requests receive a valid result response

#### Scenario: initialize with invalid params

- **WHEN** an `initialize` request lacks a string `root_path` in `params`
- **THEN** a `-32602` invalid params error is returned

### Requirement: shutdown resolves the run loop

The system SHALL answer `shutdown` with a success result `{}` and then resolve the run loop, after which the process exits with code 0.

#### Scenario: shutdown terminates with success

- **WHEN** a `shutdown` request is processed
- **THEN** a success response with result `{}` is written and the run loop resolves

### Requirement: Dispatch table scope

The system SHALL register only `initialize`, `shutdown`, `discover`, and `analyze` as built-in dispatch handlers. Any other method SHALL return `-32601`; the reserved analysis method names are `complexity`, `coverage`, `test_mapping`, `classify_signals`, `analyze/stream`, `doc_coverage`, and `cognitive_complexity`. The dispatch table SHALL be overridable via the `Server` constructor for testing (see `Injectable dispatch table`).

#### Scenario: Reserved methods are not implemented

- **WHEN** a request for `complexity`, `coverage`, `test_mapping`, `classify_signals`, `analyze/stream`, `doc_coverage`, or `cognitive_complexity` is written
- **THEN** the system responds with `-32601`
