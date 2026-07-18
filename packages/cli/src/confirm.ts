/**
 * Pre-flight gate for every flag that spends model tokens (--deep, --suggest).
 * Shows an input-token estimate from the exact prompt that would be sent
 * (chars/4 — crude but honest and stated), plus current quota usage where a
 * local source exists (Codex records rate limits in its rollouts; Claude Code
 * exposes nothing locally). Requires a TTY yes or an explicit --yes.
 */
import { createInterface } from 'node:readline/promises';
import { formatNumber as fmt } from '@asa/core';
import { readClaudeQuota } from '@asa/claude-sessions';
import { readLatestCodexRateLimits } from '@asa/codex-sessions';

export interface ModelCallPlan {
  label: string;
  backend: 'claude' | 'codex';
  /** The exact prompt that will be sent. */
  prompt: string;
  /** Expected output range in tokens. */
  outputEstimate: [number, number];
  yes?: boolean;
}

export function estimateInputTokens(prompt: string): number {
  return Math.round(prompt.length / 4);
}

export async function confirmModelCall(plan: ModelCallPlan): Promise<boolean> {
  const input = estimateInputTokens(plan.prompt);
  const [lo, hi] = plan.outputEstimate;
  console.error(
    `${plan.label}: one ${plan.backend} call, ~${fmt(input)} input tokens (est. chars/4) + ~${fmt(lo)}–${fmt(hi)} output`,
  );
  if (plan.backend === 'codex') {
    const limits = await readLatestCodexRateLimits().catch(() => undefined);
    if (limits) {
      const window = limits.windowMinutes ? ` of ${Math.round(limits.windowMinutes / 60)}h window` : '';
      console.error(
        `  codex quota: ${limits.usedPercent.toFixed(0)}% used${window}` +
          `${limits.observedAt ? ` (as of ${limits.observedAt.slice(0, 16).replace('T', ' ')})` : ''}`,
      );
    } else {
      console.error('  codex quota: no recent reading found in rollouts');
    }
  } else {
    const quota = await readClaudeQuota();
    if (quota) {
      const parts = [
        quota.sessionUsedPercent !== undefined ? `session ${quota.sessionUsedPercent}%` : undefined,
        quota.weekUsedPercent !== undefined ? `week ${quota.weekUsedPercent}%` : undefined,
        quota.weekModelUsedPercent !== undefined
          ? `week/${quota.weekModelName ?? 'model'} ${quota.weekModelUsedPercent}%`
          : undefined,
      ].filter(Boolean);
      console.error(`  claude quota: ${parts.join(' · ')} used`);
    } else {
      console.error('  claude quota: unavailable (claude -p "/usage" failed)');
    }
  }

  if (plan.yes) return true;
  if (!process.stdin.isTTY) {
    console.error('  non-interactive session — pass --yes to proceed; skipping the model call');
    return false;
  }
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await rl.question('  proceed? [y/N] ');
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}
