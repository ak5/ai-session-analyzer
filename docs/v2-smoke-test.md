# ASA V2 local smoke test

The first executable milestone has a repeatable isolated smoke path. Use an
unused loopback port and a temporary ASA root:

```sh
cargo build --workspace
root="$(mktemp -d /tmp/asa-v2-smoke.XXXXXX)"
target/debug/asa --root "$root" daemon run --endpoint 127.0.0.1:54317
```

In a second terminal, submit sanitized native events:

```sh
target/debug/asa --root "$root" hook ingest --adapter codex \
  --endpoint 127.0.0.1:54317 < fixtures/v2/hooks/codex-post-tool-use.json
target/debug/asa --root "$root" hook ingest --adapter codex \
  --endpoint 127.0.0.1:54317 < fixtures/v2/hooks/codex-stop.json
target/debug/asa --root "$root" sessions list --json
```

Evidence required in the resulting document:

- one `codex:codex-fixture-session`;
- one completed turn;
- an `invoke_agent` root span;
- an `execute_tool` child span;
- two durable observations.

To verify outage recovery, stop the daemon, ingest the sanitized Claude Stop
fixture, confirm one JSON file exists under `spool/pending`, and restart the
daemon. Startup must report one drained observation and
`claude-code:claude-fixture-session` must appear in `sessions list`.

Hook merge behavior can be tested without touching user settings by changing
into the temporary root:

```sh
/absolute/path/to/asa hooks install --all
/absolute/path/to/asa hooks status --all
/absolute/path/to/asa hooks doctor --all
/absolute/path/to/asa hooks uninstall --all
```

Codex installation intentionally instructs the user to open `/hooks`; ASA never
weakens or bypasses native hook trust.

## Installed-agent evidence (2026-07-29)

Installed versions:

- Claude Code 2.1.220;
- Codex CLI 0.145.0;
- Claude.app and ChatGPT desktop applications present.

Read-only native-store validation discovered 157 Claude and 350 Codex sessions.
One recent transcript from each parsed successfully; the samples contained 694
tool calls in total and no malformed records.

An isolated real Claude invocation fired three project-hook observations before
the model request was rejected by organization policy. This confirms the
installed Claude runtime executes ASA's neutral observer, but a real `Stop`
cannot be produced with the current account policy.

Codex completed multiple read-only prompts neutrally. Its temporary project
hook layer was not loaded because project trust is distinct from hook trust;
the visible `SessionStart` came from an existing user hook. The safe next
validation is a semantic ASA user-scope install followed by selective uninstall.
That persistent security-relevant settings change requires explicit user
approval and was not performed implicitly.
