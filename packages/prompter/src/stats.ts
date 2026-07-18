import { previewText, type AgentKind, type NormalizedSession } from '@asa/core';
import { extractPromptFeatures, type PromptFeatures } from './features.js';

/** One prompt-bearing step, flattened for aggregation. */
export interface StepSignal {
  agent: AgentKind;
  sessionId: string;
  stepId: string;
  index: number;
  timestamp?: string;
  kind: 'prompt' | 'command';
  commandName?: string;
  promptPreview: string;
  /** Longer slice of the prompt (600 chars) for the LLM-judge layer. */
  promptExcerpt: string;
  features: PromptFeatures;
  /** ms since the previous prompt-bearing step of the same session. */
  gapMs?: number;
  outputTokens: number;
  toolCalls: number;
  apiCalls: number;
  aborted: boolean;
  /** The next prompt in this session opened with a correction. */
  correctedByNext: boolean;
}

export interface SessionPrompterStats {
  agent: AgentKind;
  id: string;
  title?: string;
  cwd?: string;
  startedAt?: string;
  steps: number;
  corrections: number;
  interruptions: number;
  commands: number;
  queuedPrompts: number;
  prLinks: number;
  promptChars: number;
  avgPromptChars: number;
  avgSpecificity?: number;
  vagueCount: number;
  outputTokens: number;
  toolCalls: number;
  /** Agent output tokens per 1,000 chars of prompt — the leverage ratio. */
  outputTokensPerPromptKChar?: number;
  medianGapMs?: number;
}

export interface Aggregate {
  sessions: number;
  steps: number;
  corrections: number;
  interruptions: number;
  commands: number;
  promptChars: number;
  avgPromptChars: number;
  avgSpecificity?: number;
  vaguePerTenPrompts: number;
  correctionRate: number;
  interruptionRate: number;
  outputTokensPerPromptKChar?: number;
  toolCallsPerStep: number;
  stepsPerSession: number;
}

export interface Archetype {
  name: string;
  blurb: string;
  evidence: string[];
}

export interface LintFinding {
  rule: string;
  severity: 'info' | 'warn';
  message: string;
  examples: string[];
}

export interface WeekBucket {
  week: string;
  sessions: number;
  steps: number;
  correctionRate: number;
  interruptionRate: number;
  avgSpecificity?: number;
}

export interface PrompterReport {
  totals: Aggregate;
  perAgent: Partial<Record<AgentKind, Aggregate>>;
  sessions: SessionPrompterStats[];
  archetype: Archetype;
  lints: LintFinding[];
  skillCurve: WeekBucket[];
  correlations: {
    sampleSize: number;
    /** Pearson r across sessions: avg specificity vs correction rate. */
    specificityVsCorrectionRate?: number;
    /** Pearson r across prompts: prompt length vs tool calls unleashed. */
    promptCharsVsToolCalls?: number;
  };
}

export function collectStepSignals(session: NormalizedSession): StepSignal[] {
  const signals: StepSignal[] = [];
  for (const step of session.steps) {
    if (step.promptText === undefined || step.promptText.trim() === '') continue;
    signals.push({
      agent: session.agent,
      sessionId: session.id,
      stepId: step.id,
      index: step.index,
      timestamp: step.timestamp,
      kind: step.kind,
      commandName: step.commandName,
      promptPreview: previewText(step.promptText, 90),
      promptExcerpt: previewText(step.promptText, 600),
      features: extractPromptFeatures(step.promptText),
      outputTokens: step.usage.outputTokens,
      toolCalls: step.toolCalls.length,
      apiCalls: step.apiCalls,
      aborted: step.aborted === true,
      correctedByNext: false,
    });
  }
  for (let i = 0; i < signals.length; i++) {
    const prev = signals[i - 1];
    const cur = signals[i]!;
    if (prev?.timestamp && cur.timestamp) {
      const gap = Date.parse(cur.timestamp) - Date.parse(prev.timestamp);
      if (Number.isFinite(gap) && gap >= 0) cur.gapMs = gap;
    }
    if (prev && cur.features.isCorrection) prev.correctedByNext = true;
  }
  return signals;
}

