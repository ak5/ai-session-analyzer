# ADR 003: OpenTelemetry and OTLP

Status: Accepted\
Date: 2026-07-29

OTLP is ASA's telemetry transport and the OpenTelemetry model defines resources,
logs, traces, metrics, scopes, IDs, and statuses. Native hook invocations become
immutable OTLP log records because lifecycle starts and completions can arrive
separately. The daemon correlates those records into completed or explicitly
partial spans.

ASA pins semantic-convention schema
`https://opentelemetry.io/schemas/1.37.0`. Constants are centralized in
`asa-semconv`; adapters must not scatter standard `gen_ai.*` literals.
Agent-specific facts use the versioned `asa.*` namespace and never `otel.*`.

The initial receiver is local OTLP/gRPC logs. Traces and metrics use the
standard OTLP services when implemented. One trace represents one agent turn,
correlated to the longer conversation using `gen_ai.conversation.id`.
