import { describe, expect, it } from 'vitest';
import { emptyContentVolume,
  emptyInteractionCounts, emptyUsage, type NormalizedSession } from '@asa/core';
import { analyzeSession } from '../src/analyze.js';
import { compareReports, renderComparison } from '../src/compare.js';

function session(outputTokens: number, steps: number): NormalizedSession {
  return {
    agent: 'claude',
    id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    filePath: '/x.jsonl',
    models: [],
    compactions: 0,
    usage: { ...emptyUsage(), outputTokens, totalTokens: outputTokens },
    subagents: [],
    interactions: emptyInteractionCounts(),
    contentVolume: emptyContentVolume(),
    steps: Array.from({ length: steps }, (_, i) => ({
      id: `s${i}`,
      index: i,
      kind: 'prompt' as const,
      apiCalls: 2,
      toolCalls: [],
      usage: emptyUsage(),
    })),
  };
}

describe('compareReports / renderComparison', () => {
  const a = analyzeSession(session(100, 2));
  const b = analyzeSession(session(150, 3));

  it('computes deltas per metric', () => {
    const rows = compareReports(a, b);
    const stepsRow = rows.find((r) => r.metric === 'steps')!;
    expect(stepsRow).toMatchObject({ a: 2, b: 3 });
    const out = rows.find((r) => r.metric === 'output tokens')!;
    expect(out).toMatchObject({ a: 100, b: 150 });
  });

  it('renders a delta table with percentages', () => {
    const text = renderComparison(a, b);
    expect(text).toContain('A: claude aaaaaaaa');
    expect(text).toContain('+50');
    expect(text).toContain('50%');
  });
});
