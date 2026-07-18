import { describe, expect, it } from 'vitest';
import {
  emptyContentVolume,
  emptyInteractionCounts,
  emptyUsage,
  type NormalizedSession,
  type Step,
} from '@asa/core';
import { analyzePrompter, collectStepSignals, pearson } from '../src/stats.js';

let stepCounter = 0;

function step(promptText: string, overrides: Partial<Step> = {}): Step {
  stepCounter += 1;
  return {
    id: `s${stepCounter}`,
    index: 0,
    kind: 'prompt',
    promptText,
    promptPreview: promptText.slice(0, 60),
    apiCalls: 1,
    toolCalls: [],
    usage: { ...emptyUsage(), outputTokens: 100, totalTokens: 100 },
    ...overrides,
  };
}

function session(steps: Step[], overrides: Partial<NormalizedSession> = {}): NormalizedSession {
  return {
    agent: 'claude',
    id: `session-${Math.random().toString(36).slice(2, 8)}`,
    filePath: '/x/s.jsonl',
    models: [],
    compactions: 0,
    steps: steps.map((s, i) => ({ ...s, index: i })),
    usage: emptyUsage(),
    subagents: [],
    interactions: emptyInteractionCounts(),
    contentVolume: emptyContentVolume(),
    ...overrides,
  };
}

describe('collectStepSignals', () => {
  it('computes gaps and marks prompts corrected by the next one', () => {
    const s = session([
      step('add a flag to the cli', { timestamp: '2026-07-17T10:00:00Z' }),
      step('no, I meant the list command', { timestamp: '2026-07-17T10:01:00Z' }),
    ]);
    const signals = collectStepSignals(s);
    expect(signals).toHaveLength(2);
    expect(signals[0]!.correctedByNext).toBe(true);
    expect(signals[1]!.features.isCorrection).toBe(true);
    expect(signals[1]!.gapMs).toBe(60_000);
  });

  it('skips steps without prompt text', () => {
    const s = session([step('real prompt'), step('', { promptText: undefined })]);
    expect(collectStepSignals(s)).toHaveLength(1);
  });
});

describe('pearson', () => {
  it('returns 1 for a perfect positive correlation', () => {
    expect(pearson([1, 2, 3, 4], [10, 20, 30, 40])).toBeCloseTo(1);
  });

  it('returns undefined for n < 4 or zero variance', () => {
    expect(pearson([1, 2, 3], [1, 2, 3])).toBeUndefined();
    expect(pearson([1, 1, 1, 1], [1, 2, 3, 4])).toBeUndefined();
  });
});

describe('analyzePrompter', () => {
  it('aggregates totals and per-agent splits', () => {
    stepCounter = 0;
    const claude = session([step('fix packages/core/src/index.ts'), step('now run the tests')]);
    const codex = session([step('do the thing etc etc')], { agent: 'codex' });
    const report = analyzePrompter([claude, codex]);
    expect(report.totals.sessions).toBe(2);
    expect(report.totals.steps).toBe(3);
    expect(report.perAgent.claude?.steps).toBe(2);
    expect(report.perAgent.codex?.steps).toBe(1);
    expect(report.totals.outputTokensPerPromptKChar).toBeGreaterThan(0);
  });

  it('flags the Micromanager archetype on high steering rates', () => {
    const s = session(
      [
        step('do X', { timestamp: '2026-07-17T10:00:00Z' }),
        step('no, wrong file', { timestamp: '2026-07-17T10:01:00Z' }),
        step('actually, revert', { timestamp: '2026-07-17T10:02:00Z' }),
      ],
      { interactions: { ...emptyInteractionCounts(), interruptions: 2 } },
    );
    const report = analyzePrompter([s]);
    expect(report.archetype.name).toBe('The Micromanager');
    expect(report.lints.some((l) => l.rule === 'correction-heavy')).toBe(true);
    const correctionLint = report.lints.find((l) => l.rule === 'correction-heavy')!;
    expect(correctionLint.examples.length).toBeGreaterThan(0);
  });

  it('flags the Cannonballer for few huge prompts', () => {
    const brief = 'implement the whole feature end to end. '.repeat(30);
    const report = analyzePrompter([session([step(brief)]), session([step(brief)])]);
    expect(report.archetype.name).toBe('The Cannonballer');
  });

  it('builds a weekly skill curve', () => {
    const s = session([
      step('week one prompt', { timestamp: '2026-07-06T10:00:00Z' }),
      step('week two prompt', { timestamp: '2026-07-13T10:00:00Z' }),
    ]);
    const report = analyzePrompter([s]);
    expect(report.skillCurve).toHaveLength(2);
    expect(report.skillCurve[0]!.week < report.skillCurve[1]!.week).toBe(true);
  });

  it('emits all-clear when nothing trips', () => {
    const report = analyzePrompter([
      session([step('fix the failing test in packages/core/test/core.test.ts')]),
    ]);
    expect(report.lints).toEqual([
      expect.objectContaining({ rule: 'all-clear', severity: 'info' }),
    ]);
  });
});
