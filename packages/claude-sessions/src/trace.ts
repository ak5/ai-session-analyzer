/**
 * Join the .asa/git-trace.jsonl sidecar (written by `asa install-hooks`)
 * back onto session steps: each UserPromptSubmit event carries the git HEAD
 * at the moment a prompt was typed. Matching is nearest-timestamp within a
 * window — hook and transcript clocks are the same machine, so skew is
 * process latency, not clock drift.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseJsonl, type NormalizedSession } from '@asa/core';

export interface GitTraceEvent {
  ts?: string;
  event?: string;
  session_id?: string;
  head?: string;
  branch?: string;
  dirty_files?: number;
}

const MATCH_WINDOW_MS = 20_000;

export async function readGitTrace(cwd: string): Promise<GitTraceEvent[]> {
  try {
    return parseJsonl<GitTraceEvent>(await readFile(join(cwd, '.asa', 'git-trace.jsonl'), 'utf8'));
  } catch {
    return [];
  }
}

export function annotateStepsWithGitTrace(
  session: NormalizedSession,
  trace: GitTraceEvent[],
): void {
  const prompts = trace.filter(
    (e) => e.session_id === session.id && e.event === 'UserPromptSubmit' && e.ts && e.head,
  );
  if (!prompts.length) return;
  for (const step of session.steps) {
    if (!step.timestamp) continue;
    const stepTime = Date.parse(step.timestamp);
    let best: { event: GitTraceEvent; distance: number } | undefined;
    for (const event of prompts) {
      const distance = Math.abs(Date.parse(event.ts!) - stepTime);
      if (distance <= MATCH_WINDOW_MS && (!best || distance < best.distance)) {
        best = { event, distance };
      }
    }
    if (best) {
      step.gitHead = best.event.head;
      step.gitDirtyFiles = best.event.dirty_files;
    }
  }
}

export async function annotateSessionWithGitTrace(session: NormalizedSession): Promise<void> {
  if (!session.cwd) return;
  annotateStepsWithGitTrace(session, await readGitTrace(session.cwd));
}
