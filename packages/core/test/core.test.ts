import { describe, expect, it } from 'vitest';
import { addUsage, emptyUsage, parseJsonl, previewText, shortId } from '../src/index.js';

describe('parseJsonl', () => {
  it('parses lines and skips blank/corrupt ones', () => {
    const text = '{"a":1}\n\nnot json\n{"b":2}\n{"truncated": \n';
    expect(parseJsonl(text)).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it('returns empty array for empty input', () => {
    expect(parseJsonl('')).toEqual([]);
  });
});

describe('previewText', () => {
  it('collapses whitespace and trims', () => {
    expect(previewText('  hello\n\t world  ')).toBe('hello world');
  });

  it('truncates with an ellipsis at the limit', () => {
    const long = 'x'.repeat(100);
    const preview = previewText(long, 10);
    expect(preview).toHaveLength(10);
    expect(preview.endsWith('…')).toBe(true);
  });
});

describe('usage helpers', () => {
  it('addUsage accumulates partial deltas', () => {
    const usage = emptyUsage();
    addUsage(usage, { inputTokens: 5, totalTokens: 5 });
    addUsage(usage, { outputTokens: 3, reasoningTokens: 2, totalTokens: 5 });
    expect(usage).toMatchObject({ inputTokens: 5, outputTokens: 3, reasoningTokens: 2, totalTokens: 10 });
  });
});

describe('shortId', () => {
  it('keeps the first 8 chars', () => {
    expect(shortId('019f6fe1-5809-73f1-a4e3-478b31e04834')).toBe('019f6fe1');
  });
});
