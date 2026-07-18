/**
 * Session intent classification. Deterministic keyword heuristic by default;
 * --deep sharpens labels and names cross-session themes via one batched
 * model call (same runner as distill --suggest). The reportable insight is
 * less the taxonomy than the joins: intent mix per repo, and recurring
 * themes with zero linked PRs — asked repeatedly, never shipped.
 */
import { previewText, type NormalizedSession } from '@asa/core';
import { ASA_INTERNAL_SENTINEL, runModel, type SuggestBackend } from '@asa/distill';

export type IntentKind = 'feature' | 'bugfix' | 'refactor' | 'research' | 'ops' | 'learning' | 'other';

export interface SessionIntent {
  sessionId: string;
  agent: string;
  cwd?: string;
  title?: string;
  startedAt?: string;
  firstPrompt: string;
  intent: IntentKind;
  prLinks: number;
}

export interface IntentReport {
  sessions: SessionIntent[];
  byIntent: Record<string, number>;
  /** Repos whose sessions skew heavily to one intent. */
  byRepo: Array<{ cwd: string; sessions: number; dominant: IntentKind; share: number }>;
  /** LLM-named recurring themes (only with --deep). */
  themes?: Array<{ theme: string; sessions: string[]; shipped: boolean }>;
}

const RULES: Array<[IntentKind, RegExp]> = [
  ['bugfix', /\b(fix|bug|broken|fails?|failing|error|crash|regression|debug)\b/i],
  ['refactor', /\b(refactor|clean\s?up|simplify|restructure|rename|extract|reorganize|migrate)\b/i],
  ['ops', /\b(deploy|release|publish|ci\b|pipeline|docker|infra|server|dns|domain|monitor|backup|cron)\b/i],
  ['learning', /\b(learn|explain|teach|flashcards?|anki|tutorial|study)\b/i],
  ['research', /^(how|why|what|which|where|can|could|should|is|are|do|does)\b|\b(investigate|research|compare|evaluate|brainstorm|analy[sz]e|explore)\b/i],
  ['feature', /\b(add|implement|build|create|scaffold|support|new|write|make|ship|integrate)\b/i],
];

export function classifyIntent(prompt: string): IntentKind {
  for (const [intent, re] of RULES) {
    if (re.test(prompt)) return intent;
  }
  return 'other';
}

function firstHumanPrompt(session: NormalizedSession): string | undefined {
  return session.steps.find((s) => s.kind === 'prompt' && s.promptText?.trim())?.promptText;
}

export function buildIntentReport(sessions: NormalizedSession[]): IntentReport {
  const rows: SessionIntent[] = [];
  for (const session of sessions) {
    const prompt = firstHumanPrompt(session);
    if (!prompt) continue;
    rows.push({
      sessionId: session.id,
      agent: session.agent,
      cwd: session.cwd,
      title: session.title,
      startedAt: session.startedAt,
      firstPrompt: previewText(prompt, 100),
      intent: classifyIntent(prompt),
      prLinks: session.interactions.prLinks,
    });
  }

  const byIntent: Record<string, number> = {};
  for (const row of rows) byIntent[row.intent] = (byIntent[row.intent] ?? 0) + 1;

  const byCwd = new Map<string, SessionIntent[]>();
  for (const row of rows) {
    if (!row.cwd) continue;
    byCwd.set(row.cwd, [...(byCwd.get(row.cwd) ?? []), row]);
  }
  const byRepo = [...byCwd.entries()]
    .filter(([, group]) => group.length >= 2)
    .map(([cwd, group]) => {
      const counts = new Map<IntentKind, number>();
      for (const g of group) counts.set(g.intent, (counts.get(g.intent) ?? 0) + 1);
      const [dominant, count] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]!;
      return { cwd, sessions: group.length, dominant, share: count / group.length };
    })
    .sort((a, b) => b.sessions - a.sessions);

  return { sessions: rows, byIntent, byRepo };
}

interface ThemeResult {
  theme?: unknown;
  sessions?: unknown;
}

/** One batched model call that also refines intents and names cross-session themes. */
export async function deepenIntentReport(
  report: IntentReport,
  backend: SuggestBackend,
  options: { model?: string; runner?: (command: string, args: string[]) => Promise<string> } = {},
): Promise<IntentReport> {
  const payload = report.sessions.map((s) => ({
    id: s.sessionId.slice(0, 8),
    prompt: s.firstPrompt,
    heuristicIntent: s.intent,
  }));
  const prompt = [
    ASA_INTERNAL_SENTINEL,
    'These are opening prompts of a developer\'s AI coding-agent sessions, with a keyword-guessed intent.',
    'Identify recurring THEMES: clusters of sessions pursuing the same underlying goal (not the same category — the same actual thing).',
    'Respond with ONLY a JSON array: [{"theme":"short name","sessions":["id",...]}] — at most 8 themes, each with >= 2 sessions. No prose.',
    '',
    JSON.stringify(payload),
  ].join('\n');
  const stdout = await runModel(backend, prompt, options);
  const start = stdout.indexOf('[');
  const end = stdout.lastIndexOf(']');
  if (start < 0 || end <= start) throw new Error(`intent themes: no JSON array in model output`);
  const parsed = JSON.parse(stdout.slice(start, end + 1)) as ThemeResult[];
  const byShortId = new Map(report.sessions.map((s) => [s.sessionId.slice(0, 8), s]));
  const themes = parsed
    .filter((t) => typeof t.theme === 'string' && Array.isArray(t.sessions))
    .map((t) => {
      const members = (t.sessions as unknown[])
        .filter((id): id is string => typeof id === 'string')
        .filter((id) => byShortId.has(id));
      return {
        theme: t.theme as string,
        sessions: members,
        shipped: members.some((id) => (byShortId.get(id)?.prLinks ?? 0) > 0),
      };
    })
    .filter((t) => t.sessions.length >= 2);
  return { ...report, themes };
}
