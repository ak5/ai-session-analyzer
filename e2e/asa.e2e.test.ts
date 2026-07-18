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
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
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
    expect(res.stdout).toContain('asa fork -c <id> --at <stepId>');
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
    expect(res.stderr).toContain('exactly one of --claude <id> (-c) or --codex <id> (-o)');
  });

  it('rejects analyze with an unknown session id', async () => {
    const res = await asa('analyze', '--claude', 'ffffffff-ffff-ffff-ffff-ffffffffffff');
    expect(res.code).toBe(1);
    expect(res.stderr).toContain('No claude session matching');
  });
});

describe.skipIf(!claudeId)(`claude e2e ${claudeId ?? `(${setupHint})`}`, () => {
  it('lists the fixture session with resolved cwd in JSON', async () => {
    const res = await asa('list', '--agent', 'claude', '--json');
    expect(res.code).toBe(0);
    const rows = JSON.parse(res.stdout) as Array<{
      id: string;
      agent: string;
      cwdResolved?: string;
      orphaned: boolean;
    }>;
    const row = rows.find((r) => r.id === claudeId && r.agent === 'claude');
    expect(row).toBeTruthy();
    expect(row!.cwdResolved).toBe(repoRoot);
    expect(row!.orphaned).toBe(false);
  });

  it('groups list output by project folder, flat with --flat', async () => {
    const grouped = await asa('list');
    expect(grouped.code).toBe(0);
    expect(grouped.stdout).toContain(`${repoRoot} — `);
    expect(grouped.stdout).toContain(claudeId!);
    const flat = await asa('list', '--flat');
    expect(flat.stdout).not.toContain(' — ');
    expect(flat.stdout).toContain(claudeId!);
  });

  it('analyzes the fixture session', async () => {
    const res = await asa('analyze', '--claude', claudeId!, '--json');
    expect(res.code).toBe(0);
    const report = JSON.parse(res.stdout);
    expect(report.session.id).toBe(claudeId);
    expect(report.session.cwd).toBe(repoRoot);
    expect(report.totals.steps).toBeGreaterThanOrEqual(1);
    expect(report.totals.apiCalls).toBeGreaterThanOrEqual(1);
    expect(report.session.usage.totalTokens).toBeGreaterThan(0);
    expect(report.session.steps[0].id).toBeTruthy();
  });

  it('renders a human-readable report (short flag)', async () => {
    const res = await asa('analyze', '-c', claudeId!);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('claude session');
    expect(res.stdout).toContain('Steps (use the step id');
  });

  it('forks at a step and the fork analyzes cleanly', async () => {
    const analyzed = await asa('analyze', '--claude', claudeId!, '--json');
    const stepId = JSON.parse(analyzed.stdout).session.steps[0].id as string;

    const forked = await asa('fork', '--claude', claudeId!, '--at', stepId, '--no-launch');
    expect(forked.code).toBe(0);
    const newId = /session ([0-9a-f-]{36})/.exec(forked.stdout)?.[1];
    expect(newId).toBeTruthy();
    const newFile = /^\s+(\/.*\.jsonl)$/m.exec(forked.stdout)?.[1];
    expect(newFile && existsSync(newFile)).toBe(true);

    try {
      const reAnalyzed = await asa('analyze', '--claude', newId!, '--json');
      expect(reAnalyzed.code).toBe(0);
      expect(JSON.parse(reAnalyzed.stdout).session.id).toBe(newId);
    } finally {
      if (newFile) rmSync(newFile, { force: true });
    }
  });

  it('writes a styled HTML report with --html', async () => {
    const { tmpdir } = await import('node:os');
    const out = join(tmpdir(), `asa-e2e-${Date.now()}.html`);
    const res = await asa('analyze', '-c', claudeId!, '--html', out);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('wrote');
    const html = readFileSync(out, 'utf8');
    expect(html).toContain('<!doctype html>');
    expect(html).toContain(claudeId!.slice(0, 8));
    rmSync(out, { force: true });
  });

  it('fork --at --dry-run writes nothing', async () => {
    const analyzed = await asa('analyze', '--claude', claudeId!, '--json');
    const stepId = JSON.parse(analyzed.stdout).session.steps[0].id as string;
    const before = readdirSync(join(claudeHome, 'projects'), { recursive: true }).length;
    const res = await asa('fork', '--claude', claudeId!, '--at', stepId, '--dry-run');
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('[dry-run] would fork');
    const after = readdirSync(join(claudeHome, 'projects'), { recursive: true }).length;
    expect(after).toBe(before);
  });

  it('resume --dry-run prints the wrapped claude command', async () => {
    const res = await asa('resume', '--claude', claudeId!, '--dry-run');
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('[dry-run] would run');
    expect(res.stdout).toContain(`claude --resume ${claudeId}`);
  });

  it('fork --dry-run prints the wrapped fork command', async () => {
    const res = await asa('fork', '--claude', claudeId!, '--dry-run');
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

describe.skipIf(!claudeId || !codexId)(`compare e2e (${setupHint})`, () => {
  it('compares two sessions cross-agent with a delta table', async () => {
    const res = await asa('compare', '-c', claudeId!, '-o', codexId!);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain(`A: claude`);
    expect(res.stdout).toContain(`B: codex`);
    expect(res.stdout).toContain('total tokens');
    expect(res.stdout).toContain('Δ');
  });

  it('rejects a single session id', async () => {
    const res = await asa('compare', '-c', claudeId!);
    expect(res.code).toBe(1);
    expect(res.stderr).toContain('exactly two session ids');
  });
});

describe('setup e2e', () => {
  it('reports the environment and applies retention only with --yes', async () => {
    // reset: prior suite runs may have set retention in the sandbox home
    const settingsPath = join(claudeHome, 'settings.json');
    if (existsSync(settingsPath)) {
      const settings = JSON.parse(readFileSync(settingsPath, 'utf8')) as Record<string, unknown>;
      delete settings.cleanupPeriodDays;
      const { writeFileSync } = await import('node:fs');
      writeFileSync(settingsPath, JSON.stringify(settings));
    }
    const report = await asa('setup');
    expect(report.code).toBe(0);
    expect(report.stdout).toContain('transcript retention');
    expect(report.stdout).toContain('Left unchanged');

    const applied = await asa('setup', '--yes', '--retention-days', '180');
    expect(applied.stdout).toContain('Set cleanupPeriodDays = 180');
    const settings = JSON.parse(
      readFileSync(join(claudeHome, 'settings.json'), 'utf8'),
    ) as { cleanupPeriodDays?: number };
    expect(settings.cleanupPeriodDays).toBe(180);

    const again = await asa('setup', '--retention-days', '180');
    expect(again.stdout).toContain('nothing to change');
  });
});

describe('install-hooks e2e', () => {
  it('installs trace hooks into a fresh git repo', async () => {
    const { mkdtempSync } = await import('node:fs');
    const { execFileSync } = await import('node:child_process');
    const os = await import('node:os');
    const repo = mkdtempSync(join(os.tmpdir(), 'asa-e2e-hooks-'));
    execFileSync('git', ['init', '-q'], { cwd: repo });
    const res = await asa('install-hooks', repo);
    expect(res.code).toBe(0);
    expect(existsSync(join(repo, '.asa/hooks/git-trace.mjs'))).toBe(true);
    expect(existsSync(join(repo, '.claude/settings.json'))).toBe(true);
  });
});

describe.skipIf(!claudeId && !codexId)(`distill e2e (${setupHint})`, () => {
  it('prints deterministic stats with empty-state sections on sparse fixtures', async () => {
    const res = await asa('distill');
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('Distill — ');
    expect(res.stdout).toContain('Recurring procedures');
    expect(res.stdout).toContain('Recurring questions');
    expect(res.stdout).toContain('Command usage');
  });

  it('emits machine-readable stats with --json', async () => {
    const res = await asa('distill', '--json');
    expect(res.code).toBe(0);
    const stats = JSON.parse(res.stdout);
    expect(stats.scope.sessions).toBeGreaterThanOrEqual(1);
    expect(Array.isArray(stats.procedures)).toBe(true);
    expect(Array.isArray(stats.toolSequences)).toBe(true);
  });

  it('gates --suggest behind a token estimate and skips without --yes in non-TTY', async () => {
    const res = await asa('distill', '--suggest', 'claude');
    expect(res.code).toBe(0);
    expect(res.stderr).toContain('input tokens (est. chars/4)');
    expect(res.stderr).toContain('pass --yes to proceed');
    // the model call must not have happened
    expect(res.stdout).not.toContain('asking claude');
  });

  it('--faq reports gracefully when no questions recur', async () => {
    const res = await asa('distill', '--faq', repoRoot);
    expect(res.code).toBe(0);
    expect(res.stdout).toMatch(/No recurring questions|no extractable answers|added \d+ entries/);
  });

  it('rejects unknown --suggest backends', async () => {
    const res = await asa('distill', '--suggest', 'gemini');
    expect(res.code).toBe(1);
    expect(res.stderr).toContain('--suggest must be claude or codex');
  });
});

describe.skipIf(!claudeId && !codexId)(`meta e2e (${setupHint})`, () => {
  it('builds a project dossier for this repo from the fixture sessions', async () => {
    const res = await asa('project', repoRoot);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain(`Project dossier — ${repoRoot}`);
    expect(res.stdout).toContain('Instruction surfaces');
    expect(res.stdout).toContain('content volume');
  });

  it('reports intents with per-repo dominance', async () => {
    const res = await asa('intents', '--json');
    expect(res.code).toBe(0);
    const report = JSON.parse(res.stdout);
    expect(report.sessions.length).toBeGreaterThanOrEqual(1);
    expect(Object.keys(report.byIntent).length).toBeGreaterThanOrEqual(1);
  });

  it('runs efficacy (this repo has no committed instruction files → empty state)', async () => {
    const res = await asa('efficacy', repoRoot);
    expect(res.code).toBe(0);
    expect(res.stdout.length).toBeGreaterThan(0);
  });

  it('rejects unknown --deep backends for intents', async () => {
    const res = await asa('intents', '--deep', 'gemini');
    expect(res.code).toBe(1);
    expect(res.stderr).toContain('--deep must be claude or codex');
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
    const res = await asa('analyze', '--codex', codexId!, '--json');
    expect(res.code).toBe(0);
    const report = JSON.parse(res.stdout);
    expect(report.session.id).toBe(codexId);
    expect(report.totals.steps).toBeGreaterThanOrEqual(1);
    expect(report.session.usage.totalTokens).toBeGreaterThan(0);
  });

  it('resume --dry-run prints the wrapped codex command', async () => {
    const res = await asa('resume', '--codex', codexId!, '--dry-run');
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('[dry-run] would run');
    expect(res.stdout).toContain(`codex resume ${codexId}`);
  });

  it('forks codex at a step and the fork analyzes with lineage (short flag)', async () => {
    const res = await asa('fork', '-o', codexId!, '--at', 'e2e-turn-1', '--no-launch');
    expect(res.code).toBe(0);
    const newId = /session ([0-9a-f-]{36})/.exec(res.stdout)?.[1];
    const newFile = /^\s+(\/.*\.jsonl)$/m.exec(res.stdout)?.[1];
    expect(newId && newFile && existsSync(newFile)).toBeTruthy();
    try {
      const reAnalyzed = await asa('analyze', '-o', newId!, '--json');
      expect(reAnalyzed.code).toBe(0);
      const session = JSON.parse(reAnalyzed.stdout).session;
      expect(session.forkedFromId).toBe(codexId);
      expect(session.steps.length).toBe(1);
    } finally {
      if (newFile) rmSync(newFile, { force: true });
    }
  });
});
