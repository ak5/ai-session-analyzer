# asa — ai session analyzer

Analyze, resume, and fork **Claude Code** and **Codex CLI** sessions from their on-disk
transcripts. `asa` never reimplements the agents — it parses their session files and
wraps the real `claude` / `codex` binaries for anything interactive.

## Usage

```sh
asa list                                  # recent sessions from both agents, newest first
asa list --agent codex -n 30 --json

asa analyze -c <id>                       # tokens, steps, tool calls, MCP usage, subagents
asa analyze -o <id> --json                # ids accept unique prefixes

asa resume -c <id>                        # wraps `claude --resume` in the session's original cwd
asa resume -o <id> -p "..."               # headless via `codex exec resume`

asa fork -c <id>                          # whole-session fork (`claude --resume <id> --fork-session`)
asa fork -o <id>                          # wraps `codex fork`
asa fork -c <id> --at <stepId>            # ← fork at a step (see below)

asa prompter --since 30d                  # analyze the human across recent sessions
asa prompter --deep                       # + LLM-judge pass (one batched haiku call)
```

Session selectors: `-c/--claude <id>` and `-o/--codex <id>` (`-o` as in OpenAI).
`asa --help` carries a use-case section; every subcommand documents its flags and
caveats in `asa <cmd> --help`.

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
| `@asa/prompter` | human-side analysis: prompt features, archetypes, lint, skill curve, LLM judge |
| `asa` (`packages/cli`) | commander CLI; spawns `claude`/`codex` for resume/fork |

Both parsers are hand-rolled and deliberately tolerant (no published schema exists
for either format; unknown record types are skipped, corrupt lines ignored). See
[docs/formats.md](docs/formats.md) for the reverse-engineered format notes, including
the token-counting gotchas.

### Adding an agent (OpenCode, Gemini CLI, …)

The CLI is a thin loop over an agent registry — `packages/cli/src/agents.ts`. A new
agent needs:

1. a `@asa/<agent>-sessions` package that discovers its session files and normalizes
   them to `NormalizedSession` (use `claude-sessions`/`codex-sessions` as templates —
   discovery, tolerant line parser, `interactions` counting);
2. an `AgentAdapter` entry in the registry: flag letter, list/find/load, and the
   argv shapes for resume/fork (plus `forkAtStep` if the store allows transcript
   truncation);
3. the new kind added to `AgentKind` in `@asa/core`.

`list`, `analyze`, `resume`, `fork`, and `prompter` pick it up automatically.
OpenCode/Gemini/Copilot aren't shipped yet for one reason: no session data on this
machine to verify a parser against — format-faithful parsing is the whole product,
so guessing is worse than omitting.

## Analyzing the prompter

`asa prompter` flips the lens: instead of what the agent did, it measures how *you*
drive it, aggregated across recent sessions of both agents.

- **Per-prompt features** (heuristics in `packages/prompter/src/features.ts`):
  length, specificity 0–10 (paths/code/enumeration add, vagueness subtracts),
  question vs directive, correction openers ("no, actually…"), vague fillers
  ("etc", "or something", "idk").
- **Steering signals** from the transcripts: interruptions (`[Request interrupted…]`
  markers, Codex turns without `task_complete`), slash commands, queued prompts,
  permission-mode changes, linked PRs.
- **Leverage**: agent output tokens per 1,000 chars you typed, and tool calls per step.
- **Archetype**: rule-based verdict (Micromanager / Cannonballer / Gardener /
  Delegator / Balanced Operator) with the evidence printed under it.
- **Lint**: threshold rules with your own prompts as receipts — vague-filler,
  unanchored-epics, correction-heavy, interrupt-heavy, rapid-fire, night-owl,
  mega-prompts.
- **Skill curve**: weekly correction/interruption/specificity trend.
- **Correlations**: e.g. specificity vs correction-rate across sessions (Pearson,
  with sample-size caveats printed).
- **`--deep`**: samples corrected-then-longest prompts and grades them 1–5 on
  clarity/context via one batched `claude -p` haiku call (`--no-session-persistence`,
  so judging never pollutes the session store it analyzes). Opt-in because prompt
  excerpts leave the machine (to your own Anthropic account).

Codex subagent rollouts (machine-written "prompts") are excluded by default —
`--include-subagents` keeps them. Absolute scores mean little; trends across your
own prompts are the point.

## Development

```sh
pnpm install
pnpm build        # tsc -b project references
pnpm test         # unit tests (vitest, runs against src, no build needed)
```

Honors `CLAUDE_CONFIG_DIR` and `CODEX_HOME` overrides.

### E2E tests

The e2e suite runs the built `asa` binary as a subprocess against fixture sessions in
gitignored repo-local homes (`.e2e/claude-home`, `.e2e/codex-home`), selected via the
same `CLAUDE_CONFIG_DIR` / `CODEX_HOME` overrides the packages honor.

```sh
pnpm e2e:setup --synthetic   # hand-written format-faithful fixtures; no auth, no cost
pnpm e2e:setup               # REAL fixtures: one tiny claude -p (haiku) + codex exec run
pnpm test:e2e                # builds, then runs e2e/ (skips suites whose fixture is missing)
```

Real mode needs auth inside the isolated homes:

- **claude** (macOS): credentials live in the Keychain, which an isolated
  `CLAUDE_CONFIG_DIR` can't see. Run `claude setup-token` once and either
  `export CLAUDE_CODE_OAUTH_TOKEN=<token>` or write it to `.e2e/claude-token`
  (chmod 600). On Linux the setup script copies `~/.claude/.credentials.json` instead.
- **codex**: the setup script copies `~/.codex/auth.json` into `.e2e/codex-home/`.

The setup script refuses to run unless git confirms `.e2e/` is ignored, so session
transcripts and copied auth state can never end up in a commit. Fixture generation is
idempotent (`--force` to regenerate); the suite itself never needs auth — real Claude
session generation forces a fixed session id (`--session-id`), and tests discover
whatever fixtures exist.

## Later / ideas

- Codex fork-at-step (truncate rollout file, new uuid, `codex resume`)
- Cost estimation per model/pricing table
- Copy Claude `subagents/` transcripts into forks
- Desktop app / TUI on top of `@asa/analyze`
- Optional deps: `@anthropic-ai/claude-agent-sdk` (`listSessions()`, `getSessionMessages()`,
  programmatic resume/fork) and `@openai/codex-sdk` (`resumeThread`) instead of spawning
