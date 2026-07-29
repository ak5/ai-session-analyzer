# Architecture decision records

Architecture decision records explain durable ASA constraints and their
consequences. An implementation or merged pull request is evidence, not an
accepted decision by itself.

| ADR | Status | Decision |
| --- | --- | --- |
| [001](001-rust-rewrite.md) | Accepted | Rust rewrite and migration boundary |
| [002](002-passive-adapters.md) | Accepted | Passive observation and native adapters |
| [003](003-opentelemetry-otlp.md) | Accepted | OpenTelemetry and OTLP |
| [004](004-delivery-recovery.md) | Accepted | Daemon, delivery, and recovery |
| [005](005-session-analytics.md) | Accepted | Session documents and analytics |
| [006](006-privacy-retention.md) | Accepted | Privacy and retention |

New candidates MUST remain proposed until a maintainer accepts their exact
decision text. Superseded records remain indexed and link to their replacement.
Use the repo-local `intent-farm` skill to recover evidence-backed candidates;
it MUST NOT publish policy automatically.
