import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { SessionRef } from '@asa/core';
import { claudeProjectsDir, isSessionFileName } from './paths.js';

export interface ListClaudeSessionsOptions {
  projectsDir?: string;
}

/** Enumerate all Claude Code sessions, newest first. */
export async function listClaudeSessions(
  options: ListClaudeSessionsOptions = {},
): Promise<SessionRef[]> {
  const root = options.projectsDir ?? claudeProjectsDir();
  let projectDirs: string[];
  try {
    projectDirs = (await readdir(root, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }

  const refs: SessionRef[] = [];
  for (const slug of projectDirs) {
    const dir = join(root, slug);
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !isSessionFileName(entry.name)) continue;
      const filePath = join(dir, entry.name);
      const info = await stat(filePath).catch(() => undefined);
      refs.push({
        agent: 'claude',
        id: entry.name.replace(/\.jsonl$/, ''),
        filePath,
        cwd: slug,
        updatedAt: info?.mtime,
        sizeBytes: info?.size,
      });
    }
  }
  refs.sort((a, b) => (b.updatedAt?.getTime() ?? 0) - (a.updatedAt?.getTime() ?? 0));
  return refs;
}

/** Resolve a session by full id or unique id prefix. */
export async function findClaudeSession(
  idOrPrefix: string,
  options: ListClaudeSessionsOptions = {},
): Promise<SessionRef | undefined> {
  const refs = await listClaudeSessions(options);
  const exact = refs.find((r) => r.id === idOrPrefix);
  if (exact) return exact;
  const matches = refs.filter((r) => r.id.startsWith(idOrPrefix));
  if (matches.length > 1) {
    throw new Error(
      `Ambiguous Claude session id prefix "${idOrPrefix}" (${matches.length} matches)`,
    );
  }
  return matches[0];
}
