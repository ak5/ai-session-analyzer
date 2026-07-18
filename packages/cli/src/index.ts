import { Command } from 'commander';
import { previewText, renderHtmlReport, shortId, type NormalizedSession, type SessionRef } from '@asa/core';
import { analyzeSession, compareReports, renderComparison, renderReport } from '@asa/analyze';
import {
  listInstalledClaudeCommands,
  readClaudeStatsCache,
  readClaudeStepResponse,
} from '@asa/claude-sessions';
import { listInstalledCodexCommands, readCodexStepResponse } from '@asa/codex-sessions';
import {
  analyzePrompter,
  buildJudgePrompt,
  collectStepSignals,
  judgePrompts,
  renderPrompterReport,
  selectJudgeSamples,
  type JudgeResult,
} from '@asa/prompter';
import {
  buildDistillStats,
  buildFaqEntry,
  buildSuggestPrompt,
  isInternalSession,
  mergeFaq,
  renderDistillStats,
  runSuggest,
  type FaqEntry,
  type SuggestBackend,
} from '@asa/distill';
import { askYesNo, confirmModelCall } from './confirm.js';
import { buildSetupReport, DEFAULT_RETENTION_DAYS, readRetention, writeRetention } from './setup.js';
import {
  AGENT_FILTER_VALUES,
  AGENTS,
  SELECTOR_HINT,
  agentsForFilter,
  type AgentAdapter,
} from './agents.js';
import {
  buildIntentReport,
  buildIntentThemesPrompt,
  buildLongRangeHistory,
  buildModelReport,
  buildProjectDossier,
  computeEfficacy,
  deepenIntentReport,
  readInstructionChanges,
  renderDossier,
  renderEfficacy,
  renderIntents,
  renderLongRangeHistory,
  renderModelReport,
  steeringSamples,
} from '@asa/meta';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { colocateJj, installGitTraceHooks, resolveRepoRoot } from './hooks-install.js';
import { enrichRefs, groupByProject, type ListedRef } from './list.js';
import { spawnAgentCli } from './spawn.js';

type SelectorOpts = Record<string, string | undefined>;

interface Selected {
  adapter: AgentAdapter;
  ref: SessionRef;
}

async function resolveSession(opts: SelectorOpts): Promise<Selected> {
  const chosen = AGENTS.filter((a) => opts[a.flag] !== undefined);
  if (chosen.length !== 1) {
    throw new Error(`Pass exactly one of ${SELECTOR_HINT}`);
  }
  const adapter = chosen[0]!;
  const idOrPrefix = opts[adapter.flag]!;
  const ref = await adapter.find(idOrPrefix);
  if (!ref) throw new Error(`No ${adapter.kind} session matching "${idOrPrefix}"`);
  return { adapter, ref };
}

function addSelectorOptions(cmd: Command): Command {
  for (const agent of AGENTS) {
    cmd.option(`-${agent.short}, --${agent.flag} <id>`, `${agent.kind} session id (or unique prefix)`);
  }
  return cmd;
}

function parseSince(value: string): Date {
  const days = /^(\d+)d$/.exec(value);
  if (days) return new Date(Date.now() - Number(days[1]) * 86_400_000);
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`Cannot parse --since "${value}" — use e.g. "30d" or "2026-06-01"`);
  }
  return parsed;
}

/** Files above this size are skipped by `prompter`/`distill` (multi-hundred-MB rollouts exist). */
const PROMPTER_MAX_FILE_BYTES = 30 * 1024 * 1024;

async function loadSessionsInScope(opts: {
  agent: string;
  limit: string;
  since?: string;
  includeSubagents?: boolean;
}): Promise<NormalizedSession[]> {
  const adapters = agentsForFilter(opts.agent);
  const listed = await Promise.all(adapters.map((a) => a.list()));
  let refs = listed.flat().sort((a, b) => (b.updatedAt?.getTime() ?? 0) - (a.updatedAt?.getTime() ?? 0));
  if (opts.since) {
    const cutoff = parseSince(opts.since);
    refs = refs.filter((r) => (r.updatedAt?.getTime() ?? 0) >= cutoff.getTime());
  }
  refs = refs.slice(0, Number(opts.limit));

  const byKind = new Map(AGENTS.map((a) => [a.kind, a]));
  const sessions: NormalizedSession[] = [];
  for (const ref of refs) {
    if ((ref.sizeBytes ?? 0) > PROMPTER_MAX_FILE_BYTES) {
      console.error(`skipping ${ref.agent} ${ref.id} (${Math.round((ref.sizeBytes ?? 0) / 1e6)}MB > 30MB)`);
      continue;
    }
    try {
      sessions.push(await byKind.get(ref.agent)!.load(ref.filePath));
    } catch (err) {
      console.error(`skipping ${ref.agent} ${ref.id}: ${err instanceof Error ? err.message : err}`);
    }
  }
  // asa's own --suggest/--deep calls persist Codex rollouts — never analyze them
  const external = sessions.filter((s) => !isInternalSession(s));
  if (opts.includeSubagents) return external;
  // Subagent rollouts carry machine-written "user" prompts — they'd poison
  // any analysis of the human prompter.
  const human = external.filter((s) => !s.isSubagent);
  const dropped = external.length - human.length;
  if (dropped) console.error(`excluded ${dropped} subagent sessions (use --include-subagents to keep)`);
  return human;
}

