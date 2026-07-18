/**
 * Claude usage sources beyond the transcripts:
 * - ~/.claude/stats-cache.json — daily per-model token matrix reaching months
 *   further back than transcript retention, plus per-model lifetime totals.
 * - `claude -p "/usage"` — the subscription quota panel, which works headless:
 *   session/week used-percent with reset times. Handled locally by the CLI
 *   (no model tokens spent), but it does take a couple of seconds.
 */
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { claudeConfigDir } from './paths.js';

export interface ClaudeStatsCache {
  dailyModelTokens?: Array<{ date: string; tokensByModel?: Record<string, number> }>;
  modelUsage?: Record<
    string,
    { inputTokens?: number; outputTokens?: number; costUSD?: number }
  >;
  dailyActivity?: Array<{ date: string; sessionCount?: number; messageCount?: number }>;
}

export async function readClaudeStatsCache(configDir?: string): Promise<ClaudeStatsCache | undefined> {
  try {
    return JSON.parse(
      await readFile(join(configDir ?? claudeConfigDir(), 'stats-cache.json'), 'utf8'),
    ) as ClaudeStatsCache;
  } catch {
    return undefined;
  }
}

export interface ClaudeQuota {
  sessionUsedPercent?: number;
  weekUsedPercent?: number;
  weekModelUsedPercent?: number;
  weekModelName?: string;
  raw: string;
}

export function parseClaudeUsageOutput(text: string): ClaudeQuota | undefined {
  const session = /Current session:\s*(\d+)%\s*used/.exec(text);
  const week = /Current week \(all models\):\s*(\d+)%\s*used/.exec(text);
  const model = /Current week \(([^)]+)\):\s*(\d+)%\s*used/.exec(
    text.replace(/Current week \(all models\)[^\n]*\n?/, ''),
  );
  if (!session && !week) return undefined;
  return {
    sessionUsedPercent: session ? Number(session[1]) : undefined,
    weekUsedPercent: week ? Number(week[1]) : undefined,
    weekModelUsedPercent: model ? Number(model[2]) : undefined,
    weekModelName: model?.[1],
    raw: text.trim(),
  };
}

export async function readClaudeQuota(
  runner?: (command: string, args: string[]) => Promise<string>,
): Promise<ClaudeQuota | undefined> {
  const run =
    runner ??
    ((command: string, args: string[]) =>
      new Promise<string>((resolve, reject) => {
        const child = execFile(command, args, { timeout: 30_000 }, (err, stdout) =>
          err ? reject(err) : resolve(stdout),
        );
        child.stdin?.end();
      }));
  try {
    return parseClaudeUsageOutput(await run('claude', ['-p', '--no-session-persistence', '/usage']));
  } catch {
    return undefined;
  }
}
