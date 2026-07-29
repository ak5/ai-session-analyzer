# ASA V2 operations

Build or install one `asa` executable. The Rust implementation does not require
Node.js at runtime.

```sh
cargo build --release -p asa-cli
target/release/asa daemon install
target/release/asa hooks install --all --scope user
target/release/asa daemon doctor
```

`daemon install` uses a per-user native supervisor:

- macOS: `~/Library/LaunchAgents/com.ak5.asa.plist`;
- Linux: `${XDG_CONFIG_HOME:-~/.config}/systemd/user/asa.service`.

The service binds to `127.0.0.1:4317` by default. ASA creates a private bearer
token on first daemon run. Use `daemon start`, `stop`, `restart`, `status`,
`logs`, and `doctor` for normal operation. Foreground development uses
`daemon run`.

On Linux, daemon output is owned and rotated by the user journal according to
the host's `journald` policy. On macOS, launchd writes `daemon.log` and
`daemon.err.log` under the ASA log directory. `daemon doctor` reports either
file after 10 MiB; stop the service, rotate or archive the reported file, then
start it again. ASA does not rename a file while launchd has it open.

The adjacent authenticated control API binds to `127.0.0.1:4318` by default.
It exposes `GET /health` and `POST /v1/rpc`; both require the same bearer
token. RPC methods are `adapter.list`, `adapter.capabilities`, `session.list`,
`session.get`, `session.events`, `analysis.session`, `analysis.compare`,
`daemon.health`, `daemon.stats`, and `storage.rebuild`. Arbitrary SQL is not
exposed. OTLP remains solely the telemetry-ingestion boundary.

Hook installation semantically merges ASA handlers and preserves unrelated
agent settings. Codex project hooks still require native review/trust through
`/hooks`. The hook process never starts the daemon and always emits a neutral
native response; if the daemon is down, it writes an ASA-owned spool entry.

To remove ASA without touching native transcripts:

```sh
asa hooks uninstall --all --scope user
asa daemon uninstall
```

ASA data remains available after service uninstall. Delete one ASA-owned
session explicitly with `asa sessions delete <adapter:id> --yes`. This removes
durable ASA observations, spool entries, compressed projections, and rebuilt
DuckDB rows; it never deletes Claude or Codex transcripts.

When a repository or one of its parent directories moves, preflight the
explicit native metadata migration before applying it:

```sh
asa sessions migrate-path /old/workspace /new/workspace --dry-run
asa sessions migrate-path /old/workspace /new/workspace
```

The old directory does not need to exist. Dry-run lists every affected
Claude/Codex transcript, sidecar, and index operation and performs no writes.
Apply refuses destination collisions before mutation, rewrites only recognized
cwd/workspace fields, and never modifies files inside either repository.
Claude path-derived files move to their new project directory; Codex rollout
paths remain stable. ASA stores a durable journal under
`migration-journals/` and original per-file backups under
`migration-backups/` in the ASA data root. Re-running the exact command resumes
or confirms the migration. After completion ASA spools a
`workspace.path.changed` observation and rebuilds available projections.

Recovery commands:

```sh
asa daemon rebuild
asa storage rebuild
asa storage stats
```

Resume remains an explicit human command and never runs in the daemon or hook
path:

```sh
asa resume <session-id-or-prefix> --dry-run
asa resume <session-id-or-prefix>
asa resume <session-id-or-prefix> --prompt "continue"
```

ASA resolves a unique Claude or Codex native session, uses its recorded working
directory when that directory still exists, and launches the installed native
agent CLI with inherited input/output. If the directory no longer exists, ASA
uses the current directory. `--dry-run` prints the exact command and cwd without
launching an agent. Resume does not rewrite the transcript.

Whole-session fork has the same explicit, non-hook boundary:

```sh
asa fork <session-id-or-prefix> --dry-run
asa fork <session-id-or-prefix>
asa fork <session-id-or-prefix> --prompt "try approach B"
```

Claude delegates to `claude --resume <id> --fork-session`; Codex delegates to
`codex fork <id>`. ASA uses the same recorded-cwd recovery and inherited
terminal streams as resume. The native CLI owns creation of the fork and the
original transcript is untouched.

