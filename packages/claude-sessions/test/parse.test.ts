import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseJsonl } from '@asa/core';
import { forkClaudeSessionAtStep } from '../src/fork.js';
import { normalizeClaudeRecords } from '../src/parse.js';
import type { ClaudeRecord } from '../src/records.js';

const SESSION_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

function fixtureRecords(): ClaudeRecord[] {
  const base = {
    sessionId: SESSION_ID,
    cwd: '/tmp/proj',
    gitBranch: 'main',
    version: '2.1.212',
  };
  return [
    // step 1: prompt → assistant response split into 2 records (same message
    // id, duplicated usage) with a tool call → tool result
    {
      ...base,
      type: 'user',
      uuid: 'u1',
      timestamp: '2026-07-17T10:00:00Z',
      message: { role: 'user', content: 'first prompt' },
    },
    {
      ...base,
      type: 'assistant',
      uuid: 'a1',
      requestId: 'req_1',
      timestamp: '2026-07-17T10:00:05Z',
      message: {
        id: 'msg_1',
        role: 'assistant',
        model: 'claude-fable-5',
        content: [{ type: 'text', text: 'thinking about it' }],
        usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 1000 },
      },
    },
    {
      ...base,
      type: 'assistant',
      uuid: 'a2',
      requestId: 'req_1',
      timestamp: '2026-07-17T10:00:06Z',
      message: {
        id: 'msg_1',
        role: 'assistant',
        model: 'claude-fable-5',
        content: [
          { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls' } },
          { type: 'tool_use', id: 'toolu_2', name: 'mcp__github__get_issue', input: {} },
        ],
        // identical usage repeated on every record of the same API response
        usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 1000 },
      },
    },
    {
      ...base,
      type: 'user',
      uuid: 'u2',
      timestamp: '2026-07-17T10:00:07Z',
      message: {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'toolu_1', content: 'file.txt', is_error: false },
        ],
      },
    },
    // step 2
    {
      ...base,
      type: 'user',
      uuid: 'u3',
      timestamp: '2026-07-17T10:05:00Z',
      message: { role: 'user', content: 'second prompt' },
    },
    {
      ...base,
      type: 'assistant',
      uuid: 'a3',
      requestId: 'req_2',
      timestamp: '2026-07-17T10:05:10Z',
      message: {
        id: 'msg_2',
        role: 'assistant',
        model: 'claude-fable-5',
        content: [{ type: 'text', text: 'done' }],
        usage: { input_tokens: 20, output_tokens: 10 },
      },
    },
    { type: 'last-prompt', lastPrompt: 'second prompt', leafUuid: 'a3', sessionId: SESSION_ID },
  ];
}

describe('normalizeClaudeRecords', () => {
  const session = normalizeClaudeRecords(fixtureRecords(), `/x/${SESSION_ID}.jsonl`);

  it('splits steps on real prompts only', () => {
    expect(session.steps.map((s) => s.id)).toEqual(['u1', 'u3']);
    expect(session.steps[0]!.promptPreview).toBe('first prompt');
  });

  it('dedupes usage across split assistant records', () => {
    // msg_1 usage must be counted once despite appearing on two records
    expect(session.usage.inputTokens).toBe(120);
    expect(session.usage.outputTokens).toBe(60);
    expect(session.usage.cacheReadTokens).toBe(1000);
    expect(session.steps[0]!.apiCalls).toBe(1);
  });

  it('links tool calls to results', () => {
    const [bash, mcp] = session.steps[0]!.toolCalls;
    expect(bash!.name).toBe('Bash');
    expect(bash!.outputPreview).toBe('file.txt');
    expect(bash!.isError).toBe(false);
    expect(mcp!.isMcp).toBe(true);
    expect(mcp!.mcpServer).toBe('github');
  });

  it('captures session metadata', () => {
    expect(session.id).toBe(SESSION_ID);
    expect(session.cwd).toBe('/tmp/proj');
    expect(session.models).toEqual(['claude-fable-5']);
  });
});

describe('forkClaudeSessionAtStep', () => {
  it('truncates after the chosen step under a new session id', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'asa-test-'));
    const filePath = join(dir, `${SESSION_ID}.jsonl`);
    await writeFile(filePath, fixtureRecords().map((r) => JSON.stringify(r)).join('\n'));

    const fork = await forkClaudeSessionAtStep(filePath, 'u1');
    const records = parseJsonl<ClaudeRecord>(await readFile(fork.newFilePath, 'utf8'));

    // keeps step 1 (u1..u2), cuts before prompt u3, drops last-prompt
    expect(records.map((r) => r.uuid)).toEqual(['u1', 'a1', 'a2', 'u2']);
    expect(records.every((r) => r.sessionId === fork.newSessionId)).toBe(true);
    expect(fork.newFilePath).toBe(join(dir, `${fork.newSessionId}.jsonl`));
    expect(fork.droppedRecords).toBe(3);
  });
});