const USE_CASES = `
Use cases:
  Find and inspect your most recent expensive session
    $ asa list -n 10
    $ asa analyze -c <id>                        # tokens, steps, tools, MCP, subagents

  Re-enter a warmed-up session instead of re-explaining from scratch
    $ asa analyze -c <id>                        # pick a step id from the Steps table
    $ asa fork -c <id> --at <stepId>
    # → truncated copy under a new session id; the replayed prefix hits prompt cache

  Try a risky refactor without touching the original conversation
    $ asa fork -c <id>                           # whole-session fork (claude --fork-session)
    $ asa fork -o <id>                           # wraps codex fork

  Drive a session headlessly from a script
    $ asa resume -c <id> -p "run the tests and fix failures"
    $ asa resume -o <id> -p "continue"           # codex exec resume

  Study yourself as a prompter (30 days, both agents)
    $ asa prompter --since 30d --limit 50
    $ asa prompter --deep                        # + LLM-judge pass (claude haiku; --deep codex works too)

  Find what to extract into skills, rules, FAQs, automations
    $ asa distill --since 60d                    # deterministic recurrence stats, local only
    $ asa distill --suggest claude               # + model recommendations (or --suggest codex)

  Understand a repo's whole agent history
    $ asa project ~/Projects/botyard             # dossier: spend, steering, instruction surfaces
    $ asa efficacy ~/Projects/botyard            # did CLAUDE.md edits reduce corrections?
    $ asa intents --since 30d                    # what you use agents for, per repo
    $ asa intents --deep claude                  # + model-named recurring themes, shipped or not
    $ asa models --since 60d                    # model favorites, weekly dominance, era switches

  Feed a dashboard, browser, or jq pipeline
    $ asa analyze -c <id> --json | jq '.totals'
    $ asa prompter --html && open asa-prompter.html   # any report: --html [file]
    $ asa prompter --json | jq '.skillCurve'
`;

const program = new Command();
program
  .name('asa')
  .description(
    'ai session analyzer — analyze, resume and fork Claude Code & Codex CLI sessions,\n' +
      'and profile the human driving them. Wraps the real claude/codex binaries; never\n' +
      'reimplements them. Session ids accept unique prefixes everywhere.',
  )
  .version('1.0.0-rc.4')
  .addHelpText('after', USE_CASES);

function listRow(ref: ListedRef | SessionRef, indent = ''): string {
  const when = ref.updatedAt?.toISOString().replace('T', ' ').slice(0, 16) ?? '?';
  const size = ref.sizeBytes !== undefined ? `${Math.round(ref.sizeBytes / 1024)}kB` : '';
  const label = ref.title ?? '';
  return `${indent}${when}  ${ref.agent.padEnd(6)} ${ref.id}  ${size.padStart(8)}  ${previewText(label, 44)}`;
}

program
  .command('list')
  .description('List recent sessions from all agents, grouped by project folder')
  .option('--agent <agent>', AGENT_FILTER_VALUES, 'all')
  .option('-n, --limit <n>', 'max sessions per agent', '15')
  .option('--flat', 'one line per session, newest first, no grouping')
  .option('--json', 'output JSON (flat, with cwdResolved/orphaned per session)')
  .action(async (opts: { agent: string; limit: string; flat?: boolean; json?: boolean }) => {
    const limit = Number(opts.limit);
    const listed = await Promise.all(agentsForFilter(opts.agent).map((a) => a.list()));
    const rows = listed
      .flatMap((refs) => refs.slice(0, limit))
      .sort((a, b) => (b.updatedAt?.getTime() ?? 0) - (a.updatedAt?.getTime() ?? 0));
    if (!rows.length) {
      console.log('No sessions found.');
      return;
    }
    if (opts.flat && !opts.json) {
      for (const ref of rows) console.log(listRow(ref));
      return;
    }

    const adapterByKind = new Map(AGENTS.map((a) => [a.kind as string, a]));
    const enriched = await enrichRefs(rows, adapterByKind);
    if (opts.json) {
      console.log(JSON.stringify(enriched, null, 2));
      return;
    }

    const groups = groupByProject(enriched);
    const live = groups.filter((g) => !g.orphaned);
    const orphans = groups.filter((g) => g.orphaned);
    for (const group of live) {
      console.log(`${group.cwd} — ${group.refs.length} session${group.refs.length > 1 ? 's' : ''}`);
      for (const ref of group.refs) console.log(listRow(ref, '  '));
      console.log('');
    }
    if (orphans.length) {
      console.log('Orphans (cwd deleted or unknown):');
      for (const group of orphans) {
        console.log(`${group.cwd ?? '(unknown cwd)'} — ${group.refs.length} session${group.refs.length > 1 ? 's' : ''}`);
        for (const ref of group.refs) console.log(listRow(ref, '  '));
        console.log('');
      }
    }
  });

