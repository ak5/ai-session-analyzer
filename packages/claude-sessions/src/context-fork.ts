import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  buildContextDigest,
  estimateTokens,
  parseJsonl,
  type ContextDigestOptions,
} from '@asa/core';
import { copySessionDir } from './fork.js';
import { normalizeClaudeRecords, readClaudeStepResponse } from './parse.js';
import type { ClaudeRecord } from './records.js';

export interface ContextForkResult {
  newSessionId: string;
  newFilePath: string;
  /** Steps folded into the digest vs kept verbatim in the transcript. */
  digestedSteps: number;
  keptSteps: number;
  digestChars: number;
  /** chars/4 estimate of the crafted context (digest + kept tail). */
  estPostTokens: number;
  copiedSubagents?: number;
}

export interface ContextForkOptions extends ContextDigestOptions {
  /** Steps kept verbatim at the tail of the fork (default 2). */
  keepLastSteps?: number;
}

/**
 * Fork with a crafted context: instead of truncating the transcript
 * (`fork --at`) or letting the agent lossily summarize it (native /compact,
 * which paraphrases ~98% away in a ~2-minute billed model call), write a fork
 * whose history is the shape Claude itself produces after compaction —
 * a compact_boundary system record plus an isCompactSummary user record —
 * but with OUR deterministic digest (verbatim prompts + step conclusions +
 * files touched) as the summary, followed by the last N steps verbatim.
 *
 * Same stability caveat as fork --at: this relies on `claude --resume`
 * accepting externally written transcripts, which works today but is not a
 * stable contract.
 */
export async function craftClaudeContextFork(
  filePath: string,
  options: ContextForkOptions = {},
): Promise<ContextForkResult> {
  const keepLast = options.keepLastSteps ?? 2;
  const records = parseJsonl<ClaudeRecord>(await readFile(filePath, 'utf8'));
  const session = normalizeClaudeRecords(records, filePath);
  if (!session.steps.length) throw new Error(`No steps found in ${filePath}`);

  const keptSteps = keepLast > 0 ? session.steps.slice(-keepLast) : [];
  const digest = await buildContextDigest(
    session,
    (stepId) => readClaudeStepResponse(filePath, stepId),
    { ...options, skipStepIds: new Set(keptSteps.map((s) => s.id)) },
  );

  const newSessionId = randomUUID();
  const now = new Date().toISOString();
  // template record fields (cwd, version, gitBranch, …) from the last real user record
  const template = [...records].reverse().find((r) => r.type === 'user') ?? {};
  const base = {
    isSidechain: false,
    userType: 'external',
    entrypoint: 'cli',
    cwd: (template as { cwd?: string }).cwd ?? session.cwd,
    version: (template as { version?: string }).version ?? session.cliVersion,
    gitBranch: (template as { gitBranch?: string }).gitBranch ?? session.gitBranch,
    sessionId: newSessionId,
    session_id: newSessionId,
  };

  // verbatim tail: every record from the first kept step's prompt onward
  const tailStart = keptSteps.length
    ? records.findIndex((r) => r.uuid === keptSteps[0]!.id)
    : records.length;
  const summaryUuid = randomUUID();
  const tail = records
    .slice(tailStart)
    .filter((r) => r.type !== 'last-prompt')
    .map((r, i) => {
      const clone: ClaudeRecord = { ...r };
      if ('sessionId' in clone) clone.sessionId = newSessionId;
      if ('session_id' in clone) clone.session_id = newSessionId;
      // re-root the tail so the DAG never points at a dropped record
      if (i === 0) clone.parentUuid = summaryUuid;
      return clone;
    });

  const digestTokens = estimateTokens(digest);
  const boundary: ClaudeRecord = {
    ...base,
    parentUuid: null,
    type: 'system',
    subtype: 'compact_boundary',
    content: 'Conversation compacted',
    level: 'info',
    compactMetadata: {
      trigger: 'manual',
      preTokens: session.usage.totalTokens,
      postTokens: digestTokens,
    },
    uuid: randomUUID(),
    timestamp: now,
  } as ClaudeRecord;
  const summary: ClaudeRecord = {
    ...base,
    parentUuid: null,
    type: 'user',
    isCompactSummary: true,
    isVisibleInTranscriptOnly: true,
    message: { role: 'user', content: digest },
    uuid: summaryUuid,
    timestamp: now,
  } as ClaudeRecord;

  const newFilePath = join(dirname(filePath), `${newSessionId}.jsonl`);
  await writeFile(
    newFilePath,
    [boundary, summary, ...tail].map((r) => JSON.stringify(r)).join('\n') + '\n',
    { flag: 'wx' },
  );
  const copiedSubagents = await copySessionDir(filePath, newSessionId);
  return {
    newSessionId,
    newFilePath,
    digestedSteps: session.steps.length - keptSteps.length,
    keptSteps: keptSteps.length,
    digestChars: digest.length,
    estPostTokens: digestTokens + estimateTokens(JSON.stringify(tail)),
    copiedSubagents,
  };
}
