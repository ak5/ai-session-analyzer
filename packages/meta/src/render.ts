import { formatNumber as fmt, renderTable as table, shortId, type ContentVolume } from '@asa/core';
import type { ProjectDossier } from './dossier.js';
import type { EfficacyEntry } from './efficacy.js';
import type { IntentReport } from './intents.js';

export function renderContentVolume(volume: ContentVolume): string {
  const total = volume.humanPromptChars + volume.harnessInjectedChars + volume.toolResultChars;
  if (!total) return 'content volume: no data';
  const pct = (n: number) => `${((n / total) * 100).toFixed(0)}%`;
  return (
    `content volume (chars): human ${fmt(volume.humanPromptChars)} (${pct(volume.humanPromptChars)})` +
    ` · harness-injected ${fmt(volume.harnessInjectedChars)} (${pct(volume.harnessInjectedChars)})` +
    ` · tool results ${fmt(volume.toolResultChars)} (${pct(volume.toolResultChars)})`
  );
}

export function renderDossier(dossier: ProjectDossier): string {
  const out: string[] = [];
  const agents = Object.entries(dossier.sessions.perAgent)
    .map(([k, v]) => `${v} ${k}`)
    .join(', ');
  out.push(`Project dossier — ${dossier.path}`);
  out.push(
    `${dossier.sessions.total} sessions (${agents}) from ${dossier.sessions.firstAt?.slice(0, 10) ?? '?'} to ${dossier.sessions.lastAt?.slice(0, 10) ?? '?'}`,
  );
  const t = dossier.totals;
  out.push(
    `steps ${fmt(t.steps)} · api calls ${fmt(t.apiCalls)} · tool calls ${fmt(t.toolCalls)} (${t.toolErrors} errors, ${t.mcpCalls} mcp)` +
      ` · subagents ${t.subagents} · interruptions ${t.interruptions} · corrections ${t.corrections}` +
      ` · slash commands ${t.commands} · PRs linked ${t.prLinks} · compactions ${t.compactions}`,
  );
  out.push(`tokens: total ${fmt(dossier.usage.totalTokens)} (out ${fmt(dossier.usage.outputTokens)}, cache-read ${fmt(dossier.usage.cacheReadTokens)})`);
  out.push(renderContentVolume(dossier.contentVolume));

  out.push('', 'Instruction surfaces:');
  out.push(
    table(
      ['file', 'present', 'size', 'commits', 'last change'],
      dossier.instructionFiles.map((f) => [
        f.path,
        f.exists ? 'yes' : '—',
        f.sizeBytes !== undefined ? `${fmt(f.sizeBytes)}B` : '',
        f.commits !== undefined ? String(f.commits) : '',
        f.lastCommitAt?.slice(0, 10) ?? f.modifiedAt?.slice(0, 10) ?? '',
      ]),
    ),
  );

  if (dossier.topTools.length) {
    out.push('', 'Top tools:');
    out.push(
      table(
        ['tool', 'calls', 'errors'],
        dossier.topTools.map((t2) => [t2.name, fmt(t2.count), fmt(t2.errors)]),
      ),
    );
  }
  if (dossier.mcpServers.length) {
    out.push('', 'MCP servers:');
    out.push(table(['server', 'calls'], dossier.mcpServers.map((s) => [s.server, fmt(s.calls)])));
  }

  out.push('', 'Recent sessions:');
  out.push(
    table(
      ['when', 'agent', 'session', 'steps', 'tokens', 'title'],
      dossier.recentSessions.map((s) => [
        s.startedAt?.slice(0, 16).replace('T', ' ') ?? '?',
        s.agent,
        shortId(s.id),
        fmt(s.steps),
        fmt(s.totalTokens),
        (s.title ?? '').slice(0, 40),
      ]),
    ),
  );
  return out.join('\n');
}

export function renderEfficacy(entries: EfficacyEntry[]): string {
  if (!entries.length) {
    return 'No instruction-file history found (CLAUDE.md / AGENTS.md with git commits).';
  }
  const out: string[] = ['Instruction-change efficacy (steering metrics before → after each change):', ''];
  const pct = (x?: number) => (x === undefined ? '—' : `${(x * 100).toFixed(1)}%`);
  out.push(
    table(
      ['date', 'file', 'change', 'sessions (b/a)', 'corrections', 'interruptions'],
      entries.map((e) => [
        e.change.date.slice(0, 10),
        e.change.file,
        e.change.subject.slice(0, 44),
        `${e.before.sessions}/${e.after.sessions}`,
        `${pct(e.before.correctionRate)} → ${pct(e.after.correctionRate)}`,
        `${pct(e.before.interruptionRate)} → ${pct(e.after.interruptionRate)}`,
      ]),
    ),
  );
  out.push(
    '',
    'Correlational, not causal: model versions and task mix change too. Treat a flat',
    'line after a rule you cared about as the interesting signal, not small deltas.',
  );
  return out.join('\n');
}

export function renderIntents(report: IntentReport): string {
  const out: string[] = [];
  out.push(`Intents — ${report.sessions.length} sessions`);
  out.push(
    table(
      ['intent', 'sessions'],
      Object.entries(report.byIntent)
        .sort((a, b) => b[1] - a[1])
        .map(([intent, count]) => [intent, fmt(count)]),
    ),
  );
  if (report.byRepo.length) {
    out.push('', 'Per repo (dominant intent):');
    out.push(
      table(
        ['repo', 'sessions', 'dominant', 'share'],
        report.byRepo.map((r) => [r.cwd, fmt(r.sessions), r.dominant, `${(r.share * 100).toFixed(0)}%`]),
      ),
    );
  }
  if (report.themes) {
    out.push('', 'Recurring themes (model-named; "unshipped" = no PR linked in any member session):');
    for (const theme of report.themes) {
      out.push(
        `  ${theme.shipped ? '✓ shipped' : '✗ unshipped'}  ${theme.theme} — ${theme.sessions.length} sessions (${theme.sessions.join(', ')})`,
      );
    }
  } else {
    out.push('', 'Add --deep claude|codex to name recurring cross-session themes and flag unshipped ones.');
  }
  return out.join('\n');
}
