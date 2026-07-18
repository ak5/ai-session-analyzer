import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import {
  addUsage,
  emptyInteractionCounts,
  emptyUsage,
  parseJsonl,
  previewText,
  readFirstJsonlObjects,
  type NormalizedSession,
  type Step,
  type StepKind,
  type SubagentInfo,
  type ToolCall,
} from '@asa/core';
import {
  classifyUserRecord,
  commandParts,
  contentBlocks,
  promptText,
  type ClaudeApiUsage,
  type ClaudeRecord,
} from './records.js';
import { annotateSessionWithGitTrace } from './trace.js';

export async function readClaudeRecords(filePath: string): Promise<ClaudeRecord[]> {
  return parseJsonl<ClaudeRecord>(await readFile(filePath, 'utf8'));
}

/** The session's cwd from the file header, without loading the transcript. */
export async function readClaudeSessionCwd(filePath: string): Promise<string | undefined> {
  for (const record of (await readFirstJsonlObjects(filePath, 8)) as ClaudeRecord[]) {
    if (typeof record.cwd === 'string') return record.cwd;
  }
  return undefined;
}

export async function loadClaudeSession(filePath: string): Promise<NormalizedSession> {
  const session = normalizeClaudeRecords(await readClaudeRecords(filePath), filePath);
  await annotateSessionWithGitTrace(session);
  return session;
}

function usageDelta(usage: ClaudeApiUsage | undefined) {
  const input = usage?.input_tokens ?? 0;
  const output = usage?.output_tokens ?? 0;
  const cacheRead = usage?.cache_read_input_tokens ?? 0;
  const cacheCreation = usage?.cache_creation_input_tokens ?? 0;
  return {
    inputTokens: input,
    outputTokens: output,
    cacheReadTokens: cacheRead,
    cacheCreationTokens: cacheCreation,
    reasoningTokens: 0,
    totalTokens: input + output + cacheRead + cacheCreation,
  };
}

function classifyTool(name: string): { isMcp: boolean; mcpServer?: string } {
  // MCP tools are exposed to Claude as mcp__<server>__<tool>.
  const match = /^mcp__([^_]+(?:_[^_]+)*?)__/.exec(name);
  if (match) return { isMcp: true, mcpServer: match[1] };
  return { isMcp: false };
}

export function normalizeClaudeRecords(
  records: ClaudeRecord[],
  filePath: string,
): NormalizedSession {
  const session: NormalizedSession = {
    agent: 'claude',
    id: basename(filePath).replace(/\.jsonl$/, ''),
    filePath,
    models: [],
    compactions: 0,
    steps: [],
    usage: emptyUsage(),
    subagents: [],
    interactions: emptyInteractionCounts(),
  };

  const models = new Set<string>();
  const seenApiIds = new Set<string>();
  const toolCallsById = new Map<string, ToolCall>();
  let currentStep: Step | undefined;

  const openStep = (
    record: ClaudeRecord,
    prompt?: string,
    kind: StepKind = 'prompt',
    commandName?: string,
  ): Step => {
    const step: Step = {
      id: record.uuid ?? `step-${session.steps.length}`,
      index: session.steps.length,
      kind,
      commandName,
      timestamp: record.timestamp,
      promptText: prompt,
      promptPreview: prompt !== undefined ? previewText(prompt) : undefined,
      apiCalls: 0,
      toolCalls: [],
      usage: emptyUsage(),
    };
    session.steps.push(step);
    return step;
  };

  for (const record of records) {
    if (record.sessionId && session.id !== record.sessionId && session.steps.length === 0) {
      session.id = record.sessionId;
    }
    session.cwd ??= record.cwd;
    session.gitBranch ??= record.gitBranch;
    session.cliVersion ??= record.version;
    if (record.timestamp) {
      session.startedAt ??= record.timestamp;
      session.endedAt = record.timestamp;
    }
    if (record.type === 'ai-title' && typeof record.aiTitle === 'string') {
      session.title = record.aiTitle;
    }
    if (record.isCompactSummary) session.compactions += 1;
    if (record.type === 'permission-mode') session.interactions.permissionModeChanges += 1;
    if (record.type === 'pr-link') session.interactions.prLinks += 1;
    if (record.type === 'queue-operation' && record.operation === 'enqueue') {
      session.interactions.queuedPrompts += 1;
    }

    const userKind = classifyUserRecord(record);
    if (userKind === 'prompt') {
      currentStep = openStep(record, promptText(record));
      continue;
    }
    if (userKind === 'command') {
      const { name, args } = commandParts(record);
      session.interactions.commands += 1;
      currentStep = openStep(record, args, 'command', name);
      continue;
    }
    if (userKind === 'interruption') {
      session.interactions.interruptions += 1;
      if (currentStep) currentStep.aborted = true;
      continue;
    }
    if (userKind === 'command-output') continue;

    if (record.type === 'assistant' && record.message) {
      // Robustness: activity before any prompt (e.g. hand-crafted transcripts).
      currentStep ??= openStep(record);
      const message = record.message;
      const apiId = message.id ?? record.requestId ?? record.uuid ?? `anon-${seenApiIds.size}`;
      // One API response is split across multiple JSONL records (one per
      // content block), each repeating the identical usage object — count it once.
      if (!seenApiIds.has(apiId)) {
        seenApiIds.add(apiId);
        currentStep.apiCalls += 1;
        const delta = usageDelta(message.usage);
        addUsage(currentStep.usage, delta);
        addUsage(session.usage, delta);
      }
      if (message.model) models.add(message.model);
      for (const block of contentBlocks(message)) {
        if (block.type === 'tool_use' && typeof block.id === 'string') {
          const name = typeof block.name === 'string' ? block.name : '(unknown)';
          const call: ToolCall = {
            id: block.id,
            name,
            ...classifyTool(name),
            input: block.input,
            timestamp: record.timestamp,
          };
          toolCallsById.set(call.id, call);
          currentStep.toolCalls.push(call);
        }
      }
      continue;
    }

    if (record.type === 'user') {
      for (const block of contentBlocks(record.message)) {
        if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
          const call = toolCallsById.get(block.tool_use_id);
          if (call) {
            call.isError = block.is_error === true;
            if (typeof block.content === 'string') {
              call.outputPreview = previewText(block.content, 120);
            }
          }
        }
      }
      const agentResult = record.toolUseResult;
      if (agentResult && typeof agentResult.agentId === 'string') {
        const subagent: SubagentInfo = {
          id: agentResult.agentId,
          agentType: agentResult.agentType,
          totalTokens: agentResult.totalTokens,
          toolUseCount: agentResult.totalToolUseCount,
          durationMs: agentResult.totalDurationMs,
        };
        session.subagents.push(subagent);
      }
    }
  }

  session.models = [...models];
  return session;
}
