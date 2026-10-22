# protocol Specification
## Purpose

Wire-level contracts for the Gaze analyzer protocol as implemented by reading-stone: JSON-RPC 2.0 envelope types, standard error-code constants, `initialize` and `shutdown` request/result schemas, capability advertisement, and deterministic sorted-key serialization. Covers `src/protocol.ts` and its conformance tests.

## Requirements

### Requirement: JSON-RPC envelope types

The system SHALL define TypeScript types for the JSON-RPC 2.0 envelope: `JsonRpcRequest` (`jsonrpc`, `id`, `method`, `params`), `JsonRpcSuccess` (`jsonrpc`, `id`, `result`), `JsonRpcErrorBody` (`code`, `message`, `data`), and `JsonRpcError` (`jsonrpc`, `id`, `error`). `id` SHALL be `number | string | null`; `params` SHALL be `object | null`. Per protocol v1.2.0, Gaze emits named (object) params only — array/positional params are out of contract. Requests with no `id` are JSON-RPC 2.0 notifications; Gaze's lifecycle always supplies an `id`, so notifications are out of contract. A non-object `params` that nonetheless arrives SHALL yield `-32602` in the `initialize` handler (validation is deferred to the handler, not enforced at envelope deserialization). Only string and integer `id` values are echoed; any other `id` value (boolean, fractional number, array, object) is treated as absent and answered with `id: null`.

#### Scenario: Request and response round-trip

- **WHEN** a `JsonRpcRequest` with `id`, `method`, and `params` is serialized
- **THEN** the resulting JSON object contains the exact keys `jsonrpc`, `id`, `method`, and `params` with matching values

#### Scenario: Falsy and string ids round-trip unchanged

- **WHEN** a request with `id: 0` (or `id: "abc"`) is processed and answered
- **THEN** the response echoes the exact `id`, including the falsy `0` and the string `"abc"`, without truthiness-based dropping

#### Scenario: Success serializes result

- **WHEN** a `JsonRpcSuccess` with a `result` object is serialized
- **THEN** the JSON contains `jsonrpc: "2.0"`, the matching `id`, and the `result`

#### Scenario: Error serializes nested error body

- **WHEN** a `JsonRpcError` with a `JsonRpcErrorBody` is serialized
- **THEN** the JSON contains `jsonrpc: "2.0"`, the matching `id`, and an `error` object with `code`, `message`, and `data` (when present)

### Requirement: Standard error codes

The system SHALL define named constants for the JSON-RPC 2.0 standard error codes: `PARSE_ERROR` = `-32700`, `INVALID_REQUEST` = `-32600`, `METHOD_NOT_FOUND` = `-32601`, `INVALID_PARAMS` = `-32602`, and `INTERNAL_ERROR` = `-32603`. These constants SHALL be used in place of magic numbers.

#### Scenario: Error codes are exact

- **WHEN** the constants are imported
- **THEN** `PARSE_ERROR` equals `-32700`, `INVALID_REQUEST` equals `-32600`, `METHOD_NOT_FOUND` equals `-32601`, `INVALID_PARAMS` equals `-32602`, and `INTERNAL_ERROR` equals `-32603`

### Requirement: initialize request schema

The system SHALL accept an `initialize` request whose `params` is a JSON object containing `root_path` (string, required; the absolute project root — path form is not validated) and optionally `config` (object, the opaque `.gaze.yaml` config whose contents are ignored). A missing or `{}` `config` SHALL be accepted. If `params` is absent, is not an object (e.g. an array), or lacks a string `root_path`, the system SHALL respond with `INVALID_PARAMS` (`-32602`).

#### Scenario: initialize accepts required root_path

- **WHEN** an `initialize` request is sent with `params: {"root_path": "/abs/project", "config": {}}`
- **THEN** a valid initialize result is returned

#### Scenario: initialize accepts missing config

- **WHEN** an `initialize` request is sent with `params: {"root_path": "/abs/project"}`
- **THEN** a valid initialize result is returned

#### Scenario: initialize rejects missing root_path

- **WHEN** an `initialize` request is sent with `params: {}` (no `root_path`)
- **THEN** a `-32602` invalid params error is returned

#### Scenario: initialize rejects non-object params

- **WHEN** an `initialize` request is sent with array `params` (e.g. `[]`)
- **THEN** a `-32602` invalid params error is returned

#### Scenario: initialize rejects absent params

- **WHEN** an `initialize` request is sent with no `params` key
- **THEN** a `-32602` invalid params error is returned

### Requirement: initialize result schema

The system SHALL return an `initialize` result with exact field names: `analyzer_name` = `"reading-stone"`, `language` = `"typescript"`, `language_version` = the running interpreter's version from `process.versions.node`, `protocol_version` = the string `"1.2.0"`, and `capabilities` with all six keys `discover`, `test_mapping`, `classify_signals`, `streaming`, `doc_coverage`, and `cognitive_complexity` present and `false`. The `capabilities` object is the negotiable/optional surface; the core methods (`analyze`, `complexity`, `coverage`) are not gated by a capability flag. The `streaming` capability gates the `analyze/stream` method, the `doc_coverage` capability gates the `doc_coverage` method, and the `cognitive_complexity` capability gates the `cognitive_complexity` method. The result is a plain object built by a helper; `JsonRpcSuccess.result` SHALL be typed `object | null`.

#### Scenario: Capability flags are present and false

- **WHEN** `initialize` is called
- **THEN** the result contains exactly the six capability keys `discover`, `test_mapping`, `classify_signals`, `streaming`, `doc_coverage`, and `cognitive_complexity`, and each is `false`

#### Scenario: Protocol version is pinned

- **WHEN** `initialize` is called
- **THEN** `protocol_version` equals the literal string `"1.2.0"`

#### Scenario: Language version reflects interpreter

- **WHEN** `initialize` is called
- **THEN** `language_version` equals `process.versions.node`

#### Scenario: New optional methods are not found until implemented

- **WHEN** a `doc_coverage` or `cognitive_complexity` request is sent before those methods are implemented
- **THEN** a `-32601` method not found error is returned

### Requirement: shutdown request params

The system SHALL accept a `shutdown` request with `params` absent or `null`.

#### Scenario: shutdown accepts null or omitted params

- **WHEN** a `shutdown` request is sent with `params` absent or `null`
- **THEN** the success result `{}` is returned and the process exits 0

### Requirement: shutdown result schema

The system SHALL answer `shutdown` with an empty object `{}` as the result.

#### Scenario: shutdown returns empty object

- **WHEN** a `shutdown` request is processed
- **THEN** the success result is `{}`

### Requirement: Omit null error data

The system SHALL omit the `data` key from a serialized error when `data` is `null` or `undefined`, and SHALL NOT emit JSON `null` for it.

#### Scenario: Null data omitted

- **WHEN** a `JsonRpcErrorBody` has `data` = `null` and is serialized
- **THEN** the JSON `error` object does not contain a `data` key

### Requirement: Deterministic serialization

The system SHALL serialize every response deterministically: object keys in sorted order, no insignificant whitespace, one line. The same logical response SHALL produce byte-identical output on every run.

#### Scenario: Keys are sorted

- **WHEN** a response envelope is serialized
- **THEN** the JSON object keys appear in lexicographically sorted order at every nesting level
