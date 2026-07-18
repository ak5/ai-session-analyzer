import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CLAUDE_UNDO_COMMANDS, CODEX_UNDO_SKILLS } from '../src/undo-redo-assets.js';
import { installUndoRedo } from '../src/undo-redo.js';

describe('undo-redo assets', () => {
  it('claude commands carry frontmatter, session-scoped stacks in .jj/', () => {
    for (const [name, content] of Object.entries(CLAUDE_UNDO_COMMANDS)) {
      expect(content, name).toMatch(/^---\ndescription: /);
      expect(content, name).toContain('.jj/undo-stack-${SID}');
      expect(content, name).toContain('SID="${CLAUDE_SESSION_ID:-default}"');
    }
  });

  it('codex skills carry name frontmatter and the op-log fallback', () => {
    expect(Object.keys(CODEX_UNDO_SKILLS).sort()).toEqual(['redo', 'undo', 'undo-reset', 'undo-stack']);
    expect(CODEX_UNDO_SKILLS.undo).toContain('name: undo');
    expect(CODEX_UNDO_SKILLS.undo).toContain('.jj/undo-stack-codex');
    expect(CODEX_UNDO_SKILLS.undo).toContain('fall back to the previous op');
    // claude's marked variant must NOT fall back
    expect(CLAUDE_UNDO_COMMANDS['undo.md']).not.toContain('fall back');
  });
});

describe('installUndoRedo', () => {
  it('installs commands, skills, marker and refreshed hook — idempotently', async () => {
    const claudeDir = await mkdtemp(join(tmpdir(), 'asa-ur-claude-'));
    const codexDir = await mkdtemp(join(tmpdir(), 'asa-ur-codex-'));
    const repo = await mkdtemp(join(tmpdir(), 'asa-ur-repo-'));
    execFileSync('git', ['init', '-q'], { cwd: repo });

    const first = installUndoRedo({ claudeDir, codexDir, repoRoot: repo });
    expect(first.actions.join('\n')).toContain('/undo');
    expect(first.actions.join('\n')).toContain('$undo');
    expect(existsSync(join(claudeDir, 'commands', 'undo.md'))).toBe(true);
    expect(existsSync(join(codexDir, 'skills', 'undo', 'SKILL.md'))).toBe(true);
    expect(existsSync(join(repo, '.asa', 'undo-redo'))).toBe(true);
    // the refreshed trace hook carries the marking logic
    expect(readFileSync(join(repo, '.asa/hooks/git-trace.mjs'), 'utf8')).toContain('undo-stack-');

    const second = installUndoRedo({ claudeDir, codexDir, repoRoot: repo });
    expect(second.actions).toEqual(['already installed — nothing to do']);
  });
});
