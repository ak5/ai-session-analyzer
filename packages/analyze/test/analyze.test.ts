import { describe, expect, it } from 'vitest';
import { emptyUsage, type NormalizedSession } from '@asa/core';
import { analyzeSession } from '../src/analyze.js';
import { renderReport } from '../src/render.js';

function fixtureSession(): NormalizedSession {
  return {
    agent: 'claude',
    id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    filePath: '/x/session.jsonl',
    cwd: '/tmp/proj',
    models: ['claude-fable-5'],
    compactions: 1,
    startedAt: '2026-07-17T10:00:00Z',
    endedAt: '2026-07-17T10:10:00Z',
    usage: { ...emptyUsage(), inputTokens: 120, outputTokens: 60, totalTokens: 180 },
    subagents: [{ id: 'agent1', agentType: 'Explore', totalTokens: 5000 }],
    steps: [
      {
        id: 'u1',
        index: 0,
        apiCalls: 2,
        promptPreview: 'first prompt',
        usage: emptyUsage(),
        toolCalls: [
          { id: 't1', name: 'Bash', isMcp: false },
          { id: 't2', name: 'Bash', isMcp: false, isError: true },
          { id: 't3', name: 'mcp__github__get_issue', isMcp: true, mcpServer: 'github' },
        ],
      },
    ],
  };
}

describe('analyzeSession', () => {
  const report = analyzeSession(fixtureSession());

  it('aggregates totals', () => {
    expect(report.totals).toMatchObject({
      steps: 1,
      apiCalls: 2,
      toolCalls: 3,
      mcpCalls: 1,
      toolErrors: 1,
      subagents: 1,
      durationMs: 600_000,
    });
  });

  it('ranks tool stats and mcp servers', () => {
    expect(report.toolStats[0]).toMatchObject({ name: 'Bash', count: 2, errors: 1 });
    expect(report.mcpServers).toEqual([{ server: 'github', calls: 1 }]);
  });

  it('renders without crashing and mentions the essentials', () => {
    const text = renderReport(report);
    expect(text).toContain('claude session');
    expect(text).toContain('Bash');
    expect(text).toContain('github');
    expect(text).toContain('u1');
  });
});
