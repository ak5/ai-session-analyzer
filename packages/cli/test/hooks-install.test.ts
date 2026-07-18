import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { HOOK_SCRIPT, installGitTraceHooks } from '../src/hooks-install.js';

let repo: string;

beforeAll(async () => {
  repo = await mkdtemp(join(tmpdir(), 'asa-hooks-'));
  execFileSync('git', ['init', '-q'], { cwd: repo });
  writeFileSync(join(repo, 'file.txt'), 'hello\n');
  execFileSync('git', ['add', '.'], { cwd: repo });
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init'], {
    cwd: repo,
  });
});

describe('installGitTraceHooks', () => {
  it('installs script, settings hooks, and gitignore entry — idempotently', () => {
    const first = installGitTraceHooks(repo);
    expect(first.actions.join()).toContain('git-trace.mjs');
    expect(existsSync(join(repo, '.asa/hooks/git-trace.mjs'))).toBe(true);

    const settings = JSON.parse(readFileSync(join(repo, '.claude/settings.json'), 'utf8'));
    for (const event of ['UserPromptSubmit', 'Stop']) {
      expect(JSON.stringify(settings.hooks[event])).toContain('git-trace.mjs');
    }
    expect(readFileSync(join(repo, '.gitignore'), 'utf8')).toContain('.asa/');

    const second = installGitTraceHooks(repo);
    expect(second.actions).toEqual(['already installed — nothing to do']);
    // no duplicate hook entries
    const again = JSON.parse(readFileSync(join(repo, '.claude/settings.json'), 'utf8'));
    expect(again.hooks.UserPromptSubmit).toHaveLength(1);
  });

  it('preserves existing settings content', () => {
    const dirPath = join(repo, 'sub');
    mkdirSync(dirPath);
    execFileSync('git', ['init', '-q'], { cwd: dirPath });
    mkdirSync(join(dirPath, '.claude'), { recursive: true });
    writeFileSync(
      join(dirPath, '.claude/settings.json'),
      JSON.stringify({ permissions: { allow: ['Bash(ls:*)'] } }),
    );
    installGitTraceHooks(dirPath);
    const settings = JSON.parse(readFileSync(join(dirPath, '.claude/settings.json'), 'utf8'));
    expect(settings.permissions.allow).toEqual(['Bash(ls:*)']);
    expect(settings.hooks.Stop).toBeTruthy();
  });

  it('resolves the repo root from a subdirectory', () => {
    const sub = join(repo, 'deep', 'nested');
    mkdirSync(sub, { recursive: true });
    const result = installGitTraceHooks(sub);
    expect(result.actions[0]).toContain('resolved repo root');
    // installed at the root, not in the subdir
    expect(existsSync(join(repo, '.asa/hooks/git-trace.mjs'))).toBe(true);
    expect(existsSync(join(sub, '.asa'))).toBe(false);
  });

  it('rejects non-repos', () => {
    expect(() => installGitTraceHooks(tmpdir())).toThrow(/not inside a git/);
  });
});

describe('the hook script itself', () => {
  it('appends a trace line with HEAD and dirty count, and stays silent on stdout', () => {
    installGitTraceHooks(repo);
    writeFileSync(join(repo, 'dirty.txt'), 'x\n');
    const payload = JSON.stringify({
      cwd: repo,
      hook_event_name: 'UserPromptSubmit',
      session_id: 'sess-123',
    });
    const run = spawnSync('node', [join(repo, '.asa/hooks/git-trace.mjs')], {
      cwd: repo,
      input: payload,
    });
    expect(run.status).toBe(0);
    expect(run.stdout.toString()).toBe('');

    const lines = readFileSync(join(repo, '.asa/git-trace.jsonl'), 'utf8').trim().split('\n');
    const last = JSON.parse(lines.at(-1)!);
    expect(last.session_id).toBe('sess-123');
    expect(last.event).toBe('UserPromptSubmit');
    expect(last.head).toMatch(/^[0-9a-f]{40}$/);
    expect(last.dirty_files).toBeGreaterThanOrEqual(1);
  });

  it('marks turn boundaries onto the undo stack when armed, with tail dedupe', () => {
    installGitTraceHooks(repo);
    // arm the marker and a fake .jj + fake jj binary (CI has no real jj)
    mkdirSync(join(repo, '.jj'), { recursive: true });
    mkdirSync(join(repo, '.asa'), { recursive: true });
    writeFileSync(join(repo, '.asa', 'undo-redo'), 'armed\n');
    const fakeBin = join(repo, 'fakebin');
    mkdirSync(fakeBin, { recursive: true });
    writeFileSync(join(fakeBin, 'jj'), '#!/bin/sh\necho fakeop123\n', { mode: 0o755 });

    const payload = JSON.stringify({
      cwd: repo,
      hook_event_name: 'UserPromptSubmit',
      session_id: 'sess-mark',
    });
    const env = { ...process.env, PATH: `${fakeBin}:${process.env.PATH}` };
    spawnSync('node', [join(repo, '.asa/hooks/git-trace.mjs')], { cwd: repo, input: payload, env });
    spawnSync('node', [join(repo, '.asa/hooks/git-trace.mjs')], { cwd: repo, input: payload, env });

    const stack = readFileSync(join(repo, '.jj', 'undo-stack-sess-mark'), 'utf8').trim().split('\n');
    // second identical op deduped against the tail
    expect(stack).toEqual(['fakeop123']);
    expect(readFileSync(join(repo, '.jj', 'redo-stack-sess-mark'), 'utf8')).toBe('');
  });

  it('survives garbage stdin without crashing', () => {
    const run = spawnSync('node', [join(repo, '.asa/hooks/git-trace.mjs')], {
      cwd: repo,
      input: 'not json',
    });
    expect(run.status).toBe(0);
  });

  it('script content has no stray unescaped template artifacts', () => {
    expect(HOOK_SCRIPT).toContain(".asa', 'git-trace.jsonl'");
    expect(HOOK_SCRIPT).not.toContain('${TRACE');
  });
});
