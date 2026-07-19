import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import {
  buildContextDigest,
  estimateTokens,
  parseJsonl,
  type ContextDigestOptions,
} from '@asa/core';
import { normalizeCodexLines, readCodexStepResponse } from './parse.js';
import { rolloutSessionId } from './paths.js';
import type { CodexLine } from './records.js';

export interface CodexContextForkResult {
  newSessionId: string;
  newFilePath: string;
  digestedSteps: number;
  keptSteps: number;
  digestChars: number;
  estPostTokens: number;
}

export interface CodexContextForkOptions extends ContextDigestOptions {
  keepLastSteps?: number;
}

/**
 * Fork a Codex session with a crafted context. Native Codex compaction writes
 * a `compacted` record whose replacement_history keeps user prompts verbatim
 * plus an ENCRYPTED bridge summary (server-side state we cannot forge — see
 * docs/formats.md). Resume, however, rebuilds the model-visible history from
 * the rollout's `response_item` lines (verified live: a synthetic `compacted`
 * record at the head of a rollout is ignored), so the crafted history is
 * emitted as literal response_item messages: environment context, the prompts
 * verbatim, our digest — then the last N turns verbatim.
 */
export async function craftCodexContextFork(
  filePath: string,
  options: CodexContextForkOptions = {},
): Promise<CodexContextForkResult> {
  const keepLast = options.keepLastSteps ?? 2;
  const lines = parseJsonl<CodexLine>(await readFile(filePath, 'utf8'));
  const session = normalizeCodexLines(lines, filePath);
  if (!session.steps.length) throw new Error(`No turns found in ${filePath}`);

  const keptSteps = keepLast > 0 ? session.steps.slice(-keepLast) : [];
  const digest = await buildContextDigest(
    session,
    (stepId) => readCodexStepResponse(filePath, stepId),
    { ...options, skipStepIds: new Set(keptSteps.map((s) => s.id)) },
  );

  const newSessionId = randomUUID();
  const originalId = rolloutSessionId(basename(filePath));

  // metadata head: session_meta (re-id'd, lineage stamped) + latest turn_context
  const metaLine = lines.find((l) => l.type === 'session_meta');
  if (!metaLine?.payload) throw new Error(`No session_meta in ${filePath}`);
  const metaPayload: Record<string, unknown> = { ...metaLine.payload, id: newSessionId };
  if ('session_id' in metaPayload) metaPayload.session_id = newSessionId;
  if (originalId) metaPayload.forked_from_id = originalId;
  const turnContext = [...lines].reverse().find((l) => l.type === 'turn_context');

  // environment context item: reuse the one codex itself keeps through compaction
  const firstEnv = lines.find(
    (l) =>
      l.type === 'response_item' &&
      l.payload?.type === 'message' &&
      l.payload.role === 'user' &&
      JSON.stringify(l.payload.content ?? '').includes('<environment_context>'),
  );

  const now = new Date().toISOString();
  const userItem = (text: string): CodexLine =>
    ({
      timestamp: now,
      type: 'response_item',
      payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] },
    }) as CodexLine;
  const history: CodexLine[] = [];
  if (firstEnv) history.push(firstEnv);
  for (const step of session.steps) {
    if (keptSteps.some((k) => k.id === step.id)) continue;
    const text = step.kind === 'command' ? `${step.commandName} ${step.promptText ?? ''}`.trim() : step.promptText;
    if (text) history.push(userItem(text));
  }
  history.push(userItem(digest));

  // verbatim tail: everything from the first kept turn onward — including the
  // user_message event(s) written just BEFORE its task_started, which carry
  // the turn's prompt (normalize consumes them at the task_started boundary)
  let tailStart = lines.length;
  if (keptSteps.length) {
    tailStart = lines.findIndex(
      (l) =>
        l.type === 'event_msg' &&
        l.payload?.type === 'task_started' &&
        l.payload.turn_id === keptSteps[0]!.id,
    );
    if (tailStart < 0) tailStart = lines.length;
    while (
      tailStart > 0 &&
      lines[tailStart - 1]!.type === 'event_msg' &&
      lines[tailStart - 1]!.payload?.type === 'user_message'
    ) {
      tailStart -= 1;
    }
  }
  const tail = lines.slice(tailStart);

  const crafted: CodexLine[] = [
    { timestamp: metaLine.timestamp ?? now, type: 'session_meta', payload: metaPayload } as CodexLine,
    ...(turnContext ? [turnContext] : []),
    ...history,
    ...tail,
  ];

  const stamp = new Date().toISOString().slice(0, 19).replace(/:/g, '-');
  const newFilePath = join(dirname(filePath), `rollout-${stamp}-${newSessionId}.jsonl`);
  await writeFile(newFilePath, crafted.map((l) => JSON.stringify(l)).join('\n') + '\n', {
    flag: 'wx',
  });
  return {
    newSessionId,
    newFilePath,
    digestedSteps: session.steps.length - keptSteps.length,
    keptSteps: keptSteps.length,
    digestChars: digest.length,
    estPostTokens: estimateTokens(digest) + estimateTokens(JSON.stringify(tail)),
  };
}
