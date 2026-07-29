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
  it('escapes content, promotes headings, and badges lint lines', async () => {
    const { renderHtmlReport } = await import('../src/index.js');
    const html = renderHtmlReport({
      title: 'x <script>',
      command: 'analyze',
      body: 'Lint:\n  [warn] vague-filler: too <vague>\n  [info] night-owl: late',
      generatedAt: '2026-07-19T00:00:00Z',
    });
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>');
    expect(html).toContain('<h2>Lint</h2>');
    expect(html).toContain('class="badge warn"');
    expect(html).toContain('class="badge info"');
    expect(html).toContain('too &lt;vague&gt;');
  });

  it('parses column-aligned tables into semantic tables with numeric alignment', async () => {
    const { parseReportBlocks } = await import('../src/index.js');
    const body = [
      'Tools:',
      'tool name   calls  errors',
      '----------  -----  ------',
      'Bash fancy  1,402  16',
      'Edit        165    0',
      '',
      'plain trailing text',
    ].join('\n');
    const blocks = parseReportBlocks(body);
    expect(blocks.map((b) => b.kind)).toEqual(['heading', 'table', 'lines']);
    const table = blocks[1] as Extract<(typeof blocks)[number], { kind: 'table' }>;
    expect(table.header).toEqual(['tool name', 'calls', 'errors']);
    // cells containing spaces survive because columns come from the dash rule
    expect(table.rows[0]).toEqual(['Bash fancy', '1,402', '16']);
    expect(table.numeric).toEqual([false, true, true]);
  });
});

describe('shortId', () => {
  it('keeps the first 8 chars', () => {
    expect(shortId('019f6fe1-5809-73f1-a4e3-478b31e04834')).toBe('019f6fe1');
  });
});

describe('buildContextDigest hint', () => {
  it('states the hint and weights matching steps 4x, non-matching half', async () => {
    const { buildContextDigest, emptyContentVolume, emptyInteractionCounts, emptyUsage } =
      await import('../src/index.js');
    const step = (i: number, prompt: string) => ({
      id: `s${i}`,
      index: i,
      kind: 'prompt' as const,
      promptText: prompt,
      apiCalls: 1,
      toolCalls: [],
      usage: emptyUsage(),
    });
    const session = {
      agent: 'claude' as const,
      id: 'x',
      filePath: '/x.jsonl',
      models: [],
      compactions: 0,
      usage: emptyUsage(),
      subagents: [],
      interactions: emptyInteractionCounts(),
      contentVolume: emptyContentVolume(),
      steps: [step(0, 'set up the database schema'), step(1, 'tweak the css colors')],
    };
    const longResponse = 'r'.repeat(1000);
    const digest = await buildContextDigest(session, async () => longResponse, {
      maxResponseChars: 100,
      hint: 'database migrations',
    });
    expect(digest).toContain("Focus for this continuation (per the fork's hint): database migrations");
    const lines = digest.split('\n');
    const dbLine = lines.find((l) => l.startsWith('1. r'))!;
    const cssLine = lines.find((l) => l.startsWith('2. r'))!;
    expect(dbLine.length).toBeGreaterThan(390); // 4× budget
    expect(cssLine.length).toBeLessThan(60); // half budget
  });
});

