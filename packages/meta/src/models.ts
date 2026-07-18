/**
 * Historical model usage: which models you actually run, in what proportion,
 * and when allegiances changed. Built from per-response model attribution
 * (Claude) and per-turn turn_context (Codex, effort included). History depth
 * is bounded by session retention — raise Claude's cleanupPeriodDays for a
 * longer memory.
 */
import { formatNumber as fmt, renderTable as table, type NormalizedSession } from '@asa/core';

export interface ModelStat {
  model: string;
  agent: string;
  sessions: number;
  apiCalls: number;
  outputTokens: number;
  /** Share of the agent's total API calls. */
  share: number;
  firstSeen?: string;
  lastSeen?: string;
}

export interface ModelWeek {
  week: string;
  /** model → api calls that week */
  calls: Record<string, number>;
  dominant: string;
}

export interface ModelSwitch {
  week: string;
  from: string;
  to: string;
}

export interface ModelReport {
  models: ModelStat[];
  /** Highest API-call share per agent. */
  favorites: Record<string, string>;
  weekly: ModelWeek[];
  switches: ModelSwitch[];
}

/** Monday of the week, YYYY-MM-DD. */
function weekKey(timestamp: string): string {
  const d = new Date(timestamp);
  const day = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() - day);
  return d.toISOString().slice(0, 10);
}

