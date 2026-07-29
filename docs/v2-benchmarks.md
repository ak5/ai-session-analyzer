# ASA V2 benchmark evidence

Measured on 2026-07-29 on the development macOS host with Rust 1.88. The
commands use the bundled-DuckDB, single-executable release build.

## Hook startup and outage path

```sh
cargo build --release -p asa-cli -j 2

root="$(mktemp -d /tmp/asa-release-benchmark.XXXXXX)"
/usr/bin/time -p target/release/asa --root "$root" hook ingest \
  --adapter codex < fixtures/v2/hooks/codex-stop.json >/dev/null
```

Results:

- release executable: 48 MB;
- one hook invocation with a warm filesystem cache and no daemon: 30 ms;
- 25 warm invocations with no daemon: 960 ms total, 38.4 ms mean;
- first executable load from a cold filesystem cache: 840 ms;
- clean optimized build with bundled DuckDB: 19m22s.

The best warm single run meets the 30 ms cold-process target, while the repeated
mean is above it after the control API was linked into the final binary. Both
remain well below the 250 ms hard wait budget. A genuinely cold 48 MB executable
load does not meet 30 ms. The hook still exits neutrally and spools durably.
This is retained as an explicit one-binary packaging tradeoff rather than
hidden by an in-process benchmark.

## Storage and analytics

`asa-store` tests exercise:

- fsync before successful append return;
- checksum validation and truncated-tail recovery;
- restart deduplication;
- 16 simultaneous duplicate appends producing one durable record;
- invalid spool quarantine and duplicate-safe drain;
- deleting DuckDB and rebuilding equivalent session/turn/tool/token totals.

DuckDB stores a deterministic SHA-256 session projection watermark alongside
the analytical schema version. A full rebuild replaces both summary rows and
watermark in one transaction.

The initial analytical representation is a flattened session summary. Nested
and hybrid DuckDB representations are deferred until representative large
private transcripts can be benchmarked without checking sensitive data into
the repository.
