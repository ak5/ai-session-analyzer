import { describe, expect, it } from 'vitest';
import { normalizeCodexLines } from '../src/parse.js';
import type { CodexLine } from '../src/records.js';

const SESSION_ID = '019f6fe1-5809-73f1-a4e3-478b31e04834';

function fixtureLines(): CodexLine[] {
  return [
    {
      timestamp: '2026-07-17T10:00:00Z',
      type: 'session_meta',
      payload: {
        id: SESSION_ID,
        cwd: '/tmp/proj',
        cli_version: '0.144.4',
        git: { branch: 'main' },
      },
    },
    {
      timestamp: '2026-07-17T10:00:01Z',
      type: 'turn_context',
      payload: { model: 'gpt-5.6-sol', effort: 'low' },
    },
    {
      timestamp: '2026-07-17T10:00:02Z',
      type: 'event_msg',
      payload: { type: 'user_message', message: 'do the thing' },
    },
    {
      timestamp: '2026-07-17T10:00:03Z',
      type: 'event_msg',
      payload: { type: 'task_started', turn_id: 'turn-abc' },
    },
    {
      timestamp: '2026-07-17T10:00:04Z',
      type: 'response_item',
      payload: {
        type: 'function_call',
        name: 'exec',
        call_id: 'call_1',
        arguments: '{"cmd":"ls"}',
      },
    },
    {
      timestamp: '2026-07-17T10:00:05Z',
      type: 'response_item',
      payload: { type: 'function_call_output', call_id: 'call_1', output: 'file.txt' },
    },
    {
      timestamp: '2026-07-17T10:00:06Z',
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          total_token_usage: {
            input_tokens: 100,
            cached_input_tokens: 40,
            output_tokens: 20,
            reasoning_output_tokens: 5,
            total_tokens: 120,
          },
        },
      },
    },
    {
      timestamp: '2026-07-17T10:00:07Z',
      type: 'event_msg',
      payload: { type: 'task_complete', turn_id: 'turn-abc', duration_ms: 4000 },
    },
    // turn 2, with an MCP tool call
    {
      timestamp: '2026-07-17T10:01:00Z',
      type: 'event_msg',
      payload: { type: 'user_message', message: 'now the other thing' },
    },
    {
      timestamp: '2026-07-17T10:01:01Z',
      type: 'event_msg',
      payload: { type: 'task_started', turn_id: 'turn-def' },
    },
    {
      timestamp: '2026-07-17T10:01:02Z',
      type: 'response_item',
      payload: { type: 'custom_tool_call', name: 'github__get_issue', call_id: 'call_2', input: '{}' },
    },
    {
      timestamp: '2026-07-17T10:01:03Z',
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          total_token_usage: {
            input_tokens: 300,
            cached_input_tokens: 140,
            output_tokens: 50,
            reasoning_output_tokens: 15,
            total_tokens: 350,
          },
        },
      },
    },
  ];
}

describe('normalizeCodexLines', () => {
  const session = normalizeCodexLines(fixtureLines(), `/x/rollout-2026-07-17T10-00-00-${SESSION_ID}.jsonl`);

  it('captures session metadata', () => {
    expect(session.id).toBe(SESSION_ID);
    expect(session.cwd).toBe('/tmp/proj');
    expect(session.gitBranch).toBe('main');
    expect(session.models).toEqual(['gpt-5.6-sol (low)']);
  });

  it('uses cumulative totals for session usage', () => {
    expect(session.usage.totalTokens).toBe(350);
    expect(session.usage.reasoningTokens).toBe(15);
  });

  it('computes per-step usage as diffs of cumulative totals', () => {
    expect(session.steps).toHaveLength(2);
    expect(session.steps[0]!.usage.totalTokens).toBe(120);
    expect(session.steps[1]!.usage.totalTokens).toBe(230);
    expect(session.steps[0]!.durationMs).toBe(4000);
  });

  it('links tool calls and classifies MCP tools', () => {
    const step1 = session.steps[0]!;
    expect(step1.toolCalls[0]!.name).toBe('exec');
    expect(step1.toolCalls[0]!.isMcp).toBe(false);
    expect(step1.toolCalls[0]!.outputPreview).toBe('file.txt');
    const step2 = session.steps[1]!;
    expect(step2.toolCalls[0]!.isMcp).toBe(true);
    expect(step2.toolCalls[0]!.mcpServer).toBe('github');
    expect(step2.promptPreview).toBe('now the other thing');
  });
});
