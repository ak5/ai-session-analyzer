import { describe, expect, it } from 'vitest';
import { emptyContentVolume,
  emptyInteractionCounts, emptyUsage, type NormalizedSession } from '@asa/core';
import { analyzePrompter } from '../src/stats.js';
import { renderPrompterReport } from '../src/render.js';

const session: NormalizedSession = {
  agent: 'claude',
  id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  filePath: '/x/s.jsonl',
  models: [],
  compactions: 0,
  usage: emptyUsage(),
  subagents: [],
  interactions: emptyInteractionCounts(),
    contentVolume: emptyContentVolume(),
  steps: [
    {
      id: 'u1',
      index: 0,
      kind: 'prompt',
      timestamp: '2026-07-17T10:00:00Z',
      promptText: 'fix packages/core/src/index.ts',
      promptPreview: 'fix packages/core/src/index.ts',
      apiCalls: 1,
      toolCalls: [],
      usage: { ...emptyUsage(), outputTokens: 50, totalTokens: 50 },
    },
  ],
};

describe('renderPrompterReport', () => {
  it('renders headline, archetype, lint and session table', () => {
    const text = renderPrompterReport(analyzePrompter([session]));
    expect(text).toContain('Prompter report — 1 prompts, 1 sessions');
    expect(text).toContain('Archetype:');
    expect(text).toContain('Lint:');
    expect(text).toContain('aaaaaaaa');
  });

  it('includes the judge section when provided', () => {
    const text = renderPrompterReport(analyzePrompter([session]), {
      model: 'haiku',
      samples: 2,
      avgClarity: 4.5,
      avgContext: 3,
      grades: [{ id: 'p1', clarity: 4, context: 3, tip: 'name the file' }],
    });
    expect(text).toContain('LLM judge (haiku, 2 sampled prompts)');
    expect(text).toContain('clarity 4.5/5');
    expect(text).toContain('name the file');
  });
});
