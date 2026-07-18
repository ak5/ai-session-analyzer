import {
  formatDuration,
  formatNumber as fmt,
  renderTable as table,
  shortId,
  type UsageTotals,
} from '@asa/core';
import type { AnalysisReport } from './analyze.js';

function fmtUsage(u: UsageTotals): string {
  const parts = [`in ${fmt(u.inputTokens)}`, `out ${fmt(u.outputTokens)}`];
  if (u.cacheReadTokens) parts.push(`cache-read ${fmt(u.cacheReadTokens)}`);
  if (u.cacheCreationTokens) parts.push(`cache-write ${fmt(u.cacheCreationTokens)}`);
  if (u.reasoningTokens) parts.push(`reasoning ${fmt(u.reasoningTokens)}`);
  return parts.join(', ');
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
      ` · compactions ${session.compactions} · duration ${formatDuration(totals.durationMs)}`,
  );
  const i = session.interactions;
  if (i.interruptions || i.commands || i.queuedPrompts || i.permissionModeChanges || i.prLinks) {
    const parts: string[] = [];
    if (i.interruptions) parts.push(`interruptions ${i.interruptions}`);
    if (i.commands) parts.push(`slash commands ${i.commands}`);
    if (i.queuedPrompts) parts.push(`queued prompts ${i.queuedPrompts}`);
    if (i.permissionModeChanges) parts.push(`permission-mode changes ${i.permissionModeChanges}`);
    if (i.prLinks) parts.push(`PRs linked ${i.prLinks}`);
    out.push(`human: ${parts.join(' · ')}`);
  }
  out.push(`tokens: ${fmtUsage(session.usage)} — total ${fmt(session.usage.totalTokens)}`);
  const v = session.contentVolume;
  const volumeTotal = v.humanPromptChars + v.harnessInjectedChars + v.toolResultChars;
  if (volumeTotal > 0) {
    const pct = (n: number) => `${((n / volumeTotal) * 100).toFixed(0)}%`;
    out.push(
      `content: human ${fmt(v.humanPromptChars)} chars (${pct(v.humanPromptChars)})` +
        ` · harness ${fmt(v.harnessInjectedChars)} (${pct(v.harnessInjectedChars)})` +
        ` · tool results ${fmt(v.toolResultChars)} (${pct(v.toolResultChars)})`,
    );
  }

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
          formatDuration(a.durationMs),
        ]),
      ),
    );
  }

  if (session.steps.length) {
    const withHead = session.steps.some((s) => s.gitHead);
    out.push('', 'Steps (use the step id with `asa fork --at <id>`):');
    out.push(
      table(
        ['#', 'step id', 'api', 'tools', 'tokens in/out', ...(withHead ? ['head'] : []), 'prompt'],
        session.steps.map((s) => [
          `${s.index + 1}${s.aborted ? '!' : ''}`,
          session.agent === 'claude' ? s.id : shortId(s.id),
          fmt(s.apiCalls),
          fmt(s.toolCalls.length),
          `${fmt(s.usage.inputTokens)}/${fmt(s.usage.outputTokens)}`,
          ...(withHead ? [s.gitHead ? s.gitHead.slice(0, 7) + (s.gitDirtyFiles ? `+${s.gitDirtyFiles}` : '') : ''] : []),
          (s.kind === 'command' ? `${s.commandName ?? '(command)'} ` : '') + (s.promptPreview ?? ''),
        ]),
      ),
    );
    if (session.steps.some((s) => s.aborted)) {
      out.push('  (! = turn was interrupted/aborted)');
    }
  }

  return out.join('\n');
}
