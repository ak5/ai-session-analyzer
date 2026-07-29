# ADR 006: Privacy and retention

Status: Accepted\
Date: 2026-07-29

Default capture is operational metadata: lifecycle, tool name/status/timing,
usage, and content sizes/hashes. Prompts, full tool inputs, full tool outputs,
environment values, and binary content are not captured by default. A native
`Stop` response may capture `last_assistant_message` directly only under the
effective assistant-response capture setting.

Configuration must provide global defaults, adapter overrides, project
exclusions, redaction and size limits, retention, effective-configuration
inspection, and complete ASA session deletion. Deletion removes authoritative
ASA observations and then rebuilds every derived projection. Normal logs never
include captured content.

OTLP describes telemetry; it does not make content safe.
