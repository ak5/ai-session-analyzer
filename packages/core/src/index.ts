export type AgentKind = 'claude' | 'codex';

export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  reasoningTokens: number;
  totalTokens: number;
}

export function emptyUsage(): UsageTotals {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
  };
}

export function addUsage(target: UsageTotals, delta: Partial<UsageTotals>): UsageTotals {
  target.inputTokens += delta.inputTokens ?? 0;
  target.outputTokens += delta.outputTokens ?? 0;
  target.cacheReadTokens += delta.cacheReadTokens ?? 0;
  target.cacheCreationTokens += delta.cacheCreationTokens ?? 0;
  target.reasoningTokens += delta.reasoningTokens ?? 0;
  target.totalTokens += delta.totalTokens ?? 0;
  return target;
}

export interface ToolCall {
  /** tool_use id (Claude) or call_id (Codex) */
  id: string;
  name: string;
  isMcp: boolean;
  mcpServer?: string;
  input?: unknown;
  outputPreview?: string;
  isError?: boolean;
  timestamp?: string;
}

/**
 * How a step was initiated. `prompt` = free-text user turn; `command` = a
 * slash-command invocation (`<command-name>` marker in the transcript).
 */
export type StepKind = 'prompt' | 'command';

/**
 * A step is one user turn: the prompt plus everything the agent did before
 * the next prompt (API calls, tool calls, subagents).
 */
export interface Step {
  /** Stable id usable as a fork point: Claude = user-record uuid, Codex = turn_id. */
  id: string;
  index: number;
  kind: StepKind;
  /** For kind 'command': the slash command name, e.g. "/goal". */
  commandName?: string;
  timestamp?: string;
  durationMs?: number;
  /** Full user prompt text (command args for kind 'command'). */
  promptText?: string;
  promptPreview?: string;
  /** The run was cut short (user interrupt / no task_complete). */
  aborted?: boolean;
  /** Distinct API responses in this step (deduped). */
  apiCalls: number;
  toolCalls: ToolCall[];
  usage: UsageTotals;
}

/** Human-steering signals counted at session level. */
export interface InteractionCounts {
  /** User interrupted a running turn (Claude "[Request interrupted…]" markers / Codex aborted turns). */
  interruptions: number;
  /** Slash-command invocations. */
  commands: number;
  /** permission-mode toggle events (Claude). */
  permissionModeChanges: number;
  /** Prompts queued while a turn was running (Claude queue-operation enqueue). */
  queuedPrompts: number;
  /** PRs linked to the session (Claude pr-link records). */
  prLinks: number;
}

export function emptyInteractionCounts(): InteractionCounts {
  return {
    interruptions: 0,
    commands: 0,
    permissionModeChanges: 0,
    queuedPrompts: 0,
    prLinks: 0,
  };
}

export interface SubagentInfo {
  id: string;
  agentType?: string;
  totalTokens?: number;
  toolUseCount?: number;
  durationMs?: number;
}

export interface NormalizedSession {
  agent: AgentKind;
  id: string;
  filePath: string;
  cwd?: string;
  gitBranch?: string;
  title?: string;
  models: string[];
  cliVersion?: string;
  startedAt?: string;
  endedAt?: string;
  forkedFromId?: string;
  /** Spawned by another agent (Codex thread_source "subagent") — its "user" prompts are machine-written. */
  isSubagent?: boolean;
  compactions: number;
  steps: Step[];
  usage: UsageTotals;
  subagents: SubagentInfo[];
  interactions: InteractionCounts;
}

export interface SessionRef {
  agent: AgentKind;
  id: string;
  filePath: string;
  /** For Claude this is the (lossy) project-dir slug; for Codex the real cwd when known. */
  cwd?: string;
  title?: string;
  updatedAt?: Date;
  sizeBytes?: number;
}

export function previewText(text: string, max = 64): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max - 1)}…`;
}

export function shortId(id: string): string {
  return id.slice(0, 8);
}

export function formatNumber(n: number): string {
  return n.toLocaleString('en-US');
}

export function formatDuration(ms?: number): string {
  if (ms === undefined) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** Plain-text table: header row, dash rule, padded cells. */
export function renderTable(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)));
  const line = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i]!)).join('  ').trimEnd();
  return [line(headers), line(widths.map((w) => '-'.repeat(w))), ...rows.map(line)].join('\n');
}

/**
 * Read just the first few records of a JSONL file without loading it all —
 * session headers (cwd, meta) live in the first lines and files reach 100s of MB.
 * Reads in growing chunks until maxRecords complete lines are seen: a single
 * header line can exceed 100KB (Codex session_meta embeds base_instructions).
 */
export async function readFirstJsonlObjects(
  filePath: string,
  maxRecords = 5,
  maxBytes = 4 * 1024 * 1024,
): Promise<unknown[]> {
  const { open } = await import('node:fs/promises');
  const handle = await open(filePath, 'r');
  try {
    const chunkSize = 64 * 1024;
    const chunks: Buffer[] = [];
    let position = 0;
    let newlines = 0;
    while (position < maxBytes && newlines <= maxRecords) {
      const buffer = Buffer.alloc(chunkSize);
      const { bytesRead } = await handle.read(buffer, 0, chunkSize, position);
      if (bytesRead === 0) {
        // EOF: everything read is complete lines (last may lack trailing \n)
        return parseJsonl(Buffer.concat(chunks).toString('utf8')).slice(0, maxRecords);
      }
      const chunk = buffer.subarray(0, bytesRead);
      chunks.push(chunk);
      position += bytesRead;
      for (const byte of chunk) if (byte === 0x0a) newlines += 1;
    }
    const lines = Buffer.concat(chunks).toString('utf8').split('\n');
    // the final chunk may end mid-line — drop the possibly-truncated tail
    return parseJsonl(lines.slice(0, -1).join('\n')).slice(0, maxRecords);
  } finally {
    await handle.close();
  }
}

/** Parse a JSONL buffer tolerantly: unparseable lines are skipped. */
export function parseJsonl<T = unknown>(text: string): T[] {
  const out: T[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed) as T);
    } catch {
      // tolerate partial/corrupt lines (e.g. a session being written right now)
    }
  }
  return out;
}
