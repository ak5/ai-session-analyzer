import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseJsonl } from '@asa/core';
import { forkClaudeSessionAtStep } from '../src/fork.js';
import { normalizeClaudeRecords, readClaudeSessionCwd, readClaudeStepResponse } from '../src/parse.js';
import { annotateStepsWithGitTrace } from '../src/trace.js';
import { parseClaudeUsageOutput } from '../src/usage.js';
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

  it('attributes api calls and output tokens per model, deduped', () => {
    expect(session.modelUsage).toEqual({
      'claude-fable-5': { apiCalls: 2, outputTokens: 60 },
    });
  });
});

describe('normalizeClaudeRecords — human signals', () => {
  it('counts interruptions without creating steps, and marks the aborted step', () => {
    const records = fixtureRecords();
    records.splice(4, 0, {
      sessionId: SESSION_ID,
      type: 'user',
      uuid: 'int1',
      timestamp: '2026-07-17T10:00:08Z',
      message: { role: 'user', content: '[Request interrupted by user for tool use]' },
    });
    const session = normalizeClaudeRecords(records, `/x/${SESSION_ID}.jsonl`);
    expect(session.interactions.interruptions).toBe(1);
    expect(session.steps.map((s) => s.id)).toEqual(['u1', 'u3']);
    expect(session.steps[0]!.aborted).toBe(true);
    expect(session.steps[1]!.aborted).toBeUndefined();
  });

  it('turns slash-command invocations into command steps', () => {
    const records = fixtureRecords();
    records.push(
      {
        sessionId: SESSION_ID,
        type: 'user',
        uuid: 'cmd1',
        timestamp: '2026-07-17T10:06:00Z',
        message: {
          role: 'user',
          content:
            '<command-message>goal</command-message>\n<command-name>/goal</command-name>\n<command-args>ship the rc</command-args>',
        },
      },
      {
        sessionId: SESSION_ID,
        type: 'user',
        uuid: 'cmdout1',
        message: { role: 'user', content: '<local-command-stdout>Goal set</local-command-stdout>' },
      },
    );
    const session = normalizeClaudeRecords(records, `/x/${SESSION_ID}.jsonl`);
    const command = session.steps.at(-1)!;
    expect(command.kind).toBe('command');
    expect(command.commandName).toBe('/goal');
    expect(command.promptText).toBe('ship the rc');
    expect(session.interactions.commands).toBe(1);
    // the stdout echo must not have become a step
    expect(session.steps.map((s) => s.id)).toEqual(['u1', 'u3', 'cmd1']);
  });

  it('counts permission-mode, queue and pr-link events', () => {
    const records = fixtureRecords();
    records.push(
      { type: 'permission-mode', mode: 'acceptEdits', sessionId: SESSION_ID },
      { type: 'queue-operation', operation: 'enqueue', content: 'next', sessionId: SESSION_ID },
      { type: 'queue-operation', operation: 'remove', sessionId: SESSION_ID },
      { type: 'pr-link', prNumber: 1, sessionId: SESSION_ID },
    );
    const session = normalizeClaudeRecords(records, `/x/${SESSION_ID}.jsonl`);
    expect(session.interactions).toMatchObject({
      permissionModeChanges: 1,
      queuedPrompts: 1,
      prLinks: 1,
    });
  });

  it('stores full prompt text on steps', () => {
    const session = normalizeClaudeRecords(fixtureRecords(), `/x/${SESSION_ID}.jsonl`);
    expect(session.steps[0]!.promptText).toBe('first prompt');
    expect(session.steps[0]!.kind).toBe('prompt');
  });

  it('ignores harness-injected notification records', () => {
    const records = fixtureRecords();
    records.push({
      sessionId: SESSION_ID,
      type: 'user',
      uuid: 'notif1',
      message: {
        role: 'user',
        content: '<task-notification>Background task abc completed.</task-notification>',
      },
    });
    const session = normalizeClaudeRecords(records, `/x/${SESSION_ID}.jsonl`);
    expect(session.steps.map((s) => s.id)).toEqual(['u1', 'u3']);
  });
});

describe('normalizeClaudeRecords — compaction and subagents', () => {
  it('counts compact summaries without treating them as steps', () => {
    const records = fixtureRecords();
    records.push({
      sessionId: SESSION_ID,
      type: 'user',
      uuid: 'compact1',
      isCompactSummary: true,
      compactMetadata: { trigger: 'auto', preTokens: 150000 },
      message: { role: 'user', content: 'This session is being continued from…' },
    });
    const session = normalizeClaudeRecords(records, `/x/${SESSION_ID}.jsonl`);
    expect(session.compactions).toBe(1);
    expect(session.compactionEvents).toEqual([
      { trigger: 'auto', preTokens: 150000, timestamp: undefined },
    ]);
    expect(session.steps.map((s) => s.id)).toEqual(['u1', 'u3']);
  });

  it('collects subagent info from toolUseResult', () => {
    const records = fixtureRecords();
    records.push({
      sessionId: SESSION_ID,
      type: 'user',
      uuid: 'u4',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'toolu_agent', content: 'done' }],
      },
      toolUseResult: {
        agentId: 'a1b2c3',
        agentType: 'Explore',
        totalTokens: 55300,
        totalToolUseCount: 21,
        totalDurationMs: 806000,
      },
    });
    const session = normalizeClaudeRecords(records, `/x/${SESSION_ID}.jsonl`);
    expect(session.subagents).toEqual([
      { id: 'a1b2c3', agentType: 'Explore', totalTokens: 55300, toolUseCount: 21, durationMs: 806000 },
    ]);
  });

  it('captures the ai-title', () => {
    const records = fixtureRecords();
    records.push({ type: 'ai-title', aiTitle: 'My session', sessionId: SESSION_ID });
    expect(normalizeClaudeRecords(records, `/x/${SESSION_ID}.jsonl`).title).toBe('My session');
  });
});