function median(values: number[]): number | undefined {
  if (!values.length) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function mean(values: number[]): number | undefined {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : undefined;
}

export function pearson(xs: number[], ys: number[]): number | undefined {
  const n = Math.min(xs.length, ys.length);
  if (n < 4) return undefined;
  const mx = xs.slice(0, n).reduce((a, b) => a + b, 0) / n;
  const my = ys.slice(0, n).reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < n; i++) {
    const a = xs[i]! - mx;
    const b = ys[i]! - my;
    num += a * b;
    dx += a * a;
    dy += b * b;
  }
  if (dx === 0 || dy === 0) return undefined;
  return num / Math.sqrt(dx * dy);
}

export function sessionStats(
  session: NormalizedSession,
  signals: StepSignal[],
): SessionPrompterStats {
  const promptChars = signals.reduce((n, s) => n + s.features.chars, 0);
  const outputTokens = signals.reduce((n, s) => n + s.outputTokens, 0);
  const gaps = signals.map((s) => s.gapMs).filter((g): g is number => g !== undefined);
  return {
    agent: session.agent,
    id: session.id,
    title: session.title,
    cwd: session.cwd,
    startedAt: session.startedAt,
    steps: signals.length,
    corrections: signals.filter((s) => s.features.isCorrection).length,
    interruptions: session.interactions.interruptions,
    commands: session.interactions.commands,
    queuedPrompts: session.interactions.queuedPrompts,
    prLinks: session.interactions.prLinks,
    promptChars,
    avgPromptChars: signals.length ? Math.round(promptChars / signals.length) : 0,
    avgSpecificity: mean(signals.map((s) => s.features.specificity)),
    vagueCount: signals.reduce((n, s) => n + s.features.vagueMarkers.length, 0),
    outputTokens,
    toolCalls: signals.reduce((n, s) => n + s.toolCalls, 0),
    outputTokensPerPromptKChar:
      promptChars > 0 ? Math.round(outputTokens / (promptChars / 1000)) : undefined,
    medianGapMs: median(gaps),
  };
}

function aggregate(sessions: SessionPrompterStats[], allSignals: StepSignal[]): Aggregate {
  const steps = allSignals.length;
  const promptChars = sessions.reduce((n, s) => n + s.promptChars, 0);
  const outputTokens = sessions.reduce((n, s) => n + s.outputTokens, 0);
  const corrections = sessions.reduce((n, s) => n + s.corrections, 0);
  const interruptions = sessions.reduce((n, s) => n + s.interruptions, 0);
  return {
    sessions: sessions.length,
    steps,
    corrections,
    interruptions,
    commands: sessions.reduce((n, s) => n + s.commands, 0),
    promptChars,
    avgPromptChars: steps ? Math.round(promptChars / steps) : 0,
    avgSpecificity: mean(allSignals.map((s) => s.features.specificity)),
    vaguePerTenPrompts: steps
      ? Math.round((allSignals.reduce((n, s) => n + s.features.vagueMarkers.length, 0) / steps) * 100) / 10
      : 0,
    correctionRate: steps ? corrections / steps : 0,
    interruptionRate: steps ? interruptions / steps : 0,
    outputTokensPerPromptKChar:
      promptChars > 0 ? Math.round(outputTokens / (promptChars / 1000)) : undefined,
    toolCallsPerStep: steps ? sessions.reduce((n, s) => n + s.toolCalls, 0) / steps : 0,
    stepsPerSession: sessions.length ? steps / sessions.length : 0,
  };
}

/**
 * Rule-based archetype: ordered checks, most behaviorally distinctive first.
 * Thresholds are opinionated defaults, documented in the evidence strings so
 * the verdict is always auditable.
 */
