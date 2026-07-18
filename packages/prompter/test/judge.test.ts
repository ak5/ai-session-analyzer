import { describe, expect, it } from 'vitest';
import { judgePrompts, selectJudgeSamples, type JudgeSample } from '../src/judge.js';
import type { StepSignal } from '../src/stats.js';
import { extractPromptFeatures } from '../src/features.js';

function signal(text: string, correctedByNext = false): StepSignal {
  return {
    agent: 'claude',
    sessionId: 'sess',
    stepId: `id-${text.length}-${correctedByNext}`,
    index: 0,
    kind: 'prompt',
    promptPreview: text.slice(0, 90),
    promptExcerpt: text.slice(0, 600),
    features: extractPromptFeatures(text),
    outputTokens: 0,
    toolCalls: 0,
    apiCalls: 1,
    aborted: false,
    correctedByNext,
  };
}

describe('selectJudgeSamples', () => {
  it('prioritizes corrected prompts, then longest, without duplicates', () => {
    const corrected = signal('short but got corrected', true);
    const long = signal('l'.repeat(400));
    const short = signal('tiny');
    const samples = selectJudgeSamples([short, long, corrected], 2);
    expect(samples).toHaveLength(2);
    expect(samples[0]!.correctedByNext).toBe(true);
    expect(samples[1]!.prompt.startsWith('lll')).toBe(true);
  });
});

describe('judgePrompts', () => {
  const samples: JudgeSample[] = [
    { id: 'p1', prompt: 'do the thing', correctedByNext: true, toolCalls: 2 },
    { id: 'p2', prompt: 'fix src/x.ts line 4', correctedByNext: false, toolCalls: 1 },
  ];

  it('parses grades from noisy output and averages them', async () => {
    const runner = async () =>
      'Sure! Here are the grades:\n[{"id":"p1","clarity":2,"context":1,"tip":"name the file"},{"id":"p2","clarity":5,"context":4,"tip":""}]\n';
    const result = await judgePrompts(samples, { runner, model: 'haiku' });
    expect(result.grades).toHaveLength(2);
    expect(result.avgClarity).toBe(3.5);
    expect(result.avgContext).toBe(2.5);
  });

  it('drops grades for unknown ids', async () => {
    const runner = async () => '[{"id":"p9","clarity":5,"context":5,"tip":"x"}]';
    const result = await judgePrompts(samples, { runner });
    expect(result.grades).toHaveLength(0);
    expect(result.avgClarity).toBeUndefined();
  });

  it('throws on non-JSON output', async () => {
    const runner = async () => 'Not logged in';
    await expect(judgePrompts(samples, { runner })).rejects.toThrow(/no JSON array/);
  });

  it('short-circuits on zero samples without calling the runner', async () => {
    let called = false;
    const runner = async () => {
      called = true;
      return '[]';
    };
    const result = await judgePrompts([], { runner });
    expect(result.samples).toBe(0);
    expect(called).toBe(false);
  });
});
