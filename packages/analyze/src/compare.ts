import { formatNumber as fmt, renderTable as table, shortId } from '@asa/core';
import type { AnalysisReport } from './analyze.js';

export interface ComparisonRow {
  metric: string;
  a: number;
  b: number;
  /** Render as dollars (2dp) instead of an integer count. */
  usd?: boolean;
}

export function compareReports(a: AnalysisReport, b: AnalysisReport): ComparisonRow[] {
  const row = (metric: string, va: number | undefined, vb: number | undefined): ComparisonRow => ({
    metric,
    a: va ?? 0,
    b: vb ?? 0,
  });
  return [
    row('steps', a.totals.steps, b.totals.steps),
    row('api calls', a.totals.apiCalls, b.totals.apiCalls),
    row('tool calls', a.totals.toolCalls, b.totals.toolCalls),
    row('tool errors', a.totals.toolErrors, b.totals.toolErrors),
    row('mcp calls', a.totals.mcpCalls, b.totals.mcpCalls),
    row('subagents', a.totals.subagents, b.totals.subagents),
    row('compactions', a.session.compactions, b.session.compactions),
    row('interruptions', a.session.interactions.interruptions, b.session.interactions.interruptions),
    row('duration (s)', Math.round((a.totals.durationMs ?? 0) / 1000), Math.round((b.totals.durationMs ?? 0) / 1000)),
    row('input tokens', a.session.usage.inputTokens, b.session.usage.inputTokens),
    row('output tokens', a.session.usage.outputTokens, b.session.usage.outputTokens),
    row('cache-read tokens', a.session.usage.cacheReadTokens, b.session.usage.cacheReadTokens),
    row('cache-write tokens', a.session.usage.cacheCreationTokens, b.session.usage.cacheCreationTokens),
    row('total tokens', a.session.usage.totalTokens, b.session.usage.totalTokens),
    ...(a.cost?.pricedModels.length || b.cost?.pricedModels.length
      ? [{ metric: 'est. cost (USD)', a: a.cost?.usd ?? 0, b: b.cost?.usd ?? 0, usd: true }]
      : []),
  ];
}

export function renderComparison(a: AnalysisReport, b: AnalysisReport): string {
  const label = (r: AnalysisReport) =>
    `${r.session.agent} ${shortId(r.session.id)}${r.session.title ? ` (${r.session.title.slice(0, 40)})` : ''}`;
  const rows = compareReports(a, b);
  const out = [`A: ${label(a)}`, `B: ${label(b)}`, ''];
  out.push(
    table(
      ['metric', 'A', 'B', 'Δ', 'Δ%'],
      rows.map((r) => {
        const delta = r.b - r.a;
        const pct = r.a === 0 ? (r.b === 0 ? '0%' : '—') : `${((delta / r.a) * 100).toFixed(0)}%`;
        const val = (n: number) => (r.usd ? n.toFixed(2) : fmt(n));
        return [r.metric, val(r.a), val(r.b), `${delta > 0 ? '+' : ''}${val(delta)}`, pct];
      }),
    ),
  );
  return out.join('\n');
}
