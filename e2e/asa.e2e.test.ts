/**
 * End-to-end tests: run the built `asa` CLI as a subprocess against fixture
 * sessions living in the gitignored .e2e/ homes, selected via the same env
 * overrides the packages honor (CLAUDE_CONFIG_DIR / CODEX_HOME).
 *
 * Fixtures come from `pnpm e2e:setup` (real claude/codex runs) or
 * `pnpm e2e:setup --synthetic` (no auth needed) — the suite is agnostic.
 * Suites for a missing fixture are skipped with a hint, not failed, so
 * `pnpm test:e2e` stays runnable in any checkout.
 *
 * Requires a build first (`pnpm test:e2e` handles that).
 */
import { execFile } from 'node:child_process';
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const claudeHome = join(repoRoot, '.e2e', 'claude-home');
const codexHome = join(repoRoot, '.e2e', 'codex-home');
const asaBin = join(repoRoot, 'packages', 'cli', 'bin', 'asa.js');

const env = { ...process.env, CLAUDE_CONFIG_DIR: claudeHome, CODEX_HOME: codexHome };

interface AsaResult {
  stdout: string;
  stderr: string;
  code: number;
}

async function asa(...args: string[]): Promise<AsaResult> {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [asaBin, ...args], {
      env,
      cwd: repoRoot,
    });
    return { stdout, stderr, code: 0 };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; code?: number };
    return { stdout: e.stdout ?? '', stderr: e.stderr ?? '', code: e.code ?? 1 };
  }
}

function findClaudeFixtureId(): string | undefined {
  const projects = join(claudeHome, 'projects');
  if (!existsSync(projects)) return undefined;
  for (const slug of readdirSync(projects)) {
    const files = readdirSync(join(projects, slug)).filter((f) => /^[0-9a-f-]{36}\.jsonl$/.test(f));
    if (files.length) return files[0]!.replace(/\.jsonl$/, '');
  }
  return undefined;
}

function findCodexFixtureId(): string | undefined {
  const sessions = join(codexHome, 'sessions');
  if (!existsSync(sessions)) return undefined;
  for (const name of readdirSync(sessions, { recursive: true })) {
    const match = /rollout-.*-([0-9a-f-]{36})\.jsonl$/.exec(String(name));
    if (match) return match[1];
  }
  return undefined;
}

const claudeId = findClaudeFixtureId();
const codexId = findCodexFixtureId();
const setupHint = 'no fixture — run `pnpm e2e:setup` (or `pnpm e2e:setup --synthetic`) first';

describe('asa (no fixtures needed)', () => {
  it('prints help with every command and the use-case examples', async () => {
    const res = await asa('--help');
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('ai session analyzer');
    for (const cmd of ['list', 'analyze', 'resume', 'fork', 'prompter']) {
      expect(res.stdout).toContain(cmd);
    }
    expect(res.stdout).toContain('Use cases:');
    expect(res.stdout).toContain('asa fork --claude-session <id> --at <stepId>');
  });

  it('documents fork --at and prompter --deep in subcommand help', async () => {
    const fork = await asa('fork', '--help');
    expect(fork.stdout).toContain('--at <stepId>');
    // wrap-safe: commander reflows help text at terminal width
    expect(fork.stdout.replace(/\s+/g, ' ')).toContain('not a stable contract');
    const prompter = await asa('prompter', '--help');
    expect(prompter.stdout).toContain('--deep');
    expect(prompter.stdout).toContain('opt-in');
  });

  it('rejects analyze without a session selector', async () => {
    const res = await asa('analyze');
    expect(res.code).toBe(1);
    expect(res.stderr).toContain('exactly one of --claude-session <id> or --codex-session <id>');
  });

  it('rejects analyze with an unknown session id', async () => {
    const res = await asa('analyze', '--claude-session', 'ffffffff-ffff-ffff-ffff-ffffffffffff');
    expect(res.code).toBe(1);
    expect(res.stderr).toContain('No Claude session matching');
  });
});

