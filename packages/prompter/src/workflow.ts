/**
 * Session-workflow hygiene: compaction pressure and git discipline.
 *
 * Two theses, both checkable from the transcripts:
 * - Compactions are a smell that sessions run too long. Each one burns a
 *   cache rebuild and lossily summarizes history — smaller focused sessions
 *   (or `asa fork --at`) beat one compacted monolith.
 * - Work that surfaces in a session but never lands in git/GitHub (commits,
 *   branches, issues, PRs) survives only as transcript prose — invisible to
 *   every tool the developer actually tracks work with.
 */
import { toolCommandText, type NormalizedSession } from '@asa/core';
import type { LintFinding } from './stats.js';

export interface SessionWorkflow {
  sessionId: string;
  agent: string;
  steps: number;
  totalTokens: number;
  compactions: number;
  compactionsAuto: number;
  compactionsManual: number;
  /** Largest recorded pre-compaction context, when the format records it. */
  maxPreCompactTokens?: number;
  gitCommits: number;
  gitPushes: number;
  /** Branch creations: checkout -b / switch -c / worktree add. */
  gitBranchOps: number;
  ghIssueOps: number;
  ghPrOps: number;
  fileEdits: number;
  branch?: string;
  onDefaultBranch: boolean;
  prLinks: number;
}

export interface WorkflowReport {
  sessions: SessionWorkflow[];
  totals: {
    sessionsWithCompactions: number;
    compactions: number;
    autoShare?: number;
    sessionsCommitting: number;
    sessionsEditingWithoutCommit: number;
  };
  lints: LintFinding[];
}

const EDIT_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit']);

export function sessionWorkflow(session: NormalizedSession): SessionWorkflow {
  const events = session.compactionEvents ?? [];
  let gitCommits = 0;
  let gitPushes = 0;
  let gitBranchOps = 0;
  let ghIssueOps = 0;
  let ghPrOps = 0;
  let fileEdits = 0;

  for (const step of session.steps) {
    for (const call of step.toolCalls) {
      if (EDIT_TOOLS.has(call.name)) fileEdits += 1;
      if (typeof call.input === 'string' && call.input.includes('*** Begin Patch')) fileEdits += 1;
      const command = toolCommandText(call);
      if (!command) continue;
      if (/\bgit\b[^|;&]*\bcommit\b/.test(command)) gitCommits += 1;
      if (/\bgit\b[^|;&]*\bpush\b/.test(command)) gitPushes += 1;
      if (/\bgit\s+(checkout\s+-b|switch\s+-c|worktree\s+add)\b/.test(command)) gitBranchOps += 1;
      if (/\bgh\s+issue\s+(create|edit|comment)\b/.test(command)) ghIssueOps += 1;
      if (/\bgh\s+pr\s+(create|merge|edit)\b/.test(command)) ghPrOps += 1;
    }
  }

  const branch = session.gitBranch;
  const preTokens = events.map((e) => e.preTokens).filter((t): t is number => t !== undefined);
  return {
    sessionId: session.id,
    agent: session.agent,
    steps: session.steps.length,
    totalTokens: session.usage.totalTokens,
    compactions: session.compactions,
    compactionsAuto: events.filter((e) => e.trigger === 'auto').length,
    compactionsManual: events.filter((e) => e.trigger === 'manual').length,
    maxPreCompactTokens: preTokens.length ? Math.max(...preTokens) : undefined,
    gitCommits,
    gitPushes,
    gitBranchOps,
    ghIssueOps,
    ghPrOps,
    fileEdits,
    branch,
    onDefaultBranch: branch === 'main' || branch === 'master',
    prLinks: session.interactions.prLinks,
  };
}

export function buildWorkflowReport(sessions: NormalizedSession[]): WorkflowReport {
  const rows = sessions.map(sessionWorkflow);
  const compacted = rows.filter((r) => r.compactions > 0);
  const compactions = rows.reduce((n, r) => n + r.compactions, 0);
  const autoTotal = rows.reduce((n, r) => n + r.compactionsAuto, 0);
  const knownTrigger = autoTotal + rows.reduce((n, r) => n + r.compactionsManual, 0);
  const editingNoCommit = rows.filter((r) => r.fileEdits >= 10 && r.gitCommits === 0);

  const lints: LintFinding[] = [];
  const example = (r: SessionWorkflow) => `${r.agent} ${r.sessionId.slice(0, 8)}`;

  if (compacted.length) {
    const biggest = Math.max(...compacted.map((r) => r.maxPreCompactTokens ?? 0));
    lints.push({
      rule: 'compact-heavy',
      severity: 'warn',
      message:
        `${compacted.length}/${rows.length} sessions hit compaction (${compactions} total` +
        `${knownTrigger ? `, ${Math.round((autoTotal / knownTrigger) * 100)}% auto` : ''}` +
        `${biggest ? `, largest pre-compact context ${biggest.toLocaleString('en-US')} tokens` : ''}) — ` +
        'each one lossily summarizes history and rebuilds the cache. Prefer smaller focused sessions: ' +
        '/clear between tasks, or `asa fork --at <step>` to branch a long session instead of continuing it.',
      examples: compacted.slice(0, 3).map((r) => `${example(r)} (${r.compactions}×)`),
    });
  }
  if (editingNoCommit.length) {
    lints.push({
      rule: 'uncommitted-work',
      severity: 'warn',
      message:
        `${editingNoCommit.length} sessions made 10+ file edits with zero in-session git commits — ` +
        'that work exists only in the working tree and the transcript. Commit (or have the agent commit) before the session ends.',
      examples: editingNoCommit.slice(0, 3).map((r) => `${example(r)} (${r.fileEdits} edits)`),
    });
  }
  const mainlineEditors = rows.filter(
    (r) => r.onDefaultBranch && r.fileEdits >= 10 && r.gitBranchOps === 0,
  );
  if (mainlineEditors.length) {
    lints.push({
      rule: 'mainline-editing',
      severity: 'info',
      message: `${mainlineEditors.length} sessions edited heavily directly on main/master without creating a branch — feature branches make agent work reviewable and revertable.`,
      examples: mainlineEditors.slice(0, 3).map(example),
    });
  }
  const untracked = rows.filter(
    (r) => r.steps >= 10 && r.gitCommits === 0 && r.prLinks === 0 && r.ghIssueOps === 0 && r.ghPrOps === 0,
  );
  if (untracked.length) {
    lints.push({
      rule: 'untracked-outcomes',
      severity: 'info',
      message:
        `${untracked.length} long sessions (10+ steps) produced no commit, PR, or issue — ` +
        'decisions and follow-ups from them live only in the transcript. End long sessions by filing what came up (`gh issue create`) so it survives.',
      examples: untracked.slice(0, 3).map((r) => `${example(r)} (${r.steps} steps)`),
    });
  }
  if (!lints.length) {
    lints.push({
      rule: 'all-clear',
      severity: 'info',
      message: 'No workflow-hygiene thresholds tripped in this scope.',
      examples: [],
    });
  }

  return {
    sessions: rows,
    totals: {
      sessionsWithCompactions: compacted.length,
      compactions,
      autoShare: knownTrigger ? autoTotal / knownTrigger : undefined,
      sessionsCommitting: rows.filter((r) => r.gitCommits > 0).length,
      sessionsEditingWithoutCommit: editingNoCommit.length,
    },
    lints,
  };
}
