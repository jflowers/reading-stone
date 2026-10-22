# Spec Delta

## MODIFIED Requirements

### Requirement: JSON-RPC envelope types

> Previously: The system SHALL define TypeScript types for the JSON-RPC 2.0 envelope: `JsonRpcRequest` (`jsonrpc`, `id`, `method`, `params`), `JsonRpcSuccess` (`jsonrpc`, `id`, `result`), `JsonRpcErrorBody` (`code`, `message`, `data`), and `JsonRpcError` (`jsonrpc`, `id`, `error`). `id` SHALL be `number | string | null`; `params` SHALL be `object | null`. Per protocol v1.1.0, Gaze emits named (object) params only — array/positional params are out of contract for this change. Requests with no `id` are JSON-RPC 2.0 notifications; Gaze's v1.1.0 lifecycle always supplies an `id`, so notifications are out of contract for this change. A non-object `params` that nonetheless arrives SHALL yield `-32602` in the `initialize` handler (validation is deferred to the handler, not enforced at envelope deserialization). Only string and integer `id` values are echoed; any other `id` value (boolean, fractional number, array, object) is treated as absent and answered with `id: null`.

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

### Requirement: initialize request schema

> Previously: The system SHALL accept an `initialize` request whose `params` is a JSON object containing `root_path` (string, required; the absolute project root — path form is not validated in this change) and optionally `config` (object, the opaque `.gaze.yaml` config whose contents are ignored). A missing or `{}` `config` SHALL be accepted. If `params` is absent, is not an object (e.g. an array), or lacks a string `root_path`, the system SHALL respond with `INVALID_PARAMS` (`-32602`).

The system SHALL accept an `initialize` request whose `params` is a JSON object containing `root_path` (string, required; the absolute project root — path form is not validated at the initialize boundary; methods that use `root_path` for filesystem access resolve and traversal-check it per constitution Principle V) and optionally `config` (object, the opaque `.gaze.yaml` config whose contents are ignored). A missing or `{}` `config` SHALL be accepted. If `params` is absent, is not an object (e.g. an array), or lacks a string `root_path`, the system SHALL respond with `INVALID_PARAMS` (`-32602`).

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

> Previously: The system SHALL return an `initialize` result with exact field names: `analyzer_name` = `"reading-stone"`, `language` = `"typescript"`, `language_version` = the running interpreter's version from `process.versions.node`, `protocol_version` = the string `"1.1.0"`, and `capabilities` with all four keys `discover`, `test_mapping`, `classify_signals`, and `streaming` present and `false`. The `capabilities` object is the negotiable/optional surface; the core methods (`analyze`, `complexity`, `coverage`) are not gated by a capability flag and are simply unimplemented (`-32601`) in this change. The `streaming` capability gates the `analyze/stream` method (not implemented in this change). The result is a plain object built by a helper; `JsonRpcSuccess.result` SHALL be typed `object | null`.

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

#### Scenario: Optional methods are gated by their capability flags

- **WHEN** a `doc_coverage` or `cognitive_complexity` request is sent while the corresponding capability flag is `false`
- **THEN** a `-32601` method not found error is returned
