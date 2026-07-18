# @ak5/asa — ai session analyzer

Analyze, resume, fork, and distill **Claude Code** and **Codex CLI** sessions from
their on-disk transcripts. `asa` never reimplements the agents — it parses their
session files and wraps the real `claude` / `codex` binaries for anything
interactive.

```sh
pnpm i -g @ak5/asa   # or: npm i -g @ak5/asa
```

## Commands

```sh
asa list                          # sessions from both agents, grouped by project folder (+ orphans)
asa analyze -c <id> | -o <id>     # tokens, steps (with fork-point ids), tool calls, MCP usage, subagents
asa resume  -c <id> [-p "..."]    # wraps claude --resume / codex resume in the session's original cwd
asa fork    -c <id> [--at <stepId>]   # whole-session fork, or fork AT a step (reuse warmed-up context)
asa compare -c <a> -c <b>         # metric deltas between two sessions (or -c vs -o cross-agent)
asa prompter --since 30d [--deep] # profile the human: specificity, corrections, archetype, lint
asa distill --since 60d [--suggest claude|codex]   # what to extract into skills, rules, FAQs, crons
asa install-hooks [repo] [--jj]   # per-prompt git tracing (+ jj op-log snapshots of AI edits)
```

Session ids accept unique prefixes. `-c/--claude`, `-o/--codex` (as in OpenAI).
`asa --help` carries a use-case walkthrough; every subcommand documents its
caveats in `asa <cmd> --help`.

Everything runs locally against `~/.claude` / `~/.codex` (honors
`CLAUDE_CONFIG_DIR` / `CODEX_HOME`). The only network calls are the explicit
opt-ins (`--deep`, `--suggest`) — and those go through your own `claude`/`codex`
binaries to your own accounts.

Requires Node ≥ 20. The `claude` / `codex` CLIs are needed only for
resume/fork/suggest — analysis works on the files alone.

Full docs, session file format notes, and development setup:
[github.com/ak5/ai-session-analyzer](https://github.com/ak5/ai-session-analyzer).

MIT © Alexander Ververis
