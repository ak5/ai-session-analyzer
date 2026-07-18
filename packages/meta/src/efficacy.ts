/**
 * Instruction-file efficacy: nobody ever evaluates CLAUDE.md/AGENTS.md edits.
 * We can: git gives when each instruction change landed, sessions give
 * steering metrics (corrections, interruptions per prompt) before and after.
 * Correlational, not causal — model updates and task mix are confounds, and
 * the report says so — but a rule that was followed by zero change in the
 * behavior it targeted is still a rule worth questioning.
 */
import { spawnSync } from 'node:child_process';
import type { NormalizedSession } from '@asa/core';
import { collectStepSignals } from '@asa/prompter';

export interface InstructionChange {
  file: string;
  commit: string;
  date: string;
  subject: string;
}

export interface SteeringSample {
  sessionId: string;
  startedAt: string;
  prompts: number;
  corrections: number;
  interruptions: number;
}

export interface EfficacyWindow {
  sessions: number;
  prompts: number;
  correctionRate?: number;
  interruptionRate?: number;
}

export interface EfficacyEntry {
  change: InstructionChange;
  before: EfficacyWindow;
  after: EfficacyWindow;
}

export type GitLogRunner = (repoPath: string, file: string) => string;

const defaultGitLog: GitLogRunner = (repoPath, file) => {
  const result = spawnSync('git', ['log', '--follow', '--format=%H|%cI|%s', '--', file], {
    cwd: repoPath,
  });
  return result.status === 0 ? result.stdout.toString() : '';
};

export function readInstructionChanges(
  repoPath: string,
  files: string[] = ['CLAUDE.md', 'AGENTS.md'],
  gitLog: GitLogRunner = defaultGitLog,
): InstructionChange[] {
  const changes: InstructionChange[] = [];
  for (const file of files) {
    for (const line of gitLog(repoPath, file).trim().split('\n')) {
      const [commit, date, ...subject] = line.split('|');
      if (commit && date) changes.push({ file, commit, date, subject: subject.join('|') });
    }
  }
  return changes.sort((a, b) => a.date.localeCompare(b.date));
}

export function steeringSamples(sessions: NormalizedSession[]): SteeringSample[] {
  return sessions
    .filter((s) => s.startedAt)
    .map((s) => {
      const signals = collectStepSignals(s);
      return {
        sessionId: s.id,
        startedAt: s.startedAt!,
        prompts: signals.length,
        corrections: signals.filter((sig) => sig.features.isCorrection).length,
        interruptions: s.interactions.interruptions,
      };
    })
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
}

function window(samples: SteeringSample[]): EfficacyWindow {
  const prompts = samples.reduce((n, s) => n + s.prompts, 0);
  return {
    sessions: samples.length,
    prompts,
    correctionRate: prompts ? samples.reduce((n, s) => n + s.corrections, 0) / prompts : undefined,
    interruptionRate: prompts
      ? samples.reduce((n, s) => n + s.interruptions, 0) / prompts
      : undefined,
  };
}

/**
 * For each instruction change: steering metrics in the sessions strictly
 * before vs strictly after its commit date (capped at `windowSize` sessions
 * each side so old history doesn't wash out the comparison).
 */
export function computeEfficacy(
  changes: InstructionChange[],
  samples: SteeringSample[],
  windowSize = 10,
): EfficacyEntry[] {
  return changes.map((change) => {
    const before = samples.filter((s) => s.startedAt < change.date).slice(-windowSize);
    const after = samples.filter((s) => s.startedAt >= change.date).slice(0, windowSize);
    return { change, before: window(before), after: window(after) };
  });
}
