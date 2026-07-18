import type { NormalizedSession } from '@asa/core';
import { collectStepSignals, type StepSignal } from '@asa/prompter';
import { clusterPrompts, type PromptCluster } from './cluster.js';
import { mineToolSequences, type SequenceStat } from './sequences.js';

export { ASA_INTERNAL_SENTINEL } from '@asa/core';
import { ASA_INTERNAL_SENTINEL } from '@asa/core';

export function isInternalSession(session: NormalizedSession): boolean {
  return session.steps[0]?.promptText?.startsWith(ASA_INTERNAL_SENTINEL) === true;
}

export interface CommandUsage {
  command: string;
  /**
   * 'skill' = matches an installed user skill/command/plugin.
   * 'builtin' = /-prefixed and not installed — plausibly CLI-provided.
   * 'unknown' = $-prefixed and not installed — Codex has no $ builtins, so
   * this is a removed/renamed skill.
   */
  kind: 'skill' | 'builtin' | 'unknown';
  count: number;
  sessions: number;
}

export interface DistillStats {
  scope: {
    sessions: number;
    prompts: number;
    perAgent: Record<string, number>;
    cwds: string[];
  };
  /** Recurring directive prompts — skill / automation candidates. */
  procedures: PromptCluster[];
  /** Recurring questions — FAQ / SRS candidates. */
  questions: PromptCluster[];
  /** Recurring corrections — CLAUDE.md / AGENTS.md rule candidates. */
  lessons: PromptCluster[];
  /** Recurring tool-call n-grams — procedure evidence from the action side. */
  toolSequences: SequenceStat[];
  /** Already-extracted skills and how much they're used. */
  commandUsage: CommandUsage[];
}

export interface DistillOptions {
  /** Installed skill/command names (no / or $ prefix) — see listInstalledClaudeCommands / listInstalledCodexCommands. */
  knownSkills?: Set<string>;
}

export function buildDistillStats(
  allSessions: NormalizedSession[],
  options: DistillOptions = {},
): DistillStats {
  const sessions = allSessions.filter((s) => !isInternalSession(s));
  // Forked transcripts are prefix copies that keep the original step uuids —
  // without dedupe every fork would fake a recurrence of its own history.
  const seen = new Set<string>();
  const signals: StepSignal[] = sessions.flatMap(collectStepSignals).filter((s) => {
    const key = `${s.stepId}|${s.promptExcerpt}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const clusters = clusterPrompts(signals);

  const commandCounts = new Map<string, { count: number; sessions: Set<string> }>();
  for (const session of sessions) {
    for (const step of session.steps) {
      if (step.kind !== 'command' || !step.commandName) continue;
      let entry = commandCounts.get(step.commandName);
      if (!entry) {
        entry = { count: 0, sessions: new Set() };
        commandCounts.set(step.commandName, entry);
      }
      entry.count += 1;
      entry.sessions.add(session.id);
    }
  }

  const perAgent: Record<string, number> = {};
  for (const s of sessions) perAgent[s.agent] = (perAgent[s.agent] ?? 0) + 1;

  return {
    scope: {
      sessions: sessions.length,
      prompts: signals.length,
      perAgent,
      cwds: [...new Set(sessions.map((s) => s.cwd).filter((c): c is string => !!c))],
    },
    procedures: clusters.filter((c) => c.kind === 'directive'),
    questions: clusters.filter((c) => c.kind === 'question'),
    lessons: clusters.filter((c) => c.kind === 'correction'),
    toolSequences: mineToolSequences(sessions),
    commandUsage: [...commandCounts.entries()]
      .map(([command, s]): CommandUsage => {
        const bare = command.replace(/^[/$]/, '');
        const known =
          options.knownSkills?.has(bare) || options.knownSkills?.has(bare.split(':')[0] ?? bare);
        return {
          command,
          kind: known ? 'skill' : command.startsWith('$') ? 'unknown' : 'builtin',
          count: s.count,
          sessions: s.sessions.size,
        };
      })
      .sort((a, b) => b.count - a.count),
  };
}
