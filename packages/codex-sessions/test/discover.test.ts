import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { findCodexSession, listCodexSessions } from '../src/discover.js';
import { rolloutSessionId } from '../src/paths.js';

const A = '019f0000-0000-7000-8000-000000000001';
const B = '019f0000-0000-7000-8000-000000000002';

let root: string;
let indexFile: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'asa-codex-discover-'));
  const day = join(root, '2026', '07', '17');
  await mkdir(day, { recursive: true });
  await writeFile(join(day, `rollout-2026-07-17T10-00-00-${A}.jsonl`), '{"type":"session_meta"}\n');
  await writeFile(join(day, `rollout-2026-07-17T11-00-00-${B}.jsonl`), '{"type":"session_meta"}\n');
  // legacy pretty-printed .json files must be ignored
  await writeFile(join(root, 'rollout-2025-05-01-deadbeef.json'), '{}');
  indexFile = join(root, 'session_index.jsonl');
  await writeFile(indexFile, `${JSON.stringify({ id: A, thread_name: 'fix the CI' })}\n`);
});

describe('rolloutSessionId', () => {
  it('extracts the uuid from current-format names only', () => {
    expect(rolloutSessionId(`rollout-2026-07-17T10-00-00-${A}.jsonl`)).toBe(A);
    expect(rolloutSessionId('rollout-2025-05-01-deadbeef.json')).toBeUndefined();
    expect(rolloutSessionId('other.jsonl')).toBeUndefined();
  });
});

describe('listCodexSessions', () => {
  it('walks the YYYY/MM/DD layout and attaches titles from the index', async () => {
    const refs = await listCodexSessions({ sessionsDir: root, indexFile });
    expect(refs.map((r) => r.id).sort()).toEqual([A, B]);
    expect(refs.find((r) => r.id === A)?.title).toBe('fix the CI');
    expect(refs.find((r) => r.id === B)?.title).toBeUndefined();
  });

  it('returns [] for a missing root', async () => {
    expect(await listCodexSessions({ sessionsDir: '/nonexistent/xyz' })).toEqual([]);
  });
});

describe('findCodexSession', () => {
  it('resolves by unique prefix and throws on ambiguity', async () => {
    expect((await findCodexSession(`${A}`, { sessionsDir: root, indexFile }))?.id).toBe(A);
    await expect(findCodexSession('019f0000', { sessionsDir: root, indexFile })).rejects.toThrow(
      /Ambiguous/,
    );
  });
});
