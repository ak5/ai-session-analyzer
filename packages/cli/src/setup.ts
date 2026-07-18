/**
 * `asa setup`: onboarding report + one optional, confirmed settings change.
 *
 * Everything asa's longitudinal features (efficacy, skill curve, models) can
 * see is bounded by Claude Code's transcript retention — 30 days by default
 * (`cleanupPeriodDays`). The single highest-value onboarding step is raising
 * it, so setup offers exactly that, and otherwise only reports.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  claudeConfigDir,
  claudeProjectsDir,
  listClaudeSessions,
  readClaudeStatsCache,
} from '@asa/claude-sessions';
import { codexHome, codexSessionsDir, listCodexSessions } from '@asa/codex-sessions';

export const DEFAULT_RETENTION_DAYS = 365;
const CLAUDE_DEFAULT_RETENTION = 30;

export interface RetentionState {
  settingsPath: string;
  current?: number;
  effective: number;
}

export function readRetention(configDir?: string): RetentionState {
  const settingsPath = join(configDir ?? claudeConfigDir(), 'settings.json');
  let current: number | undefined;
  try {
    const settings = JSON.parse(readFileSync(settingsPath, 'utf8')) as {
      cleanupPeriodDays?: number;
    };
    if (typeof settings.cleanupPeriodDays === 'number') current = settings.cleanupPeriodDays;
  } catch {
    // no settings file yet
  }
  return { settingsPath, current, effective: current ?? CLAUDE_DEFAULT_RETENTION };
}

/** Set cleanupPeriodDays, preserving all other settings content. */
export function writeRetention(settingsPath: string, days: number): void {
  let settings: Record<string, unknown> = {};
  if (existsSync(settingsPath)) {
    settings = JSON.parse(readFileSync(settingsPath, 'utf8')) as Record<string, unknown>;
  }
  settings.cleanupPeriodDays = days;
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
}

function binaryVersion(command: string): string | undefined {
  const result = spawnSync(command, ['--version'], { timeout: 10_000 });
  return result.status === 0 ? result.stdout.toString().trim().split('\n')[0] : undefined;
}

export async function buildSetupReport(): Promise<string[]> {
  const lines: string[] = [];
  const claudeVersion = binaryVersion('claude');
  const codexVersion = binaryVersion('codex');
  lines.push(`claude binary: ${claudeVersion ?? 'NOT FOUND (needed for resume/fork/--deep/--suggest claude)'}`);
  lines.push(`codex binary:  ${codexVersion ?? 'NOT FOUND (needed for codex resume/fork/--suggest codex)'}`);

  const [claudeSessions, codexSessions] = await Promise.all([
    listClaudeSessions().catch(() => []),
    listCodexSessions().catch(() => []),
  ]);
  lines.push(`claude sessions: ${claudeSessions.length} under ${claudeProjectsDir()}`);
  lines.push(`codex sessions:  ${codexSessions.length} under ${codexSessionsDir()}`);
  if (!existsSync(join(codexHome(), 'session_index.jsonl'))) {
    lines.push('codex session_index.jsonl: missing (titles unavailable in asa list)');
  }

  const cache = await readClaudeStatsCache();
  if (cache?.dailyModelTokens?.length) {
    lines.push(`claude stats-cache: ${cache.dailyModelTokens.length} days of model history (asa models long-range)`);
  }

  const retention = readRetention();
  lines.push(
    `claude transcript retention: ${retention.effective} days` +
      (retention.current === undefined ? ' (default — cleanupPeriodDays unset)' : ''),
  );
  return lines;
}
