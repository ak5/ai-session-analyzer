# ADR 004: Daemon, delivery, and recovery

Status: Accepted\
Date: 2026-07-29

The Tokio daemon binds to loopback by default and requires a bearer token stored
with user-only permissions. Ingestion is bounded by transport and record size
limits. Acknowledgement happens only after a checksummed, length-delimited
observation frame is appended and `sync_data` succeeds.

Delivery is at least once. Observation IDs make daemon ingestion idempotent.
There is no global-ordering or exactly-once claim. A truncated final frame is
discarded during recovery; checksum failures are reported rather than silently
skipped. Hook clients wait at most 200 ms and atomically spool locally when the
daemon is unavailable. Daemon startup drains that spool before serving.

Session and future DuckDB projections occur outside acknowledgement and are
rebuildable from the durable segment. Hook clients never start the daemon.
Native `launchd` and systemd user supervisors own background process lifecycle.
