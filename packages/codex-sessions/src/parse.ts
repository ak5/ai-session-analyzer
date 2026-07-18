import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import {
  addUsage,
  emptyContentVolume,
  emptyInteractionCounts,
  emptyUsage,
  parseJsonl,
  previewText,
  readFirstJsonlObjects,
  type NormalizedSession,
  type Step,
  type ToolCall,
  type UsageTotals,
} from '@asa/core';
import { rolloutSessionId } from './paths.js';
import {
  classifyCodexTool,
  type CodexLine,
  type CodexTokenCountInfo,
  type CodexTokenUsage,
} from './records.js';

export async function readCodexLines(filePath: string): Promise<CodexLine[]> {
  return parseJsonl<CodexLine>(await readFile(filePath, 'utf8'));
}

/** The session's cwd from session_meta, without loading the transcript. */
export async function readCodexSessionCwd(filePath: string): Promise<string | undefined> {
  for (const line of (await readFirstJsonlObjects(filePath, 3)) as CodexLine[]) {
    if (line.type === 'session_meta' && typeof line.payload?.cwd === 'string') {
      return line.payload.cwd;
    }
  }
  return undefined;
}

export async function loadCodexSession(filePath: string): Promise<NormalizedSession> {
  return normalizeCodexLines(await readCodexLines(filePath), filePath);
}

function toUsage(u: CodexTokenUsage | undefined): UsageTotals {
  const usage = emptyUsage();
  if (!u) return usage;
  usage.inputTokens = u.input_tokens ?? 0;
  usage.cacheReadTokens = u.cached_input_tokens ?? 0;
  usage.outputTokens = u.output_tokens ?? 0;
  usage.reasoningTokens = u.reasoning_output_tokens ?? 0;
  usage.totalTokens =
    u.total_tokens ?? usage.inputTokens + usage.outputTokens;
  return usage;
}

function diffUsage(now: UsageTotals, before: UsageTotals): UsageTotals {
  return {
    inputTokens: Math.max(0, now.inputTokens - before.inputTokens),
    outputTokens: Math.max(0, now.outputTokens - before.outputTokens),
    cacheReadTokens: Math.max(0, now.cacheReadTokens - before.cacheReadTokens),
    cacheCreationTokens: 0,
    reasoningTokens: Math.max(0, now.reasoningTokens - before.reasoningTokens),
    totalTokens: Math.max(0, now.totalTokens - before.totalTokens),
  };
}

