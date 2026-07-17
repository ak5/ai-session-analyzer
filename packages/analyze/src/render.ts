import { shortId, type UsageTotals } from '@asa/core';
import type { AnalysisReport } from './analyze.js';

function fmt(n: number): string {
  return n.toLocaleString('en-US');
}

function fmtDuration(ms?: number): string {
  if (ms === undefined) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

function fmtUsage(u: UsageTotals): string {
  const parts = [`in ${fmt(u.inputTokens)}`, `out ${fmt(u.outputTokens)}`];
  if (u.cacheReadTokens) parts.push(`cache-read ${fmt(u.cacheReadTokens)}`);
  if (u.cacheCreationTokens) parts.push(`cache-write ${fmt(u.cacheCreationTokens)}`);
  if (u.reasoningTokens) parts.push(`reasoning ${fmt(u.reasoningTokens)}`);
  return parts.join(', ');
}

function table(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)),
  );
  const line = (cells: string[]) =>
    cells.map((c, i) => c.padEnd(widths[i]!)).join('  ').trimEnd();
  return [line(headers), line(widths.map((w) => '-'.repeat(w))), ...rows.map(line)].join('\n');
}

export function renderReport(report: AnalysisReport): string {
  const { session, totals } = report;
  const out: string[] = [];

  out.push(`${session.agent} session ${session.id}`);
  if (session.title) out.push(`  title    ${session.title}`);
  if (session.cwd) out.push(`  cwd      ${session.cwd}`);
  if (session.gitBranch) out.push(`  branch   ${session.gitBranch}`);
  if (session.models.length) out.push(`  model    ${session.models.join(', ')}`);
  if (session.cliVersion) out.push(`  cli      ${session.cliVersion}`);
  if (session.forkedFromId) out.push(`  fork of  ${session.forkedFromId}`);
  out.push(`  file     ${session.filePath}`);
  out.push('');
  out.push(
    `steps ${totals.steps} · api calls ${totals.apiCalls} · tool calls ${totals.toolCalls}` +
      ` (${totals.mcpCalls} mcp, ${totals.toolErrors} errors) · subagents ${totals.subagents}` +
      ` · compactions ${session.compactions} · duration ${fmtDuration(totals.durationMs)}`,
  );
  out.push(`tokens: ${fmtUsage(session.usage)} — total ${fmt(session.usage.totalTokens)}`);

  if (report.toolStats.length) {
    out.push('', 'Tools:');
    out.push(
      table(
        ['tool', 'calls', 'errors', 'mcp server'],
        report.toolStats.map((t) => [t.name, fmt(t.count), fmt(t.errors), t.mcpServer ?? '']),
      ),
    );
  }

  if (report.mcpServers.length) {
    out.push('', 'MCP servers:');
    out.push(
      table(
        ['server', 'calls'],
        report.mcpServers.map((s) => [s.server, fmt(s.calls)]),
      ),
    );
  }

  if (session.subagents.length) {
    out.push('', 'Subagents:');
    out.push(
      table(
        ['id', 'type', 'tokens', 'tool calls', 'duration'],
        session.subagents.map((a) => [
          a.id,
          a.agentType ?? '',
          a.totalTokens !== undefined ? fmt(a.totalTokens) : '',
          a.toolUseCount !== undefined ? fmt(a.toolUseCount) : '',
          fmtDuration(a.durationMs),
        ]),
      ),
    );
  }

  if (session.steps.length) {
    out.push('', 'Steps (use the step id with `asa fork --at <id>`):');
    out.push(
      table(
        ['#', 'step id', 'api', 'tools', 'tokens in/out', 'prompt'],
        session.steps.map((s) => [
          String(s.index + 1),
          session.agent === 'claude' ? s.id : shortId(s.id),
          fmt(s.apiCalls),
          fmt(s.toolCalls.length),
          `${fmt(s.usage.inputTokens)}/${fmt(s.usage.outputTokens)}`,
          s.promptPreview ?? '',
        ]),
      ),
    );
  }

  return out.join('\n');
}
