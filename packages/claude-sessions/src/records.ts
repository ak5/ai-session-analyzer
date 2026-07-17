/**
 * Tolerant types for lines in ~/.claude/projects/<slug>/<sessionId>.jsonl.
 * There is no published schema and fields change between CLI versions, so
 * everything is optional and unknown record types must be ignored, not fatal.
 */

export interface ClaudeContentBlock {
  type?: string;
  text?: string;
  thinking?: string;
  // tool_use
  id?: string;
  name?: string;
  input?: unknown;
  // tool_result
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
  [k: string]: unknown;
}

export interface ClaudeApiUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  [k: string]: unknown;
}

export interface ClaudeMessage {
  id?: string;
  role?: string;
  model?: string;
  content?: string | ClaudeContentBlock[];
  usage?: ClaudeApiUsage;
  [k: string]: unknown;
}

export interface ClaudeRecord {
  type?: string;
  uuid?: string;
  parentUuid?: string | null;
  sessionId?: string;
  session_id?: string;
  timestamp?: string;
  cwd?: string;
  gitBranch?: string;
  version?: string;
  requestId?: string;
  isSidechain?: boolean;
  isMeta?: boolean;
  isCompactSummary?: boolean;
  compactMetadata?: { trigger?: string; preTokens?: number; [k: string]: unknown };
  aiTitle?: string;
  message?: ClaudeMessage;
  /** Structured tool metadata carried next to tool_result records. */
  toolUseResult?: {
    agentId?: string;
    agentType?: string;
    totalTokens?: number;
    totalToolUseCount?: number;
    totalDurationMs?: number;
    [k: string]: unknown;
  };
  [k: string]: unknown;
}

export function contentBlocks(message: ClaudeMessage | undefined): ClaudeContentBlock[] {
  const content = message?.content;
  return Array.isArray(content) ? content : [];
}

/**
 * A "real" user prompt (step boundary): a user record that is not meta, not a
 * compact summary, not a sidechain record, and not a tool_result carrier.
 */
export function isPromptRecord(record: ClaudeRecord): boolean {
  if (record.type !== 'user' || record.isMeta || record.isCompactSummary || record.isSidechain) {
    return false;
  }
  const content = record.message?.content;
  if (typeof content === 'string') return content.trim().length > 0;
  if (Array.isArray(content)) {
    if (content.some((b) => b.type === 'tool_result')) return false;
    return content.some((b) => b.type === 'text' && typeof b.text === 'string');
  }
  return false;
}

export function promptText(record: ClaudeRecord): string {
  const content = record.message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((b) => b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('\n');
  }
  return '';
}
