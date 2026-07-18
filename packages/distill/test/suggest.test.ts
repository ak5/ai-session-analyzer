import { describe, expect, it } from 'vitest';
import { ASA_INTERNAL_SENTINEL, type DistillStats } from '../src/stats.js';
import { buildSuggestPrompt, runSuggest, suggestInvocation, trimStatsForPayload } from '../src/suggest.js';

const stats: DistillStats = {
  scope: { sessions: 2, prompts: 4, perAgent: { claude: 2 }, cwds: ['/tmp/proj'] },
  procedures: Array.from({ length: 30 }, (_, i) => ({
    kind: 'directive' as const,
    representative: `procedure ${i}`,
    count: 2,
    sessions: ['a', 'b'],
    agents: ['claude'],
    totalOutputTokens: 10,
    totalToolCalls: 2,
    examples: [],
  })),
  questions: [],
  lessons: [],
  toolSequences: [],
  commandUsage: [],
};

describe('buildSuggestPrompt', () => {
  it('leads with the sentinel and embeds the trimmed stats JSON', () => {
    const prompt = buildSuggestPrompt(stats);
    expect(prompt.startsWith(ASA_INTERNAL_SENTINEL)).toBe(true);
    expect(prompt).toContain('Skills to extract');
    expect(prompt).toContain('"procedure 0"');
    expect(trimStatsForPayload(stats).procedures).toHaveLength(15);
  });

  it('uses a custom template when given', () => {
    expect(buildSuggestPrompt(stats, 'CUSTOM TEMPLATE')).toContain('CUSTOM TEMPLATE');
  });
});

describe('suggestInvocation', () => {
  it('maps backends to the right headless commands', () => {
    const claude = suggestInvocation('claude', 'p', 'haiku');
    expect(claude.command).toBe('claude');
    expect(claude.args).toContain('--no-session-persistence');
    expect(claude.args).toContain('haiku');
    const codex = suggestInvocation('codex', 'p');
    expect(codex.command).toBe('codex');
    expect(codex.args[0]).toBe('exec');
  });
});

describe('runSuggest', () => {
  it('passes the prompt to the runner and returns trimmed output', async () => {
    let seen: { command: string; args: string[] } | undefined;
    const output = await runSuggest(stats, {
      backend: 'codex',
      runner: async (command, args) => {
        seen = { command, args };
        return '  recommendations here\n';
      },
    });
    expect(output).toBe('recommendations here');
    expect(seen!.command).toBe('codex');
    expect(seen!.args.at(-1)).toContain(ASA_INTERNAL_SENTINEL);
  });
});
