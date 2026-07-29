# ASA V2 verification matrix

This file is the implementation checklist for `tmp/NEXT.md`. A checked item
must have repeatable evidence, not only an implementation claim.

See [v2-completion-audit.md](v2-completion-audit.md) for the requirement-level
assessment and the distinction between implemented behavior and external
installed-agent validation.

## Foundation

- [x] Accepted focused ADR set.
- [x] Existing commands classified.
- [x] One Rust workspace and one `asa` executable.
- [x] Platform paths use `directories`.
- [x] Structured errors and `tracing`.
- [x] Format, clippy, test, and build commands available.
- [ ] Sanitized real fixture corpus (synthetic hook/transcript fixtures exist).
- [x] Measured one-record hook benchmark and storage prototype.

## First executable milestone

- [x] Claude and Codex native payload adapters.
- [x] OTLP/gRPC log request and local authenticated receiver.
- [x] Separate authenticated local query/control API.
- [x] Durable fsync-before-ack segment.
- [x] Bounded durable-ingestion queue with per-request oneshot acknowledgements.
- [x] Recovery from a partial final write.
- [x] Duplicate observation suppression across restart.
- [x] Hook outage spool and startup drain.
- [x] Neutral output path independent of ASA health.
- [x] Compressed, rebuildable nested session projections.
- [x] `sessions list` and `sessions show`.
- [x] Semantic hook install/uninstall/status/doctor/test.
- [x] Correlated GenAI trace projection; unmatched evidence remains incomplete.
- [x] Tool and subagent lifecycle pairs become child spans.
- [x] Native transcript discovery, tolerant parsing, and rebuild reconciliation.
- [x] Atomic native transcript checkpoints with parser-version invalidation.
- [x] Concurrent duplicate delivery and truncated-tail crash recovery tests.
- [x] Child-process abort recovery before append, after fsync, and after segment seal.
- [x] Kill-point recovery matrix and bounded saturation stress suite.
- [x] Installed native stores and Claude project-hook execution validated.
- [ ] Codex ASA user-hook execution and Claude `Stop` (blocked by trust/account policy).

## Replacement boundary

- [x] Native plus observed session listing.
- [x] Rust `analyze` parity, with intentional differences classified.
- [x] Rust `compare` parity, with intentional differences classified.
- [x] Dedicated-thread, rebuildable DuckDB session projection.
- [x] macOS `launchd` and Linux systemd user supervision.
- [x] Release artifacts and install/uninstall documentation.
- [x] Privacy configuration, exclusion, retention, and deletion tests.
- [x] Prompt capture metadata/redacted/full modes and size limits.
- [x] Native Claude/Codex `resume` argv parity, cwd recovery, and dry-run safety.
- [x] Native Claude/Codex whole-session `fork` argv parity, cwd recovery, and dry-run safety.
- [x] Mid-session `fork --at`, original preservation, Claude sidecars, Codex lineage, and no-launch safety.
- [x] Crafted-context fork native shapes, deterministic focus weighting, verbatim tail, and no-launch safety.
- [x] Local deterministic `distill`, cross-session clustering, internal-session exclusion, scope filters, and JSON.
- [x] Local deterministic `prompter`, specificity/leverage, archetype/lints, workflow/trends, correlations, and JSON.
- [x] Local `project`, `efficacy`, `intents`, and `models` reports with canonical repository attribution and parser-owned model usage.
- [x] Safe native `sessions migrate-path` preflight, collision refusal,
  backups/journal, Claude path-derived moves and sidecars, Codex metadata,
  native indexes, and idempotent resume.
