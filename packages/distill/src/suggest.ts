/**
 * The --suggest layer: ship the deterministic stats plus the template to a
 * model and print its recommendations. Same wrapping philosophy as
 * everything else — spawn the user's own claude/codex binaries.
 */
import { modelInvocation, runModel, type ModelBackend } from '@asa/core';
import { ASA_INTERNAL_SENTINEL, type DistillStats } from './stats.js';
import { DEFAULT_SUGGEST_TEMPLATE } from './suggest-template.js';

// Backwards-compatible aliases: the runner now lives in @asa/core so prompter
// (which distill depends on) can use it too.
export type SuggestBackend = ModelBackend;
export const suggestInvocation = modelInvocation;
export { runModel };

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

export async function runSuggest(stats: DistillStats, options: SuggestOptions): Promise<string> {
  return runModel(options.backend, buildSuggestPrompt(stats, options.template), options);
}
