# ASA documentation

This is the canonical map of durable repository documentation. The Rust V2
implementation is the distribution target. TypeScript V1 remains a behavioral
oracle until the migration boundary in ADR 001 is complete.

## Start here

- [Repository conventions](conventions.md) — ownership, branch policy, commands,
  documentation responsibilities, and agent workflow.
- [Contributing](../CONTRIBUTING.md) — setup, checks, pull requests, and releases.
- [Security](../SECURITY.md) — private reporting and sensitive-data boundaries.
- [V2 operations](v2-operations.md) — install, supervise, diagnose, recover, and
  remove the Rust daemon.
- [V2 verification](v2-verification.md) — evidence-backed implementation matrix.
- [V2 completion audit](v2-completion-audit.md) — foundation status and remaining
  external acceptance gates.

## V2 architecture and evidence

- [Benchmark evidence](v2-benchmarks.md)
- [Crash and saturation matrix](v2-crash-matrix.md)
- [TypeScript parity](v2-parity.md)
- [Local smoke test](v2-smoke-test.md)
- [Architecture decision index](adr/index.md)
- [ADR 001: Rust rewrite and migration boundary](adr/001-rust-rewrite.md)
- [ADR 002: Passive adapters](adr/002-passive-adapters.md)
- [ADR 003: OpenTelemetry and OTLP](adr/003-opentelemetry-otlp.md)
- [ADR 004: Delivery and recovery](adr/004-delivery-recovery.md)
- [ADR 005: Session documents and analytics](adr/005-session-analytics.md)
- [ADR 006: Privacy and retention](adr/006-privacy-retention.md)

## Development and reference

- [Testing](testing.md) — Rust V2 and TypeScript V1 verification.
- [Publishing](publishing.md) — native V2 artifacts and retained V1 npm releases.
- [Adding an agent](adding-an-agent.md)
- [Session formats](formats.md)
- [Analysis features](analysis.md)
- [Git tracing](git-tracing.md)

When a code change makes a documented command, behavior, schema, path, workflow,
or default inaccurate, update the document named in the ownership map in
[conventions.md](conventions.md).
