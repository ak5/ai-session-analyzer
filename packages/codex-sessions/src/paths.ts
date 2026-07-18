import { readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export function codexHome(): string {
  return process.env.CODEX_HOME ?? join(homedir(), '.codex');
}

export function codexSessionsDir(): string {
  return join(codexHome(), 'sessions');
}

export function codexSessionIndexFile(): string {
  return join(codexHome(), 'session_index.jsonl');
}

/**
 * Names of installed Codex skills (invoked as $-prefixed messages) and custom
 * prompts: skill directories under <codexHome>/skills, prompt .md files under
 * <codexHome>/prompts. Names are returned without the $ prefix.
 */
export async function listInstalledCodexCommands(home?: string): Promise<Set<string>> {
  const root = home ?? codexHome();
  const names = new Set<string>();
  try {
    for (const entry of await readdir(join(root, 'skills'), { withFileTypes: true })) {
      if (entry.isDirectory()) names.add(entry.name);
    }
  } catch {
    // no skills dir
  }
  try {
    for (const entry of await readdir(join(root, 'prompts'), { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith('.md')) names.add(entry.name.replace(/\.md$/, ''));
    }
  } catch {
    // no prompts dir
  }
  return names;
}

const ROLLOUT_RE = /^rollout-.*-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/;

/** Extract the session uuid from a rollout filename, if it is one. */
export function rolloutSessionId(fileName: string): string | undefined {
  return ROLLOUT_RE.exec(fileName)?.[1];
}