describe('annotateStepsWithGitTrace', () => {
  it('joins nearest UserPromptSubmit events onto steps within the window', () => {
    const session = normalizeClaudeRecords(fixtureRecords(), `/x/${SESSION_ID}.jsonl`);
    annotateStepsWithGitTrace(session, [
      { ts: '2026-07-17T10:00:01Z', event: 'UserPromptSubmit', session_id: SESSION_ID, head: 'a'.repeat(40), dirty_files: 2 },
      { ts: '2026-07-17T10:05:00Z', event: 'UserPromptSubmit', session_id: SESSION_ID, head: 'b'.repeat(40), dirty_files: 0 },
      { ts: '2026-07-17T10:05:00Z', event: 'Stop', session_id: SESSION_ID, head: 'c'.repeat(40) },
      { ts: '2026-07-17T10:05:00Z', event: 'UserPromptSubmit', session_id: 'other-session', head: 'd'.repeat(40) },
    ]);
    expect(session.steps[0]!.gitHead).toBe('a'.repeat(40));
    expect(session.steps[0]!.gitDirtyFiles).toBe(2);
    expect(session.steps[1]!.gitHead).toBe('b'.repeat(40));
  });

  it('leaves steps unannotated when no event is close enough', () => {
    const session = normalizeClaudeRecords(fixtureRecords(), `/x/${SESSION_ID}.jsonl`);
    annotateStepsWithGitTrace(session, [
      { ts: '2026-07-17T11:00:00Z', event: 'UserPromptSubmit', session_id: SESSION_ID, head: 'a'.repeat(40) },
    ]);
    expect(session.steps.every((s) => s.gitHead === undefined)).toBe(true);
  });
});

describe('parseClaudeUsageOutput', () => {
  it('extracts session/week/model percentages from the /usage panel', () => {
    const quota = parseClaudeUsageOutput(
      'You are currently using your subscription\n\n' +
        'Current session: 19% used · resets Jul 18 at 11:39pm\n' +
        'Current week (all models): 20% used · resets Jul 18\n' +
        'Current week (Fable): 33% used · resets Jul 18\n',
    )!;
    expect(quota.sessionUsedPercent).toBe(19);
    expect(quota.weekUsedPercent).toBe(20);
    expect(quota.weekModelUsedPercent).toBe(33);
    expect(quota.weekModelName).toBe('Fable');
  });

  it('returns undefined for unrecognizable output', () => {
    expect(parseClaudeUsageOutput('Not logged in')).toBeUndefined();
  });
});

describe('readClaudeStepResponse', () => {
  it('collects assistant text for a step, stopping at the next prompt', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'asa-resp-'));
    const filePath = join(dir, `${SESSION_ID}.jsonl`);
    await writeFile(filePath, fixtureRecords().map((r) => JSON.stringify(r)).join('\n'));
    expect(await readClaudeStepResponse(filePath, 'u1')).toBe('thinking about it');
    expect(await readClaudeStepResponse(filePath, 'u3')).toBe('done');
    expect(await readClaudeStepResponse(filePath, 'nope')).toBeUndefined();
  });
});

