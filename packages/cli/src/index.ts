import { Command } from 'commander';
import { previewText, shortId, type NormalizedSession, type SessionRef } from '@asa/core';
import { analyzeSession, compareReports, renderComparison, renderReport } from '@asa/analyze';
import { listInstalledClaudeCommands } from '@asa/claude-sessions';
import { listInstalledCodexCommands } from '@asa/codex-sessions';
import {
  analyzePrompter,
  collectStepSignals,
  judgePrompts,
  renderPrompterReport,
  selectJudgeSamples,
  type JudgeResult,
} from '@asa/prompter';
import {
  buildDistillStats,
  isInternalSession,
  renderDistillStats,
  runSuggest,
  type SuggestBackend,
} from '@asa/distill';
import {
  AGENT_FILTER_VALUES,
  AGENTS,
  SELECTOR_HINT,
  agentsForFilter,
  type AgentAdapter,
} from './agents.js';
import {
  buildIntentReport,
  buildProjectDossier,
  computeEfficacy,
  deepenIntentReport,
  readInstructionChanges,
  renderDossier,
  renderEfficacy,
  renderIntents,
  steeringSamples,
} from '@asa/meta';
import { installGitTraceHooks, resolveRepoRoot } from './hooks-install.js';
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
    $ asa prompter --deep                        # + LLM-judge pass via claude -p (haiku)

  Find what to extract into skills, rules, FAQs, automations
    $ asa distill --since 60d                    # deterministic recurrence stats, local only
    $ asa distill --suggest claude               # + model recommendations (or --suggest codex)

  Understand a repo's whole agent history
    $ asa project ~/Projects/botyard             # dossier: spend, steering, instruction surfaces
    $ asa efficacy ~/Projects/botyard            # did CLAUDE.md edits reduce corrections?
    $ asa intents --since 30d                    # what you use agents for, per repo
    $ asa intents --deep claude                  # + model-named recurring themes, shipped or not

  Feed a dashboard or jq pipeline
    $ asa analyze -c <id> --json | jq '.totals'
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
  .version('1.0.0-rc.2')
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
  .action(async (opts: SelectorOpts & { json?: boolean }) => {
    const { adapter, ref } = await resolveSession(opts);
    const report = analyzeSession(await adapter.load(ref.filePath));
    console.log(opts.json ? JSON.stringify(report, null, 2) : renderReport(report));
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
  .option('--deep', 'add an LLM-judge pass: sampled prompts graded via `claude -p` (haiku)')
  .option('--sample <k>', 'prompts to sample for --deep', '10')
  .option('--model <model>', 'judge model for --deep', 'haiku')
  .option('--json', 'output the full report as JSON')
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
      deep?: boolean;
      sample: string;
      model: string;
      json?: boolean;
    }) => {
      const sessions = await loadSessionsInScope(opts);
      if (!sessions.length) throw new Error('No sessions in scope — relax --since/--agent/--limit');
      const report = analyzePrompter(sessions);

      let judge: JudgeResult | undefined;
      if (opts.deep) {
        const samples = selectJudgeSamples(sessions.flatMap(collectStepSignals), Number(opts.sample));
        try {
          judge = await judgePrompts(samples, { model: opts.model });
        } catch (err) {
          console.error(
            `--deep judge failed (${err instanceof Error ? err.message : err}) — continuing without it`,
          );
        }
      }

      if (opts.json) {
        console.log(JSON.stringify({ ...report, judge }, null, 2));
      } else {
        console.log(renderPrompterReport(report, judge));
      }
    },
  );

const collect = (value: string, previous: string[] = []) => [...previous, value];

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
  .action(async (path: string | undefined, opts: { limit: string; json?: boolean }) => {
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
  .action(
    async (path: string | undefined, opts: { limit: string; window: string; json?: boolean }) => {
      const repoRoot = resolveRepoRoot(path ?? process.cwd());
      const changes = readInstructionChanges(repoRoot);
      const sessions = await loadSessionsForRepo(repoRoot, Number(opts.limit));
      const entries = computeEfficacy(changes, steeringSamples(sessions), Number(opts.window));
      console.log(opts.json ? JSON.stringify(entries, null, 2) : renderEfficacy(entries));
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
  .option('--model <model>', 'model for --deep claude')
  .option('--json', 'output the report as JSON')
  .action(
    async (opts: {
      agent: string;
      limit: string;
      since?: string;
      deep?: string;
      model?: string;
      json?: boolean;
    }) => {
      const sessions = await loadSessionsInScope(opts);
      if (!sessions.length) throw new Error('No sessions in scope — relax --since/--agent/--limit');
      let report = buildIntentReport(sessions);
      if (opts.deep) {
        if (opts.deep !== 'claude' && opts.deep !== 'codex') {
          throw new Error(`--deep must be claude or codex, got "${opts.deep}"`);
        }
        try {
          report = await deepenIntentReport(report, opts.deep, { model: opts.model });
        } catch (err) {
          console.error(
            `--deep failed (${err instanceof Error ? err.message : err}) — continuing with heuristics`,
          );
        }
      }
      console.log(opts.json ? JSON.stringify(report, null, 2) : renderIntents(report));
    },
  );

program
  .command('compare')
  .description('Compare two sessions metric by metric (original vs fork, replay, or cross-agent)')
  .option('-c, --claude <id>', 'claude session id (repeatable)', collect, [])
  .option('-o, --codex <id>', 'codex session id (repeatable)', collect, [])
  .option('--json', 'output both reports and the comparison rows as JSON')
  .addHelpText(
    'after',
    `
Examples:
  $ asa compare -c <original> -c <fork>       # did the fork do better?
  $ asa compare -c <claude-id> -o <codex-id>  # same task, different agent
Order: A = first id given (claude ids first), B = second.
`,
  )
  .action(async (opts: { claude: string[]; codex: string[]; json?: boolean }) => {
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
    if (opts.json) {
      console.log(JSON.stringify({ a, b, rows: compareReports(a!, b!) }, null, 2));
    } else {
      console.log(renderComparison(a!, b!));
    }
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
  .option('--model <model>', 'model for --suggest claude (codex uses its configured default)')
  .option('--prompt-file <path>', 'override the suggest prompt template with a file')
  .option('--json', 'output the raw stats as JSON')
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
      model?: string;
      promptFile?: string;
      json?: boolean;
    }) => {
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
      console.log(renderDistillStats(stats));

      if (opts.suggest) {
        if (opts.suggest !== 'claude' && opts.suggest !== 'codex') {
          throw new Error(`--suggest must be claude or codex, got "${opts.suggest}"`);
        }
        const template = opts.promptFile
          ? await (await import('node:fs/promises')).readFile(opts.promptFile, 'utf8')
          : undefined;
        console.log(`\n— asking ${opts.suggest} for recommendations…\n`);
        console.log(
          await runSuggest(stats, {
            backend: opts.suggest as SuggestBackend,
            model: opts.model,
            template,
          }),
        );
      }
    },
  );

program.parseAsync(process.argv).catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
