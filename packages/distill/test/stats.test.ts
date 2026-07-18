import { describe, expect, it } from 'vitest';
import {
  emptyContentVolume,
  emptyInteractionCounts,
  emptyUsage,
  type NormalizedSession,
  type Step,
  type ToolCall,
} from '@asa/core';
import { toolLabel, mineToolSequences } from '../src/sequences.js';
import { ASA_INTERNAL_SENTINEL, buildDistillStats, isInternalSession } from '../src/stats.js';

let n = 0;

function step(promptText: string, toolCalls: ToolCall[] = [], kind: Step['kind'] = 'prompt'): Step {
  n += 1;
  return {
    id: `s${n}`,
    index: 0,
    kind,
    commandName: kind === 'command' ? promptText : undefined,
    promptText: kind === 'command' ? undefined : promptText,
    promptPreview: promptText.slice(0, 60),
    apiCalls: 1,
    toolCalls,
    usage: emptyUsage(),
  };
}

function session(id: string, steps: Step[]): NormalizedSession {
  return {
    agent: 'claude',
    id,
    filePath: `/x/${id}.jsonl`,
    cwd: '/tmp/proj',
    models: [],
    compactions: 0,
    steps: steps.map((s, i) => ({ ...s, index: i })),
    usage: emptyUsage(),
    subagents: [],
    interactions: emptyInteractionCounts(),
    contentVolume: emptyContentVolume(),
  };
}

const call = (name: string, input?: unknown): ToolCall => ({ id: `t${++n}`, name, isMcp: false, input });

describe('toolLabel', () => {
  it('qualifies Bash with the leading command word', () => {
    expect(toolLabel(call('Bash', { command: 'git status --short' }))).toBe('Bash:git');
    expect(toolLabel(call('Bash', { command: '/usr/bin/env node x.js' }))).toBe('Bash:env');
  });

  it('parses codex exec JS-wrapped cmd args, patches, and JSON, tolerating garbage', () => {
    expect(
      toolLabel(call('exec', 'const r = await tools.exec_command({"cmd":"LC_ALL=C git status"})')),
    ).toBe('exec:git');
    expect(toolLabel(call('exec', 'const patch = "*** Begin Patch\\n..."'))).toBe('exec:apply_patch');
    expect(toolLabel(call('exec', 'await tools.exec_command({cmd:"rg -n pattern ."})'))).toBe('exec:rg');
    expect(toolLabel(call('exec', '{"command":["pnpm","test"]}'))).toBe('exec:pnpm');
    expect(toolLabel(call('exec', '{"cmd":"bash -lc \'pnpm build\'"}'))).toBe('exec:pnpm');
    expect(toolLabel(call('exec', 'not json'))).toBe('exec');
    expect(toolLabel(call('Read'))).toBe('Read');
  });

  it('dedupes fork-copied steps by uuid+prompt', () => {
    const original = session('orig', [step('deploy the staging server and run smoke tests')]);
    const fork = { ...original, id: 'fork', filePath: '/x/fork.jsonl' };
    const other = session('other', [step('deploy staging server and run the smoke tests')]);
    const stats = buildDistillStats([original, fork, other]);
    // fork must not inflate the cluster: 2 genuine occurrences, not 3
    expect(stats.procedures[0]?.count).toBe(2);
  });
});

describe('mineToolSequences', () => {
  it('finds recurring n-grams across sessions, not one-offs', () => {
    const recurring = [call('Read', undefined), call('Bash', { command: 'pnpm test' }), call('Edit', undefined)];
    const sessions = ['a', 'b', 'c'].map((id) =>
      session(id, [step('fix it', [...recurring]), step('other', [call('Write')])]),
    );
    const mined = mineToolSequences(sessions);
    expect(mined.some((s) => s.sequence.join('→') === 'Read→Bash:pnpm→Edit')).toBe(true);
    expect(mined.every((s) => s.sessions.length >= 2)).toBe(true);
  });
});

describe('buildDistillStats', () => {
  it('splits clusters by kind, counts command usage, excludes internal sessions', () => {
    const sessions = [
      session('s1', [
        step('deploy the staging server and run smoke tests'),
        step('/verify', [], 'command'),
      ]),
      session('s2', [
        step('deploy staging server and run the smoke tests'),
        step('/verify', [], 'command'),
      ]),
      session('internal', [step(`${ASA_INTERNAL_SENTINEL}\njudge these prompts`)]),
    ];
    expect(isInternalSession(sessions[2]!)).toBe(true);
    const stats = buildDistillStats(sessions);
    expect(stats.scope.sessions).toBe(2);
    expect(stats.procedures).toHaveLength(1);
    expect(stats.commandUsage).toEqual([{ command: '/verify', count: 2, sessions: 2 }]);
  });
});
