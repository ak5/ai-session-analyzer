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

const ROLLOUT_RE = /^rollout-.*-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/;

/** Extract the session uuid from a rollout filename, if it is one. */
export function rolloutSessionId(fileName: string): string | undefined {
  return ROLLOUT_RE.exec(fileName)?.[1];
}
