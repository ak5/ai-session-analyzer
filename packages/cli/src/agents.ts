/**
 * Agent registry: everything the CLI knows about a supported agent lives in
 * one adapter. Adding an agent (OpenCode, Gemini CLI, …) means:
 *   1. a @asa/<agent>-sessions package that discovers session files and
 *      normalizes them to @asa/core's NormalizedSession,
 *   2. an AgentAdapter entry here (flag letter, binary, resume/fork args),
 *   3. extending AgentKind in @asa/core.
 * list/analyze/resume/fork/prompter then pick it up automatically.
 */
import type { AgentKind, NormalizedSession, SessionRef } from '@asa/core';
import {
  findClaudeSession,
  forkClaudeSessionAtStep,
  listClaudeSessions,
  loadClaudeSession,
  readClaudeSessionCwd,
  type ForkAtStepResult,
} from '@asa/claude-sessions';
import {
  findCodexSession,
  forkCodexSessionAtStep,
  listCodexSessions,
  loadCodexSession,
  readCodexSessionCwd,
} from '@asa/codex-sessions';

export interface CliInvocation {
  command: string;
  args: string[];
}

export interface AgentAdapter {
  kind: AgentKind;
  /** Long option name (`--claude`) and the value accepted by --agent filters. */
  flag: string;
  /** Short option letter (`-c`). */
  short: string;
  list(): Promise<SessionRef[]>;
  find(idOrPrefix: string): Promise<SessionRef | undefined>;
  load(filePath: string): Promise<NormalizedSession>;
  /** Real cwd from the session file header (cheap — reads a few lines). */
  cwd(ref: SessionRef): Promise<string | undefined>;
  resume(id: string, prompt?: string): CliInvocation;
  fork(id: string, prompt?: string): CliInvocation;
  /** Present when the agent supports forking at a step (transcript truncation). */
  forkAtStep?(filePath: string, stepId: string): Promise<ForkAtStepResult>;
}

const claudeAgent: AgentAdapter = {
  kind: 'claude',
  flag: 'claude',
  short: 'c',
  list: () => listClaudeSessions(),
  find: (id) => findClaudeSession(id),
  load: (filePath) => loadClaudeSession(filePath),
  cwd: (ref) => readClaudeSessionCwd(ref.filePath),
  resume: (id, prompt) => ({
    command: 'claude',
    args: prompt ? ['-p', '--resume', id, prompt] : ['--resume', id],
  }),
  fork: (id, prompt) => ({
    command: 'claude',
    args: prompt
      ? ['-p', '--resume', id, '--fork-session', prompt]
      : ['--resume', id, '--fork-session'],
  }),
  forkAtStep: forkClaudeSessionAtStep,
};

// -o as in OpenAI: -c was taken and codex/claude collide on every other letter.
const codexAgent: AgentAdapter = {
  kind: 'codex',
  flag: 'codex',
  short: 'o',
  list: () => listCodexSessions(),
  find: (id) => findCodexSession(id),
  load: (filePath) => loadCodexSession(filePath),
  cwd: (ref) => readCodexSessionCwd(ref.filePath),
  resume: (id, prompt) => ({
    command: 'codex',
    args: prompt ? ['exec', 'resume', id, prompt] : ['resume', id],
  }),
  fork: (id, prompt) => ({ command: 'codex', args: prompt ? ['fork', id, prompt] : ['fork', id] }),
  forkAtStep: forkCodexSessionAtStep,
};

export const AGENTS: AgentAdapter[] = [claudeAgent, codexAgent];

export const AGENT_FILTER_VALUES = ['all', ...AGENTS.map((a) => a.flag)].join(' | ');

/** "--claude <id> (-c) or --codex <id> (-o)" — for error messages. */
export const SELECTOR_HINT = AGENTS.map((a) => `--${a.flag} <id> (-${a.short})`).join(' or ');

export function agentsForFilter(filter: string): AgentAdapter[] {
  if (filter === 'all') return AGENTS;
  const matched = AGENTS.filter((a) => a.flag === filter);
  if (!matched.length) throw new Error(`Unknown --agent "${filter}" — use ${AGENT_FILTER_VALUES}`);
  return matched;
}
