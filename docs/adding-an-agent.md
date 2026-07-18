# Adding an agent (OpenCode, Gemini CLI, Copilot CLI, …)

Every asa command is a loop over an agent registry. Supporting a new agent is
three contained steps — `list`, `analyze`, `resume`, `fork`, `compare`,
`prompter`, `distill`, `project`, `efficacy`, and `intents` all pick it up
automatically.

## 1. A sessions package

Create `packages/<agent>-sessions` (`@asa/<agent>-sessions`), using
`claude-sessions` / `codex-sessions` as templates. It must provide:

- **Discovery**: enumerate session files newest-first as `SessionRef`s
  (id, filePath, updatedAt, sizeBytes), plus find-by-id-or-unique-prefix and a
  cheap header read for the session's cwd (`readFirstJsonlObjects` in
  `@asa/core` handles huge first lines).
- **A tolerant parser**: normalize the on-disk format to `NormalizedSession`
  (`@asa/core`) — steps split on real human prompts, tool calls linked to
  results, deduped token usage, `interactions` counts (interruptions, commands,
  queued prompts, PR links), `contentVolume` char attribution, subagent handling.
  Every field optional at the record level; unknown record types skipped, corrupt
  lines ignored. There is no published schema for any of these formats — parse
  defensively and pin findings with unit tests.

## 2. A registry entry

Add an `AgentAdapter` to `packages/cli/src/agents.ts`: kind, long flag, short
flag letter, `list`/`find`/`load`/`cwd`, and the argv shapes for `resume` and
`fork` (plus `forkAtStep` if the store permits transcript truncation the way
Claude's does).

## 3. A kind

Extend `AgentKind` in `@asa/core`.

## Why only claude/codex ship today

No other agent's session data was on hand to verify a parser against.
Format-faithful parsing is the whole product — a guessed parser produces
confidently wrong numbers, which is worse than absence. If you have real session
files for a target agent, that's the unblock: start from a sample and pin every
assumption with tests.
