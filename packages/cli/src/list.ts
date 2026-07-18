import { existsSync } from 'node:fs';
import type { SessionRef } from '@asa/core';
import type { AgentAdapter } from './agents.js';

export interface ListedRef extends SessionRef {
  /** Real cwd from the session file header (the ref's own cwd may be a lossy slug). */
  cwdResolved?: string;
  /** cwd is unknown or no longer exists on disk. */
  orphaned: boolean;
}

export interface ProjectGroup {
  /** undefined = cwd could not be determined from the session file */
  cwd?: string;
  orphaned: boolean;
  refs: ListedRef[];
  lastActive?: Date;
}

export async function enrichRefs(
  refs: SessionRef[],
  adapterByKind: Map<string, AgentAdapter>,
): Promise<ListedRef[]> {
  return Promise.all(
    refs.map(async (ref): Promise<ListedRef> => {
      let cwd: string | undefined;
      try {
        cwd = await adapterByKind.get(ref.agent)?.cwd(ref);
      } catch {
        // unreadable header — treat as unknown cwd
      }
      return { ...ref, cwdResolved: cwd, orphaned: !cwd || !existsSync(cwd) };
    }),
  );
}

/**
 * Group by resolved cwd, live projects first (most recently active first),
 * then orphans (deleted or unknown cwd) in their own trailing section.
 */
export function groupByProject(refs: ListedRef[]): ProjectGroup[] {
  const byCwd = new Map<string, ProjectGroup>();
  for (const ref of refs) {
    const key = ref.cwdResolved ?? '';
    let group = byCwd.get(key);
    if (!group) {
      group = { cwd: ref.cwdResolved, orphaned: ref.orphaned, refs: [] };
      byCwd.set(key, group);
    }
    group.refs.push(ref);
    if (ref.updatedAt && (!group.lastActive || ref.updatedAt > group.lastActive)) {
      group.lastActive = ref.updatedAt;
    }
  }
  for (const group of byCwd.values()) {
    group.refs.sort((a, b) => (b.updatedAt?.getTime() ?? 0) - (a.updatedAt?.getTime() ?? 0));
  }
  return [...byCwd.values()].sort((a, b) => {
    if (a.orphaned !== b.orphaned) return a.orphaned ? 1 : -1;
    return (b.lastActive?.getTime() ?? 0) - (a.lastActive?.getTime() ?? 0);
  });
}
