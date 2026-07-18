import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { SessionRef } from '@asa/core';
import { enrichRefs, groupByProject, type ListedRef } from '../src/list.js';
import type { AgentAdapter } from '../src/agents.js';

function ref(overrides: Partial<ListedRef>): ListedRef {
  return {
    agent: 'claude',
    id: 'id',
    filePath: '/x.jsonl',
    orphaned: false,
    ...overrides,
  };
}

describe('groupByProject', () => {
  it('groups by cwd, live projects by recency first, orphans last', () => {
    const groups = groupByProject([
      ref({ id: 'a', cwdResolved: '/proj/one', updatedAt: new Date('2026-07-01') }),
      ref({ id: 'b', cwdResolved: '/proj/two', updatedAt: new Date('2026-07-10') }),
      ref({ id: 'c', cwdResolved: '/proj/one', updatedAt: new Date('2026-07-05') }),
      ref({ id: 'd', cwdResolved: '/gone', orphaned: true, updatedAt: new Date('2026-07-15') }),
      ref({ id: 'e', cwdResolved: undefined, orphaned: true }),
    ]);
    expect(groups.map((g) => g.cwd)).toEqual(['/proj/two', '/proj/one', '/gone', undefined]);
    expect(groups[1]!.refs.map((r) => r.id)).toEqual(['c', 'a']);
    expect(groups[2]!.orphaned).toBe(true);
  });
});

describe('enrichRefs', () => {
  it('resolves cwd via the adapter and flags missing dirs as orphaned', async () => {
    const liveDir = await mkdtemp(join(tmpdir(), 'asa-live-'));
    const cwds = new Map([
      ['live', liveDir],
      ['gone', join(liveDir, 'deleted-subdir')],
      ['unknown', undefined],
    ]);
    const adapter = {
      cwd: async (r: SessionRef) => cwds.get(r.id),
    } as unknown as AgentAdapter;
    const enriched = await enrichRefs(
      [
        { agent: 'claude', id: 'live', filePath: '/x' },
        { agent: 'claude', id: 'gone', filePath: '/x' },
        { agent: 'claude', id: 'unknown', filePath: '/x' },
      ],
      new Map([['claude', adapter]]),
    );
    expect(enriched.map((r) => r.orphaned)).toEqual([false, true, true]);
    expect(enriched[0]!.cwdResolved).toBe(liveDir);
  });
});