addSelectorOptions(
  program
    .command('analyze')
    .description('Analyze a session: tokens, steps, tool calls, MCP usage, subagents'),
)
  .option('--json', 'output the full report as JSON')
  .option('--html [file]', 'write the report as a styled HTML page')
  .action(async (opts: SelectorOpts & { json?: boolean; html?: boolean | string }) => {
    const { adapter, ref } = await resolveSession(opts);
    const report = analyzeSession(await adapter.load(ref.filePath));
    await deliver('analyze', `session ${shortId(report.session.id)} — ${report.session.title ?? report.session.agent}`, renderReport(report), report, opts);
  });

addSelectorOptions(
  program
    .command('resume')
    .description('Resume a session in its original cwd (wraps `claude --resume` / `codex resume`)'),
)
  .option('-p, --prompt <prompt>', 'run headless with this prompt instead of interactively')
  .option('--dry-run', 'print the command instead of running it')
  .action(async (opts: SelectorOpts & { prompt?: string; dryRun?: boolean }) => {
    const { adapter, ref } = await resolveSession(opts);
    const session = await adapter.load(ref.filePath);
    const { command, args } = adapter.resume(ref.id, opts.prompt);
    process.exitCode = await spawnAgentCli(command, args, {
      cwd: session.cwd,
      dryRun: opts.dryRun,
    });
  });

addSelectorOptions(
  program
    .command('fork')
    .description(
      'Fork a session (new session id, original untouched). With --at <stepId>, fork at a specific step — reusing the warmed-up context up to that point.',
    ),
)
  .option('--at <stepId>', 'step id (from `asa analyze`) to fork at, where supported')
  .option('-p, --prompt <prompt>', 'run headless with this prompt instead of interactively')
  .option('--no-launch', 'only create the fork, do not launch the agent CLI')
  .option('--dry-run', 'print the command instead of running it')
  .addHelpText(
    'after',
    `
Notes:
  --at writes a truncated transcript copy under a fresh session id (original
  untouched) and resumes it — re-entering the conversation at that step with the
  warmed-up context. Claude Code accepts such transcripts today, but it is not a
  stable contract: treat step-forks as disposable. Fork subagent transcripts are
  not copied.

Examples:
  $ asa fork -c 092aede3                    # whole-session fork
  $ asa fork -c 092aede3 --at <stepId>      # fork at a step
  $ asa fork -c 092aede3 --at <stepId> -p "try approach B instead"
  $ asa fork -c 092aede3 --at <stepId> --no-launch   # just create it
`,
  )
  .action(
    async (
      opts: SelectorOpts & {
        at?: string;
        prompt?: string;
        launch: boolean;
        dryRun?: boolean;
      },
    ) => {
      const { adapter, ref } = await resolveSession(opts);
      const session = await adapter.load(ref.filePath);
      const spawnOpts = { cwd: session.cwd, dryRun: opts.dryRun };

      if (opts.at) {
        if (!adapter.forkAtStep) {
          const supported = AGENTS.filter((a) => a.forkAtStep).map((a) => a.kind).join(', ');
          throw new Error(`--at is not supported for ${adapter.kind} sessions yet (only: ${supported})`);
        }
        if (opts.dryRun) {
          console.log(
            `[dry-run] would fork ${shortId(ref.id)} at step ${shortId(opts.at)}: truncated copy of\n` +
              `  ${ref.filePath}\n  under a new session id, then resume it`,
          );
          return;
        }
        const fork = await adapter.forkAtStep(ref.filePath, opts.at);
        console.log(
          `Forked ${shortId(ref.id)} at step ${shortId(opts.at)} → session ${fork.newSessionId}` +
            `\n  ${fork.newFilePath}\n  kept ${fork.keptRecords} records, dropped ${fork.droppedRecords}`,
        );
        if (!opts.launch) return;
        const { command, args } = adapter.resume(fork.newSessionId, opts.prompt);
        process.exitCode = await spawnAgentCli(command, args, spawnOpts);
        return;
      }

      const { command, args } = adapter.fork(ref.id, opts.prompt);
      process.exitCode = await spawnAgentCli(command, args, spawnOpts);
    },
  );

