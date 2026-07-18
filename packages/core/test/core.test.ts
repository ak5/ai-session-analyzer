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

describe('readFirstJsonlObjects', () => {
  it('handles header lines larger than one read chunk', async () => {
    const { mkdtemp, writeFile } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = await mkdtemp(join(tmpdir(), 'asa-core-'));
    const filePath = join(dir, 'big-header.jsonl');
    // first line ~200KB — bigger than the 64KB chunk size
    const big = { type: 'session_meta', payload: { cwd: '/tmp/proj', blob: 'x'.repeat(200_000) } };
    await writeFile(filePath, `${JSON.stringify(big)}\n${JSON.stringify({ type: 'other' })}\n`);
    const { readFirstJsonlObjects } = await import('../src/index.js');
    const records = (await readFirstJsonlObjects(filePath, 2)) as Array<{ type: string }>;
    expect(records).toHaveLength(2);
    expect(records[0]!.type).toBe('session_meta');
  });

  it('reads files without trailing newline to EOF', async () => {
    const { mkdtemp, writeFile } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = await mkdtemp(join(tmpdir(), 'asa-core-'));
    const filePath = join(dir, 'no-trailing.jsonl');
    await writeFile(filePath, '{"a":1}\n{"b":2}');
    const { readFirstJsonlObjects } = await import('../src/index.js');
    expect(await readFirstJsonlObjects(filePath, 5)).toEqual([{ a: 1 }, { b: 2 }]);
  });
});

describe('renderHtmlReport', () => {
  it('escapes content and highlights lint lines', async () => {
    const { renderHtmlReport } = await import('../src/index.js');
    const html = renderHtmlReport({
      title: 'x <script>',
      command: 'analyze',
      body: 'Lint:\n  [warn] vague-filler: too <vague>\n  [info] night-owl: late',
      generatedAt: '2026-07-19T00:00:00Z',
    });
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>');
    expect(html).toContain('<span class="warn">');
    expect(html).toContain('<span class="info">');
    expect(html).toContain('too &lt;vague&gt;');
  });
});

describe('shortId', () => {
  it('keeps the first 8 chars', () => {
    expect(shortId('019f6fe1-5809-73f1-a4e3-478b31e04834')).toBe('019f6fe1');
  });
});
