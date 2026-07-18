import { formatNumber as fmt, renderTable as table, shortId } from '@asa/core';
import type { PromptCluster } from './cluster.js';
import type { DistillStats } from './stats.js';

function clusterTable(clusters: PromptCluster[]): string {
  return table(
    ['×', 'sessions', 'agents', 'out-tokens', 'recurring prompt'],
    clusters.map((c) => [
      String(c.count),
      String(c.sessions.length),
      c.agents.join('+'),
      fmt(c.totalOutputTokens),
      c.representative,
    ]),
  );
}

export function renderDistillStats(stats: DistillStats): string {
  const out: string[] = [];
  const agents = Object.entries(stats.scope.perAgent)
    .map(([k, v]) => `${v} ${k}`)
    .join(', ');
  out.push(
    `Distill — ${stats.scope.prompts} prompts across ${stats.scope.sessions} sessions (${agents}), ${stats.scope.cwds.length} projects`,
  );

  out.push('', 'Recurring procedures (skill candidates):');
  out.push(stats.procedures.length ? clusterTable(stats.procedures) : '  none found');

  out.push('', 'Recurring questions (FAQ / flashcard candidates):');
  out.push(stats.questions.length ? clusterTable(stats.questions) : '  none found');

  out.push('', 'Recurring corrections (CLAUDE.md rule candidates):');
  out.push(stats.lessons.length ? clusterTable(stats.lessons) : '  none found');

  out.push('', 'Recurring tool sequences (procedure evidence):');
  out.push(
    stats.toolSequences.length
      ? table(
          ['×', 'sessions', 'sequence'],
          stats.toolSequences.map((s) => [
            String(s.count),
            String(s.sessions.length),
            s.sequence.join(' → '),
          ]),
        )
      : '  none found',
  );

  out.push('', 'Existing slash-command usage (already extracted):');
  out.push(
    stats.commandUsage.length
      ? table(
          ['command', '×', 'sessions'],
          stats.commandUsage.map((c) => [c.command, String(c.count), String(c.sessions)]),
        )
      : '  none used in scope',
  );

  if (stats.procedures.length || stats.questions.length || stats.lessons.length) {
    const example = stats.procedures[0] ?? stats.questions[0] ?? stats.lessons[0];
    out.push(
      '',
      `Sessions behind the top cluster: ${example!.sessions.map(shortId).join(', ')}`,
      'Run with --suggest claude|codex for extraction recommendations based on these stats.',
    );
  }
  return out.join('\n');
}
