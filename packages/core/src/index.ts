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
  /** Git HEAD when this prompt was submitted (from an asa git-trace hook). */
  gitHead?: string;
  /** Dirty-file count at prompt time (from an asa git-trace hook). */
  gitDirtyFiles?: number;
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

/** One context compaction: the conversation was summarized in place. */
export interface CompactionEvent {
  /** "manual" (/compact) or "auto" (context limit); undefined when the format doesn't say (Codex). */
  trigger?: string;
  /** Context size in tokens just before compacting (Claude records this). */
  preTokens?: number;
  timestamp?: string;
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

/**
 * Char-count attribution of session input content. A cost *proxy*: token
 * usage is only recorded per API response and can't be split by source, but
 * character volume by origin is exact and comparable across sessions.
 */
export interface ContentVolume {
  /** Text the human actually typed (prompts, command args). */
  humanPromptChars: number;
  /** Harness-injected context: system reminders, CLAUDE.md/memory blocks, attachments, base instructions. */
  harnessInjectedChars: number;
  /** Tool results fed back into context. */
  toolResultChars: number;
}

export function emptyContentVolume(): ContentVolume {
  return { humanPromptChars: 0, harnessInjectedChars: 0, toolResultChars: 0 };
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
  compactionEvents?: CompactionEvent[];
  /** Per-model attribution: API calls and output tokens by model id (Codex models carry "(effort)"). */
  modelUsage?: Record<string, { apiCalls: number; outputTokens: number }>;
  steps: Step[];
  usage: UsageTotals;
  subagents: SubagentInfo[];
  interactions: InteractionCounts;
  contentVolume: ContentVolume;
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

/** Full shell command text of a Bash/exec tool call, across both agents' arg shapes. */
export function toolCommandText(call: ToolCall): string | undefined {
  const input = call.input;
  if (typeof input === 'object' && input !== null) {
    const c = (input as { command?: unknown }).command;
    if (typeof c === 'string') return c;
  }
  if (typeof input === 'string') {
    // codex exec args: JS source calling tools.exec_command({cmd:"…"}) or plain JSON
    const cmdMatch = /["']?cmd["']?\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(input);
    if (cmdMatch) return cmdMatch[1]!.replace(/\\(.)/g, '$1');
    try {
      const parsed = JSON.parse(input) as { command?: unknown; cmd?: unknown };
      const c = parsed.command ?? parsed.cmd;
      if (typeof c === 'string') return c;
      if (Array.isArray(c)) return c.join(' ');
    } catch {
      // free-form args
    }
  }
  return undefined;
}

/** First real command word of a shell string: skips env-var assignments and wrapper shells. */
export function shellVerb(commandText: string): string | undefined {
  const tokens = commandText.trim().split(/\s+/);
  let i = 0;
  while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i]!)) i += 1;
  if (['bash', 'sh', 'zsh'].includes(tokens[i]?.split('/').pop() ?? '') && /^-l?c$/.test(tokens[i + 1] ?? '')) {
    return shellVerb(tokens.slice(i + 2).join(' ').replace(/^['"]/, ''));
  }
  return tokens[i]?.split('/').pop();
}

/**
 * Prefix stamped on every prompt asa itself sends to an agent (--suggest,
 * --deep). `codex exec` always persists a rollout, so sessions whose first
 * prompt carries this sentinel are asa's own and are excluded from analysis —
 * otherwise asa would eventually analyze itself.
 */
export const ASA_INTERNAL_SENTINEL = '[asa-internal]';

export type ModelBackend = 'claude' | 'codex';

/** argv for one headless model call through the user's own agent CLI. */
export function modelInvocation(
  backend: ModelBackend,
  prompt: string,
  model?: string,
): { command: string; args: string[] } {
  if (backend === 'claude') {
    return {
      command: 'claude',
      args: ['-p', '--model', model ?? 'claude-fable-5', '--no-session-persistence', prompt],
    };
  }
  return { command: 'codex', args: ['exec', '--skip-git-repo-check', prompt] };
}

/** Run any prompt through a headless claude/codex call. */
export async function runModel(
  backend: ModelBackend,
  prompt: string,
  options: { model?: string; runner?: (command: string, args: string[]) => Promise<string> } = {},
): Promise<string> {
  const { command, args } = modelInvocation(backend, prompt, options.model);
  const runner =
    options.runner ??
    (async (cmd: string, cmdArgs: string[]) => {
      const { execFile } = await import('node:child_process');
      return new Promise<string>((resolve, reject) => {
        const child = execFile(
          cmd,
          cmdArgs,
          { timeout: 300_000, maxBuffer: 8 * 1024 * 1024 },
          (err, stdout, stderr) =>
            err ? reject(new Error(stderr.trim() || err.message)) : resolve(stdout),
        );
        // codex exec blocks forever on a piped-open stdin — close it
        child.stdin?.end();
      });
    });
  return (await runner(command, args)).trim();
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

/** Read the last few records of a JSONL file without loading it all (tail counterpart of readFirstJsonlObjects). */
export async function readLastJsonlObjects(
  filePath: string,
  maxRecords = 20,
  maxBytes = 256 * 1024,
): Promise<unknown[]> {
  const { open, stat } = await import('node:fs/promises');
  const size = (await stat(filePath)).size;
  const readBytes = Math.min(size, maxBytes);
  const handle = await open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(readBytes);
    await handle.read(buffer, 0, readBytes, size - readBytes);
    let text = buffer.toString('utf8');
    // unless we read the whole file, the first line is probably truncated
    if (readBytes < size) text = text.slice(text.indexOf('\n') + 1);
    const records = parseJsonl(text);
    return records.slice(-maxRecords);
  } finally {
    await handle.close();
  }
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Wrap a text report as a self-contained HTML page: monospace layout (the
 * reports are column-aligned), light/dark via prefers-color-scheme, and a
 * few regex highlights ([warn]/[info] lints, table rules, section headers).
 * Deliberately a styled mirror of the terminal output, not a separate UI.
 */
export function renderHtmlReport(options: {
  title: string;
  command: string;
  body: string;
  generatedAt?: string;
}): string {
  const body = escapeHtml(options.body)
    .replace(/^(\[warn\].*)$/gm, '<span class="warn">$1</span>')
    .replace(/^(\s*\[warn\].*)$/gm, '<span class="warn">$1</span>')
    .replace(/^(\s*\[info\].*)$/gm, '<span class="info">$1</span>')
    .replace(/^([A-Z][^\n]{0,60}:)$/gm, '<span class="head">$1</span>')
    .replace(/^(-{2,}[\s-]*)$/gm, '<span class="rule">$1</span>');
  const generated = options.generatedAt ?? new Date().toISOString();
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(options.title)}</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 2rem auto; max-width: 110ch; padding: 0 1rem;
         background: Canvas; color: CanvasText;
         font: 13px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; }
  header { margin-bottom: 1.5rem; }
  h1 { font-size: 1.1rem; margin: 0 0 .25rem; }
  .meta { opacity: .6; font-size: .85em; }
  pre { white-space: pre; overflow-x: auto; }
  .warn { color: light-dark(#b45309, #fbbf24); font-weight: 600; }
  .info { color: light-dark(#1d4ed8, #93c5fd); }
  .head { font-weight: 700; }
  .rule { opacity: .4; }
</style>
</head>
<body>
<header>
<h1>${escapeHtml(options.title)}</h1>
<div class="meta">asa ${escapeHtml(options.command)} · generated ${escapeHtml(generated)}</div>
</header>
<pre>${body}</pre>
</body>
</html>
`;
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