program
  .command('prompter')
  .description(
    'Analyze the human: prompt specificity, corrections, interruptions, leverage, archetype, lint findings, and a weekly skill curve — aggregated across recent sessions of all agents.',
  )
  .option('--agent <agent>', AGENT_FILTER_VALUES, 'all')
  .option('-n, --limit <n>', 'max sessions to load (newest first)', '25')
  .option('--since <when>', 'only sessions updated since, e.g. "30d" or "2026-06-01"')
  .option('--include-subagents', 'keep agent-spawned sessions (their prompts are machine-written)')
  .option('--deep [backend]', 'add an LLM-judge pass: sampled prompts graded via claude (haiku, default) or codex')
  .option('--sample <k>', 'prompts to sample for --deep', '10')
  .option('--yes', 'skip the token-estimate confirmation for --deep')
  .option('--model <model>', 'judge model for --deep', 'haiku')
  .option('--json', 'output the full report as JSON')
  .option('--html [file]', 'write the report as a styled HTML page')
  .addHelpText(
    'after',
    `
Notes:
  Heuristics are documented in packages/prompter/src/features.ts — the absolute
  scores mean little; trends and comparisons across your own prompts are the point.
  --deep sends sampled prompt excerpts to your own Anthropic account (one batched
  haiku call, --no-session-persistence) and is therefore opt-in.

Examples:
  $ asa prompter --since 30d
  $ asa prompter --agent codex -n 40 --json | jq '.archetype'
  $ asa prompter --deep --sample 15
`,
  )
  .action(
    async (opts: {
      agent: string;
      limit: string;
      since?: string;
      includeSubagents?: boolean;
      deep?: boolean | string;
      yes?: boolean;
      sample: string;
      model: string;
      json?: boolean;
      html?: boolean | string;
    }) => {
      const sessions = await loadSessionsInScope(opts);
      if (!sessions.length) throw new Error('No sessions in scope — relax --since/--agent/--limit');
      const report = analyzePrompter(sessions);

      let judge: JudgeResult | undefined;
      if (opts.deep) {
        const backend = opts.deep === true ? 'claude' : opts.deep;
        if (backend !== 'claude' && backend !== 'codex') {
          throw new Error(`--deep must be claude or codex, got "${backend}"`);
        }
        const samples = selectJudgeSamples(sessions.flatMap(collectStepSignals), Number(opts.sample));
        const approved = await confirmModelCall({
          label: `--deep judge (${samples.length} sampled prompts)`,
          backend,
          prompt: buildJudgePrompt(samples),
          outputEstimate: [200, 1500],
          yes: opts.yes,
        });
        if (approved) {
          try {
            judge = await judgePrompts(samples, {
              backend,
              model: backend === 'claude' ? opts.model : undefined,
            });
          } catch (err) {
            console.error(
              `--deep judge failed (${err instanceof Error ? err.message : err}) — continuing without it`,
            );
          }
        }
      }

      await deliver('prompter', 'prompter report', renderPrompterReport(report, judge), { ...report, judge }, opts);
    },
  );

const collect = (value: string, previous: string[] = []) => [...previous, value];

/** Shared output tail for report commands: --json, --html [file], or text. */
async function deliver(
  command: string,
  title: string,
  text: string,
  json: unknown,
  opts: { json?: boolean; html?: boolean | string },
): Promise<void> {
  if (opts.json) {
    console.log(JSON.stringify(json, null, 2));
    return;
  }
  if (opts.html) {
    const { writeFile } = await import('node:fs/promises');
    const file = typeof opts.html === 'string' ? opts.html : `asa-${command}.html`;
    await writeFile(file, renderHtmlReport({ title, command, body: text }));
    console.log(`wrote ${file}`);
    return;
  }
  console.log(text);
}

