import { describe, expect, it } from 'vitest';
import { extractPromptFeatures, type StepSignal } from '@asa/prompter';
import { clusterPrompts, jaccard, tokenize } from '../src/cluster.js';

let n = 0;

function signal(text: string, sessionId: string, timestamp?: string): StepSignal {
  n += 1;
  return {
    agent: 'claude',
    sessionId,
    stepId: `s${n}`,
    index: 0,
    kind: 'prompt',
    promptPreview: text.slice(0, 90),
    promptExcerpt: text.slice(0, 600),
    features: extractPromptFeatures(text),
    outputTokens: 10,
    toolCalls: 1,
    apiCalls: 1,
    aborted: false,
    correctedByNext: false,
    timestamp,
  };
}

describe('tokenize / jaccard', () => {
  it('strips stopwords and short tokens', () => {
    const tokens = tokenize('run the deploy script for the staging server');
    expect(tokens.has('the')).toBe(false);
    expect(tokens.has('deploy')).toBe(true);
  });

  it('jaccard is 1 for identical sets, 0 for disjoint', () => {
    const a = tokenize('deploy staging server');
    expect(jaccard(a, a)).toBe(1);
    expect(jaccard(a, tokenize('write unit tests'))).toBe(0);
  });
});

describe('clusterPrompts', () => {
  it('clusters similar prompts across sessions, splits by kind', () => {
    const clusters = clusterPrompts([
      signal('deploy the staging server and run the smoke tests', 'sess1', '2026-07-01T10:00:00Z'),
      signal('deploy staging server, run smoke tests please', 'sess2', '2026-07-08T10:00:00Z'),
      signal('how does the deploy pipeline work?', 'sess1'),
      signal('how does the deploy pipeline actually work?', 'sess3'),
      signal('write a haiku about databases', 'sess1'),
    ]);
    const procedure = clusters.find((c) => c.kind === 'directive');
    expect(procedure).toBeTruthy();
    expect(procedure!.count).toBe(2);
    expect(procedure!.sessions.sort()).toEqual(['sess1', 'sess2']);
    expect(procedure!.firstSeen).toBe('2026-07-01T10:00:00Z');
    const question = clusters.find((c) => c.kind === 'question');
    expect(question!.count).toBe(2);
    // the haiku one-off must not appear
    expect(clusters.some((c) => c.representative.includes('haiku'))).toBe(false);
  });

  it('ignores same-session repetition and tiny prompts', () => {
    const clusters = clusterPrompts([
      signal('rebuild the project and rerun the tests', 'sess1'),
      signal('rebuild the project and rerun the tests', 'sess1'),
      signal('ok', 'sess1'),
      signal('ok', 'sess2'),
    ]);
    expect(clusters).toHaveLength(0);
  });
});
