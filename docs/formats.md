# Session file formats

Reverse-engineered notes, verified against Claude Code v2.1.212 and Codex CLI v0.144.4
(2026-07). No official schema exists for either — parse tolerantly, skip unknown types.

## Claude Code

**Path:** `~/.claude/projects/<slug>/<sessionId>.jsonl` where `<slug>` is the cwd with
`/` → `-` (lossy). Filename = session uuid. Resume appends to the same file;
`--fork-session` starts a new file. Subagent transcripts live in
`<slug>/<sessionId>/subagents/agent-<agentId>.jsonl` (linked from the parent's
`toolUseResult.agentId`). `$CLAUDE_CONFIG_DIR` overrides `~/.claude`.

**Lines** are flat objects with a top-level `type`: `user`, `assistant`, `system`,
`attachment`, `file-history-snapshot`/`-delta`, `last-prompt`, `mode`,
`permission-mode`, `ai-title`, `pr-link`, `queue-operation`. Common envelope on
conversation records: `uuid`, `parentUuid` (the DAG), `sessionId`, `cwd`, `gitBranch`,
`version`, `timestamp`, `isSidechain`, `isMeta`.

- `assistant.message` is a raw Anthropic API message (`id`, `model`, `content[]`,
  `usage`). **One API response is split into multiple records, one per content block,
  each repeating the identical `usage`** — dedupe by `message.id` (or `requestId`)
  before summing tokens, or you overcount 3–8×.
- Tool linking: `tool_use.id` ↔ a later `user` record's `tool_result.tool_use_id`,
  plus a structured sibling `toolUseResult` (per-tool shape; for Agent runs it carries
  `agentId`, `totalTokens`, `toolStats`, full `usage`).
- A "real" user prompt = `type:user`, not `isMeta`, not a `tool_result` carrier, not
  `isCompactSummary`, not `isSidechain` — and not one of the in-band text markers:
  `[Request interrupted…]` (user interrupt), `<command-name>/<command-args>` (slash
  command invocation), `<local-command-stdout>` (command output echo),
  `<system-reminder>`/`<task-notification>` (harness-injected context).
- Compaction (dissected live for `asa fork --context`): a `system` record with
  `subtype:"compact_boundary"` carrying `compactMetadata` — `trigger`
  (manual|auto), `preTokens`/`postTokens` (observed: ~977k → ~18k, 98% dropped),
  `durationMs` (~2 min: it's a billed full-context summarization call),
  `preservedSegment{headUuid,anchorUuid,tailUuid}` + `preservedMessages` (a small
  set of recent messages kept verbatim), `preCompactDiscoveredTools`,
  `cumulativeDroppedTokens` — followed by a `user` record with
  `isCompactSummary:true` + `isVisibleInTranscriptOnly:true` whose content is the
  LLM-written summary (a ~15k-char structured *paraphrase*; the literal prompts
  are gone). All pre-compact records stay in the file; the live context after
  compaction is summary + preserved segment + post-boundary records.
- `/compact <hint>` mechanism (tested via an A/B on identical fork pairs — see
  `asa fork --at`): the CLI appends a summarization instruction (with the hint
  as custom instructions) to the conversation as a user message and has the
  session's model write the summary — works headless (`claude -p --resume <id>
  "/compact <hint>"`, stdout empty, boundary+summary appended). The hint biases
  section *content* — hinted topics dominate "Key Technical Concepts" and
  "Current Work", de-hinted facts get dropped from them entirely — but the
  9-section template itself is fixed. In one observed run the internal
  instruction leaked into the summary's own "All user messages" section.
- No cumulative totals stored anywhere; no persistent sessionId→project index
  (`~/.claude/sessions/<pid>.json` covers live processes only — glob otherwise).

## Codex CLI

**Path:** `~/.codex/sessions/YYYY/MM/DD/rollout-<ISO-ts>-<uuid>.jsonl` (uuid = session
id). Pre-May-2025 legacy files are single pretty-printed `.json` objects — different
format, not parsed here. `~/.codex/session_index.jsonl` maps `id` → `thread_name` /
`updated_at`. `$CODEX_HOME` overrides `~/.codex`. Rust source of truth:
`codex-rs/protocol/src/protocol.rs` (`RolloutLine`/`RolloutItem`) in openai/codex.

**Lines** are `{timestamp, type, payload}` envelopes. Types: `session_meta` (first
line: `id`, `cwd`, `cli_version`, `git{branch,commit_hash}`, `forked_from_id` on
forks/subagents, `thread_source: user|subagent`), `turn_context` (per-turn `model`,
`effort`, sandbox/approval config), `response_item`, `event_msg`, `world_state`,
`compacted` (`replacement_history` + `window_id` chain), `inter_agent_communication_metadata`.

- `response_item.payload.type`: `message`, `reasoning` (encrypted), `function_call` /
  `function_call_output`, `custom_tool_call` / `custom_tool_call_output`. Tool linking
  via shared `call_id`.
- Usage lives in `event_msg` `token_count` events: `info.total_token_usage`
  (**cumulative session-to-date** — take the last one for totals, diff at turn
  boundaries for per-step) and `info.last_token_usage` (per API call). Breaks out
  `cached_input_tokens` and `reasoning_output_tokens`; `model_context_window` gives
  the context-fill denominator.
- Turn boundaries: `event_msg` `task_started` (`turn_id`) … `task_complete`
  (`duration_ms`); user text arrives as `user_message` events.
- Subagents get their own rollout file (`thread_source:"subagent"`,
  `source.subagent.thread_spawn.parent_thread_id`).
- Compaction (dissected live for `asa fork --context`): a `compacted` record whose
  `replacement_history` REPLACES the model-visible history — the real user
  prompts verbatim (accumulating across successive compactions) plus one
  `{type:"compaction", encrypted_content:"gAAAA…"}` bridge item: the summary is
  server-side encrypted state and cannot be read or forged. Codex keeping
  prompts verbatim is the design cue `fork --context` borrows.
- Resume rebuilds the model-visible history from `response_item` lines, NOT from
  `event_msg` (that's the UI stream) — verified live: a synthetic `compacted`
  record at the head of a crafted rollout is ignored, while plain
  `response_item` messages load fine. `codex exec resume` needs the FULL session
  id — an unknown/short id silently starts a fresh session instead of erroring.

## CLI surface used by `asa`

- `claude --resume <id> [--fork-session]`, `claude -p --resume <id> "<prompt>"`,
  `--session-id <uuid>`, `-c/--continue`. No CLI-level rewind — fork-at-step is
  synthesized by truncating the JSONL under a new uuid (works on --resume today,
  not a stable contract).
- `codex resume <id|name> [--last]`, `codex exec resume <id> "<prompt>"` (headless),
  `codex fork <id>` (interactive only — no headless fork upstream).
