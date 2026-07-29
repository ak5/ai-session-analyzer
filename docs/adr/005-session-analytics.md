# ADR 005: Session documents and analytics

Status: Accepted\
Date: 2026-07-29

ASA keeps versioned nested `SessionDocument` projections compressed with zstd.
They preserve source, surface, lineage, workspace attributions, turns, usage,
metadata, and projection provenance. They are a human/query projection, not a
new telemetry protocol or source of truth.

Native transcripts remain authoritative for native history; durable ASA
observations remain authoritative for what hooks accepted. Reconciliation
deduplicates their overlapping facts and never edits native transcripts.

DuckDB is rebuildable analytical state owned by one synchronous thread. It is
never in the hook acknowledgement path. Nested, flat, and hybrid layouts must
be benchmarked against real ASA queries before choosing. Parquet is deferred
until measurements justify compaction or scan benefits. No vector database or
embedding pipeline is included.

The maintained Rust `duckdb` wrapper currently brings Apache Arrow crates as
transitive implementation dependencies even with default features disabled.
ASA does not use Arrow APIs and has not added Parquet support. The bundled build
is intentionally retained for reproducible distribution; binary size and
compile cost are measured before release and can justify revisiting the wrapper
without changing DuckDB's rebuildable role.
