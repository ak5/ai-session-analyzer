import type { NormalizedSession, Step } from './index.js';

/**
 * Deterministic context digest for crafted forks (`asa fork --context`).
 *
 * Design informed by how the agents' own compaction behaves (docs/formats.md):
 * Codex keeps user prompts verbatim across compactions and it is the single
 * highest-signal, lowest-cost content in a session (typically ~1% of chars);
 * Claude's native compact paraphrases everything into one summary, losing the
 * literal prompts and conclusions. This digest keeps both verbatim and drops
 * the bulk that resume re-creates anyway (tool results, harness injections).
 * No model call: building it is instant, free, and reproducible.
 */
export interface ContextDigestOptions {
  /** Per-prompt cap, chars (whole prompts are kept up to this). */
  maxPromptChars?: number;
  /** Per-step response-excerpt cap, chars. */
  maxResponseChars?: number;
  /** Steps whose full detail is skipped because they are kept verbatim in the fork. */
  skipStepIds?: Set<string>;
}

/** Reads the assistant's final text for a step (agent-specific implementations). */
export type StepResponseReader = (stepId: string) => Promise<string | undefined>;

const FILE_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit', 'apply_patch']);

function fileTouches(steps: Step[]): string[] {
  const paths = new Set<string>();
  for (const step of steps) {
    for (const call of step.toolCalls) {
      if (!FILE_TOOLS.has(call.name)) continue;
      const input = call.input as { file_path?: string; path?: string } | undefined;
      const p = input?.file_path ?? input?.path;
      if (typeof p === 'string') paths.add(p);
    }
  }
  return [...paths];
}

function cap(text: string, max: number): string {
  const clean = text.trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 1)}…`;
}

export async function buildContextDigest(
  session: NormalizedSession,
  readResponse: StepResponseReader,
  options: ContextDigestOptions = {},
): Promise<string> {
  const maxPrompt = options.maxPromptChars ?? 2000;
  const maxResponse = options.maxResponseChars ?? 600;
  const skip = options.skipStepIds ?? new Set<string>();

  const steps = session.steps.filter((s) => !skip.has(s.id));
  const out: string[] = [];
  out.push(
    'This session continues an earlier conversation, forked with a crafted context ' +
      `(asa fork --context) from session ${session.id}.`,
  );
  const meta: string[] = [`${session.steps.length} steps`];
  if (session.cwd) meta.push(`cwd ${session.cwd}`);
  if (session.gitBranch) meta.push(`branch ${session.gitBranch}`);
  if (session.startedAt) meta.push(`started ${session.startedAt.slice(0, 10)}`);
  out.push(`Original session: ${meta.join(' · ')}.`);
  out.push(
    'Below is the verbatim record of what the human asked and how each step concluded — ' +
      'trust it over memory, and re-read files before editing them: tool outputs were dropped.',
  );

  out.push('', '## The prompts, verbatim');
  for (const step of steps) {
    const label = step.kind === 'command' ? `${step.commandName ?? '(command)'} ` : '';
    const text = step.promptText ?? step.promptPreview;
    if (!text && !label) continue;
    const aborted = step.aborted ? ' [interrupted]' : '';
    out.push(`${step.index + 1}.${aborted} ${label}${cap(text ?? '', maxPrompt)}`);
  }

  out.push('', '## How each step concluded');
  for (const step of steps) {
    const response = await readResponse(step.id);
    if (!response) continue;
    out.push(`${step.index + 1}. ${cap(response, maxResponse)}`);
  }

  const files = fileTouches(steps);
  if (files.length) {
    out.push('', '## Files created or edited (re-read before touching)');
    for (const f of files) out.push(`- ${f}`);
  }

  const heads = steps
    .map((s) => s.gitHead)
    .filter((h, i, arr): h is string => !!h && arr.indexOf(h) === i);
  if (heads.length) {
    out.push('', `## Git heads seen (chronological): ${heads.map((h) => h.slice(0, 7)).join(' → ')}`);
  }

  return out.join('\n');
}

/** Rough token estimate used for crafted-fork bookkeeping (chars/4 heuristic). */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
