# Analysis features in depth

Details behind `asa prompter`, `asa distill`, and the `asa project` /
`asa efficacy` / `asa intents` trio. For file-format internals see
[formats.md](formats.md).

## prompter

Measures how the *human* drives the agents, aggregated across recent sessions of
both agents.

- **Per-prompt features** (heuristics in `packages/prompter/src/features.ts`):
  length, specificity 0–10 (paths/code/enumeration/imperative add, vagueness
  subtracts), question vs directive, correction openers ("no, actually…"), vague
  fillers ("etc", "or something", "idk"). Absolute scores mean little; trends and
  comparisons across your own prompts are the point.
- **Steering signals** from the transcripts: interruptions (Claude
  `[Request interrupted…]` markers; Codex turns without `task_complete`), slash
  commands, queued prompts, permission-mode changes, linked PRs.
- **Leverage**: agent output tokens per 1,000 chars typed; tool calls per step.
- **Archetype**: ordered rule-based verdict — Micromanager (steering rate > 25%),
  Cannonballer (few huge prompts), Delegator (command/subagent heavy), Gardener
  (many small nudges), Balanced Operator — with the evidence always printed.
- **Lint rules**: vague-filler, unanchored-epics (long prompts naming no file or
  identifier), correction-heavy (with the prompts that *got* corrected as
  examples), interrupt-heavy, rapid-fire (<15s follow-ups), night-owl,
  mega-prompts. Thresholds live in `packages/prompter/src/stats.ts`.
- **Skill curve**: weekly correction/interruption/specificity trend.
- **Correlations**: Pearson across sessions (e.g. specificity vs correction rate),
  printed with sample size; treat |r| < 0.3 or small n as noise.
- **`--deep [claude|codex]`**: samples corrected-then-longest prompts and grades
  clarity/context 1–5 via one batched headless call — claude (haiku, default,
  --no-session-persistence) or codex (rollout stamped [asa-internal] and excluded
  from analysis), so judging never pollutes the session store it analyzes.

- **Workflow section**: session-level hygiene from the same scope.
  *Compaction pressure* — sessions that hit `/compact` (or auto-compaction), with
  auto/manual split and largest pre-compact context; the recommendation is
  structural: smaller focused sessions (`/clear` between tasks, `asa fork --at`
  to branch instead of continuing a monolith), since every compaction lossily
  summarizes history and rebuilds the prompt cache. *Git discipline* — detected
  from tool calls across both agents' arg shapes: in-session commits, pushes,
  branch creations, `gh issue`/`gh pr` operations, edit volume, and the branch
  worked on. Lint rules: compact-heavy, uncommitted-work (10+ edits, zero
  commits), mainline-editing (heavy edits on main/master without a branch), and
  untracked-outcomes (long sessions producing no commit, PR, or issue — their
  decisions live only in the transcript; end them by filing what came up).

## Model-call confirmation

Every flag that spends tokens (`prompter --deep`, `distill --suggest`,
`intents --deep`) is gated: asa builds the exact prompt it would send, prints an
input-token estimate (chars/4, stated as such) plus an expected-output range, and
current quota for the chosen backend: Codex records rate-limit state
(`used_percent`, window, reset) in every rollout's `token_count` events, so asa
reads the newest rollout's tail; for Claude, asa runs headless
`claude -p "/usage"` (handled locally by the CLI, no model tokens) and parses the
session/week percentages. Then it asks `proceed? [y/N]` on a TTY, or skips the
call in non-interactive runs unless `--yes` is passed.

**Exclusions:** Codex subagent rollouts carry machine-written "user" prompts and
are excluded by default (`--include-subagents` keeps them). Sessions created by
asa's own model calls are always excluded (see the sentinel below).

## distill

Two layers:

1. **Deterministic stats** — fully local. Cross-session prompt clustering by
   token-set Jaccard (stopword-stripped, embedding-free, threshold 0.45), split
   into procedures / questions / corrections; only clusters spanning ≥ 2 sessions
   count — within-session repetition is conversation, cross-session repetition is
   a missing skill/doc. Tool-sequence n-grams (n = 2–4) with shell-verb
   qualification: Bash and Codex `exec` calls are labeled by their leading command
   word (`exec:gh`), parsing Codex's JS-wrapped `{cmd:"…"}` args and apply-patch
   blobs, skipping env-var prefixes and `bash -lc` wrappers; sequences made only
   of unqualified shell/wait calls are filtered as noise. Command usage (Claude
   `/name`, Codex `$name`) is reported with a kind label — skill (matches the
   installed skill/command/plugin inventory), builtin, or unknown — so
   already-extracted procedures aren't re-recommended.
2. **`--suggest claude|codex`** — ships a trimmed stats digest (short prompt
   previews, counts, session spread — never full transcripts) to a headless model
   run and prints recommendations under a fixed taxonomy: skills to extract,
   CLAUDE.md/AGENTS.md rules, automations (hooks/crons), `docs/dev-faq.md`
   entries, and human-side items (retention gaps worth flashcards,
   prompting-vocabulary upgrades). The prompt template is the product: it lives at
   `packages/distill/src/suggest-template.ts`; override per-run with
   `--prompt-file`.

**Self-hygiene invariants:**

- Every prompt asa sends to a model is stamped `[asa-internal]`. Sessions whose
  first prompt carries the sentinel are excluded from *all* analysis — `codex
  exec` always persists a rollout, and distill must never distill itself.
- Forked transcripts are prefix copies that keep original step uuids; distill
  dedupes signals by uuid + prompt so a fork never fakes a recurrence of its own
  history.

## project / efficacy / intents

- **`asa project [path]`** — per-repo dossier: sessions per agent, aggregate
  spend/steering, top tools and MCP servers, recent-session table, and an
  instruction-surface inventory (CLAUDE.md, AGENTS.md, `.claude/settings.json`,
  skills dir, `docs/dev-faq.md`, asa git-trace) with per-file git commit counts.
  Includes the **content-volume split**: chars of session input attributed to
  human prompts vs harness injection (system reminders, CLAUDE.md blocks,
  attachments, Codex `base_instructions` and developer messages) vs tool results.
  Char-based by design: token usage is recorded per API response and cannot be
  attributed by source; characters can, and are comparable across sessions.
- **`asa efficacy [path]`** — reads `git log --follow` for CLAUDE.md/AGENTS.md,
  then compares correction and interruption rates in the K sessions strictly
  before vs strictly after each commit (default K = 10, `--window`).
  Correlational, not causal — model versions and task mix drift too, and the
  report prints that caveat. The actionable signal is usually the *absence* of
  change after a rule you cared about.
- **`asa intents`** — keyword-classified opening-prompt intents (feature / bugfix /
  refactor / research / ops / learning / other; rules in
  `packages/meta/src/intents.ts`) with per-repo dominance. `--deep claude|codex`
  batches opening prompts through one model call to name recurring cross-session
  *themes*, each flagged shipped/unshipped by whether any member session has a
  recorded PR link. Recurring unshipped themes are issues waiting to be filed.

Session-history caveat for all longitudinal features: Claude Code prunes
transcripts after ~30 days by default (`cleanupPeriodDays` in settings) — raise it
if you want `efficacy` and the skill curve to see further back.
