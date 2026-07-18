import { describe, expect, it } from 'vitest';
import {
  emptyContentVolume,
  emptyInteractionCounts,
  emptyUsage,
  type NormalizedSession,
  type ToolCall,
} from '@asa/core';
import { buildWorkflowReport, sessionWorkflow } from '../src/workflow.js';

let n = 0;
const call = (name: string, input?: unknown): ToolCall => ({ id: `t${++n}`, name, isMcp: false, input });

function session(overrides: Partial<NormalizedSession> = {}): NormalizedSession {
  return {
    agent: 'claude',
    id: `session-${++n}`,
    filePath: '/x.jsonl',
    models: [],
    compactions: 0,
    usage: { ...emptyUsage(), totalTokens: 1000 },
    subagents: [],
    interactions: emptyInteractionCounts(),
    contentVolume: emptyContentVolume(),
    steps: [],
    ...overrides,
  };
}

function steps(toolCalls: ToolCall[], count = 1) {
  return Array.from({ length: count }, (_, i) => ({
    id: `s${i}`,
    index: i,
    kind: 'prompt' as const,
    apiCalls: 1,
    toolCalls: i === 0 ? toolCalls : [],
    usage: emptyUsage(),
  }));
}

describe('sessionWorkflow', () => {
  it('detects git and gh activity across both agents’ arg shapes', () => {
    const w = sessionWorkflow(
      session({
        gitBranch: 'dev',
        steps: steps([
          call('Bash', { command: 'git add -A && git commit -m "x"' }),
          call('Bash', { command: 'git push origin dev' }),
          call('Bash', { command: 'git switch -c feat/y' }),
          call('exec', 'await tools.exec_command({cmd:"gh issue create -t bug"})'),
          call('Edit'),
          call('Write'),
        ]),
      }),
    );
    expect(w).toMatchObject({
      gitCommits: 1,
      gitPushes: 1,
      gitBranchOps: 1,
      ghIssueOps: 1,
      fileEdits: 2,
      onDefaultBranch: false,
    });
  });

  it('splits compaction triggers and records max preTokens', () => {
    const w = sessionWorkflow(
      session({
        compactions: 2,
        compactionEvents: [
          { trigger: 'auto', preTokens: 150_000 },
          { trigger: 'manual', preTokens: 90_000 },
        ],
      }),
    );
    expect(w.compactionsAuto).toBe(1);
    expect(w.compactionsManual).toBe(1);
    expect(w.maxPreCompactTokens).toBe(150_000);
  });
});

describe('buildWorkflowReport', () => {
  it('lints compact-heavy sessions with the smaller-sessions recommendation', () => {
    const report = buildWorkflowReport([
      session({ compactions: 2, compactionEvents: [{ trigger: 'auto' }, { trigger: 'auto' }] }),
      session(),
    ]);
    const lint = report.lints.find((l) => l.rule === 'compact-heavy')!;
    expect(lint.severity).toBe('warn');
    expect(lint.message).toContain('smaller focused sessions');
    expect(lint.message).toContain('100% auto');
    expect(report.totals.sessionsWithCompactions).toBe(1);
  });

  it('lints heavy edits without commits, and untracked long sessions', () => {
    const editor = session({
      steps: steps(Array.from({ length: 12 }, () => call('Edit')), 12),
    });
    const report = buildWorkflowReport([editor]);
    expect(report.lints.map((l) => l.rule).sort()).toEqual([
      'uncommitted-work',
      'untracked-outcomes',
    ]);
  });

  it('lints mainline editing without a branch', () => {
    const report = buildWorkflowReport([
      session({
        gitBranch: 'main',
        steps: steps(Array.from({ length: 12 }, () => call('Write')), 2),
      }),
    ]);
    expect(report.lints.some((l) => l.rule === 'mainline-editing')).toBe(true);
  });

  it('all-clear when hygiene holds', () => {
    const clean = session({
      gitBranch: 'dev',
      steps: steps([call('Edit'), call('Bash', { command: 'git commit -m x' })], 3),
    });
    expect(buildWorkflowReport([clean]).lints).toEqual([
      expect.objectContaining({ rule: 'all-clear' }),
    ]);
  });
});
