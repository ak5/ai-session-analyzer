/**
 * Cross-session prompt clustering. Deliberately embedding-free: token-set
 * Jaccard over stopword-stripped prompts is enough to catch "I typed
 * roughly this again" at personal-history scale, is deterministic, and
 * costs nothing. The LLM layer (--suggest) does the nuanced reading.
 */
import type { StepSignal } from '@asa/prompter';

const STOPWORDS = new Set(
  'the a an and or but if then else for to of in on at with without from into is are was were be been do does did can could should would will just also this that these those it its my our your we you i me etc'.split(
    ' ',
  ),
);

export function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 2 && !STOPWORDS.has(w)),
  );
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let intersection = 0;
  for (const token of a) if (b.has(token)) intersection += 1;
  return intersection / (a.size + b.size - intersection);
}

export type ClusterKind = 'question' | 'correction' | 'directive';

export interface ClusterMemberRef {
  agent: string;
  sessionId: string;
  stepId: string;
  timestamp?: string;
}

export interface PromptCluster {
  kind: ClusterKind;
  /** Preview of the longest member — the fullest phrasing of the recurring ask. */
  representative: string;
  count: number;
  sessions: string[];
  agents: string[];
  totalOutputTokens: number;
  totalToolCalls: number;
  examples: string[];
  /** Up to 5 member (session, step) refs — enough to re-read answers from transcripts. */
  memberRefs: ClusterMemberRef[];
  firstSeen?: string;
  lastSeen?: string;
}

interface WorkingCluster {
  kind: ClusterKind;
  tokens: Set<string>;
  members: StepSignal[];
}

function kindOf(signal: StepSignal): ClusterKind {
  if (signal.features.isCorrection) return 'correction';
  if (signal.features.isQuestion) return 'question';
  return 'directive';
}

export interface ClusterOptions {
  /** Jaccard threshold to join a cluster. */
  similarity?: number;
  /** Prompts shorter than this are noise ("ok", "yes", "do it"). */
  minChars?: number;
}

/**
 * Greedy clustering, longest prompts first (so representatives are the
 * fullest phrasing). Only clusters spanning >= 2 sessions are returned:
 * within-session repetition is conversation, cross-session repetition is
 * a missing skill/doc.
 */
export function clusterPrompts(signals: StepSignal[], options: ClusterOptions = {}): PromptCluster[] {
  const threshold = options.similarity ?? 0.45;
  const minChars = options.minChars ?? 15;
  const clusters: WorkingCluster[] = [];

  const eligible = signals
    .filter((s) => s.kind === 'prompt' && s.features.chars >= minChars)
    .sort((a, b) => b.features.chars - a.features.chars);

  for (const signal of eligible) {
    const kind = kindOf(signal);
    const tokens = tokenize(signal.promptExcerpt);
    if (!tokens.size) continue;
    const home = clusters.find((c) => c.kind === kind && jaccard(c.tokens, tokens) >= threshold);
    if (home) {
      home.members.push(signal);
    } else {
      clusters.push({ kind, tokens, members: [signal] });
    }
  }

  return clusters
    .filter((c) => c.members.length >= 2 && new Set(c.members.map((m) => m.sessionId)).size >= 2)
    .map((c) => {
      const timestamps = c.members.map((m) => m.timestamp).filter((t): t is string => !!t).sort();
      return {
        kind: c.kind,
        representative: c.members[0]!.promptPreview,
        count: c.members.length,
        sessions: [...new Set(c.members.map((m) => m.sessionId))],
        agents: [...new Set(c.members.map((m) => m.agent))],
        totalOutputTokens: c.members.reduce((n, m) => n + m.outputTokens, 0),
        totalToolCalls: c.members.reduce((n, m) => n + m.toolCalls, 0),
        examples: c.members.slice(0, 3).map((m) => m.promptPreview),
        memberRefs: c.members.slice(0, 5).map((m) => ({
          agent: m.agent,
          sessionId: m.sessionId,
          stepId: m.stepId,
          timestamp: m.timestamp,
        })),
        firstSeen: timestamps[0],
        lastSeen: timestamps.at(-1),
      };
    })
    .sort((a, b) => b.count - a.count);
}
