import type { NormalizedSession, ToolCall } from '@asa/core';

export interface ToolStat {
  name: string;
  count: number;
  errors: number;
  isMcp: boolean;
  mcpServer?: string;
}

export interface McpServerStat {
  server: string;
  calls: number;
}

export interface AnalysisReport {
  session: NormalizedSession;
  totals: {
    steps: number;
    apiCalls: number;
    toolCalls: number;
    mcpCalls: number;
    toolErrors: number;
    subagents: number;
    durationMs?: number;
  };
  toolStats: ToolStat[];
  mcpServers: McpServerStat[];
}

function allToolCalls(session: NormalizedSession): ToolCall[] {
  return session.steps.flatMap((s) => s.toolCalls);
}

export function analyzeSession(session: NormalizedSession): AnalysisReport {
  const calls = allToolCalls(session);
  const byName = new Map<string, ToolStat>();
  const byServer = new Map<string, number>();
  for (const call of calls) {
    let stat = byName.get(call.name);
    if (!stat) {
      stat = { name: call.name, count: 0, errors: 0, isMcp: call.isMcp, mcpServer: call.mcpServer };
      byName.set(call.name, stat);
    }
    stat.count += 1;
    if (call.isError) stat.errors += 1;
    if (call.isMcp && call.mcpServer) {
      byServer.set(call.mcpServer, (byServer.get(call.mcpServer) ?? 0) + 1);
    }
  }

  let durationMs: number | undefined;
  if (session.startedAt && session.endedAt) {
    const span = Date.parse(session.endedAt) - Date.parse(session.startedAt);
    if (Number.isFinite(span) && span >= 0) durationMs = span;
  }

  return {
    session,
    totals: {
      steps: session.steps.length,
      apiCalls: session.steps.reduce((n, s) => n + s.apiCalls, 0),
      toolCalls: calls.length,
      mcpCalls: calls.filter((c) => c.isMcp).length,
      toolErrors: calls.filter((c) => c.isError).length,
      subagents: session.subagents.length,
      durationMs,
    },
    toolStats: [...byName.values()].sort((a, b) => b.count - a.count),
    mcpServers: [...byServer.entries()]
      .map(([server, count]) => ({ server, calls: count }))
      .sort((a, b) => b.calls - a.calls),
  };
}
