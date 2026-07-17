import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { parseJsonl, type SessionRef } from '@asa/core';
import { codexSessionIndexFile, codexSessionsDir, rolloutSessionId } from './paths.js';

export interface ListCodexSessionsOptions {
  sessionsDir?: string;
  indexFile?: string;
}

interface SessionIndexEntry {
  id?: string;
  thread_name?: string;
  updated_at?: string;
}

/** id → human title, from ~/.codex/session_index.jsonl (best effort). */
export async function readCodexSessionTitles(indexFile?: string): Promise<Map<string, string>> {
  const titles = new Map<string, string>();
  try {
    const entries = parseJsonl<SessionIndexEntry>(
      await readFile(indexFile ?? codexSessionIndexFile(), 'utf8'),
    );
    for (const entry of entries) {
      if (entry.id && entry.thread_name) titles.set(entry.id, entry.thread_name);
    }
  } catch {
    // index is optional
  }
  return titles;
}

/** Enumerate Codex rollout sessions (current YYYY/MM/DD layout), newest first. */
export async function listCodexSessions(
  options: ListCodexSessionsOptions = {},
): Promise<SessionRef[]> {
  const root = options.sessionsDir ?? codexSessionsDir();
  let names: string[];
  try {
    names = await readdir(root, { recursive: true });
  } catch {
    return [];
  }

  const titles = await readCodexSessionTitles(options.indexFile);
  const refs: SessionRef[] = [];
  for (const name of names) {
    const id = rolloutSessionId(basename(name));
    if (!id) continue;
    const filePath = join(root, name);
    const info = await stat(filePath).catch(() => undefined);
    if (!info?.isFile()) continue;
    refs.push({
      agent: 'codex',
      id,
      filePath,
      title: titles.get(id),
      updatedAt: info.mtime,
      sizeBytes: info.size,
    });
  }
  refs.sort((a, b) => (b.updatedAt?.getTime() ?? 0) - (a.updatedAt?.getTime() ?? 0));
  return refs;
}

/** Resolve a session by full id or unique id prefix. */
export async function findCodexSession(
  idOrPrefix: string,
  options: ListCodexSessionsOptions = {},
): Promise<SessionRef | undefined> {
  const refs = await listCodexSessions(options);
  const exact = refs.find((r) => r.id === idOrPrefix);
  if (exact) return exact;
  const matches = refs.filter((r) => r.id.startsWith(idOrPrefix));
  if (matches.length > 1) {
    throw new Error(`Ambiguous Codex session id prefix "${idOrPrefix}" (${matches.length} matches)`);
  }
  return matches[0];
}
