# Spec Delta

## MODIFIED Requirements

### Requirement: initialize result schema

The system SHALL return an `initialize` result with exact field names: `analyzer_name` = `"reading-stone"`, `language` = `"typescript"`, `language_version` = the running interpreter's version from `process.versions.node`, `protocol_version` = the string `"1.2.0"`, and `capabilities` with all six keys `discover`, `test_mapping`, `classify_signals`, `streaming`, `doc_coverage`, and `cognitive_complexity` present and `false`. The `capabilities` object is the negotiable/optional surface; the core methods (`analyze`, `complexity`, `coverage`) are not gated by a capability flag and are simply unimplemented (`-32601`) in this change. The `streaming` capability gates the `analyze/stream` method, the `doc_coverage` capability gates the `doc_coverage` method, and the `cognitive_complexity` capability gates the `cognitive_complexity` method (none implemented in this change). The result is a plain object built by a helper; `JsonRpcSuccess.result` SHALL be typed `object | null`.

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