describe.skipIf(!claudeId)(`claude e2e ${claudeId ?? `(${setupHint})`}`, () => {
  it('lists the fixture session', async () => {
    const res = await asa('list', '--agent', 'claude', '--json');
    expect(res.code).toBe(0);
    const rows = JSON.parse(res.stdout) as Array<{ id: string; agent: string }>;
    expect(rows.some((r) => r.id === claudeId && r.agent === 'claude')).toBe(true);
  });

  it('analyzes the fixture session', async () => {
    const res = await asa('analyze', '--claude-session', claudeId!, '--json');
    expect(res.code).toBe(0);
    const report = JSON.parse(res.stdout);
    expect(report.session.id).toBe(claudeId);
    expect(report.session.cwd).toBe(repoRoot);
    expect(report.totals.steps).toBeGreaterThanOrEqual(1);
    expect(report.totals.apiCalls).toBeGreaterThanOrEqual(1);
    expect(report.session.usage.totalTokens).toBeGreaterThan(0);
    expect(report.session.steps[0].id).toBeTruthy();
  });

  it('renders a human-readable report', async () => {
    const res = await asa('analyze', '--claude-session', claudeId!);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('claude session');
    expect(res.stdout).toContain('Steps (use the step id');
  });

  it('forks at a step and the fork analyzes cleanly', async () => {
    const analyzed = await asa('analyze', '--claude-session', claudeId!, '--json');
    const stepId = JSON.parse(analyzed.stdout).session.steps[0].id as string;

    const forked = await asa('fork', '--claude-session', claudeId!, '--at', stepId, '--no-launch');
    expect(forked.code).toBe(0);
    const newId = /session ([0-9a-f-]{36})/.exec(forked.stdout)?.[1];
    expect(newId).toBeTruthy();
    const newFile = /^\s+(\/.*\.jsonl)$/m.exec(forked.stdout)?.[1];
    expect(newFile && existsSync(newFile)).toBe(true);

    try {
      const reAnalyzed = await asa('analyze', '--claude-session', newId!, '--json');
      expect(reAnalyzed.code).toBe(0);
      expect(JSON.parse(reAnalyzed.stdout).session.id).toBe(newId);
    } finally {
      if (newFile) rmSync(newFile, { force: true });
    }
  });

  it('fork --at --dry-run writes nothing', async () => {
    const analyzed = await asa('analyze', '--claude-session', claudeId!, '--json');
    const stepId = JSON.parse(analyzed.stdout).session.steps[0].id as string;
    const before = readdirSync(join(claudeHome, 'projects'), { recursive: true }).length;
    const res = await asa('fork', '--claude-session', claudeId!, '--at', stepId, '--dry-run');
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('[dry-run] would fork');
    const after = readdirSync(join(claudeHome, 'projects'), { recursive: true }).length;
    expect(after).toBe(before);
  });

  it('resume --dry-run prints the wrapped claude command', async () => {
    const res = await asa('resume', '--claude-session', claudeId!, '--dry-run');
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('[dry-run] would run');
    expect(res.stdout).toContain(`claude --resume ${claudeId}`);
  });

  it('fork --dry-run prints the wrapped fork command', async () => {
    const res = await asa('fork', '--claude-session', claudeId!, '--dry-run');
    expect(res.code).toBe(0);
    expect(res.stdout).toContain(`claude --resume ${claudeId} --fork-session`);
  });
});

describe.skipIf(!claudeId && !codexId)(`prompter e2e (${setupHint})`, () => {
  it('aggregates fixture sessions into a prompter report', async () => {
    const res = await asa('prompter', '--json');
    expect(res.code).toBe(0);
    const report = JSON.parse(res.stdout);
    expect(report.totals.sessions).toBeGreaterThanOrEqual(1);
    expect(report.totals.steps).toBeGreaterThanOrEqual(1);
    expect(report.archetype.name).toBeTruthy();
    expect(report.lints.length).toBeGreaterThan(0);
  });

  it('renders the human-readable report', async () => {
    const res = await asa('prompter');
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('Prompter report');
    expect(res.stdout).toContain('Archetype:');
  });
});

describe.skipIf(!codexId)(`codex e2e ${codexId ?? `(${setupHint})`}`, () => {
  it('lists the fixture session', async () => {
    const res = await asa('list', '--agent', 'codex', '--json');
    expect(res.code).toBe(0);
    const rows = JSON.parse(res.stdout) as Array<{ id: string; agent: string }>;
    expect(rows.some((r) => r.id === codexId && r.agent === 'codex')).toBe(true);
  });

  it('analyzes the fixture session', async () => {
    const res = await asa('analyze', '--codex-session', codexId!, '--json');
    expect(res.code).toBe(0);
    const report = JSON.parse(res.stdout);
    expect(report.session.id).toBe(codexId);
    expect(report.totals.steps).toBeGreaterThanOrEqual(1);
    expect(report.session.usage.totalTokens).toBeGreaterThan(0);
  });

  it('resume --dry-run prints the wrapped codex command', async () => {
    const res = await asa('resume', '--codex-session', codexId!, '--dry-run');
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('[dry-run] would run');
    expect(res.stdout).toContain(`codex resume ${codexId}`);
  });

  it('rejects --at for codex forks', async () => {
    const res = await asa('fork', '--codex-session', codexId!, '--at', 'e2e-turn-1');
    expect(res.code).toBe(1);
    expect(res.stderr).toContain('--at is not supported for Codex sessions yet');
  });
});