/** distill --faq: recurring questions in one repo's sessions + answers re-read from the transcripts. */
async function writeFaq(repoRoot: string, limit: number): Promise<void> {
  const { readFile, writeFile } = await import('node:fs/promises');
  const sessions = await loadSessionsForRepo(repoRoot, limit);
  if (!sessions.length) throw new Error(`No sessions found for ${repoRoot}`);
  const stats = buildDistillStats(sessions);
  if (!stats.questions.length) {
    console.log(`No recurring questions across ${stats.scope.sessions} sessions in ${repoRoot} — nothing to distill yet.`);
    return;
  }

  const byKind = new Map(AGENTS.map((a) => [a.kind as string, a]));
  const entries: FaqEntry[] = [];
  for (const cluster of stats.questions) {
    // memberRefs are representative-first: prefer the answer to the exact
    // phrasing shown as the entry's question over longer sibling answers
    let best: { answer: string; sessionId: string } | undefined;
    for (const ref of cluster.memberRefs) {
      const adapter = byKind.get(ref.agent);
      const sessionRef = await adapter?.find(ref.sessionId).catch(() => undefined);
      if (!sessionRef) continue;
      const answer =
        ref.agent === 'claude'
          ? await readClaudeStepResponse(sessionRef.filePath, ref.stepId).catch(() => undefined)
          : await readCodexStepResponse(sessionRef.filePath, ref.stepId).catch(() => undefined);
      if (answer) {
        best = { answer, sessionId: ref.sessionId };
        break;
      }
    }
    if (best) entries.push(buildFaqEntry(cluster, best.answer, best.sessionId));
    else console.error(`no extractable answer for: "${cluster.representative.slice(0, 60)}" — skipped`);
  }
  if (!entries.length) {
    console.log('Recurring questions found, but no extractable answers survived — nothing written.');
    return;
  }

  const faqPath = join(repoRoot, 'docs', 'dev-faq.md');
  const existing = await readFile(faqPath, 'utf8').catch(() => undefined);
  const merged = mergeFaq(existing, entries);
  if (!merged.added.length) {
    console.log(`docs/dev-faq.md already covers all ${merged.kept} recurring questions — unchanged.`);
    return;
  }
  const { mkdir } = await import('node:fs/promises');
  await mkdir(join(repoRoot, 'docs'), { recursive: true });
  await writeFile(faqPath, merged.content);
  console.log(`${faqPath}: added ${merged.added.length} entries${merged.kept ? `, kept ${merged.kept} existing untouched` : ''}`);
  for (const q of merged.added) console.log(`  + ${q}`);
}

/** Sessions whose header cwd matches the repo (or lives under it). */
async function loadSessionsForRepo(repoRoot: string, limit: number): Promise<NormalizedSession[]> {
  const all = await loadSessionsInScope({ agent: 'all', limit: String(limit) });
  return all.filter((s) => s.cwd === repoRoot || s.cwd?.startsWith(repoRoot + '/'));
}

program
  .command('project [path]')
  .description(
    'Project dossier: every session for one repo (both agents) — spend, steering, tools, content volume, and the instruction surfaces (CLAUDE.md, AGENTS.md, skills, hooks) shaping agent behavior there',
  )
  .option('-n, --limit <n>', 'max sessions to scan (newest first)', '200')
  .option('--json', 'output the dossier as JSON')
  .option('--html [file]', 'write the dossier as a styled HTML page')
  .action(async (path: string | undefined, opts: { limit: string; json?: boolean; html?: boolean | string }) => {
    const repoRoot = resolveRepoRoot(path ?? process.cwd());
    const sessions = await loadSessionsForRepo(repoRoot, Number(opts.limit));
    if (!sessions.length) throw new Error(`No sessions found for ${repoRoot}`);
    const corrections = sessions.map(
      (s) => collectStepSignals(s).filter((sig) => sig.features.isCorrection).length,
    );
    const dossier = buildProjectDossier(repoRoot, sessions, corrections);
    console.log(opts.json ? JSON.stringify(dossier, null, 2) : renderDossier(dossier));
  });

program
  .command('efficacy [path]')
  .description(
    'Did your CLAUDE.md / AGENTS.md edits work? Steering metrics (corrections, interruptions per prompt) before vs after each instruction-file commit',
  )
  .option('-n, --limit <n>', 'max sessions to scan (newest first)', '200')
  .option('--window <k>', 'sessions per side of each change', '10')
  .option('--json', 'output entries as JSON')
  .option('--html [file]', 'write the report as a styled HTML page')
  .action(
    async (path: string | undefined, opts: { limit: string; window: string; json?: boolean; html?: boolean | string }) => {
      const repoRoot = resolveRepoRoot(path ?? process.cwd());
      const changes = readInstructionChanges(repoRoot);
      const sessions = await loadSessionsForRepo(repoRoot, Number(opts.limit));
      const entries = computeEfficacy(changes, steeringSamples(sessions), Number(opts.window));
      await deliver('efficacy', `instruction efficacy — ${repoRoot}`, renderEfficacy(entries), entries, opts);
    },
  );