function pickArchetype(totals: Aggregate, subagentsPerSession: number): Archetype {
  const steerRate = totals.correctionRate + totals.interruptionRate;
  const commandRate = totals.steps ? totals.commands / totals.steps : 0;
  const evidence = [
    `${totals.steps} prompts across ${totals.sessions} sessions (${totals.stepsPerSession.toFixed(1)}/session)`,
    `avg prompt ${totals.avgPromptChars} chars, specificity ${totals.avgSpecificity?.toFixed(1) ?? '—'}/10`,
    `correction rate ${(totals.correctionRate * 100).toFixed(0)}%, interruption rate ${(totals.interruptionRate * 100).toFixed(0)}%`,
    `slash-command share ${(commandRate * 100).toFixed(0)}%, subagents/session ${subagentsPerSession.toFixed(1)}`,
  ];
  if (totals.steps === 0) {
    return { name: 'Unknown', blurb: 'No prompt-bearing steps found in scope.', evidence };
  }
  if (steerRate > 0.25) {
    return {
      name: 'The Micromanager',
      blurb:
        'You steer constantly — interrupts and corrections above 25% of turns. Consider front-loading constraints into the first prompt.',
      evidence,
    };
  }
  if (totals.avgPromptChars > 700 && totals.stepsPerSession < 4) {
    return {
      name: 'The Cannonballer',
      blurb:
        'Few, huge prompts — you brief once and let the agent run. Works when specs are complete; corrections are expensive when not.',
      evidence,
    };
  }
  if (commandRate > 0.25 || subagentsPerSession >= 1.5) {
    return {
      name: 'The Delegator',
      blurb:
        'Heavy slash-command and subagent use — you operate the harness more than you type prose.',
      evidence,
    };
  }
  if (totals.stepsPerSession >= 8 && totals.avgPromptChars < 300) {
    return {
      name: 'The Gardener',
      blurb: 'Many small nudges per session — high-touch, incremental steering.',
      evidence,
    };
  }
  return {
    name: 'The Balanced Operator',
    blurb: 'No dominant steering pathology — mixed prompt sizes, moderate correction rate.',
    evidence,
  };
}

function localHour(timestamp: string): number {
  return new Date(timestamp).getHours();
}

function lint(totals: Aggregate, signals: StepSignal[]): LintFinding[] {
  const findings: LintFinding[] = [];
  const examplesOf = (pred: (s: StepSignal) => boolean, n = 3) =>
    signals.filter(pred).slice(0, n).map((s) => `"${s.promptPreview}"`);

  if (totals.vaguePerTenPrompts > 1.5) {
    findings.push({
      rule: 'vague-filler',
      severity: 'warn',
      message: `${totals.vaguePerTenPrompts} vague fillers ("etc", "or something", "idk"…) per 10 prompts — each one is a decision delegated blind.`,
      examples: examplesOf((s) => s.features.vagueMarkers.length > 0),
    });
  }
  const longUnanchored = signals.filter(
    (s) => s.features.chars > 200 && !s.features.hasPath && !s.features.hasCode,
  );
  if (signals.length >= 5 && longUnanchored.length / signals.length > 0.3) {
    findings.push({
      rule: 'unanchored-epics',
      severity: 'warn',
      message: `${longUnanchored.length}/${signals.length} long prompts name no file, path, or identifier — the agent has to guess the target.`,
      examples: longUnanchored.slice(0, 3).map((s) => `"${s.promptPreview}"`),
    });
  }
  if (totals.correctionRate > 0.15) {
    findings.push({
      rule: 'correction-heavy',
      severity: 'warn',
      message: `${(totals.correctionRate * 100).toFixed(0)}% of prompts are corrections — these prompts got corrected right after:`,
      examples: examplesOf((s) => s.correctedByNext),
    });
  }
  if (totals.interruptionRate > 0.15) {
    findings.push({
      rule: 'interrupt-heavy',
      severity: 'warn',
      message: `${(totals.interruptionRate * 100).toFixed(0)}% interruption rate — turns often get cut off mid-run.`,
      examples: examplesOf((s) => s.aborted),
    });
  }
  const fastGaps = signals.filter((s) => s.gapMs !== undefined && s.gapMs < 15_000);
  const gapped = signals.filter((s) => s.gapMs !== undefined);
  if (gapped.length >= 5 && fastGaps.length / gapped.length > 0.2) {
    findings.push({
      rule: 'rapid-fire',
      severity: 'info',
      message: `${fastGaps.length}/${gapped.length} follow-ups within 15s of the previous prompt — firing before reading, or healthy queueing?`,
      examples: [],
    });
  }
  const night = signals.filter((s) => s.timestamp && localHour(s.timestamp) < 5);
  if (signals.length >= 10 && night.length / signals.length > 0.2) {
    findings.push({
      rule: 'night-owl',
      severity: 'info',
      message: `${((night.length / signals.length) * 100).toFixed(0)}% of prompts land between midnight and 5am local.`,
      examples: [],
    });
  }
  const sorted = signals.map((s) => s.features.chars).sort((a, b) => a - b);
  const p90 = sorted[Math.floor(sorted.length * 0.9)] ?? 0;
  if (p90 > 3000) {
    findings.push({
      rule: 'mega-prompts',
      severity: 'info',
      message: `p90 prompt length is ${p90} chars — big briefs are fine, but check whether their sessions end in corrections.`,
      examples: [],
    });
  }
  if (!findings.length) {
    findings.push({
      rule: 'all-clear',
      severity: 'info',
      message: 'No lint thresholds tripped in this scope.',
      examples: [],
    });
  }
  return findings;
}

