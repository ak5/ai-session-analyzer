import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  emptyContentVolume,
  emptyInteractionCounts,
  emptyUsage,
  type NormalizedSession,
  type Step,
} from '@asa/core';
import { buildProjectDossier, inventoryInstructionFiles } from '../src/dossier.js';
import { computeEfficacy, readInstructionChanges, steeringSamples } from '../src/efficacy.js';
import { buildIntentReport, classifyIntent, deepenIntentReport } from '../src/intents.js';
import { renderDossier, renderEfficacy, renderIntents } from '../src/render.js';

let n = 0;

function step(promptText: string, timestamp?: string): Step {
  n += 1;
  return {
    id: `s${n}`,
    index: 0,
    kind: 'prompt',
    promptText,
    promptPreview: promptText.slice(0, 60),
    timestamp,
    apiCalls: 1,
    toolCalls: [],
    usage: emptyUsage(),
  };
}

function session(
  id: string,
  steps: Step[],
  overrides: Partial<NormalizedSession> = {},
): NormalizedSession {
  return {
    agent: 'claude',
    id,
    filePath: `/x/${id}.jsonl`,
    cwd: '/tmp/proj',
    models: [],
    compactions: 0,
    steps: steps.map((s, i) => ({ ...s, index: i })),
    usage: { ...emptyUsage(), totalTokens: 100 },
    subagents: [],
    interactions: emptyInteractionCounts(),
    contentVolume: { humanPromptChars: 50, harnessInjectedChars: 500, toolResultChars: 200 },
    startedAt: steps[0]?.timestamp,
    ...overrides,
  };
}

describe('inventoryInstructionFiles / buildProjectDossier', () => {
  it('inventories instruction surfaces and aggregates sessions', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'asa-meta-'));
    execFileSync('git', ['init', '-q'], { cwd: repo });
    writeFileSync(join(repo, 'CLAUDE.md'), '# rules\n- use pnpm\n');
    mkdirSync(join(repo, '.claude', 'skills', 'deploy'), { recursive: true });
    execFileSync('git', ['add', '.'], { cwd: repo });
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'add rules'], {
      cwd: repo,
    });

    const files = inventoryInstructionFiles(repo);
    const claudeMd = files.find((f) => f.path === 'CLAUDE.md')!;
    expect(claudeMd.exists).toBe(true);
    expect(claudeMd.commits).toBe(1);
    expect(files.find((f) => f.path === 'AGENTS.md')!.exists).toBe(false);
    expect(files.some((f) => f.path.includes('1 skills'))).toBe(true);

    const dossier = buildProjectDossier(
      repo,
      [session('a', [step('fix it', '2026-07-01T10:00:00Z')]), session('b', [step('more', '2026-07-02T10:00:00Z')], { agent: 'codex' })],
      [0, 1],
    );
    expect(dossier.sessions.total).toBe(2);
    expect(dossier.sessions.perAgent).toEqual({ claude: 1, codex: 1 });
    expect(dossier.totals.corrections).toBe(1);
    expect(dossier.contentVolume.harnessInjectedChars).toBe(1000);
    expect(renderDossier(dossier)).toContain('Instruction surfaces');
  });
});

describe('efficacy', () => {
  it('splits steering metrics around instruction changes', () => {
    const changes = readInstructionChanges('/repo', ['CLAUDE.md'], () =>
      'abc|2026-07-05T00:00:00Z|add pnpm rule\n',
    );
    expect(changes).toHaveLength(1);
    const sessions = [
      session('before1', [step('no, wrong', '2026-07-01T10:00:00Z'), step('do x', '2026-07-01T11:00:00Z')]),
      session('after1', [step('do y', '2026-07-06T10:00:00Z'), step('do z', '2026-07-06T11:00:00Z')]),
    ];
    const entries = computeEfficacy(changes, steeringSamples(sessions));
    expect(entries[0]!.before.sessions).toBe(1);
    expect(entries[0]!.after.sessions).toBe(1);
    expect(entries[0]!.before.correctionRate).toBe(0.5);
    expect(entries[0]!.after.correctionRate).toBe(0);
    expect(renderEfficacy(entries)).toContain('50.0% → 0.0%');
    expect(renderEfficacy([])).toContain('No instruction-file history');
  });
});

describe('intents', () => {
  it('classifies by keyword rules', () => {
    expect(classifyIntent('fix the failing tests in ci')).toBe('bugfix');
    expect(classifyIntent('add a new list command')).toBe('feature');
    expect(classifyIntent('refactor the parser into modules')).toBe('refactor');
    expect(classifyIntent('deploy the staging server')).toBe('ops');
    expect(classifyIntent('how does the fork mechanism work?')).toBe('research');
    expect(classifyIntent('explain monads and make anki cards')).toBe('learning');
  });

  it('builds per-repo dominant intents and joins PR links', () => {
    const report = buildIntentReport([
      session('s1', [step('fix the bug in auth')]),
      session('s2', [step('fix the login crash')], { interactions: { ...emptyInteractionCounts(), prLinks: 1 } }),
    ]);
    expect(report.byIntent.bugfix).toBe(2);
    expect(report.byRepo[0]).toMatchObject({ cwd: '/tmp/proj', dominant: 'bugfix', share: 1 });
    expect(renderIntents(report)).toContain('bugfix');
  });

  it('deepens with model-named themes and shipped flags', async () => {
    const report = buildIntentReport([
      session('aaaabbbb-1111-4000-8000-000000000001', [step('fix auth bug')]),
      session('aaaacccc-1111-4000-8000-000000000002', [step('fix auth again')], {
        interactions: { ...emptyInteractionCounts(), prLinks: 1 },
      }),
    ]);
    const deepened = await deepenIntentReport(report, 'claude', {
      runner: async () =>
        '[{"theme":"auth flakiness","sessions":["aaaabbbb","aaaacccc"]},{"theme":"solo","sessions":["aaaabbbb"]}]',
    });
    expect(deepened.themes).toHaveLength(1);
    expect(deepened.themes![0]).toMatchObject({ theme: 'auth flakiness', shipped: true });
    expect(renderIntents(deepened)).toContain('✓ shipped');
  });
});
