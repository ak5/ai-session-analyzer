# Testing

ASA has two verification tracks during the V2 migration. Rust V2 is the
distributed implementation. TypeScript V1 remains the behavioral oracle for
deferred features and parity fixtures.

## Rust V2

Run the complete workspace gate:

```sh
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
cargo build --locked --release --workspace
```

The Rust suite covers native payload and transcript adapters, versioned OTLP
encoding, authenticated ingestion, bounded concurrency, durable acknowledgement,
duplicate suppression, spool recovery, process-abort recovery, privacy,
retention, deletion, trace correlation, compressed projection, and DuckDB
rebuild equivalence. Adapter tests also isolate workspace-path migration across
Claude/Codex transcripts, indexes, Unicode/spaces, sidecars, collisions,
backups, and idempotent journal resume. See [V2 verification](v2-verification.md), the
[completion audit](v2-completion-audit.md), and the
[isolated smoke procedure](v2-smoke-test.md). The
[crash and saturation matrix](v2-crash-matrix.md) maps each required failure
point to deterministic recovery evidence.

Use `cargo test -p <crate>` while iterating. Tests that exercise native stores
MUST use isolated paths or read-only discovery; ordinary tests MUST NOT mutate
real Claude or Codex transcripts.

## TypeScript V1 unit tests

```sh
pnpm test        # vitest, resolves workspace imports to src — no build needed
```

Parsers are tested against synthetic records that encode the format gotchas from
[formats.md](formats.md) (usage dedupe, cumulative-total diffing, interruption
markers, subagent linking, fork truncation).

## TypeScript V1 E2E: real CLI, sandboxed homes

The e2e suite (`pnpm test:e2e`, config `vitest.e2e.config.ts`) runs the **built
binary** as a subprocess against fixture sessions living in gitignored repo-local
homes — the same `CLAUDE_CONFIG_DIR` / `CODEX_HOME` overrides the packages honor:

```
.e2e/claude-home/   ← CLAUDE_CONFIG_DIR for fixtures
.e2e/codex-home/    ← CODEX_HOME for fixtures
```

Fixture generation, idempotent (`--force` to regenerate):

```sh
pnpm e2e:setup --synthetic   # hand-written format-faithful fixtures; no auth, no cost (CI path)
pnpm e2e:setup               # REAL fixtures: one tiny `claude -p` (haiku) + one `codex exec`
```

The suite is agnostic to which mode produced the files, and per-agent suites
*skip with a hint* (never fail) when their fixture is missing — `pnpm test:e2e`
is runnable in any checkout.

## Auth for real-mode fixtures

An isolated `CLAUDE_CONFIG_DIR` cannot see macOS-Keychain credentials. The
supported bridge is a long-lived token:

```sh
claude setup-token                          # one-time, interactive
export CLAUDE_CODE_OAUTH_TOKEN=<token>      # or: write it to .e2e/claude-token (chmod 600)
```

On Linux, the setup script copies `~/.claude/.credentials.json` into the home
instead. For codex, it copies `~/.codex/auth.json` into `.e2e/codex-home/`.

**Safety invariant:** the setup script refuses to write anything unless
`git check-ignore` confirms `.e2e/` is ignored — session transcripts and copied
auth state can never end up in a commit. Real Claude fixture generation forces a
fixed session id (`--session-id`), and tests discover whatever fixtures exist.

Real-mode fixture generation can use account quota and handles credentials.
Prefer `--synthetic` unless real native validation is the explicit task.

## Cross-stack gate

`mise run check-all` runs both complete tracks. mise pins Node and pnpm;
`rust-toolchain.toml` remains the Rust version owner. CI keeps the tracks visible
as separate jobs so a V1 or V2 failure retains a clear owner.
