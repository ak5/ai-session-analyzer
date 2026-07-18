import { readdir } from 'node:fs/promises';
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

/**
 * Names of user-installed Claude skills and commands (without the leading /):
 * skill directories under <configDir>/skills and <extraRoot>/.claude/skills,
 * command .md files under the matching commands/ dirs. Anything invoked that
 * is NOT in this set is a builtin (/clear, /model, …) or came from a plugin.
 */
export async function listInstalledClaudeCommands(options: {
  configDir?: string;
  projectDirs?: string[];
} = {}): Promise<Set<string>> {
  const names = new Set<string>();
  const configDir = options.configDir ?? claudeConfigDir();
  const roots = [configDir, ...(options.projectDirs ?? []).map((d) => join(d, '.claude'))];

  // installed plugins ship skills/commands under their own installPath
  try {
    const { readFile } = await import('node:fs/promises');
    const manifest = JSON.parse(
      await readFile(join(configDir, 'plugins', 'installed_plugins.json'), 'utf8'),
    ) as { plugins?: Record<string, Array<{ installPath?: string }>> };
    for (const [pluginKey, installs] of Object.entries(manifest.plugins ?? {})) {
      const pluginName = pluginKey.split('@')[0];
      for (const install of installs) {
        if (install.installPath) roots.push(install.installPath);
        // invocations may be plugin-prefixed ("/slack:standup") — index the prefix form too
        if (pluginName) names.add(pluginName);
      }
    }
  } catch {
    // no plugins manifest
  }

  for (const root of roots) {
    try {
      for (const entry of await readdir(join(root, 'skills'), { withFileTypes: true })) {
        if (entry.isDirectory()) names.add(entry.name);
      }
    } catch {
      // no skills dir
    }
    try {
      for (const entry of await readdir(join(root, 'commands'), { withFileTypes: true })) {
        if (entry.isFile() && entry.name.endsWith('.md')) names.add(entry.name.replace(/\.md$/, ''));
      }
    } catch {
      // no commands dir
    }
  }
  return names;
}
