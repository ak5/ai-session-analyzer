/**
 * Heuristic feature extraction for a single human prompt. Everything here is
 * a cheap, explainable signal — the LLM-judge layer (judge.ts) exists for the
 * nuanced reading. Thresholds and word lists are tuned for developer prompts
 * to coding agents, not general chat.
 */

export interface PromptFeatures {
  chars: number;
  words: number;
  isQuestion: boolean;
  /** Starts like a course-correction of the previous turn ("no, actually…"). */
  isCorrection: boolean;
  hasPath: boolean;
  hasCode: boolean;
  hasEnumeration: boolean;
  /** Every vague-filler occurrence found (duplicates kept for counting). */
  vagueMarkers: string[];
  /** 0–10 composite; see specificityScore for the formula. */
  specificity: number;
}

const VAGUE_MARKERS = [
  'etc',
  'or something',
  'or whatever',
  'somehow',
  'idk',
  'whatever works',
  'and so on',
  'stuff like that',
  'something like that',
  'you know what i mean',
  'or such',
] as const;

const CORRECTION_RE =
  /^(no[,.\s!]|nope\b|wait[,.\s]|actually[,.\s]|not (that|this)\b|that'?s (not|wrong)|i (meant|said)\b|undo\b|revert\b|instead[,.\s]|wrong\b|stop[,.\s!])/i;

const QUESTION_START_RE = /^(how|why|what|which|where|when|who|can|could|should|would|is|are|do|does|did|will)\b/i;

const PATH_RE = /(?:^|[\s"'`(=])(?:~?\/[\w.@-]+(?:\/[\w.@-]+)+|[\w.-]+\/[\w.@-]+(?:\/[\w.@-]+)+|[\w-]+\.(?:ts|tsx|js|jsx|mjs|py|rs|go|rb|java|kt|swift|md|json|jsonl|yaml|yml|toml|css|scss|html|sh|sql))\b/;

const CODE_RE = /`[^`]+`|\b[a-z][a-z0-9]*[A-Z]\w*\b|\b\w+_\w+\b|--[\w-]{2,}\b/;

const ENUMERATION_RE = /(?:^|\n)\s*(?:[-*•]|\d+[.)])\s+\S/;

const IMPERATIVE_RE =
  /^(add|fix|make|write|run|update|refactor|implement|create|remove|delete|rename|move|change|build|test|wire|extract|convert|use|set|show|analyze|scaffold|document|ship|deploy|investigate|check|verify)\b/i;

export function findVagueMarkers(text: string): string[] {
  const lower = text.toLowerCase();
  const found: string[] = [];
  for (const marker of VAGUE_MARKERS) {
    const re = new RegExp(`\\b${marker.replace(/ /g, '\\s+')}\\b`, 'g');
    for (const _ of lower.matchAll(re)) found.push(marker);
  }
  return found;
}

/**
 * 0–10 composite. Starts at 5; anchors (paths, code, enumeration, imperative
 * verb, workable length) add, vagueness subtracts. The absolute number means
 * little — comparisons across your own prompts are the point.
 */
function specificityScore(f: Omit<PromptFeatures, 'specificity'>, text: string): number {
  let score = 5;
  if (f.hasPath) score += 1.5;
  if (f.hasCode) score += 1.5;
  if (f.hasEnumeration) score += 1;
  if (IMPERATIVE_RE.test(text.trim())) score += 1;
  if (f.chars >= 80 && f.chars <= 2000) score += 1;
  if (f.chars < 20) score -= 2;
  score -= Math.min(3, f.vagueMarkers.length);
  return Math.max(0, Math.min(10, Math.round(score * 10) / 10));
}

export function extractPromptFeatures(text: string): PromptFeatures {
  const trimmed = text.trim();
  const partial: Omit<PromptFeatures, 'specificity'> = {
    chars: trimmed.length,
    words: trimmed ? trimmed.split(/\s+/).length : 0,
    isQuestion: /\?\s*$/.test(trimmed) || QUESTION_START_RE.test(trimmed),
    isCorrection: CORRECTION_RE.test(trimmed),
    hasPath: PATH_RE.test(trimmed),
    hasCode: CODE_RE.test(trimmed),
    hasEnumeration: ENUMERATION_RE.test(trimmed),
    vagueMarkers: findVagueMarkers(trimmed),
  };
  return { ...partial, specificity: specificityScore(partial, trimmed) };
}