/** Monday of the prompt's week, as YYYY-MM-DD — the skill-curve bucket key. */
function weekKey(timestamp: string): string {
  const d = new Date(timestamp);
  const day = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() - day);
  return d.toISOString().slice(0, 10);
}

function skillCurve(signals: StepSignal[]): WeekBucket[] {
  const byWeek = new Map<string, StepSignal[]>();
  for (const s of signals) {
    if (!s.timestamp) continue;
    const key = weekKey(s.timestamp);
    byWeek.set(key, [...(byWeek.get(key) ?? []), s]);
  }
  return [...byWeek.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([week, weekSignals]) => ({
      week,
      sessions: new Set(weekSignals.map((s) => s.sessionId)).size,
      steps: weekSignals.length,
      correctionRate: weekSignals.filter((s) => s.features.isCorrection).length / weekSignals.length,
      interruptionRate: weekSignals.filter((s) => s.aborted).length / weekSignals.length,
      avgSpecificity: mean(weekSignals.map((s) => s.features.specificity)),
    }));
}

export function analyzePrompter(sessions: NormalizedSession[]): PrompterReport {
  const perSessionSignals = sessions.map((s) => collectStepSignals(s));
  const stats = sessions.map((s, i) => sessionStats(s, perSessionSignals[i]!));
  const allSignals = perSessionSignals.flat();
  const totals = aggregate(stats, allSignals);

  const perAgent: Partial<Record<AgentKind, Aggregate>> = {};
  for (const agent of ['claude', 'codex'] as const) {
    const agentStats = stats.filter((s) => s.agent === agent);
    if (agentStats.length) {
      perAgent[agent] = aggregate(agentStats, allSignals.filter((s) => s.agent === agent));
    }
  }

  const subagentsPerSession = sessions.length
    ? sessions.reduce((n, s) => n + s.subagents.length, 0) / sessions.length
    : 0;

  const withSpec = stats.filter((s) => s.steps >= 2 && s.avgSpecificity !== undefined);
  return {
    totals,
    perAgent,
    sessions: stats,
    archetype: pickArchetype(totals, subagentsPerSession),
    lints: lint(totals, allSignals),
    skillCurve: skillCurve(allSignals),
    correlations: {
      sampleSize: withSpec.length,
      specificityVsCorrectionRate: pearson(
        withSpec.map((s) => s.avgSpecificity!),
        withSpec.map((s) => s.corrections / s.steps),
      ),
      promptCharsVsToolCalls: pearson(
        allSignals.map((s) => s.features.chars),
        allSignals.map((s) => s.toolCalls),
      ),
    },
  };
}
