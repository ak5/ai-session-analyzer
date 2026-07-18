/**
 * docs/dev-faq.md distillation: recurring question clusters + the answers the
 * transcripts already contain (extraction, not generation — the answer was
 * paid for once). Regeneration is idempotent and edit-preserving: entries are
 * keyed by a stable question hash in an HTML-comment marker; existing keys are
 * never rewritten, new questions append, nothing is ever deleted.
 */
import { createHash } from 'node:crypto';
import { previewText } from '@asa/core';
import { tokenize, type PromptCluster } from './cluster.js';

export interface FaqEntry {
  key: string;
  question: string;
  answer: string;
  askedCount: number;
  sessionCount: number;
  sourceSession: string;
  lastSeen?: string;
}

/** Stable id from the question's token set — survives rephrasings that cluster together. */
export function questionKey(representative: string): string {
  const tokens = [...tokenize(representative)].sort().join(' ');
  return createHash('sha256').update(tokens).digest('hex').slice(0, 12);
}

const ANSWER_CAP = 1500;

export function buildFaqEntry(
  cluster: PromptCluster,
  answer: string,
  sourceSession: string,
): FaqEntry {
  return {
    key: questionKey(cluster.representative),
    question: cluster.representative,
    answer: answer.length > ANSWER_CAP ? `${answer.slice(0, ANSWER_CAP)}…` : answer,
    askedCount: cluster.count,
    sessionCount: cluster.sessions.length,
    sourceSession,
    lastSeen: cluster.lastSeen,
  };
}

function renderEntry(entry: FaqEntry): string {
  const meta = `asked ${entry.askedCount}× across ${entry.sessionCount} sessions; distilled from session ${entry.sourceSession.slice(0, 8)}${entry.lastSeen ? `, last ${entry.lastSeen.slice(0, 10)}` : ''}`;
  return [
    `<!-- asa-faq ${entry.key} — edit freely; asa never rewrites this entry -->`,
    `## ${previewText(entry.question, 120)}`,
    '',
    entry.answer,
    '',
    `_${meta}_`,
    '<!-- /asa-faq -->',
  ].join('\n');
}

const HEADER = `# Dev FAQ

Distilled by \`asa distill --faq\` from questions asked repeatedly across agent
sessions, with answers extracted from the transcripts. Edit entries freely —
regeneration only appends new questions, never rewrites existing ones.
`;

export interface FaqMergeResult {
  content: string;
  added: string[];
  kept: number;
}

export function mergeFaq(existing: string | undefined, entries: FaqEntry[]): FaqMergeResult {
  const existingKeys = new Set(
    [...(existing ?? '').matchAll(/<!-- asa-faq (\S+)/g)].map((m) => m[1]!),
  );
  const fresh = entries.filter((e) => !existingKeys.has(e.key));
  const base = existing?.trimEnd() ? existing.trimEnd() + '\n' : HEADER;
  const content = fresh.length
    ? base + '\n' + fresh.map(renderEntry).join('\n\n') + '\n'
    : (existing ?? HEADER);
  return {
    content,
    added: fresh.map((e) => previewText(e.question, 60)),
    kept: existingKeys.size,
  };
}
