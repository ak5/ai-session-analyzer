# asa — ai session analyzer

Analyze, resume, and fork **Claude Code** and **Codex CLI** sessions from their on-disk
transcripts. `asa` never reimplements the agents — it parses their session files and
wraps the real `claude` / `codex` binaries for anything interactive.

## Usage

```sh
asa list                                  # recent sessions from both agents, newest first
asa list --agent codex -n 30 --json

asa analyze --claude-session <id>         # tokens, steps, api calls, tool calls, MCP usage, subagents
asa analyze --codex-session <id> --json   # ids accept unique prefixes

asa resume --claude-session <id>          # wraps `claude --resume` in the session's original cwd
asa resume --codex-session <id> -p "..."  # headless via `codex exec resume`

asa fork --claude-session <id>            # whole-session fork (`claude --resume <id> --fork-session`)
asa fork --codex-session <id>             # wraps `codex fork`
asa fork --claude-session <id> --at <stepId>   # ← fork at a step (see below)
```

During development: `pnpm asa <args>` or `node packages/cli/bin/asa.js <args>`.
To get a global `asa`: `pnpm build && cd packages/cli && pnpm link --global`.

### Fork at a step

`asa analyze` prints a step id per user turn. `asa fork --at <stepId>` writes a
truncated copy of the transcript (everything up to and including that step) under a
fresh session id into the same project dir, then launches `claude --resume <newId>`.
That re-enters the conversation at that point with the context "warmed up" — prompt
caching applies to the replayed prefix — without touching the original session.

Neither CLI offers this natively (`--fork-session` only forks whole sessions). It
relies on Claude Code accepting externally written transcripts on `--resume`, which
works today (verified against v2.1.212) but is not a stable contract: treat forks as
disposable. Codex `--at` forking is not implemented yet (same trick is possible with
rollout files).

## Packages

Classic pnpm monorepo:

| package | role |
|---|---|
| `@asa/core` | normalized session model (`NormalizedSession`, `Step`, `ToolCall`, `UsageTotals`) shared by everything |
| `@asa/claude-sessions` | discovery + parsing + fork-at-step for `~/.claude/projects/**.jsonl` |
| `@asa/codex-sessions` | discovery + parsing for `~/.codex/sessions/**/rollout-*.jsonl` |
| `@asa/analyze` | analysis + text rendering over the normalized model |
| `asa` (`packages/cli`) | commander CLI; spawns `claude`/`codex` for resume/fork |

Both parsers are hand-rolled and deliberately tolerant (no published schema exists
for either format; unknown record types are skipped, corrupt lines ignored). See
[docs/formats.md](docs/formats.md) for the reverse-engineered format notes, including
the token-counting gotchas.

## Development

```sh
pnpm install
pnpm build        # tsc -b project references
pnpm test         # vitest, runs against src (no build needed)
```

Honors `CLAUDE_CONFIG_DIR` and `CODEX_HOME` overrides.

## Later / ideas

- Codex fork-at-step (truncate rollout file, new uuid, `codex resume`)
- Cost estimation per model/pricing table
- Copy Claude `subagents/` transcripts into forks
- Desktop app / TUI on top of `@asa/analyze`
- Optional deps: `@anthropic-ai/claude-agent-sdk` (`listSessions()`, `getSessionMessages()`,
  programmatic resume/fork) and `@openai/codex-sdk` (`resumeThread`) instead of spawning