program
  .command('intents')
  .description(
    'What do you actually use the agents for? Classify session intents (feature/bugfix/refactor/research/ops/learning), per-repo mix, and — with --deep — model-named recurring themes flagged shipped/unshipped via PR links',
  )
  .option('--agent <agent>', AGENT_FILTER_VALUES, 'all')
  .option('-n, --limit <n>', 'max sessions to load (newest first)', '50')
  .option('--since <when>', 'only sessions updated since, e.g. "30d" or "2026-06-01"')
  .option('--deep <backend>', 'name recurring themes via a model (claude | codex)')
  .option('--yes', 'skip the token-estimate confirmation for --deep')
  .option('--model <model>', 'model for --deep claude')
  .option('--json', 'output the report as JSON')
  .option('--html [file]', 'write the report as a styled HTML page')
  .action(
    async (opts: {
      agent: string;
      limit: string;
      since?: string;
      deep?: string;
      yes?: boolean;
      model?: string;
      json?: boolean;
      html?: boolean | string;
    }) => {
      const sessions = await loadSessionsInScope(opts);
      if (!sessions.length) throw new Error('No sessions in scope — relax --since/--agent/--limit');
      let report = buildIntentReport(sessions);
      if (opts.deep) {
        if (opts.deep !== 'claude' && opts.deep !== 'codex') {
          throw new Error(`--deep must be claude or codex, got "${opts.deep}"`);
        }
        const approved = await confirmModelCall({
          label: `--deep themes (${report.sessions.length} opening prompts)`,
          backend: opts.deep,
          prompt: buildIntentThemesPrompt(report),
          outputEstimate: [100, 800],
          yes: opts.yes,
        });
        if (approved) {
          try {
            report = await deepenIntentReport(report, opts.deep, { model: opts.model });
          } catch (err) {
            console.error(
              `--deep failed (${err instanceof Error ? err.message : err}) — continuing with heuristics`,
            );
          }
        }
      }
      await deliver('intents', 'session intents', renderIntents(report), report, opts);
    },
  );

program
  .command('compare')
  .description('Compare two sessions metric by metric (original vs fork, replay, or cross-agent)')
  .option('-c, --claude <id>', 'claude session id (repeatable)', collect, [])
  .option('-o, --codex <id>', 'codex session id (repeatable)', collect, [])
  .option('--json', 'output both reports and the comparison rows as JSON')
  .option('--html [file]', 'write the comparison as a styled HTML page')
  .addHelpText(
    'after',
    `
Examples:
  $ asa compare -c <original> -c <fork>       # did the fork do better?
  $ asa compare -c <claude-id> -o <codex-id>  # same task, different agent
Order: A = first id given (claude ids first), B = second.
`,
  )
  .action(async (opts: { claude: string[]; codex: string[]; json?: boolean; html?: boolean | string }) => {
    const byKind = (kind: string) => AGENTS.find((a) => a.kind === kind)!;
    const selectors = [
      ...opts.claude.map((id) => ({ agent: byKind('claude'), id })),
      ...opts.codex.map((id) => ({ agent: byKind('codex'), id })),
    ];
    if (selectors.length !== 2) {
      throw new Error(`compare needs exactly two session ids (got ${selectors.length}) — e.g. asa compare -c <a> -c <b>`);
    }
    const reports = await Promise.all(
      selectors.map(async ({ agent, id }) => {
        const ref = await agent.find(id);
        if (!ref) throw new Error(`No ${agent.kind} session matching "${id}"`);
        return analyzeSession(await agent.load(ref.filePath));
      }),
    );
    const [a, b] = reports;
    await deliver(
      'compare',
      `compare ${shortId(a!.session.id)} vs ${shortId(b!.session.id)}`,
      renderComparison(a!, b!),
      { a, b, rows: compareReports(a!, b!) },
      opts,
    );
  });

program
  .command('install-hooks [repo]')
  .description(
    'Install per-prompt git tracing into a repo: Claude Code hooks stamp git HEAD + dirty state into .asa/git-trace.jsonl, and asa analyze joins commits onto steps',
  )
  .option('--jj', 'also colocate a jj repo (jj git init --colocate) so every turn snapshots the working copy into the jj op log')
  .addHelpText(
    'after',
    `
Notes:
  Idempotent. Writes .asa/hooks/git-trace.mjs, registers UserPromptSubmit + Stop
  hooks in the repo's .claude/settings.json, and gitignores .asa/. The hook never
  writes to stdout (UserPromptSubmit stdout would leak into agent context).
  Codex already records commit_hash at session start; it has no per-turn hook
  surface today, so tracing is Claude-only.

Examples:
  $ asa install-hooks                 # current directory
  $ asa install-hooks ~/Projects/botyard --jj
`,
  )
  .action(async (repo: string | undefined, opts: { jj?: boolean }) => {
    const target = repo ?? process.cwd();
    const { actions } = installGitTraceHooks(target, { jj: opts.jj });
    console.log(`install-hooks in ${target}:`);
    for (const action of actions) console.log(`  · ${action}`);
  });

