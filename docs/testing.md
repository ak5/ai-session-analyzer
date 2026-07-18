# Testing

## Unit tests

```sh
pnpm test        # vitest, resolves workspace imports to src — no build needed
```

Parsers are tested against synthetic records that encode the format gotchas from
[formats.md](formats.md) (usage dedupe, cumulative-total diffing, interruption
markers, subagent linking, fork truncation).

## E2E: real CLI, sandboxed homes

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
