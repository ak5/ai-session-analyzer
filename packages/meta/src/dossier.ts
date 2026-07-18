/**
 * Project dossier: everything asa knows about one repo — its sessions
 * (both agents), aggregate spend and steering metrics, tool/MCP profile,
 * context-tax split, and an inventory of the instruction surfaces
 * (CLAUDE.md, AGENTS.md, skills, FAQ, hooks) that shape agent behavior there.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  addUsage,
  emptyContentVolume,
  emptyUsage,
  type ContentVolume,
  type NormalizedSession,
  type UsageTotals,
} from '@asa/core';
import { analyzeSession, type ToolStat } from '@asa/analyze';

export interface InstructionFile {
  path: string;
  exists: boolean;
  sizeBytes?: number;
  modifiedAt?: string;
  /** Commits touching this file (git log --follow), when in a git repo. */
  commits?: number;
  lastCommitAt?: string;
}

export interface ProjectDossier {
  path: string;
  sessions: {
    total: number;
    perAgent: Record<string, number>;
    firstAt?: string;
    lastAt?: string;
  };
  usage: UsageTotals;
  totals: {
    steps: number;
    apiCalls: number;
    toolCalls: number;
    toolErrors: number;
    mcpCalls: number;
    subagents: number;
    interruptions: number;
    corrections: number;
    commands: number;
    prLinks: number;
    compactions: number;
  };
  contentVolume: ContentVolume;
  topTools: ToolStat[];
  mcpServers: { server: string; calls: number }[];
  instructionFiles: InstructionFile[];
  recentSessions: Array<{
    agent: string;
    id: string;
    title?: string;
    startedAt?: string;
    steps: number;
    totalTokens: number;
  }>;
}

function gitFileHistory(repoPath: string, file: string): { commits?: number; lastCommitAt?: string } {
  const log = spawnSync('git', ['log', '--follow', '--format=%cI', '--', file], { cwd: repoPath });
  if (log.status !== 0) return {};
  const dates = log.stdout.toString().trim().split('\n').filter(Boolean);
  return dates.length ? { commits: dates.length, lastCommitAt: dates[0] } : { commits: 0 };
}

export function inventoryInstructionFiles(repoPath: string): InstructionFile[] {
  const candidates = ['CLAUDE.md', 'AGENTS.md', '.claude/settings.json', 'docs/dev-faq.md'];
  const skillsDir = join(repoPath, '.claude', 'skills');
  const files: InstructionFile[] = candidates.map((rel) => {
    const full = join(repoPath, rel);
    if (!existsSync(full)) return { path: rel, exists: false };
    const info = statSync(full);
    return {
      path: rel,
      exists: true,
      sizeBytes: info.size,
      modifiedAt: info.mtime.toISOString(),
      ...gitFileHistory(repoPath, rel),
    };
  });
  if (existsSync(skillsDir)) {
    const count = readdirSync(skillsDir, { withFileTypes: true }).filter((e) => e.isDirectory()).length;
    files.push({ path: `.claude/skills (${count} skills)`, exists: true });
  } else {
    files.push({ path: '.claude/skills', exists: false });
  }
  files.push({
    path: '.asa/git-trace.jsonl (asa install-hooks)',
    exists: existsSync(join(repoPath, '.asa', 'git-trace.jsonl')),
  });
  return files;
}

/** Correction count comes from the prompter heuristic — kept dependency-light here. */
export function buildProjectDossier(
  repoPath: string,
  sessions: NormalizedSession[],
  correctionsPerSession: number[],
): ProjectDossier {
  const usage = emptyUsage();
  const volume = emptyContentVolume();
  const perAgent: Record<string, number> = {};
  const toolStats = new Map<string, ToolStat>();
  const mcp = new Map<string, number>();
  const totals = {
    steps: 0,
    apiCalls: 0,
    toolCalls: 0,
    toolErrors: 0,
    mcpCalls: 0,
    subagents: 0,
    interruptions: 0,
    corrections: correctionsPerSession.reduce((a, b) => a + b, 0),
    commands: 0,
    prLinks: 0,
    compactions: 0,
  };
  const timestamps: string[] = [];

  for (const session of sessions) {
    perAgent[session.agent] = (perAgent[session.agent] ?? 0) + 1;
    addUsage(usage, session.usage);
    volume.humanPromptChars += session.contentVolume.humanPromptChars;
    volume.harnessInjectedChars += session.contentVolume.harnessInjectedChars;
    volume.toolResultChars += session.contentVolume.toolResultChars;
    if (session.startedAt) timestamps.push(session.startedAt);

    const report = analyzeSession(session);
    totals.steps += report.totals.steps;
    totals.apiCalls += report.totals.apiCalls;
    totals.toolCalls += report.totals.toolCalls;
    totals.toolErrors += report.totals.toolErrors;
    totals.mcpCalls += report.totals.mcpCalls;
    totals.subagents += report.totals.subagents;
    totals.interruptions += session.interactions.interruptions;
    totals.commands += session.interactions.commands;
    totals.prLinks += session.interactions.prLinks;
    totals.compactions += session.compactions;
    for (const stat of report.toolStats) {
      const existing = toolStats.get(stat.name);
      if (existing) {
        existing.count += stat.count;
        existing.errors += stat.errors;
      } else {
        toolStats.set(stat.name, { ...stat });
      }
    }
    for (const server of report.mcpServers) {
      mcp.set(server.server, (mcp.get(server.server) ?? 0) + server.calls);
    }
  }

  timestamps.sort();
  return {
    path: repoPath,
    sessions: {
      total: sessions.length,
      perAgent,
      firstAt: timestamps[0],
      lastAt: timestamps.at(-1),
    },
    usage,
    totals,
    contentVolume: volume,
    topTools: [...toolStats.values()].sort((a, b) => b.count - a.count).slice(0, 12),
    mcpServers: [...mcp.entries()]
      .map(([server, calls]) => ({ server, calls }))
      .sort((a, b) => b.calls - a.calls),
    instructionFiles: inventoryInstructionFiles(repoPath),
    recentSessions: sessions
      .slice()
      .sort((a, b) => (b.startedAt ?? '').localeCompare(a.startedAt ?? ''))
      .slice(0, 10)
      .map((s) => ({
        agent: s.agent,
        id: s.id,
        title: s.title,
        startedAt: s.startedAt,
        steps: s.steps.length,
        totalTokens: s.usage.totalTokens,
      })),
  };
}