program
  .command('setup')
  .description(
    'Onboarding: environment report, then independently-confirmed optional steps — raise Claude transcript retention (global), install per-prompt git tracing (repo), colocate jj for op-log snapshots (repo)',
  )
  .option('--retention-days <n>', 'retention to offer', String(DEFAULT_RETENTION_DAYS))
  .option('--no-jj', 'skip offering jj colocation with the repo hooks')
  .option('--yes', 'apply all offered steps without asking')
  .action(async (opts: { retentionDays: string; jj: boolean; yes?: boolean }) => {
    for (const line of await buildSetupReport()) console.log(`  ${line}`);

    // step 1 (global): transcript retention
    const target = Number(opts.retentionDays);
    const retention = readRetention();
    if (retention.effective >= target) {
      console.log(`\nRetention already ${retention.effective} days — nothing to change.`);
    } else {
      console.log(
        `\nOptional: raise cleanupPeriodDays ${retention.current === undefined ? '(unset, default 30)' : `from ${retention.current}`} to ${target} in ${retention.settingsPath}.` +
          '\nEvery longitudinal asa feature gets smarter with more history; transcripts are plain text and cheap to keep.',
      );
      if (await askYesNo('  apply? [y/N] ', opts.yes, 'retention unchanged')) {
        writeRetention(retention.settingsPath, target);
        console.log(`Set cleanupPeriodDays = ${target}.`);
      } else {
        console.log('Left unchanged.');
      }
    }

    // step 2 (per-repo): git-trace hooks + jj, when run inside a repo
    let repoRoot: string | undefined;
    try {
      repoRoot = resolveRepoRoot(process.cwd());
    } catch {
      console.log('\nNot inside a git repo — skipping per-repo git tracing (run `asa setup` from a repo, or `asa install-hooks <path>`).');
    }
    if (repoRoot) {
      console.log(
        `\nOptional: install per-prompt git tracing into ${repoRoot} — asa analyze then shows the commit each prompt ran against.`,
      );
      if (await askYesNo('  install? [y/N] ', opts.yes, 'hooks not installed')) {
        const { actions } = installGitTraceHooks(repoRoot, { jj: false });
        for (const action of actions) console.log(`  · ${action}`);
      } else {
        console.log('Skipped.');
      }
    }

    // step 3 (per-repo, its own opt-in): jj colocation
    if (repoRoot && opts.jj && !existsSync(join(repoRoot, '.jj'))) {
      console.log(
        `\nOptional: colocate a jj repo in ${repoRoot} (jj git init --colocate). The trace hook then` +
          `\nsnapshots the working copy into jj's op log every turn — commit-free, diffable history of` +
          `\nwhat the agent changed between prompts (jj op log / jj op diff), and a base for undo/replay` +
          `\ntooling. Fully reversible: delete .jj/ to leave.`,
      );
      if (await askYesNo('  colocate? [y/N] ', opts.yes, 'jj not colocated')) {
        console.log(`  · ${colocateJj(repoRoot)}`);
      } else {
        console.log('Skipped.');
      }
    }
  });

program
  .command('models')
  .description(
    'Historical model usage: favorites by API-call share, weekly dominant model, and when you switched — per agent, with Codex reasoning effort included',
  )
  .option('--agent <agent>', AGENT_FILTER_VALUES, 'all')
  .option('-n, --limit <n>', 'max sessions to load (newest first)', '100')
  .option('--since <when>', 'only sessions updated since, e.g. "30d" or "2026-06-01"')
  .option('--include-subagents', 'keep agent-spawned sessions')
  .option('--json', 'output the report as JSON')
  .option('--html [file]', 'write the report as a styled HTML page')
  .action(
    async (opts: { agent: string; limit: string; since?: string; includeSubagents?: boolean; json?: boolean; html?: boolean | string }) => {
      const sessions = await loadSessionsInScope(opts);
      if (!sessions.length) throw new Error('No sessions in scope — relax --since/--agent/--limit');
      const report = buildModelReport(sessions);
      const cache = await readClaudeStatsCache();
      const longRange = cache?.dailyModelTokens ? buildLongRangeHistory(cache.dailyModelTokens) : undefined;
      const text = renderModelReport(report) + (longRange ? '\n\n' + renderLongRangeHistory(longRange) : '');
      await deliver('models', 'model usage history', text, { ...report, longRange }, opts);
    },
  );

