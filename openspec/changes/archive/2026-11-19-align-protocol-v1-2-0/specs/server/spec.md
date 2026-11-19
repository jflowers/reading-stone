# Spec Delta

## MODIFIED Requirements

### Requirement: Dispatch table scope

> Previously: The system SHALL register only `initialize` and `shutdown` in this change. Any other method SHALL return `-32601`. The dispatch table SHALL be overridable via the `Server` constructor for testing (see `Injectable dispatch table`).

The system SHALL register only `initialize`, `shutdown`, and `discover` as built-in dispatch handlers. Any other method SHALL return `-32601`; the reserved analysis method names are `analyze`, `complexity`, `coverage`, `test_mapping`, `classify_signals`, `analyze/stream`, `doc_coverage`, and `cognitive_complexity`. The dispatch table SHALL be overridable via the `Server` constructor for testing (see `Injectable dispatch table`).

#### Scenario: Reserved methods are not implemented

- **WHEN** a request for `analyze`, `complexity`, `coverage`, `test_mapping`, `classify_signals`, `analyze/stream`, `doc_coverage`, or `cognitive_complexity` is written
- **THEN** the system responds with `-32601`
