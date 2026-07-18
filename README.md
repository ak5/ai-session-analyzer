# asa — ai session analyzer

[![test](https://github.com/ak5/ai-session-analyzer/actions/workflows/test.yml/badge.svg?branch=dev)](https://github.com/ak5/ai-session-analyzer/actions/workflows/test.yml)

Your AI coding sessions are a dataset. **asa** turns the transcripts that Claude Code
and Codex CLI already write to disk into something you can **inspect** (tokens, steps,
tools, cost), **act on** (resume and fork sessions — including forking *mid-conversation*
to reuse a warmed-up context), and **learn from** (what you keep re-asking, whether your
CLAUDE.md edits actually work, where your tokens really go).

`asa` never reimplements the agents. It parses their session files and wraps the real
`claude` / `codex` binaries for anything interactive.

**Everything runs locally** against `~/.claude` and `~/.codex`. Nothing leaves your
machine except two explicitly opt-in flags (`--deep`, `--suggest`), which send short
prompt excerpts through your own `claude`/`codex` CLIs to your own accounts.

## A taste

```console
$ asa analyze -c 092aede3
claude session 092aede3-e6c8-4377-b895-05a3605af00b
  title    Build AI session analyzer with fork and token tracking
  cwd      /Users/ak5/Projects/ai-session-analyzer
  model    claude-fable-5

steps 7 · api calls 103 · tool calls 169 · subagents 3 · duration 13h 54m
tokens: in 188, out 161,117, cache-read 15,969,935 — total 16,661,925
content: human 5,581 chars (2%) · harness 153,057 (44%) · tool results 189,290 (54%)

Steps (use the step id with `asa fork --at <id>`):
#  step id                               api  tools  prompt
1  025bf4c2-d128-49af-a193-cf09bcb5cf87  31   58     i need a plan to scaffold me…
2  336a91f4-7342-453e-a2cd-8315f9750f97  7    11     /goal get a v1-rc out on main…
5  83421cf1-4fc4-48bb-a511-89a7bc34538d  1    0      how would one analyze the human prompter?…
```

That `content:` line is your **context tax** — 44% of this session's input was
harness-injected instructions, not conversation. And every step id is a **time-travel
point**:

```console
$ asa fork -c 092aede3 --at 83421cf1
Forked 092aede3 at step 83421cf1 → session a2807c82-14aa-4ccd-b13b-98c4ef9de525
  kept 461 records, dropped 281
→ claude --resume a2807c82…   # re-enter the conversation as it was at step 5
```

The original session is untouched; the replayed prefix hits prompt cache. Then measure
what the alternate timeline cost:

```console
$ asa compare -c 092aede3 -c a2807c82
metric        A           B          Δ            Δ%
steps         20          5          -15          -75%
total tokens  39,278,156  8,031,034  -31,247,122  -80%
```

## Install

From a clone (npm package coming soon):

```sh
git clone https://github.com/ak5/ai-session-analyzer
cd ai-session-analyzer
pnpm install && pnpm build
npm i -g ./packages/cli        # links the bundled CLI globally as `asa`
asa --version
```

Node ≥ 20, pnpm. The global install is a link to your checkout — `git pull &&
pnpm build` updates it in place. Works on the session files alone; the `claude` /
`codex` CLIs are only needed for `resume`, `fork`, and the opt-in model passes.

## Inspect

```sh
asa list                        # sessions from both agents, grouped by project folder
asa list --flat -n 30 --json    # or flat / machine-readable
asa analyze -c <id>             # tokens, steps, tool calls, MCP usage, subagents
asa analyze -o <id> --json      # -c/--claude, -o/--codex (as in OpenAI); ids accept unique prefixes
asa compare -c <a> -c <b>       # metric deltas — original vs fork, or -c vs -o cross-agent
```

`asa list` groups by each session's real cwd (read from the file headers) and ends
with an **Orphans** section — sessions whose directory no longer exists (deleted
worktrees, dev-slot clones).

## Act

```sh
asa resume -c <id>              # wraps `claude --resume` in the session's original cwd
asa resume -o <id> -p "..."     # headless via `codex exec resume`
asa fork -c <id>                # whole-session fork (`--fork-session`) — codex: wraps `codex fork`
asa fork -c <id> --at <stepId>  # fork AT a step (Claude; see the demo above)
```

**Fork at a step** is the feature neither CLI has: `--at` writes a truncated copy of
the transcript up to that step under a fresh session id, then resumes it. Retry a
decision point, A/B an approach, or re-enter an expensive session without replaying
your whole day. Caveat, stated plainly: it relies on Claude Code accepting externally
written transcripts on `--resume` — works today (verified against v2.1.212, including
deep forks correctly recalling earlier-step content), but not a stable contract; treat
step-forks as disposable. Resume a fork with a model whose context window fits it: a
fork of a heavy session can exceed a smaller model's window (`--model haiku` on a
200k+ context replies "Prompt is too long").

## Learn

Full details for everything below: [docs/analysis.md](docs/analysis.md).

**`asa prompter --since 30d`** — analyze the human. Specificity, corrections,
interruptions, leverage, a weekly skill curve, an archetype verdict, prompt lint
with your own prompts as receipts — plus **workflow hygiene**: compaction pressure
(sessions running long enough to lossily summarize themselves → prefer smaller
sessions or `asa fork --at`) and git discipline (edits without commits, heavy work
directly on main, long sessions whose outcomes never became a commit/PR/issue):

```console
Archetype: The Gardener
  Many small nudges per session — high-touch, incremental steering.
Lint:
  [warn] vague-filler: 2.1 vague fillers ("etc", "or something", "idk"…) per 10 prompts
      e.g. "i need a plan to scaffold me in this repo a typescript based claude code or codex…"
  [info] night-owl: 20% of prompts land between midnight and 5am local.
```

**`asa distill --since 60d`** — what should stop being typed by hand. Deterministic
recurrence mining (prompt clusters, tool-sequence n-grams like `exec:gh → exec:gh`
across 11 sessions), then `--suggest claude|codex` turns the stats into
recommendations: skills to extract, CLAUDE.md rules, automations, `docs/dev-faq.md`
entries, flashcard-worthy retention gaps.

```console
Recurring procedures (skill candidates):
×  sessions  recurring prompt
3  3         commit and push to dev
2  2         merge it with --admin i apprive
```

**`asa project` / `asa efficacy` / `asa intents`** — repo-level meta. One repo's
whole agent history with its instruction surfaces and git churn; correction rates
before vs after every CLAUDE.md/AGENTS.md commit (finally: did that rule *work*?);
and per-repo intent mix, with `--deep` naming recurring themes flagged
shipped/unshipped via PR links.

**`asa models --since 60d`** — model archaeology. Per-model API calls, share,
favorites, and a weekly dominant-model timeline with switch detection (Codex
reasoning effort included) — plus a long-range era history from Claude's
`stats-cache.json`, whose daily per-model token matrix reaches months beyond
transcript retention:

```console
Era changes (weekly dominant by tokens):
  week of 2026-05-25: claude-opus-4-7 → claude-opus-4-8
  week of 2026-07-13: claude-opus-4-8 → claude-fable-5
```

Model-spending flags everywhere (`--deep`, `--suggest`) are gated behind a token
estimate plus your live quota (Codex: rollout rate-limit events; Claude: headless
`claude -p "/usage"`) and a `proceed? [y/N]` — `--yes` to skip.

**`asa install-hooks [repo] [--jj]`** — git context per step. Claude Code hooks stamp
git HEAD + dirty state per prompt into a gitignored trace; `analyze` then shows the
commit each step ran against. `--jj` snapshots the working copy into
[jj](https://github.com/jj-vcs/jj)'s op log every turn — commit-free diffable history
of AI edits. Details: [docs/git-tracing.md](docs/git-tracing.md).

## How it works

Classic pnpm monorepo:

| package | role |
|---|---|
| `@asa/core` | normalized cross-agent session model shared by everything |
| `@asa/claude-sessions` | discovery, tolerant parsing, fork-at-step, git-trace join for `~/.claude/projects/**.jsonl` |
| `@asa/codex-sessions` | discovery + tolerant parsing for `~/.codex/sessions/**/rollout-*.jsonl` |
| `@asa/analyze` | per-session analysis, comparison, text rendering |
| `@asa/prompter` | human-side analysis: prompt features, archetypes, lint, skill curve, LLM judge |
| `@asa/distill` | recurrence mining + `--suggest` recommendations |
| `@asa/meta` | repo-level: dossier, instruction efficacy, intents |
| `@ak5/asa` (`packages/cli`) | the CLI: agent registry, command surface, spawns `claude`/`codex` |

No published schema exists for either transcript format, so both parsers are
hand-rolled and deliberately tolerant: unknown record types skipped, corrupt lines
ignored. [docs/formats.md](docs/formats.md) has the reverse-engineered format notes,
including the token-counting gotchas (Claude splits one API response across multiple
records that each repeat the same usage — dedupe or overcount 3–8×; Codex stores
cumulative totals — diff at turn boundaries).

Honors `CLAUDE_CONFIG_DIR` and `CODEX_HOME` overrides throughout. Adding another
agent (OpenCode, Gemini CLI, …) is a sessions package + one registry entry:
[docs/adding-an-agent.md](docs/adding-an-agent.md).

## Development

```sh
pnpm install
pnpm build        # tsc -b project references + esbuild bundle of the CLI
pnpm test         # unit tests (vitest, runs against src, no build needed)
pnpm test:e2e     # drives the real binary against sandboxed fixture homes in .e2e/
```

E2E fixtures come from `pnpm e2e:setup` (real `claude -p`/`codex exec` runs into
gitignored repo-local homes) or `--synthetic` (no auth, no cost). Auth bridging and
safety invariants: [docs/testing.md](docs/testing.md).

Published artifact is `@ak5/asa` only — the CLI, bundled, zero runtime deps.
Bundling rationale, tarball verification, release steps:
[docs/publishing.md](docs/publishing.md).

## Roadmap

- **Replay**: re-run a session's prompts after changing CLAUDE.md/memory/code, in a
  worktree, with recorded-from-transcript **VCR-style MCP mocks** (the transcript
  already holds every MCP call + result) — scored via `asa compare`
- Codex fork-at-step and per-turn git tracing (no hook surface upstream yet)
- More agents via the adapter registry (OpenCode, Gemini CLI, Copilot CLI)
- Cost estimation per model/pricing table
- Copy Claude `subagents/` transcripts into forks
- Desktop app / TUI on top of the analysis packages

## License

MIT — see [LICENSE](LICENSE) and [CONTRIBUTORS.md](CONTRIBUTORS.md).
