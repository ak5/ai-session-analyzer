import { describe, expect, it } from 'vitest';
import type { PromptCluster } from '../src/cluster.js';
import { buildFaqEntry, mergeFaq, questionKey } from '../src/faq.js';

const cluster: PromptCluster = {
  kind: 'question',
  representative: 'how do we use just actually',
  count: 2,
  sessions: ['s1', 's2'],
  agents: ['codex'],
  totalOutputTokens: 100,
  totalToolCalls: 0,
  examples: [],
  memberRefs: [],
  lastSeen: '2026-07-15T10:00:00Z',
};

describe('questionKey', () => {
  it('is stable across word order and punctuation, distinct across questions', () => {
    expect(questionKey('how do we use just actually')).toBe(questionKey('actually — how do we use JUST?'));
    expect(questionKey('how do we use just')).not.toBe(questionKey('how do we deploy staging'));
  });
});

describe('buildFaqEntry / mergeFaq', () => {
  const entry = buildFaqEntry(cluster, 'Use `just <task>`; tasks live in the justfile.', 's1-full-id');

  it('caps oversized answers', () => {
    const big = buildFaqEntry(cluster, 'x'.repeat(3000), 's1');
    expect(big.answer.length).toBeLessThanOrEqual(1501);
    expect(big.answer.endsWith('…')).toBe(true);
  });

  it('creates a fresh file with header and marked entries', () => {
    const merged = mergeFaq(undefined, [entry]);
    expect(merged.content).toContain('# Dev FAQ');
    expect(merged.content).toContain(`<!-- asa-faq ${entry.key}`);
    expect(merged.content).toContain('## how do we use just actually');
    expect(merged.content).toContain('asked 2× across 2 sessions');
    expect(merged.added).toHaveLength(1);
  });

  it('never rewrites an existing (possibly human-edited) entry, appends only new ones', () => {
    const first = mergeFaq(undefined, [entry]).content;
    const humanEdited = first.replace('Use `just <task>`', 'HUMAN IMPROVED ANSWER');

    const other = buildFaqEntry(
      { ...cluster, representative: 'how do we deploy staging' },
      'Run the deploy task.',
      's3',
    );
    const merged = mergeFaq(humanEdited, [entry, other]);
    expect(merged.content).toContain('HUMAN IMPROVED ANSWER');
    expect(merged.content).not.toContain('Use `just <task>`');
    expect(merged.content).toContain('how do we deploy staging');
    expect(merged.added).toEqual(['how do we deploy staging']);
    expect(merged.kept).toBe(1);

    // fully covered → byte-identical, no churn
    const again = mergeFaq(merged.content, [entry, other]);
    expect(again.content).toBe(merged.content);
    expect(again.added).toHaveLength(0);
  });
});