describe('pricing', () => {
  it('resolves models by longest prefix after stripping dates and effort suffixes', async () => {
    const { BUILTIN_PRICING, resolveModelRates } = await import('../src/pricing.js');
    expect(resolveModelRates('claude-haiku-4-5-20251001', BUILTIN_PRICING)?.output).toBe(5);
    expect(resolveModelRates('gpt-5.1-codex (high)', BUILTIN_PRICING)?.input).toBe(1.25);
    // gpt-5.1 must not swallow gpt-5.1-codex's slot, and vice versa
    expect(resolveModelRates('gpt-5.1', BUILTIN_PRICING)).toBe(BUILTIN_PRICING['gpt-5.1']);
    expect(resolveModelRates('claude-fable-5', BUILTIN_PRICING)).toBeUndefined();
    // unknown minor versions must not be priced by a shorter prefix
    expect(resolveModelRates('gpt-5.6-sol (low)', BUILTIN_PRICING)).toBeUndefined();
  });

  it('prices a claude session: input excludes cache, write billed separately', async () => {
    const { estimateSessionCost } = await import('../src/pricing.js');
    const cost = estimateSessionCost({
      agent: 'claude',
      models: ['claude-haiku-4-5'],
      modelUsage: { 'claude-haiku-4-5': { apiCalls: 2, outputTokens: 1_000_000 } },
      usage: {
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
        cacheReadTokens: 10_000_000,
        cacheCreationTokens: 1_000_000,
        reasoningTokens: 0,
        totalTokens: 13_000_000,
      },
    })!;
    // 1M in @$1 + 1M out @$5 + 10M cache-read @$0.10 + 1M cache-write @$1.25
    expect(cost.usd).toBeCloseTo(1 + 5 + 1 + 1.25, 5);
    expect(cost.pricedModels).toEqual(['claude-haiku-4-5']);
  });

  it('prices a codex session: cached subset comes out of inputTokens', async () => {
    const { estimateSessionCost } = await import('../src/pricing.js');
    const cost = estimateSessionCost({
      agent: 'codex',
      models: ['gpt-5.1-codex'],
      modelUsage: { 'gpt-5.1-codex (medium)': { apiCalls: 1, outputTokens: 1_000_000 } },
      usage: {
        inputTokens: 5_000_000,
        outputTokens: 1_000_000,
        cacheReadTokens: 4_000_000,
        cacheCreationTokens: 0,
        reasoningTokens: 0,
        totalTokens: 6_000_000,
      },
    })!;
    // 1M uncached in @$1.25 + 1M out @$10 + 4M cached @$0.125
    expect(cost.usd).toBeCloseTo(1.25 + 10 + 0.5, 5);
  });

  it('splits multi-model sessions by output share and names unpriced models', async () => {
    const { estimateSessionCost } = await import('../src/pricing.js');
    const cost = estimateSessionCost({
      agent: 'claude',
      models: ['claude-haiku-4-5', 'claude-fable-5'],
      modelUsage: {
        'claude-haiku-4-5': { apiCalls: 1, outputTokens: 1_000_000 },
        'claude-fable-5': { apiCalls: 1, outputTokens: 3_000_000 },
      },
      usage: {
        inputTokens: 4_000_000,
        outputTokens: 4_000_000,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        reasoningTokens: 0,
        totalTokens: 8_000_000,
      },
    })!;
    // haiku gets 25% of input (1M @$1) + its own 1M out @$5; fable-5 unpriced
    expect(cost.usd).toBeCloseTo(1 + 5, 5);
    expect(cost.unpricedModels).toEqual(['claude-fable-5']);
  });

  it('merges a user override file over the builtin table', async () => {
    const { mkdtemp, writeFile } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { loadPricing, resolveModelRates } = await import('../src/pricing.js');
    const dir = await mkdtemp(join(tmpdir(), 'asa-pricing-'));
    const overridePath = join(dir, 'pricing.json');
    await writeFile(overridePath, JSON.stringify({ 'claude-fable-5': { input: 20, output: 100 } }));
    const table = loadPricing(overridePath);
    expect(resolveModelRates('claude-fable-5', table)?.output).toBe(100);
    expect(resolveModelRates('claude-haiku-4-5', table)?.output).toBe(5); // builtin survives
    expect(loadPricing(join(dir, 'missing.json'))).toEqual(
      (await import('../src/pricing.js')).BUILTIN_PRICING,
    );
  });

  it('formatUsd keeps sub-cent costs meaningful', async () => {
    const { formatUsd } = await import('../src/pricing.js');
    expect(formatUsd(0)).toBe('$0');
    expect(formatUsd(0.0042)).toBe('$0.0042');
    expect(formatUsd(12.345)).toBe('$12.35');
  });
});
