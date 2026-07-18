import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { parseJsonl } from '@asa/core';
import { rolloutSessionId } from './paths.js';
import type { CodexLine } from './records.js';

export interface CodexForkAtStepResult {
  newSessionId: string;
  newFilePath: string;
  keptRecords: number;
  droppedRecords: number;
}

/**
 * Fork a Codex session at a step (turn) by writing a truncated rollout under
 * a fresh session id — the Codex twin of forkClaudeSessionAtStep, with one
 * upgrade: Codex has a native lineage field, so the fork carries
 * `forked_from_id` pointing at the original.
 *
 * Steps map to task_started events; the cut lands just before the turn AFTER
 * the chosen one. Step ids are turn_ids (from `asa analyze`); ordinal
 * fallbacks (`turn-<n>`) are matched by task_started order, which assumes no
 * tool activity precedes the first turn (true for CLI-driven sessions).
 */
export async function forkCodexSessionAtStep(
  filePath: string,
  stepId: string,
): Promise<CodexForkAtStepResult> {
  const lines = parseJsonl<CodexLine>(await readFile(filePath, 'utf8'));

  let target = -1;
  let cut = lines.length;
  let ordinal = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.type !== 'event_msg' || line.payload?.type !== 'task_started') continue;
    if (target >= 0) {
      cut = i;
      break;
    }
    const id = typeof line.payload.turn_id === 'string' ? line.payload.turn_id : `turn-${ordinal}`;
    ordinal += 1;
    if (id === stepId || `turn-${ordinal - 1}` === stepId) target = i;
  }
  if (target < 0) {
    throw new Error(`No turn with step id ${stepId} in ${filePath} (step ids come from \`asa analyze\`)`);
  }

  const newSessionId = randomUUID();
  const originalId = rolloutSessionId(basename(filePath));
  const kept = lines.slice(0, cut).map((line) => {
    if (line.type !== 'session_meta' || !line.payload) return line;
    const payload: Record<string, unknown> = { ...line.payload, id: newSessionId };
    if ('session_id' in payload) payload.session_id = newSessionId;
    if (originalId) payload.forked_from_id = originalId;
    return { ...line, payload } as CodexLine;
  });

  const stamp = new Date().toISOString().slice(0, 19).replace(/:/g, '-');
  const newFilePath = join(dirname(filePath), `rollout-${stamp}-${newSessionId}.jsonl`);
  await writeFile(newFilePath, kept.map((l) => JSON.stringify(l)).join('\n') + '\n', { flag: 'wx' });
  return {
    newSessionId,
    newFilePath,
    keptRecords: kept.length,
    droppedRecords: lines.length - cut,
  };
}
