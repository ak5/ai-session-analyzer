# asa — ai session analyzer

[![test](https://github.com/ak5/ai-session-analyzer/actions/workflows/test.yml/badge.svg?branch=dev)](https://github.com/ak5/ai-session-analyzer/actions/workflows/test.yml)

Your AI coding sessions are a dataset. **asa** turns the transcripts that Claude Code
and Codex CLI already write to disk into something you can **inspect** (tokens, steps,
tools, cost), **act on** (resume and fork sessions — including forking
*mid-conversation* to reuse a warmed-up context), and **learn from** (what you keep
re-typing, whether your CLAUDE.md edits actually work, where your tokens really go).

`asa` never reimplements the agents — it parses their session files and wraps the real
`claude` / `codex` binaries for anything interactive. **Everything runs locally**
against `~/.claude` and `~/.codex`; nothing leaves your machine except two explicitly
opt-in flags (`--deep`, `--suggest`), which send short prompt excerpts through your own
`claude`/`codex` CLIs to your own accounts.

## Quick start

```sh
git clone https://github.com/ak5/ai-session-analyzer
cd ai-session-analyzer
pnpm install && pnpm build
npm i -g ./packages/cli        # links the bundled CLI globally as `asa`
```

Node ≥ 20, pnpm. (npm package coming soon; the global install is a link to your
checkout — `git pull && pnpm build` updates it in place.) The `claude` / `codex`
CLIs are only needed for `resume`, `fork`, and the opt-in model passes — analysis
works on the session files alone.

**Sixty seconds to your first insight:**

```console
$ asa list -n 10                # what do I have? (both agents, grouped by project)
/Users/you/Projects/botyard — 2 sessions
  2026-07-19 05:37  claude adad3a2f-7946-4a4a-a833-6daf8524a8f5   9603kB
  2026-07-18 13:53  claude 5f2066c3-7231-41ed-bdf2-e7c1e463653f   4405kB
/Users/you/Projects/showyourcards/app — 2 sessions
  2026-07-19 05:16  codex  019f69e7-30f3-77d0-95a3-3c4f86be2ce6   8147kB
  …

$ asa analyze -c adad3a2f       # where did that one go? (ids accept unique prefixes)
steps 87 · api calls 529 · tool calls 699 (0 mcp, 20 errors) · subagents 3 · duration 27h
tokens: in 975, out 650,413, cache-read 267,016,252 — total 269,437,886
content: human 8,212 chars (1%) · harness 333,926 (54%) · tool results 281,014 (45%)

$ asa distill --since 30d       # what do I keep typing by hand?
Recurring procedures (skill candidates):
×  sessions  agents        out-tokens  recurring prompt
4  4         codex+claude  9,875       ok whats the next step to do this
2  2         claude        1,664       merge it with --admin i apprive
```

That `content:` line is your **context tax** — over half of that session's input was
harness-injected instructions, not conversation. And `distill` just told you which
prompts you've paid for four times.

Then run **`asa setup`** once: an environment report plus three independently
confirmed opt-in steps — raise Claude's transcript retention
(`cleanupPeriodDays` defaults to 30 days, the ceiling on every longitudinal
feature), install per-prompt git tracing into the current repo, and colocate jj
for op-log snapshots of agent edits.

## Commands

Sessions are addressed with `-c/--claude <id>` or `-o/--codex <id>` (as in
OpenAI); ids accept unique prefixes. Every report command also takes `--json`
(machine-readable) and `--html [file]` (a styled, self-contained page —
dark/light aware, shareable). `asa <command> --help` documents every flag, and
`asa --help` ends with a use-case cookbook.

| command | what it answers |
|---|---|
| `asa list` | what sessions do I have? — both agents, grouped by project, orphans flagged |
| `asa analyze` | where did this session go? — tokens, steps, tools, MCP, subagents, content volume |
| `asa compare` | what changed between these two? — metric deltas: original vs fork, or cross-agent |
| `asa resume` | re-enter a session in its original cwd (wraps `claude --resume` / `codex resume`) |
| `asa fork` | branch a session — whole-session, `--at <stepId>` mid-conversation, or `--context` for a crafted-context fork |
| `asa distill` | what should stop being typed by hand? — recurring prompts, questions, tool sequences; `--suggest` for model recommendations, `--faq` to write a dev-faq |
| `asa prompter` | how do I prompt? — specificity, corrections, archetype, lint, workflow hygiene |
| `asa project` | one repo's whole agent history — spend, steering, instruction surfaces |
| `asa efficacy` | did my CLAUDE.md / AGENTS.md edits work? — steering metrics before vs after each commit |
| `asa intents` | what do I use agents for? — intent mix per repo; `--deep` names recurring themes |
| `asa models` | model archaeology — favorites, weekly dominance, era switches |
| `asa setup` | onboarding: retention, git tracing, jj — each step confirmed separately |
| `asa install-hooks` | per-prompt git tracing for one repo (what `setup` installs, standalone) |

`analyze` and `compare` also estimate **API-equivalent cost** (`est. cost $27.35`)
from published list prices — on a subscription your marginal cost is $0; this is
what the same tokens would have cost via the API. Models missing from the builtin
table are named, never guessed: add their rates to `~/.asa/pricing.json`
(`{"claude-fable-5": {"input": 15, "output": 75, "cacheRead": 1.5, "cacheWrite": 18.75}}`,
USD per million tokens) and they price everywhere.

## Fork at a step

Every step id in `asa analyze` output is a **time-travel point**:

```console
$ asa analyze -c 092aede3
Steps (use the step id with `asa fork --at <id>`):
#  step id                               api  tools  prompt
1  025bf4c2-d128-49af-a193-cf09bcb5cf87  31   58     i need a plan to scaffold me…
5  83421cf1-4fc4-48bb-a511-89a7bc34538d  1    0      how would one analyze the human prompter?…

$ asa fork -c 092aede3 --at 83421cf1
Forked 092aede3 at step 83421cf1 → session a2807c82-14aa-4ccd-b13b-98c4ef9de525
  kept 461 records, dropped 281
→ claude --resume a2807c82…   # re-enter the conversation as it was at step 5
```

The original session is untouched; the replayed prefix hits prompt cache. Then
measure what the alternate timeline cost:

```console
$ asa compare -c 092aede3 -c a2807c82
metric        A           B          Δ            Δ%
steps         20          5          -15          -75%
total tokens  39,278,156  8,031,034  -31,247,122  -80%
```

**Fork at a step** is the feature neither CLI has: `--at` writes a truncated copy of
the transcript up to that step under a fresh session id, then resumes it. Retry a
decision point, A/B an approach, or re-enter an expensive session without replaying
your whole day. Works on both agents — Codex forks even carry native
`forked_from_id` lineage. Caveat, stated plainly: it relies on each CLI accepting
externally written transcripts on resume — verified live on both (Claude v2.1.212,
Codex v0.144, including deep forks correctly recalling earlier-step content), but
neither transcript format is a stable contract; treat step-forks as disposable.
Resume a fork with a model whose context window fits it: a fork of a heavy session
can exceed a smaller model's window (`--model haiku` on a 200k+ context replies
"Prompt is too long").

`asa resume` covers the non-fork cases: interactive re-entry in the session's
original cwd, or headless (`asa resume -o <id> -p "continue"` wraps
`codex exec resume` — scriptable).

## Fork with a crafted context (beat /compact at its own game)

Native compaction is a lossy paraphrase: Claude's `/compact` spends a ~2-minute
full-context summarization call (~1M billed tokens) to shrink ~977k → ~18k,
throwing away your literal words; Codex keeps your prompts verbatim but hides its
bridge summary in an encrypted blob. `asa fork -c <id> --context` crafts the fork's
history instead — mimicking each agent's own post-compaction transcript shape, but
with a deterministic digest: **every prompt verbatim, each step's concluding
response, files touched** — while dropping tool results and harness bulk (typically
99% of content). Instant, zero tokens spent, inspectable in the transcript, and the
original session is untouched. `--keep N` holds the last N steps fully verbatim.

Live proof, both agents: a 307M-token Claude session crafted to ~8.5k tokens of
context — the resumed fork *quoted the user's exact words from step 8 of 50*
("we can call it ensure-plugins or something and it can be idempotent…"), which the
session's own native compact summary had paraphrased away. Same on Codex: a 9.1M-token
session's crafted fork recalled a verbatim quote, a repo name, and a typo'd path
from digested steps. Same stability caveat as `--at`: crafted transcripts rely on
resume accepting external files — treat forks as disposable.

## Distill: stop typing it by hand

`asa distill` mines recurring behavior across sessions — repeated procedures,
questions, corrections, and tool sequences. Plain `distill` is fully local and
deterministic (token-overlap clustering, no embeddings, no API calls):

```console
$ asa distill --since 60d
Distill — 676 prompts across 34 sessions (12 claude, 22 codex), 12 projects

Recurring procedures (skill candidates):
×  sessions  agents        out-tokens  recurring prompt
4  4         codex+claude  9,875       ok whats the next step to do this
2  2         claude        17,081      merge in the renovate thing if thats already a pr also
2  2         claude        1,664       merge it with --admin i apprive

Recurring questions (FAQ / flashcard candidates):
×  sessions  agents        out-tokens  recurring prompt
4  3         codex+claude  18,886      what else can we build now before we do a release

Recurring tool sequences (procedure evidence):
×    sessions  sequence
581  9         exec:gh → exec:gh
314  12        exec:git → exec:git

Command usage (skill = your extracted procedures; builtin = CLI-provided):
command            kind     ×  sessions
/boiltheocean      skill    3  2
$session-closeout  skill    2  2
```

The `out-tokens` column is what each repetition has cost you so far — the case
for extracting it. Two flags turn stats into artifacts:

- **`--suggest claude|codex`** ships the digest to a model (your own account,
  your own CLI) and prints extraction recommendations: skills to write,
  CLAUDE.md rules, automations, retention gaps, prompting-vocabulary upgrades.
  Gated behind a token estimate + your live quota + `proceed? [y/N]` (`--yes`
  to skip). The prompt template is `packages/distill/src/suggest-template.ts`,
  or bring your own with `--prompt-file`.
- **`--faq [repo]`** writes `docs/dev-faq.md` for real: recurring questions with
  answers extracted from your transcripts (you already paid for them),
  edit-preserving on regeneration — hand-tuned answers survive.

## Learn: the rest

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
| `@asa/prompter` | human-side analysis: prompt features, archetypes, lint, workflow hygiene, skill curve, LLM judge |
| `@asa/distill` | recurrence mining + `--suggest` recommendations |
| `@asa/meta` | repo-level: dossier, instruction efficacy, intents, model history |
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
- Codex per-turn git tracing (no hook surface upstream yet)
- More agents via the adapter registry (OpenCode, Gemini CLI, Copilot CLI)
- Desktop app / TUI on top of the analysis packages

## License

MIT — see [LICENSE](LICENSE) and [CONTRIBUTORS.md](CONTRIBUTORS.md).
