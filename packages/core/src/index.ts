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
 * A step is one user turn: the prompt plus everything the agent did before
 * the next prompt (API calls, tool calls, subagents).
 */
export interface Step {
  /** Stable id usable as a fork point: Claude = user-record uuid, Codex = turn_id. */
  id: string;
  index: number;
  timestamp?: string;
  durationMs?: number;
  promptPreview?: string;
  /** Distinct API responses in this step (deduped). */
  apiCalls: number;
  toolCalls: ToolCall[];
  usage: UsageTotals;
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
  compactions: number;
  steps: Step[];
  usage: UsageTotals;
  subagents: SubagentInfo[];
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
