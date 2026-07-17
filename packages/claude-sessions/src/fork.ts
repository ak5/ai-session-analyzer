import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { parseJsonl } from '@asa/core';
import { isPromptRecord, type ClaudeRecord } from './records.js';

export interface ForkAtStepResult {
  newSessionId: string;
  newFilePath: string;
  keptRecords: number;
  droppedRecords: number;
}

/**
 * Fork a Claude session at a specific step by writing a truncated copy of the
 * transcript under a fresh session id, ready for `claude --resume <newId>`.
 *
 * The transcript is kept up to and including the step identified by
 * `stepUuid` (a record uuid, normally the user-prompt uuid shown by
 * `asa analyze`) — the cut lands just before the next user prompt.
 *
 * This synthesizes what neither CLI offers: `claude --fork-session` can only
 * fork the whole session. It relies on Claude Code accepting externally
 * written transcripts on --resume, which works today but is not a stable
 * contract — treat forks as disposable.
 */
export async function forkClaudeSessionAtStep(
  filePath: string,
  stepUuid: string,
): Promise<ForkAtStepResult> {
  const records = parseJsonl<ClaudeRecord>(await readFile(filePath, 'utf8'));
  const anchor = records.findIndex((r) => r.uuid === stepUuid);
  if (anchor < 0) {
    throw new Error(`No record with uuid ${stepUuid} in ${filePath}`);
  }
  let cut = records.length;
  for (let i = anchor + 1; i < records.length; i++) {
    if (isPromptRecord(records[i]!)) {
      cut = i;
      break;
    }
  }

  const newSessionId = randomUUID();
  const kept = records
    .slice(0, cut)
    // last-prompt records point at a DAG leaf that may be beyond the cut.
    .filter((r) => r.type !== 'last-prompt')
    .map((r) => {
      const clone: ClaudeRecord = { ...r };
      if ('sessionId' in clone) clone.sessionId = newSessionId;
      if ('session_id' in clone) clone.session_id = newSessionId;
      return clone;
    });

  const newFilePath = join(dirname(filePath), `${newSessionId}.jsonl`);
  await writeFile(newFilePath, kept.map((r) => JSON.stringify(r)).join('\n') + '\n', {
    flag: 'wx',
  });
  return {
    newSessionId,
    newFilePath,
    keptRecords: kept.length,
    droppedRecords: records.length - cut,
  };
}
