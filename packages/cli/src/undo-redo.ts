/**
 * Opt-in installer for the experimental /undo /redo ($undo/$redo) tooling.
 * Global side: command files into <claude config>/commands and skill dirs
 * into <codex home>/skills. Repo side: an `.asa/undo-redo` marker that arms
 * turn-marking in the git-trace hook (Claude prompts push jj op ids onto the
 * undo stack). Everything reversible: delete the files/marker to leave.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { claudeConfigDir } from '@asa/claude-sessions';
import { codexHome } from '@asa/codex-sessions';
import { CLAUDE_UNDO_COMMANDS, CODEX_UNDO_SKILLS } from './undo-redo-assets.js';
import { installGitTraceHooks, TRACE_DIR } from './hooks-install.js';

export interface UndoRedoInstallOptions {
  claudeDir?: string;
  codexDir?: string;
  /** When set: arm turn-marking in this repo (writes the marker, refreshes the hook). */
  repoRoot?: string;
}

function writeIfChanged(path: string, content: string): boolean {
  if (existsSync(path) && readFileSync(path, 'utf8') === content) return false;
  writeFileSync(path, content);
  return true;
}

export function installUndoRedo(options: UndoRedoInstallOptions = {}): { actions: string[] } {
  const actions: string[] = [];

  const commandsDir = join(options.claudeDir ?? claudeConfigDir(), 'commands');
  mkdirSync(commandsDir, { recursive: true });
  const wroteClaude = Object.entries(CLAUDE_UNDO_COMMANDS).filter(([name, content]) =>
    writeIfChanged(join(commandsDir, name), content),
  );
  if (wroteClaude.length) {
    actions.push(`claude: wrote ${wroteClaude.map(([n]) => '/' + n.replace('.md', '')).join(' ')} into ${commandsDir}`);
  }

  const skillsDir = join(options.codexDir ?? codexHome(), 'skills');
  const wroteCodex = Object.entries(CODEX_UNDO_SKILLS).filter(([name, content]) => {
    mkdirSync(join(skillsDir, name), { recursive: true });
    return writeIfChanged(join(skillsDir, name, 'SKILL.md'), content);
  });
  if (wroteCodex.length) {
    actions.push(`codex: wrote ${wroteCodex.map(([n]) => '$' + n).join(' ')} into ${skillsDir}`);
  }

  if (options.repoRoot) {
    const marker = join(options.repoRoot, TRACE_DIR, 'undo-redo');
    mkdirSync(join(options.repoRoot, TRACE_DIR), { recursive: true });
    if (!existsSync(marker)) {
      writeFileSync(marker, 'turn-marking enabled by `asa setup --undo-redo`\n');
      actions.push('repo: armed turn-marking (.asa/undo-redo marker)');
    }
    // refresh the trace hook so it carries the marking logic
    const hookActions = installGitTraceHooks(options.repoRoot).actions;
    actions.push(...hookActions.filter((a) => !a.startsWith('already installed')));
  }

  if (!actions.length) actions.push('already installed — nothing to do');
  return { actions };
}
