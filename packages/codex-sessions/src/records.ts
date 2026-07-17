/**
 * Tolerant types for lines in ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl.
 * Source of truth is `RolloutLine`/`RolloutItem` in openai/codex
 * codex-rs/protocol/src/protocol.rs (serde-tagged as {type, payload}); no npm
 * types package is published, so everything here is optional and defensive.
 */

export interface CodexLine {
  timestamp?: string;
  type?: string;
  payload?: Record<string, unknown> & {
    type?: string;
    [k: string]: unknown;
  };
  [k: string]: unknown;
}

export interface CodexTokenUsage {
  input_tokens?: number;
  cached_input_tokens?: number;
  output_tokens?: number;
  reasoning_output_tokens?: number;
  total_tokens?: number;
}

export interface CodexTokenCountInfo {
  total_token_usage?: CodexTokenUsage;
  last_token_usage?: CodexTokenUsage;
  model_context_window?: number;
}

/** Built-in Codex tools; anything else is an MCP / custom tool. */
export const CODEX_BUILTIN_TOOLS = new Set([
  'exec',
  'shell',
  'local_shell',
  'apply_patch',
  'update_plan',
  'view_image',
  'web_search',
  'read_file',
  'list_dir',
]);

export function classifyCodexTool(name: string): { isMcp: boolean; mcpServer?: string } {
  if (CODEX_BUILTIN_TOOLS.has(name)) return { isMcp: false };
  // MCP tools surface as <server>__<tool> (older builds used <server>.<tool>).
  const sep = name.includes('__') ? '__' : name.includes('.') ? '.' : undefined;
  if (sep) return { isMcp: true, mcpServer: name.split(sep)[0] };
  return { isMcp: false };
}
