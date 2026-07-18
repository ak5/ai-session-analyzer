/**
 * The --suggest layer: ship the deterministic stats plus the template to a
 * model and print its recommendations. Same wrapping philosophy as
 * everything else — spawn the user's own claude/codex binaries.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ASA_INTERNAL_SENTINEL, type DistillStats } from './stats.js';
import { DEFAULT_SUGGEST_TEMPLATE } from './suggest-template.js';

const execFileAsync = promisify(execFile);

export type SuggestBackend = 'claude' | 'codex';

export interface SuggestOptions {
  backend: SuggestBackend;
  /** Model override — passed to claude -p --model; ignored for codex (uses its configured default). */
  model?: string;
  template?: string;
  runner?: (command: string, args: string[]) => Promise<string>;
}

/** Trim stats for the payload: cap list sizes so the call stays cheap. */
export function trimStatsForPayload(stats: DistillStats): DistillStats {
  const cap = <T>(xs: T[], n: number) => xs.slice(0, n);
  return {
    ...stats,
    procedures: cap(stats.procedures, 15),
    questions: cap(stats.questions, 15),
    lessons: cap(stats.lessons, 10),
    toolSequences: cap(stats.toolSequences, 12),
    commandUsage: cap(stats.commandUsage, 20),
  };
}

export function buildSuggestPrompt(stats: DistillStats, template = DEFAULT_SUGGEST_TEMPLATE): string {
  return [
    // sentinel first: sessions created by this very call must be excluded
    // from future distill runs (codex exec always persists a rollout)
    ASA_INTERNAL_SENTINEL,
    template,
    '',
    '## Stats',
    '```json',
    JSON.stringify(trimStatsForPayload(stats), null, 1),
    '```',
  ].join('\n');
}

const defaultRunner = async (command: string, args: string[]): Promise<string> => {
  const { stdout } = await execFileAsync(command, args, {
    timeout: 300_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  return stdout;
};

export function suggestInvocation(backend: SuggestBackend, prompt: string, model?: string): {
  command: string;
  args: string[];
} {
  if (backend === 'claude') {
    return {
      command: 'claude',
      args: ['-p', '--model', model ?? 'claude-fable-5', '--no-session-persistence', prompt],
    };
  }
  return { command: 'codex', args: ['exec', '--skip-git-repo-check', prompt] };
}

/** Run any prompt through a headless claude/codex call. Generic model access for asa features. */
export async function runModel(
  backend: SuggestBackend,
  prompt: string,
  options: { model?: string; runner?: (command: string, args: string[]) => Promise<string> } = {},
): Promise<string> {
  const { command, args } = suggestInvocation(backend, prompt, options.model);
  const runner = options.runner ?? defaultRunner;
  return (await runner(command, args)).trim();
}

export async function runSuggest(stats: DistillStats, options: SuggestOptions): Promise<string> {
  return runModel(options.backend, buildSuggestPrompt(stats, options.template), options);
}
