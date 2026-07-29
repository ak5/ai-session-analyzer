# TypeScript to Rust parity

The sanitized Claude and Codex transcript fixtures under `fixtures/v2` were
placed in isolated native-store layouts and analyzed by both implementations
on 2026-07-29.

The Rust reports match the retained TypeScript workflow for:

- steps and API calls;
- tool and MCP counts;
- tool errors;
- model identity;
- input, output, cache-read, cache-creation, reasoning, and total tokens;
- duration;
- Claude/Codex comparison deltas.

Intentional output-model differences:

- Rust uses namespaced IDs (`claude-code:<id>` and `codex:<id>`);
- Rust uses snake_case JSON field names and omits raw prompt/tool content;
- Rust exposes malformed/truncated line counts;
- Rust reports the sanitized completed Codex turn as non-interrupted. The
  TypeScript implementation reports one interruption for that completed turn;
  the native `task_complete` evidence makes the Rust result the corrected
  behavior;
- the TypeScript-only pricing/content-volume fields are not required before
  replacement and remain classified for later redesign.

The parser unit tests pin the fixture totals, and the comparison implementation
includes the TypeScript duration row.

Rust `resume` also matches the retained V1 process boundary:

- Claude interactive: `claude --resume <id>`;
- Claude headless: `claude -p --resume <id> <prompt>`;
- Codex interactive: `codex resume <id>`;
- Codex headless: `codex exec resume <id> <prompt>`;
- both use the native session's recorded cwd when it still exists and inherit
  the terminal streams;
- `--dry-run` renders the command and cwd without launching the agent.

Unit tests pin all four argv forms. An isolated sanitized-store smoke proved
unique-prefix discovery and dry-run rendering for both adapters without
modifying or launching either native agent.

Rust whole-session `fork` matches the retained V1 native process boundary:

- Claude interactive: `claude --resume <id> --fork-session`;
- Claude headless: `claude -p --resume <id> --fork-session <prompt>`;
- Codex interactive: `codex fork <id>`;
- Codex with an initial prompt: `codex fork <id> <prompt>`.

It shares resume's unique-prefix resolution, recorded-cwd recovery, inherited
terminal streams, exit-code propagation, and non-launching `--dry-run`.
Unit tests pin the four argv forms. A second isolated sanitized-store smoke
proved discovery and exact dry-run rendering for both adapters. Mid-session
and crafted-context forks were classified separately because they write new
native transcripts.

Rust mid-session `fork --at` now matches the retained V1 cut semantics for both
adapters. Claude copies through the selected record until the next genuine user
prompt, removes stale `last-prompt` records, rewrites session IDs, and copies
subagent/tool-result sidecars. Codex copies through the selected turn until the
next `task_started`, rewrites session metadata, and adds `forked_from_id`.
Create-new/fsync behavior and `--no-launch` make mutation explicit. Unit tests
prove original-byte preservation and adapter-specific lineage; an isolated
CLI smoke created both fork forms and verified the source hashes were
unchanged.

Rust crafted-context `fork --context` now retains the V1 deterministic digest
contract: literal older prompts, capped conclusions, recognized file writes,
optional keyword focus weighting, and a configurable recent verbatim tail.
Claude uses a `compact_boundary` plus `isCompactSummary` and re-roots the tail;
Codex emits literal model-visible response items, preserves its latest turn
context, stamps lineage, and includes the pre-turn user message in the tail.
No model or network call is made. Adapter tests cover both output shapes,
source preservation, focus weighting, and collision-safe sidecar handling; an
isolated CLI smoke created both forms with `--keep 0 --no-launch`.

Rust `distill` ports the retained V1 local recurrence core:

- newest-session limiting plus `--agent` and `--since Nd|YYYY-MM-DD` scope;
- ASA-internal-session exclusion and fork-prefix deduplication;
- 0.45 Jaccard clustering after stopword removal, minimum 15 characters, and
  cross-session recurrence;
- separate directive, question, and correction groups;
- recurring 2–4 tool-call n-grams and command-use counts;
- deterministic text and JSON output.

Unit tests pin clustering, tokenization, command classification, native
transcript extraction, internal exclusion, and deduplication. An isolated
two-adapter CLI smoke proved both output modes and filters. Shell-command
qualification, installed-skill inventory, model-backed `--suggest`, FAQ
writing, and HTML output remain explicitly unported subfeatures.

Rust `prompter` ports the retained explainable local analysis: prompt
specificity anchors, vague/correction detection, per-session and per-adapter
aggregates, output-token leverage, tool-call rate, ordered archetype rules,
lint thresholds, compaction/PR workflow signals, weekly trend buckets, and
Pearson correlations with the same four-sample floor. It shares distill's
native prompt extraction, scope filters, ASA-internal exclusion, and JSON
surface. Tests cover feature ordering, archetype thresholds, correlation
behavior, native extraction, correction accounting, internal exclusion, and
weekly grouping. An isolated two-adapter smoke proved text and JSON output.
Rapid-gap metrics, detailed git-command hygiene, the opt-in `--deep` judge,
and HTML remain explicitly unported.

Rust also ports the four local history reports:

- `project`: canonical repository attribution, usage/steering totals,
  tools/MCP, and instruction-surface inventory;
- `efficacy`: read-only `AGENTS.md`/`CLAUDE.md` Git history joined to bounded
  before/after correction and interruption windows;
- `intents`: the ordered bugfix/refactor/ops/learning/research/feature/other
  opening-prompt heuristic and per-repository dominance;
- `models`: true parser-level Claude response and Codex turn attribution,
  normalized display names, favorites, weekly dominance, and switches.

Tests pin intent precedence, date-suffix display, Monday bucketing, per-model
fixture totals, project inventory, bounded efficacy rates, and macOS
`/tmp`/`/private/tmp` attribution. Isolated CLI smokes covered text/JSON for all
four and a temporary Git commit proved the efficacy join. Deep intent themes,
stats-cache history, git commit counts per instruction surface, and HTML remain
explicitly unported subfeatures.

Rust `sessions migrate-path` is the explicit exception to native transcript
immutability. It scans Claude and Codex stores before writing, supports missing
old workspace directories and descendant workspaces, rewrites only recognized
cwd/workspace metadata, moves Claude path-derived transcripts and sidecars,
updates native indexes, and leaves Codex rollout locations stable. Collision
checks finish before mutation. Applied migrations use ASA-owned per-file
backups and an atomic resumable journal; rerunning the same migration is
idempotent. Tests cover both adapters, indexes, spaces and Unicode, sidecars,
destination collisions, dry-run, backups, and completed-migration resume.
