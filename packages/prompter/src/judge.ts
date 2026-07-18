/**
 * Opt-in LLM-judge layer: sample real prompts, ship them to a cheap model via
 * `claude -p` for a qualitative read, merge grades into the report.
 *
 * Deliberate choices:
 * - Spawns the claude CLI (same wrapping philosophy as resume/fork) rather
 *   than an SDK, so it uses whatever auth the user's claude already has.
 * - `--no-session-persistence` so judging doesn't pollute the very session
 *   store this tool analyzes.
 * - One batched call, prompts truncated — cost stays a fraction of a cent.
 * - Prompts leave the machine (to the user's own Anthropic account); that is
 *   why this only runs behind the explicit --deep flag.
 */
import { execFile } from 'node:child_process';
import type { StepSignal } from './stats.js';

export interface JudgeSample {
  id: string;
  prompt: string;
  correctedByNext: boolean;
  toolCalls: number;
}

export interface JudgeGrade {
  id: string;
  /** 1–5: could a competent stranger act on this without guessing? */
  clarity: number;
  /** 1–5: does it carry the context the agent needed? */
  context: number;
  tip: string;
}

export interface JudgeResult {
  model: string;
  samples: number;
  avgClarity?: number;
  avgContext?: number;
  grades: JudgeGrade[];
}

export type JudgeRunner = (prompt: string, model: string) => Promise<string>;

const defaultRunner: JudgeRunner = (prompt, model) =>
  new Promise((resolve, reject) => {
    const child = execFile(
      'claude',
      ['-p', '--model', model, '--no-session-persistence', prompt],
      { timeout: 120_000, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) =>
        err ? reject(new Error(stderr.trim() || err.message)) : resolve(stdout),
    );
    // never leave a piped stdin dangling for CLIs that wait on it
    child.stdin?.end();
  });

/** Corrected-then-longest sampling: failure cases first, then the big briefs. */
export function selectJudgeSamples(signals: StepSignal[], limit: number): JudgeSample[] {
  const seen = new Set<string>();
  const picked: StepSignal[] = [];
  const push = (s: StepSignal) => {
    const key = `${s.sessionId}:${s.stepId}`;
    if (!seen.has(key) && picked.length < limit) {
      seen.add(key);
      picked.push(s);
    }
  };
  signals.filter((s) => s.correctedByNext).forEach(push);
  [...signals].sort((a, b) => b.features.chars - a.features.chars).forEach(push);
  return picked.map((s, i) => ({
    id: `p${i + 1}`,
    prompt: s.promptExcerpt,
    correctedByNext: s.correctedByNext,
    toolCalls: s.toolCalls,
  }));
}

function buildJudgePrompt(samples: JudgeSample[]): string {
  return [
    'You are reviewing prompts a developer typed to a coding agent (Claude Code / Codex CLI).',
    'For each prompt, grade:',
    '- clarity (1-5): could a competent stranger act on it without guessing the goal?',
    '- context (1-5): does it carry the needed anchors (files, names, constraints)?',
    'And give one terse, concrete improvement tip (max 15 words). `correctedByNext: true` means the developer had to correct the agent right after — factor that in.',
    '',
    'Respond with ONLY a JSON array, no prose, no code fences:',
    '[{"id":"p1","clarity":3,"context":2,"tip":"..."}]',
    '',
    `Prompts: ${JSON.stringify(samples)}`,
  ].join('\n');
}

function parseGrades(stdout: string, sampleIds: Set<string>): JudgeGrade[] {
  const start = stdout.indexOf('[');
  const end = stdout.lastIndexOf(']');
  if (start < 0 || end <= start) throw new Error(`judge returned no JSON array: ${stdout.slice(0, 200)}`);
  const parsed: unknown = JSON.parse(stdout.slice(start, end + 1));
  if (!Array.isArray(parsed)) throw new Error('judge output is not an array');
  return parsed
    .filter(
      (g): g is JudgeGrade =>
        typeof g === 'object' &&
        g !== null &&
        typeof (g as JudgeGrade).id === 'string' &&
        sampleIds.has((g as JudgeGrade).id) &&
        typeof (g as JudgeGrade).clarity === 'number' &&
        typeof (g as JudgeGrade).context === 'number',
    )
    .map((g) => ({ ...g, tip: typeof g.tip === 'string' ? g.tip : '' }));
}

export async function judgePrompts(
  samples: JudgeSample[],
  options: { model?: string; runner?: JudgeRunner } = {},
): Promise<JudgeResult> {
  const model = options.model ?? 'haiku';
  if (!samples.length) return { model, samples: 0, grades: [] };
  const runner = options.runner ?? defaultRunner;
  const stdout = await runner(buildJudgePrompt(samples), model);
  const grades = parseGrades(stdout, new Set(samples.map((s) => s.id)));
  const avg = (xs: number[]) =>
    xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10 : undefined;
  return {
    model,
    samples: samples.length,
    avgClarity: avg(grades.map((g) => g.clarity)),
    avgContext: avg(grades.map((g) => g.context)),
    grades,
  };
}
