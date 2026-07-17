import { homedir } from 'node:os';
import { join } from 'node:path';

export function claudeConfigDir(): string {
  return process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude');
}

export function claudeProjectsDir(): string {
  return join(claudeConfigDir(), 'projects');
}

const SESSION_FILE_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/;

export function isSessionFileName(name: string): boolean {
  return SESSION_FILE_RE.test(name);
}
