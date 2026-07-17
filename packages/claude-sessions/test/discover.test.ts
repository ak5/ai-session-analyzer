import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { findClaudeSession, listClaudeSessions } from '../src/discover.js';

const A = 'aaaaaaaa-0000-4000-8000-000000000001';
const B = 'bbbbbbbb-0000-4000-8000-000000000002';

let projectsDir: string;

beforeAll(async () => {
  projectsDir = await mkdtemp(join(tmpdir(), 'asa-claude-discover-'));
  const proj1 = join(projectsDir, '-tmp-proj1');
  const proj2 = join(projectsDir, '-tmp-proj2');
  await mkdir(proj1, { recursive: true });
  await mkdir(proj2, { recursive: true });
  await writeFile(join(proj1, `${A}.jsonl`), '{"type":"user"}\n');
  await writeFile(join(proj2, `${B}.jsonl`), '{"type":"user"}\n');
  // distractors that must not be listed: subagent transcripts and non-session files
  const subagents = join(proj1, A, 'subagents');
  await mkdir(subagents, { recursive: true });
  await writeFile(join(subagents, 'agent-abc123.jsonl'), '{"type":"user"}\n');
  await writeFile(join(proj1, 'notes.txt'), 'not a session');
});

describe('listClaudeSessions', () => {
  it('finds top-level session files only', async () => {
    const refs = await listClaudeSessions({ projectsDir });
    expect(refs.map((r) => r.id).sort()).toEqual([A, B]);
    expect(refs.every((r) => r.agent === 'claude')).toBe(true);
    expect(refs.every((r) => r.sizeBytes! > 0)).toBe(true);
  });

  it('returns [] for a missing root', async () => {
    expect(await listClaudeSessions({ projectsDir: '/nonexistent/xyz' })).toEqual([]);
  });
});

describe('findClaudeSession', () => {
  it('resolves by exact id and by unique prefix', async () => {
    expect((await findClaudeSession(A, { projectsDir }))?.id).toBe(A);
    expect((await findClaudeSession('bbbbbbbb', { projectsDir }))?.id).toBe(B);
  });

  it('returns undefined for no match', async () => {
    expect(await findClaudeSession('cccccccc', { projectsDir })).toBeUndefined();
  });

  it('throws on ambiguous prefix', async () => {
    const C = 'aaaaaaaa-0000-4000-8000-000000000003';
    await writeFile(join(projectsDir, '-tmp-proj1', `${C}.jsonl`), '{"type":"user"}\n');
    await expect(findClaudeSession('aaaaaaaa', { projectsDir })).rejects.toThrow(/Ambiguous/);
  });
});