/** Trim date-stamp suffixes for display: claude-haiku-4-5-20251001 → claude-haiku-4-5. */
export function displayModel(model: string): string {
  return model.replace(/-20\d{6}(?=\s|$|\()/, '');
}

export function buildModelReport(sessions: NormalizedSession[]): ModelReport {
  const stats = new Map<string, ModelStat>();
  const weekly = new Map<string, Record<string, number>>();

  for (const session of sessions) {
    const usage = session.modelUsage ?? {};
    for (const [rawModel, u] of Object.entries(usage)) {
      // "<synthetic>" is the harness stamping generated messages, not a model choice
      if (rawModel.startsWith('<')) continue;
      const model = displayModel(rawModel);
      let stat = stats.get(model);
      if (!stat) {
        stat = { model, agent: session.agent, sessions: 0, apiCalls: 0, outputTokens: 0, share: 0 };
        stats.set(model, stat);
      }
      stat.sessions += 1;
      stat.apiCalls += u.apiCalls;
      stat.outputTokens += u.outputTokens;
      if (session.startedAt) {
        if (!stat.firstSeen || session.startedAt < stat.firstSeen) stat.firstSeen = session.startedAt;
        if (!stat.lastSeen || session.startedAt > stat.lastSeen) stat.lastSeen = session.startedAt;
      }
      if (session.startedAt) {
        const week = weekKey(session.startedAt);
        const bucket = weekly.get(week) ?? {};
        bucket[model] = (bucket[model] ?? 0) + u.apiCalls;
        weekly.set(week, bucket);
      }
    }
  }

  const perAgentTotals = new Map<string, number>();
  for (const stat of stats.values()) {
    perAgentTotals.set(stat.agent, (perAgentTotals.get(stat.agent) ?? 0) + stat.apiCalls);
  }
  for (const stat of stats.values()) {
    const total = perAgentTotals.get(stat.agent) ?? 0;
    stat.share = total ? stat.apiCalls / total : 0;
  }

  const favorites: Record<string, string> = {};
  for (const agent of perAgentTotals.keys()) {
    const best = [...stats.values()]
      .filter((s) => s.agent === agent)
      .sort((a, b) => b.apiCalls - a.apiCalls)[0];
    if (best) favorites[agent] = best.model;
  }

  const weeks: ModelWeek[] = [...weekly.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([week, calls]) => ({
      week,
      calls,
      dominant: Object.entries(calls).sort((a, b) => b[1] - a[1])[0]![0],
    }));

  const switches: ModelSwitch[] = [];
  for (let i = 1; i < weeks.length; i++) {
    if (weeks[i]!.dominant !== weeks[i - 1]!.dominant) {
      switches.push({ week: weeks[i]!.week, from: weeks[i - 1]!.dominant, to: weeks[i]!.dominant });
    }
  }

  return {
    models: [...stats.values()].sort((a, b) => b.apiCalls - a.apiCalls),
    favorites,
    weekly: weeks,
    switches,
  };
}

export interface LongRangeModelHistory {
  days: number;
  from: string;
  to: string;
  models: Array<{ model: string; tokens: number; firstActive: string; lastActive: string }>;
  switches: ModelSwitch[];
}

/** Months-deep Claude model history from stats-cache.json's daily token matrix. */
export function buildLongRangeHistory(
  dailyModelTokens: Array<{ date: string; tokensByModel?: Record<string, number> }>,
): LongRangeModelHistory | undefined {
  const days = dailyModelTokens.filter((d) => d.date && d.tokensByModel);
  if (!days.length) return undefined;
  const perModel = new Map<string, { tokens: number; first: string; last: string }>();
  const weekly = new Map<string, Record<string, number>>();
  for (const day of days) {
    for (const [rawModel, tokens] of Object.entries(day.tokensByModel!)) {
      if (rawModel.startsWith('<') || typeof tokens !== 'number' || !tokens) continue;
      const model = displayModel(rawModel);
      const entry = perModel.get(model) ?? { tokens: 0, first: day.date, last: day.date };
      entry.tokens += tokens;
      if (day.date < entry.first) entry.first = day.date;
      if (day.date > entry.last) entry.last = day.date;
      perModel.set(model, entry);
      const week = weekKey(`${day.date}T00:00:00Z`);
      const bucket = weekly.get(week) ?? {};
      bucket[model] = (bucket[model] ?? 0) + tokens;
      weekly.set(week, bucket);
    }
  }
  const weeks = [...weekly.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([week, calls]) => ({ week, dominant: Object.entries(calls).sort((a, b) => b[1] - a[1])[0]![0] }));
  const switches: ModelSwitch[] = [];
  for (let i = 1; i < weeks.length; i++) {
    if (weeks[i]!.dominant !== weeks[i - 1]!.dominant) {
      switches.push({ week: weeks[i]!.week, from: weeks[i - 1]!.dominant, to: weeks[i]!.dominant });
    }
  }
  const sorted = [...days].map((d) => d.date).sort();
  return {
    days: days.length,
    from: sorted[0]!,
    to: sorted.at(-1)!,
    models: [...perModel.entries()]
      .map(([model, e]) => ({ model, tokens: e.tokens, firstActive: e.first, lastActive: e.last }))
      .sort((a, b) => b.tokens - a.tokens),
    switches,
  };
}

export function renderLongRangeHistory(history: LongRangeModelHistory): string {
  const out: string[] = [];
  out.push(`Long-range Claude history (stats-cache, ${history.days} days: ${history.from} → ${history.to}):`);
  out.push(
    table(
      ['model', 'tokens', 'first active', 'last active'],
      history.models.map((m) => [m.model, fmt(m.tokens), m.firstActive, m.lastActive]),
    ),
  );
  if (history.switches.length) {
    out.push('', 'Era changes (weekly dominant by tokens):');
    for (const s of history.switches) out.push(`  week of ${s.week}: ${s.from} → ${s.to}`);
  }
  return out.join('\n');
}

export function renderModelReport(report: ModelReport): string {
  const out: string[] = [];
  if (!report.models.length) return 'No model usage found in scope.';

  out.push('Model usage:');
  out.push(
    table(
      ['model', 'agent', 'sessions', 'api calls', 'share', 'out-tokens', 'first seen', 'last seen'],
      report.models.map((m) => [
        m.model,
        m.agent,
        fmt(m.sessions),
        fmt(m.apiCalls),
        `${(m.share * 100).toFixed(0)}%`,
        fmt(m.outputTokens),
        m.firstSeen?.slice(0, 10) ?? '',
        m.lastSeen?.slice(0, 10) ?? '',
      ]),
    ),
  );

  out.push('', 'Favorites (by API-call share):');
  for (const [agent, model] of Object.entries(report.favorites)) {
    out.push(`  ${agent}: ${model}`);
  }

  if (report.weekly.length > 1) {
    out.push('', 'Weekly dominant model:');
    out.push(
      table(
        ['week of', 'dominant', 'calls', 'also used'],
        report.weekly.slice(-10).map((w) => {
          const sorted = Object.entries(w.calls).sort((a, b) => b[1] - a[1]);
          return [
            w.week,
            w.dominant,
            fmt(sorted[0]![1]),
            sorted.slice(1, 4).map(([m, c]) => `${m} (${fmt(c)})`).join(', '),
          ];
        }),
      ),
    );
  }

  if (report.switches.length) {
    out.push('', 'Switches (weekly dominant changed):');
    for (const s of report.switches) out.push(`  week of ${s.week}: ${s.from} → ${s.to}`);
  }
  out.push('', 'History depth = session retention; raise cleanupPeriodDays (Claude) to remember further back.');
  return out.join('\n');
}
