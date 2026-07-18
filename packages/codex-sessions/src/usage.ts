/**
 * Codex records rate-limit state in every token_count event — the tail of the
 * newest rollout is a free, local answer to "how much of my quota is used?".
 * Claude Code records nothing comparable in its transcripts.
 */
import { readLastJsonlObjects } from '@asa/core';
import { listCodexSessions } from './discover.js';
import type { CodexLine } from './records.js';

export interface CodexRateLimits {
  usedPercent: number;
  windowMinutes?: number;
  resetsAt?: string;
  planType?: string;
  /** When this reading was recorded (rollout event timestamp). */
  observedAt?: string;
}

export async function readLatestCodexRateLimits(): Promise<CodexRateLimits | undefined> {
  const refs = (await listCodexSessions()).slice(0, 5);
  for (const ref of refs) {
    let lines: CodexLine[];
    try {
      lines = (await readLastJsonlObjects(ref.filePath, 60)) as CodexLine[];
    } catch {
      continue;
    }
    for (let i = lines.length - 1; i >= 0; i--) {
      const payload = lines[i]?.payload;
      if (lines[i]?.type !== 'event_msg' || payload?.type !== 'token_count') continue;
      const limits = payload.rate_limits as
        | {
            primary?: { used_percent?: number; window_minutes?: number; resets_at?: string };
            plan_type?: string;
          }
        | undefined;
      const used = limits?.primary?.used_percent;
      if (typeof used === 'number') {
        return {
          usedPercent: used,
          windowMinutes: limits?.primary?.window_minutes,
          resetsAt: limits?.primary?.resets_at,
          planType: limits?.plan_type,
          observedAt: lines[i]?.timestamp,
        };
      }
    }
  }
  return undefined;
}
