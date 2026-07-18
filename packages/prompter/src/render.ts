import { formatDuration, formatNumber as fmt, renderTable as table, shortId } from '@asa/core';
import type { JudgeResult } from './judge.js';
import type { Aggregate, PrompterReport } from './stats.js';

function pct(x: number): string {
  return `${(x * 100).toFixed(0)}%`;
}

function aggRow(label: string, a: Aggregate): string[] {
  return [
    label,
    fmt(a.sessions),
    fmt(a.steps),
    String(a.avgPromptChars),
    a.avgSpecificity !== undefined ? a.avgSpecificity.toFixed(1) : '—',
    pct(a.correctionRate),
    pct(a.interruptionRate),
    a.outputTokensPerPromptKChar !== undefined ? fmt(a.outputTokensPerPromptKChar) : '—',
    a.toolCallsPerStep.toFixed(1),
  ];
}

export function renderPrompterReport(report: PrompterReport, judge?: JudgeResult): string {
  const out: string[] = [];
  const t = report.totals;

  out.push(
    `Prompter report — ${fmt(t.steps)} prompts, ${fmt(t.sessions)} sessions, ` +
      `${fmt(t.promptChars)} chars typed`,
  );

  const rows = [aggRow('all', t)];
  for (const [agent, agg] of Object.entries(report.perAgent)) {
    if (Object.keys(report.perAgent).length > 1) rows.push(aggRow(agent, agg));
  }
  out.push(
    '',
    table(
      ['scope', 'sessions', 'prompts', 'avg chars', 'specificity', 'corrections', 'interrupts', 'out-tok/kchar', 'tools/step'],
      rows,
    ),
  );

  out.push('', `Archetype: ${report.archetype.name}`);
  out.push(`  ${report.archetype.blurb}`);
  for (const e of report.archetype.evidence) out.push(`  · ${e}`);

  out.push('', 'Lint:');
  for (const finding of report.lints) {
    out.push(`  [${finding.severity}] ${finding.rule}: ${finding.message}`);
    for (const ex of finding.examples) out.push(`      e.g. ${ex}`);
  }

  const w = report.workflow;
  out.push('', 'Workflow:');
  out.push(
    `  compactions: ${w.totals.sessionsWithCompactions}/${report.sessions.length} sessions (${w.totals.compactions} total` +
      `${w.totals.autoShare !== undefined ? `, ${pct(w.totals.autoShare)} auto` : ''})` +
      ` · committing in-session: ${w.totals.sessionsCommitting}` +
      ` · heavy edits w/o commit: ${w.totals.sessionsEditingWithoutCommit}`,
  );
  for (const finding of w.lints) {
    out.push(`  [${finding.severity}] ${finding.rule}: ${finding.message}`);
    for (const ex of finding.examples) out.push(`      e.g. ${ex}`);
  }

  const c = report.correlations;
  out.push('', `Correlations (n=${c.sampleSize} sessions — treat |r| < 0.3 or small n as noise):`);
  out.push(
    `  specificity vs correction-rate: ${c.specificityVsCorrectionRate !== undefined ? `r=${c.specificityVsCorrectionRate.toFixed(2)}` : 'n too small'}` +
      '  (negative = your more specific prompts need fewer corrections)',
  );
  out.push(
    `  prompt length vs tool calls:    ${c.promptCharsVsToolCalls !== undefined ? `r=${c.promptCharsVsToolCalls.toFixed(2)}` : 'n too small'}` +
      '  (positive = bigger briefs unleash more agent work)',
  );

  if (report.skillCurve.length > 1) {
    out.push('', 'Skill curve (by week):');
    out.push(
      table(
        ['week of', 'sessions', 'prompts', 'corrections', 'interrupts', 'specificity'],
        report.skillCurve
          .slice(-10)
          .map((w) => [
            w.week,
            fmt(w.sessions),
            fmt(w.steps),
            pct(w.correctionRate),
            pct(w.interruptionRate),
            w.avgSpecificity !== undefined ? w.avgSpecificity.toFixed(1) : '—',
          ]),
      ),
    );
  }

  if (judge && judge.samples > 0) {
    out.push('', `LLM judge (${judge.backend} ${judge.model}, ${judge.samples} sampled prompts):`);
    out.push(
      `  clarity ${judge.avgClarity?.toFixed(1) ?? '—'}/5 · context ${judge.avgContext?.toFixed(1) ?? '—'}/5`,
    );
    const tips = judge.grades.filter((g) => g.tip).slice(0, 5);
    if (tips.length) {
      out.push('  tips:');
      for (const g of tips) out.push(`    · ${g.tip}`);
    }
  }

  if (report.sessions.length) {
    out.push('', 'Sessions in scope:');
    out.push(
      table(
        ['session', 'agent', 'prompts', 'corr', 'intr', 'avg chars', 'spec', 'gap (median)', 'title/cwd'],
        report.sessions.map((s) => [
          shortId(s.id),
          s.agent,
          fmt(s.steps),
          fmt(s.corrections),
          fmt(s.interruptions),
          String(s.avgPromptChars),
          s.avgSpecificity !== undefined ? s.avgSpecificity.toFixed(1) : '—',
          formatDuration(s.medianGapMs),
          (s.title ?? s.cwd ?? '').slice(0, 40),
        ]),
      ),
    );
  }

  return out.join('\n');
}
