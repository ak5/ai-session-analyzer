import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { normalizeCodexLines, readCodexSessionCwd } from '../src/parse.js';
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

  it('marks turns without task_complete as aborted and counts the interruption', () => {
    // fixture turn 2 has no task_complete → aborted; turn 1 completed
    expect(session.steps[0]!.aborted).toBeUndefined();
    expect(session.steps[1]!.aborted).toBe(true);
    expect(session.interactions.interruptions).toBe(1);
  });

  it('stores full prompt text on steps', () => {
    expect(session.steps[1]!.promptText).toBe('now the other thing');
  });

  it('reads cwd from session_meta without loading the transcript', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'asa-codex-test-'));
    const filePath = join(dir, `rollout-2026-07-17T10-00-00-${SESSION_ID}.jsonl`);
    await writeFile(filePath, fixtureLines().map((l) => JSON.stringify(l)).join('\n'));
    expect(await readCodexSessionCwd(filePath)).toBe('/tmp/proj');
  });

  it('treats $-prefixed messages as command steps, not prompts', () => {
    const lines = fixtureLines();
    lines.push(
      { timestamp: '2026-07-17T10:02:00Z', type: 'event_msg',
        payload: { type: 'user_message', message: '$session-closeout wrap it up' } },
      { timestamp: '2026-07-17T10:02:01Z', type: 'event_msg',
        payload: { type: 'task_started', turn_id: 'turn-cmd' } },
    );
    const s = normalizeCodexLines(lines, `/x/rollout-2026-07-17T10-00-00-${SESSION_ID}.jsonl`);
    const commandStep = s.steps.at(-1)!;
    expect(commandStep.kind).toBe('command');
    expect(commandStep.commandName).toBe('$session-closeout');
    expect(commandStep.promptText).toBe('wrap it up');
    expect(s.interactions.commands).toBe(1);
  });

  it('does not leak a consumed user message into the next turn', () => {
    const lines = fixtureLines();
    lines.push({ timestamp: '2026-07-17T10:02:00Z', type: 'event_msg',
      payload: { type: 'task_started', turn_id: 'turn-3' } });
    const s = normalizeCodexLines(lines, `/x/rollout-2026-07-17T10-00-00-${SESSION_ID}.jsonl`);
    expect(s.steps.at(-1)!.promptText).toBeUndefined();
  });

  it('marks subagent rollouts', () => {
    const lines = fixtureLines();
    lines[0]!.payload!.thread_source = 'subagent';
    const sub = normalizeCodexLines(lines, `/x/rollout-2026-07-17T10-00-00-${SESSION_ID}.jsonl`);
    expect(sub.isSubagent).toBe(true);
    expect(session.isSubagent).toBeUndefined();
  });

  it('tracks fork lineage and compactions', () => {
    const lines = fixtureLines();
    lines[0]!.payload!.forked_from_id = '019f0000-dead-7000-8000-000000000099';
    lines.push({ timestamp: '2026-07-17T10:02:00Z', type: 'compacted', payload: { window_number: 1 } });
    const forked = normalizeCodexLines(lines, `/x/rollout-2026-07-17T10-00-00-${SESSION_ID}.jsonl`);
    expect(forked.forkedFromId).toBe('019f0000-dead-7000-8000-000000000099');
    expect(forked.compactions).toBe(1);
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