describe('readClaudeSessionCwd', () => {
  it('reads cwd from the header without needing the whole file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'asa-test-'));
    const filePath = join(dir, `${SESSION_ID}.jsonl`);
    await writeFile(filePath, fixtureRecords().map((r) => JSON.stringify(r)).join('\n'));
    expect(await readClaudeSessionCwd(filePath)).toBe('/tmp/proj');
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

  it('forking at the last step keeps everything except bookkeeping records', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'asa-test-'));
    const filePath = join(dir, `${SESSION_ID}.jsonl`);
    await writeFile(filePath, fixtureRecords().map((r) => JSON.stringify(r)).join('\n'));

    const fork = await forkClaudeSessionAtStep(filePath, 'u3');
    const records = parseJsonl<ClaudeRecord>(await readFile(fork.newFilePath, 'utf8'));
    expect(records.map((r) => r.uuid)).toEqual(['u1', 'a1', 'a2', 'u2', 'u3', 'a3']);
    expect(fork.droppedRecords).toBe(0);
  });

  it('throws for an unknown step uuid', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'asa-test-'));
    const filePath = join(dir, `${SESSION_ID}.jsonl`);
    await writeFile(filePath, fixtureRecords().map((r) => JSON.stringify(r)).join('\n'));
    await expect(forkClaudeSessionAtStep(filePath, 'nope')).rejects.toThrow(/No record with uuid/);
  });

  it('copies subagent transcripts and tool-results into the fork, rewriting sessionId', async () => {
    const { mkdir } = await import('node:fs/promises');
    const dir = await mkdtemp(join(tmpdir(), 'asa-test-'));
    const filePath = join(dir, `${SESSION_ID}.jsonl`);
    await writeFile(filePath, fixtureRecords().map((r) => JSON.stringify(r)).join('\n'));
    await mkdir(join(dir, SESSION_ID, 'subagents'), { recursive: true });
    await mkdir(join(dir, SESSION_ID, 'tool-results'), { recursive: true });
    await writeFile(
      join(dir, SESSION_ID, 'subagents', 'agent-abc123.jsonl'),
      JSON.stringify({ uuid: 's1', sessionId: SESSION_ID, agentId: 'abc123', type: 'user' }) + '\n',
    );
    await writeFile(
      join(dir, SESSION_ID, 'subagents', 'agent-abc123.meta.json'),
      JSON.stringify({ agentType: 'Explore', toolUseId: 'toolu_1' }),
    );
    await writeFile(join(dir, SESSION_ID, 'tool-results', 'toolu_1.txt'), 'big output');

    const fork = await forkClaudeSessionAtStep(filePath, 'u1');
    expect(fork.copiedSubagents).toBe(1);
    const sub = parseJsonl<ClaudeRecord>(
      await readFile(join(dir, fork.newSessionId, 'subagents', 'agent-abc123.jsonl'), 'utf8'),
    );
    expect(sub[0]!.sessionId).toBe(fork.newSessionId);
    expect(
      JSON.parse(
        await readFile(join(dir, fork.newSessionId, 'subagents', 'agent-abc123.meta.json'), 'utf8'),
      ).agentType,
    ).toBe('Explore');
    expect(await readFile(join(dir, fork.newSessionId, 'tool-results', 'toolu_1.txt'), 'utf8')).toBe(
      'big output',
    );
  });

  it('reports zero copied subagents when the session has no sidecar dir', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'asa-test-'));
    const filePath = join(dir, `${SESSION_ID}.jsonl`);
    await writeFile(filePath, fixtureRecords().map((r) => JSON.stringify(r)).join('\n'));
    const fork = await forkClaudeSessionAtStep(filePath, 'u1');
    expect(fork.copiedSubagents).toBe(0);
  });
});

describe('craftClaudeContextFork', () => {
  it('writes compact_boundary + digest summary + verbatim re-rooted tail', async () => {
    const { craftClaudeContextFork } = await import('../src/context-fork.js');
    const dir = await mkdtemp(join(tmpdir(), 'asa-ctx-'));
    const filePath = join(dir, `${SESSION_ID}.jsonl`);
    await writeFile(filePath, fixtureRecords().map((r) => JSON.stringify(r)).join('\n'));

    const fork = await craftClaudeContextFork(filePath, { keepLastSteps: 1 });
    expect(fork.digestedSteps).toBe(1);
    expect(fork.keptSteps).toBe(1);

    const records = parseJsonl<ClaudeRecord>(await readFile(fork.newFilePath, 'utf8'));
    // shape mimics native post-compaction transcripts
    expect(records[0]).toMatchObject({
      type: 'system',
      subtype: 'compact_boundary',
      compactMetadata: { trigger: 'manual' },
    });
    const summary = records[1]!;
    expect(summary.isCompactSummary).toBe(true);
    const digest = summary.message!.content as string;
    expect(digest).toContain('first prompt'); // verbatim, not paraphrased
    expect(digest).toContain('thinking about it'); // step conclusion
    expect(digest).not.toContain('second prompt'); // kept verbatim instead
    // tail: step 2's records, re-rooted onto the summary record
    expect(records[2]).toMatchObject({ uuid: 'u3', parentUuid: summary.uuid });
    expect(records.every((r) => r.sessionId === fork.newSessionId)).toBe(true);
    expect(records.some((r) => r.type === 'last-prompt')).toBe(false);
    // the fork parses as a session whose remaining step is the kept one
    const forked = normalizeClaudeRecords(records, fork.newFilePath);
    expect(forked.steps.map((s) => s.id)).toEqual(['u3']);
  });

  it('digests everything when keepLastSteps is 0', async () => {
    const { craftClaudeContextFork } = await import('../src/context-fork.js');
    const dir = await mkdtemp(join(tmpdir(), 'asa-ctx-'));
    const filePath = join(dir, `${SESSION_ID}.jsonl`);
    await writeFile(filePath, fixtureRecords().map((r) => JSON.stringify(r)).join('\n'));
    const fork = await craftClaudeContextFork(filePath, { keepLastSteps: 0 });
    const records = parseJsonl<ClaudeRecord>(await readFile(fork.newFilePath, 'utf8'));
    expect(records).toHaveLength(2); // boundary + summary only
    expect((records[1]!.message!.content as string)).toContain('second prompt');
  });
});
