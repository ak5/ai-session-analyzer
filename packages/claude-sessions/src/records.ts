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

/** What a non-meta user record represents, for step-splitting and human-signal counting. */
export type UserRecordKind =
  /** free-text prompt — starts a step */
  | 'prompt'
  /** slash-command invocation (<command-name> marker) — starts a step */
  | 'command'
  /** "[Request interrupted…]" marker — counts as an interruption, not a step */
  | 'interruption'
  /** <local-command-stdout> echo of a command's output — ignored */
  | 'command-output'
  /** tool_result carrier / meta / sidechain / compact summary / empty */
  | 'other';

const COMMAND_NAME_RE = /<command-name>\s*([^<\n]+?)\s*<\/command-name>/;
const COMMAND_ARGS_RE = /<command-args>\s*([\s\S]*?)\s*<\/command-args>/;

// Harness-injected user records that carry no human text. Deliberately an
// explicit list, not "starts with <": humans do paste XML/HTML into prompts.
const HARNESS_TAG_RE = /^<(system-reminder|task-notification|background-task|tool-reminder)\b/;

export function classifyUserRecord(record: ClaudeRecord): UserRecordKind {
  if (record.type !== 'user' || record.isMeta || record.isCompactSummary || record.isSidechain) {
    return 'other';
  }
  const content = record.message?.content;
  if (Array.isArray(content) && content.some((b) => b.type === 'tool_result')) return 'other';
  const text = promptText(record).trim();
  if (!text) return 'other';
  if (text.startsWith('[Request interrupted')) return 'interruption';
  if (COMMAND_NAME_RE.test(text)) return 'command';
  if (text.startsWith('<local-command-stdout>')) return 'command-output';
  if (HARNESS_TAG_RE.test(text)) return 'other';
  return 'prompt';
}

/** For a 'command' record: the command name, and its args as the prompt text. */
export function commandParts(record: ClaudeRecord): { name: string; args?: string } {
  const text = promptText(record);
  const name = COMMAND_NAME_RE.exec(text)?.[1] ?? '(unknown)';
  const args = COMMAND_ARGS_RE.exec(text)?.[1] || undefined;
  return { name, args };
}

/** A step boundary: a real prompt or a slash-command invocation. */
export function isPromptRecord(record: ClaudeRecord): boolean {
  const kind = classifyUserRecord(record);
  return kind === 'prompt' || kind === 'command';
}