program
  .command('distill')
  .description(
    'Mine recurring behavior across sessions: repeated procedures, questions, corrections, and tool sequences — the raw stats for deciding what to extract into skills, rules, FAQs, and automations.',
  )
  .option('--agent <agent>', AGENT_FILTER_VALUES, 'all')
  .option('-n, --limit <n>', 'max sessions to load (newest first)', '50')
  .option('--since <when>', 'only sessions updated since, e.g. "30d" or "2026-06-01"')
  .option('--include-subagents', 'keep agent-spawned sessions')
  .option(
    '--suggest <backend>',
    'ship the stats to a model (claude | codex) for extraction recommendations',
  )
  .option('--faq [path]', 'write docs/dev-faq.md in the repo (default: cwd) from recurring questions + transcript answers')
  .option('--model <model>', 'model for --suggest claude (codex uses its configured default)')
  .option('--prompt-file <path>', 'override the suggest prompt template with a file')
  .option('--yes', 'skip the token-estimate confirmation for --suggest')
  .option('--json', 'output the raw stats as JSON')
  .option('--html [file]', 'write the report as a styled HTML page')
  .addHelpText(
    'after',
    `
Notes:
  Plain \`asa distill\` is fully local and deterministic — clustering is
  token-overlap based, no embeddings, no API calls. --suggest sends the stats
  digest (prompt previews included) to your own claude/codex account and prints
  the model's recommendations: skills to extract, CLAUDE.md rules, automations,
  docs/dev-faq.md entries, retention gaps, and prompting-vocabulary upgrades.
  The suggest prompt lives in packages/distill/src/suggest-template.ts — iterate
  on it there, or point --prompt-file at an alternative.
  Suggest calls are stamped "[asa-internal]" and such sessions are excluded from
  all analysis (codex exec has no way to skip writing a rollout).

Examples:
  $ asa distill --since 60d
  $ asa distill --json | jq '.questions'
  $ asa distill --suggest claude
  $ asa distill --suggest codex --prompt-file my-prompt.md
`,
  )
  .action(
    async (opts: {
      agent: string;
      limit: string;
      since?: string;
      includeSubagents?: boolean;
      suggest?: string;
      faq?: boolean | string;
      yes?: boolean;
      model?: string;
      promptFile?: string;
      json?: boolean;
      html?: boolean | string;
    }) => {
      if (opts.faq) {
        const repoRoot = resolveRepoRoot(typeof opts.faq === 'string' ? opts.faq : process.cwd());
        // repo-scoped scan: the newest-overall window must be wide enough to
        // reach this repo's sessions among everything else
        await writeFaq(repoRoot, Math.max(Number(opts.limit), 300));
        return;
      }
      const sessions = await loadSessionsInScope(opts);
      if (!sessions.length) throw new Error('No sessions in scope — relax --since/--agent/--limit');
      const projectDirs = [...new Set(sessions.map((s) => s.cwd).filter((c): c is string => !!c))];
      const [claudeSkills, codexSkills] = await Promise.all([
        listInstalledClaudeCommands({ projectDirs }),
        listInstalledCodexCommands(),
      ]);
      const stats = buildDistillStats(sessions, {
        knownSkills: new Set([...claudeSkills, ...codexSkills]),
      });

      if (opts.json) {
        console.log(JSON.stringify(stats, null, 2));
        return;
      }
      let body = renderDistillStats(stats);
      if (!opts.suggest) {
        await deliver('distill', 'distill — recurrence stats', body, stats, opts);
        return;
      }
      if (!opts.html) console.log(body);

      if (opts.suggest) {
        if (opts.suggest !== 'claude' && opts.suggest !== 'codex') {
          throw new Error(`--suggest must be claude or codex, got "${opts.suggest}"`);
        }
        const template = opts.promptFile
          ? await (await import('node:fs/promises')).readFile(opts.promptFile, 'utf8')
          : undefined;
        const backend = opts.suggest as SuggestBackend;
        const approved = await confirmModelCall({
          label: '--suggest recommendations',
          backend,
          prompt: buildSuggestPrompt(stats, template),
          outputEstimate: [500, 3000],
          yes: opts.yes,
        });
        if (!approved) return;
        console.log(`\n— asking ${opts.suggest} for recommendations…`);
        const recommendations = await runSuggest(stats, { backend, model: opts.model, template });
        if (opts.html) {
          body += `\n\nRecommendations (${backend}):\n\n${recommendations}`;
          await deliver('distill', 'distill — recurrence stats + recommendations', body, stats, opts);
        } else {
          console.log('\n' + recommendations);
        }
      }
    },
  );

program.parseAsync(process.argv).catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