An explicit mid-session fork writes a new disposable native transcript and can
optionally stop before launch:

```sh
asa fork <session-id-or-prefix> --at <step-id> --dry-run
asa fork <session-id-or-prefix> --at <step-id> --no-launch
asa fork <session-id-or-prefix> --at <step-id> --prompt "try approach B"
```

The cut lands immediately before the next prompt/turn. Claude session IDs and
subagent transcript IDs are rewritten and sidecar tool results are copied.
Codex session metadata receives the new ID and native `forked_from_id` lineage.
New files use exclusive creation and are flushed before ASA reports success;
the source transcript is never modified. This relies on undocumented native
transcript formats, so these forks are explicitly disposable.

Crafted-context fork deterministically retains literal prompts, capped step
conclusions, and touched file paths while dropping tool-result bulk. The most
recent steps remain verbatim:

```sh
asa fork <session-id-or-prefix> --context --keep 2 --dry-run
asa fork <session-id-or-prefix> --context --keep 2 --no-launch
asa fork <session-id-or-prefix> --context --hint "database migration"
```

`--hint` gives matching step conclusions four times the normal excerpt budget
and non-matching conclusions half, using local keyword matching only. There is
no model call and no network request. Claude receives its native
`compact_boundary` plus summary shape with a re-rooted tail; Codex receives
literal user history, native lineage, and its verbatim recent turns. As with
`--at`, the original is read-only and the crafted fork is disposable.

Local distillation scans native transcripts explicitly and never runs from a
hook:

```sh
asa distill --since 30d
asa distill --agent claude --limit 100
asa distill --json
```

It removes ASA-internal model-pass sessions, deduplicates fork-copied
step/prompt pairs, clusters repeated directives, questions, and corrections
only when they span multiple sessions, and reports recurring tool sequences
and command use. Clustering uses deterministic stopword-stripped token overlap;
there are no embeddings, model calls, or network requests. The V1 `--suggest`
and `--faq` mutations are not yet exposed by Rust.

Local prompter analysis uses the same explicit native-session scope:

```sh
asa prompter --since 30d
asa prompter --agent codex --limit 40
asa prompter --json
```

It reports prompt length and specificity, correction/interruption rates,
output-token leverage, tool calls, per-agent/session aggregates, an
evidence-backed archetype, deterministic lint findings, compaction/PR workflow
signals, weekly buckets, and correlations when the sample is large enough.
ASA-internal sessions are excluded. The V1 model-backed `--deep` judge and HTML
output remain unported; plain Rust `prompter` makes no model or network call.

Longitudinal local reports share the native-session scope and JSON option:

```sh
asa project .
asa efficacy . --window 10
asa intents --since 60d
asa models --since 90d
```

`project` resolves the Git root, attributes sessions whose recorded cwd is the
root or a descendant (canonicalizing `/tmp`-style aliases), aggregates usage,
tools/MCP, steering events, and inventories instruction surfaces. `efficacy`
reads `git log --follow` for `AGENTS.md` and `CLAUDE.md`, then compares bounded
before/after correction and interruption windows; it labels the result as
correlational. `intents` uses an ordered local taxonomy over opening prompts.
`models` uses parser-owned per-response/per-turn attribution for API calls,
output tokens, favorites, weekly dominance, and switches. Model-backed intent
themes, Claude long-range stats-cache history, and HTML remain unported.

Native reconciliation checkpoints include the transcript identity, path, size,
modification time, and parser version. A shrink, replacement, parser upgrade,
or missing projection invalidates the checkpoint. Checkpoints advance atomically
only after a projection succeeds. The current parser deliberately performs a
complete reparse even for a valid checkpoint; incremental append parsing stays
disabled until hook/native document merging is proven safe.

Privacy defaults are metadata-first. Create and inspect the explicit policy
with `asa privacy init` and `asa privacy show`. Configure `retention_days`, then
run `asa privacy enforce-retention --yes` to remove expired ASA-owned data.
