# ASA V2 completion audit

This audit maps the implementation to `tmp/NEXT.md`. It separates implemented
behavior from validation that depends on installed-agent policy or an
explicitly approved user-settings change.

## Foundation definition of done

| Requirement | Status | Evidence |
| --- | --- | --- |
| Rust is the distributed implementation | Implemented | One Cargo workspace produces one `asa` binary; release build succeeds. |
| Claude Code and Codex use real passive hooks | Partially externally validated | Claude executed ASA's neutral project hook. Codex's native payload adapter and semantic installer are tested, but executing an ASA user hook requires approval to change user-scoped security settings. |
| OTLP is the telemetry boundary | Implemented | Authenticated OTLP/gRPC logs receiver, versioned observation encoding, pinned schema URL, and standard OTLP trace assembly. |
| OTel GenAI semantics are pinned and tested | Implemented | Semantic-convention constants and namespace tests; trace tests preserve incomplete status and tool/subagent parentage. |
| Durable acknowledgement and recovery | Implemented | Fsync-before-ack segments, checksums, bounded sealing, duplicate suppression, spool drain, and child-process abort tests. |
| Supervised and diagnosable daemon | Implemented | launchd and systemd-user definitions; authenticated health/status, doctor, logs, restart, rebuild, and documented rotation ownership. |
| Rebuildable session documents | Implemented | Compressed documents rebuild from retained hook observations and tolerant native transcript parsing. |
| Rebuildable DuckDB analytics | Implemented | Dedicated owner thread, transactional full rebuild, deterministic watermark, and delete/rebuild equivalence test. |
| Core list, analyze, and compare workflows | Implemented | Rust commands and fixture-pinned TypeScript parity evidence. |
| Explicit, tested privacy defaults | Implemented | Metadata-first defaults, per-adapter overrides, exclusions, prompt/assistant capture modes, size limits, retention, and explicit deletion. |
| Desktop support is accurately reported | Implemented | Desktop apps are discovery sources only; native CLI hooks are the supported observation path. |
| Native sessions remain untouched | Implemented | ASA writes only its own root and settings entries installed by explicit hook-management commands; deletion tests protect native stores. |
| TypeScript can be retired under the ADR | Implemented replacement boundary | Rust owns the central workflow; remaining V1-only product features are explicitly deferred by Phase 9 and the migration ADR. |

## Phase and milestone assessment

- Phases 1–8 and the first executable milestone are implemented in the Rust
  workspace.
- Phase 9 is intentionally a post-foundation value-ordered backlog in the
  handoff, not a prerequisite for the stated V2 foundation definition of done.
  Native Claude/Codex `resume`, whole-session `fork`, and mid-session
  `fork --at`, and crafted-context `fork --context` are now ported. The native
  wrappers have interactive/headless argv parity and a non-launching dry-run;
  transcript-writing forks preserve source bytes, rewrite adapter lineage,
  support create-without-launch, and use deterministic local context shaping.
- Local deterministic `distill` is ported with native Claude/Codex extraction,
  cross-session recurrence clustering, fork deduplication, internal-session
  exclusion, tool-sequence mining, scope filters, and JSON. Its model/FAQ/HTML
  extensions remain separately classified work.
- Local `prompter` is ported with explainable prompt features, aggregates,
  archetype/lints, workflow signals, weekly trends, correlations, filters, and
  JSON. Its model judge, detailed git-input inspection, rapid-gap analysis, and
  HTML remain separate redesign work.
- Local `project`, `efficacy`, `intents`, and `models` are ported with shared
  native scoping, canonical repository joins, instruction history windows,
  deterministic intent rules, and per-model response/turn attribution.
- Explicit `sessions migrate-path` covers repository and parent-directory
  moves across both native stores. It completes collision-safe preflight,
  preserves payloads outside recognized workspace metadata, moves Claude
  path-derived transcripts and sidecars, updates indexes, keeps recoverable
  backups, and resumes from an atomic ASA-owned journal.
- Hook/native reconciliation currently reparses complete transcripts. Atomic
  checkpoints and invalidation are implemented; append-only incremental parsing
  remains deliberately disabled until document-level merge correctness is
  proven.
- OTLP logs are the implemented ingestion signal. Standard OTLP traces can be
  assembled from projected sessions; a trace receiver and metrics remain later
  protocol extensions, consistent with the handoff's “logs first” scope.

## Repeatable verification

The latest local verification completed on 2026-07-29:

```text
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
cargo build --locked --release --workspace
git diff --check
```

Results: 73 unit/integration tests passed, all doc tests passed, clippy emitted
no warnings, and the optimized workspace build succeeded.

The optimized binary also passed an isolated loopback smoke: startup drained
two outage-spooled Codex observations, authenticated `daemon status` reported
healthy, and `sessions show codex:codex-fixture-session` returned one completed
turn with an `invoke_agent` root, an `execute_tool` child, and an observation
count of two. The temporary ASA root was removed afterward.

The suite covers malformed native tails, protocol version rejection, privacy
modes, semantic installer preservation, authenticated ingestion, actual durable
queue saturation, 256-export slow-persistence stress, graceful queue drain,
simultaneous duplicate delivery, checksummed-tail repair, segment sealing, spool
quarantine, deletion, projection correlation, DuckDB rebuild equivalence, and
process aborts across segment, projection, DuckDB, and spool-drain boundaries.
See the [crash and saturation matrix](v2-crash-matrix.md).

## Remaining validation gates

These do not justify weakening agent trust or claiming evidence that was not
observed:

1. Install the ASA Codex hook at user scope, run a read-only prompt, verify the
   observation, then selectively uninstall ASA's entry. This is a persistent
   security-settings change and requires explicit user approval.
1. Produce a real Claude `Stop` observation. The installed organization policy
   currently rejects model access before `Stop`; three earlier lifecycle/tool
   observations already proved the neutral hook path executes.
1. Promote sanitized payloads captured from approved real runs into a
   provenance-labelled fixture corpus. Existing fixtures are sanitized and
   representative, but are not claimed as raw captures from those installed
   runs.
   Until gates 1 and 2 are run, the code implementation is complete at the
   foundation boundary but cross-agent installed-hook acceptance is not complete.
