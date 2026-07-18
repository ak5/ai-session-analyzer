# Git tracing (`asa install-hooks`)

Claude transcripts record only a branch name; Codex records one commit hash at
session start. The trace hooks close the gap so analysis can join *each step* to
the exact repo state it ran against.

## What gets installed

`asa install-hooks [repo]` (idempotent; resolves the repo root from any
subdirectory, like git):

- `.asa/hooks/git-trace.mjs` — a self-contained Node script; repos never need
  asa itself installed.
- `UserPromptSubmit` + `Stop` hook entries in the repo's `.claude/settings.json`
  (existing settings content is preserved; duplicate entries are never added).
- `.asa/` added to `.gitignore`.

Each hook event appends one JSONL line to `.asa/git-trace.jsonl`:

```json
{"ts":"…","event":"UserPromptSubmit","session_id":"…","head":"<sha>","branch":"dev","dirty_files":3}
```

`loadClaudeSession` joins the trace onto steps by nearest timestamp (±20s window,
same-machine clocks), so `asa analyze` shows a `head` column per step and
`asa compare` can relate behavior changes to repo changes.

The hook **never writes to stdout**: `UserPromptSubmit` stdout is injected into
the agent's context, so a chatty hook would silently pollute every conversation
it observes. It also never blocks — all failures are swallowed, exit 0.

## `--jj`: op-log snapshots of AI edits

With `--jj`, the installer also colocates a [jj](https://github.com/jj-vcs/jj)
repo (`jj git init --colocate`) and the hook runs `jj status` per event — which
forces a working-copy snapshot into jj's operation log. Result: commit-free,
diffable history of exactly what the agent changed between any two prompts:

```sh
jj op log            # one snapshot per hook event
jj op diff --op <id> # what changed in that window
```

## Codex

Codex rollouts already record `git.commit_hash` at session start, but Codex has
no per-turn hook surface today, so per-step tracing is Claude-only. If/when codex
grows hooks, the trace format and join are agent-agnostic.