export function normalizeCodexLines(lines: CodexLine[], filePath: string): NormalizedSession {
  const session: NormalizedSession = {
    agent: 'codex',
    id: rolloutSessionId(basename(filePath)) ?? basename(filePath),
    filePath,
    models: [],
    compactions: 0,
    steps: [],
    usage: emptyUsage(),
    subagents: [],
    interactions: emptyInteractionCounts(),
    contentVolume: emptyContentVolume(),
  };
  const volume = session.contentVolume;

  const models = new Set<string>();
  const toolCallsById = new Map<string, ToolCall>();
  let currentStep: Step | undefined;
  let lastUserText: string | undefined;
  // Cumulative session usage as of the step boundary — per-step usage is the
  // diff of `total_token_usage` between boundaries (safer than summing
  // last_token_usage, which repeats per API call within a turn).
  let cumulative = emptyUsage();
  let stepStart = emptyUsage();

  const closeStep = () => {
    if (!currentStep) return;
    currentStep.usage = diffUsage(cumulative, stepStart);
    // no task_complete arrived for this turn: it was aborted/interrupted
    if (currentStep.durationMs === undefined) {
      currentStep.aborted = true;
      session.interactions.interruptions += 1;
    }
  };
  const openStep = (id: string, timestamp?: string): Step => {
    closeStep();
    stepStart = { ...cumulative };
    // Codex skills are invoked as $-prefixed messages ("$session-closeout …") —
    // command steps, not free-text prompts
    let kind: Step['kind'] = 'prompt';
    let commandName: string | undefined;
    let text = lastUserText;
    const command = text?.match(/^\$[\w:.-]+/);
    if (command) {
      kind = 'command';
      commandName = command[0];
      text = text!.slice(command[0].length).trim() || undefined;
      session.interactions.commands += 1;
    }
    lastUserText = undefined; // consume: a turn without fresh input must not inherit it
    const step: Step = {
      id,
      index: session.steps.length,
      kind,
      commandName,
      timestamp,
      promptText: text,
      promptPreview: text !== undefined ? previewText(text) : undefined,
      apiCalls: 0,
      toolCalls: [],
      usage: emptyUsage(),
    };
    session.steps.push(step);
    return step;
  };

  for (const line of lines) {
    const payload = line.payload ?? {};
    if (line.timestamp) {
      session.startedAt ??= line.timestamp;
      session.endedAt = line.timestamp;
    }

    switch (line.type) {
      case 'session_meta': {
        if (typeof payload.base_instructions === 'string') {
          volume.harnessInjectedChars += payload.base_instructions.length;
        }
        if (typeof payload.id === 'string') session.id = payload.id;
        if (typeof payload.cwd === 'string') session.cwd = payload.cwd;
        if (typeof payload.cli_version === 'string') session.cliVersion = payload.cli_version;
        if (typeof payload.forked_from_id === 'string') session.forkedFromId = payload.forked_from_id;
        if (
          payload.thread_source === 'subagent' ||
          (typeof payload.source === 'object' && payload.source !== null && 'subagent' in payload.source)
        ) {
          session.isSubagent = true;
        }
        const git = payload.git as { branch?: string } | undefined;
        if (git?.branch) session.gitBranch = git.branch;
        break;
      }
      case 'turn_context': {
        if (typeof payload.model === 'string') {
          const effort = typeof payload.effort === 'string' ? ` (${payload.effort})` : '';
          models.add(`${payload.model}${effort}`);
        }
        break;
      }
      case 'compacted': {
        session.compactions += 1;
        break;
      }
      case 'event_msg': {
        switch (payload.type) {
          case 'user_message': {
            const text = payload.message ?? payload.text;
            if (typeof text === 'string') {
              lastUserText = text;
              volume.humanPromptChars += text.length;
            }
            break;
          }
          case 'task_started': {
            const turnId = typeof payload.turn_id === 'string' ? payload.turn_id : undefined;
            currentStep = openStep(turnId ?? `turn-${session.steps.length}`, line.timestamp);
            break;
          }
          case 'task_complete': {
            if (currentStep && typeof payload.duration_ms === 'number') {
              currentStep.durationMs = payload.duration_ms;
            }
            break;
          }
          case 'token_count': {
            const info = payload.info as CodexTokenCountInfo | undefined;
            if (info?.total_token_usage) cumulative = toUsage(info.total_token_usage);
            if (currentStep) currentStep.apiCalls += 1;
            break;
          }
        }
        break;
      }
      case 'response_item': {
        switch (payload.type) {
          case 'message': {
            // developer messages and tag-wrapped user items (<environment_context>,
            // <user_instructions>) are harness-injected, not typed by the human
            const role = payload.role;
            const content = payload.content;
            if (Array.isArray(content)) {
              const text = content
                .map((c) => (typeof (c as { text?: unknown }).text === 'string' ? (c as { text: string }).text : ''))
                .join('');
              if (role === 'developer' || (role === 'user' && /^\s*</.test(text))) {
                volume.harnessInjectedChars += text.length;
              }
            }
            break;
          }
          case 'function_call':
          case 'custom_tool_call': {
            const callId = typeof payload.call_id === 'string' ? payload.call_id : undefined;
            if (!callId) break;
            currentStep ??= openStep(`turn-${session.steps.length}`, line.timestamp);
            const name = typeof payload.name === 'string' ? payload.name : '(unknown)';
            const call: ToolCall = {
              id: callId,
              name,
              ...classifyCodexTool(name),
              input: payload.arguments ?? payload.input,
              timestamp: line.timestamp,
            };
            toolCallsById.set(callId, call);
            currentStep.toolCalls.push(call);
            break;
          }
          case 'function_call_output':
          case 'custom_tool_call_output': {
            if (typeof payload.output === 'string') volume.toolResultChars += payload.output.length;
            const callId = typeof payload.call_id === 'string' ? payload.call_id : undefined;
            const call = callId ? toolCallsById.get(callId) : undefined;
            if (call && typeof payload.output === 'string') {
              call.outputPreview = previewText(payload.output, 120);
            }
            break;
          }
        }
        break;
      }
    }
  }

  closeStep();
  session.usage = cumulative;
  session.models = [...models];
  return session;
}
