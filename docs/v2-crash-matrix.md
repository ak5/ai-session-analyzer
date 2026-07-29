# ASA V2 crash and saturation matrix

This matrix maps the failure points required by `tmp/NEXT.md` to deterministic
tests. Each recovery test starts from ASA-owned temporary storage. Child-process
tests use an abrupt abort so Rust destructors and orderly shutdown cannot make
the result pass accidentally.

| Failure point | Test evidence | Recovery invariant |
| --- | --- | --- |
| Before durable append | `process_crashes_recover_before_append_after_fsync_and_after_seal` / `before-append` | No observation appears. |
| After durable append, before acknowledgement | Same test / `after-append` | The synced observation survives and retry deduplicates. |
| During segment seal | `restart_between_sealed_rename_and_active_replacement_recovers` and the `after-seal` abort case | A renamed sealed segment remains readable; a missing active segment is recreated without loss. |
| During correlation | `correlation_rebuild_after_restart_completes_partial_evidence_once` | Durable partial evidence remains valid and later completion produces one correlated child span. |
| During session projection | `interrupted_projection_temp_file_never_replaces_last_good_document` | An aborted temporary write cannot replace the last good compressed document; rebuild removes debris. |
| During DuckDB projection | `process_crash_during_duckdb_transaction_preserves_committed_projection` | DuckDB rolls back the interrupted transaction and retains the committed rows and watermark. |
| During spool drain | `restart_during_spool_drain_deduplicates_append_before_unlink` | An item appended before abort is deduplicated and removed on the next drain. |
| Partial active-segment tail | `partial_tail_is_truncated_during_recovery` | Recovery truncates only the incomplete active tail. |
| Duplicate delivery | `simultaneous_duplicate_delivery_appends_once` | Concurrent at-least-once delivery creates one durable record. |

Saturation and shutdown coverage:

- `full_durable_queue_fails_fast_without_accepting_request` fills the actual
  durable queue and proves the next request receives `RESOURCE_EXHAUSTED`
  without appearing in storage.
- `sustained_slow_persistence_saturates_only_by_explicit_rejection` submits 256
  concurrent exports against deliberately slow persistence. Every request is
  either durably acknowledged or explicitly rejected, and the recovered count
  equals the acknowledged count.
- `many_simultaneous_exports_are_all_durable` proves the non-saturated concurrent
  path.
- `persistence_worker_drains_accepted_queue_before_shutdown` proves accepted
  queue entries drain before worker termination.

Projection and DuckDB are deliberately outside the acknowledgement boundary.
Their crash tests therefore prove rebuild/rollback behavior rather than delaying
or weakening durable ingestion acknowledgement.
