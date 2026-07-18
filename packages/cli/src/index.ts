import { Command } from 'commander';
import { previewText, shortId, type NormalizedSession, type SessionRef } from '@asa/core';
import {
  findClaudeSession,
  forkClaudeSessionAtStep,
  listClaudeSessions,
  loadClaudeSession,
} from '@asa/claude-sessions';
import { findCodexSession, listCodexSessions, loadCodexSession } from '@asa/codex-sessions';
import { analyzeSession, renderReport } from '@asa/analyze';
import {
  analyzePrompter,
  collectStepSignals,
  judgePrompts,
  renderPrompterReport,
  selectJudgeSamples,
  type JudgeResult,
} from '@asa/prompter';
import { spawnAgentCli } from './spawn.js';

interface SessionSelector {
  claudeSession?: string;
  codexSession?: string;
}

async function resolveSession(sel: SessionSelector): Promise<SessionRef> {
  if (!!sel.claudeSession === !!sel.codexSession) {
    throw new Error('Pass exactly one of --claude-session <id> or --codex-session <id>');
  }
  const ref = sel.claudeSession
    ? await findClaudeSession(sel.claudeSession)
    : await findCodexSession(sel.codexSession!);
  if (!ref) {
    throw new Error(`No ${sel.claudeSession ? 'Claude' : 'Codex'} session matching "${sel.claudeSession ?? sel.codexSession}"`);
  }
  return ref;
}

async function loadSession(ref: SessionRef): Promise<NormalizedSession> {
  return ref.agent === 'claude' ? loadClaudeSession(ref.filePath) : loadCodexSession(ref.filePath);
}

function addSelectorOptions(cmd: Command): Command {
  return cmd
    .option('--claude-session <id>', 'Claude Code session id (or unique prefix)')
    .option('--codex-session <id>', 'Codex session id (or unique prefix)');
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

/** Files above this size are skipped by `prompter` (multi-hundred-MB rollouts exist). */
const PROMPTER_MAX_FILE_BYTES = 30 * 1024 * 1024;

async function loadSessionsForPrompter(opts: {
  agent: string;
  limit: string;
  since?: string;
  includeSubagents?: boolean;
}): Promise<NormalizedSession[]> {
  const wantClaude = opts.agent === 'all' || opts.agent === 'claude';
  const wantCodex = opts.agent === 'all' || opts.agent === 'codex';
  const [claude, codex] = await Promise.all([
    wantClaude ? listClaudeSessions() : Promise.resolve([]),
    wantCodex ? listCodexSessions() : Promise.resolve([]),
  ]);
  let refs = [...claude, ...codex].sort(
    (a, b) => (b.updatedAt?.getTime() ?? 0) - (a.updatedAt?.getTime() ?? 0),
  );
  if (opts.since) {
    const cutoff = parseSince(opts.since);
    refs = refs.filter((r) => (r.updatedAt?.getTime() ?? 0) >= cutoff.getTime());
  }
  refs = refs.slice(0, Number(opts.limit));

  const sessions: NormalizedSession[] = [];
  for (const ref of refs) {
    if ((ref.sizeBytes ?? 0) > PROMPTER_MAX_FILE_BYTES) {
      console.error(`skipping ${ref.agent} ${ref.id} (${Math.round((ref.sizeBytes ?? 0) / 1e6)}MB > 30MB)`);
      continue;
    }
    try {
      sessions.push(await loadSession(ref));
    } catch (err) {
      console.error(`skipping ${ref.agent} ${ref.id}: ${err instanceof Error ? err.message : err}`);
    }
  }
  if (opts.includeSubagents) return sessions;
  // Subagent rollouts carry machine-written "user" prompts — they'd poison
  // any analysis of the human prompter.
  const human = sessions.filter((s) => !s.isSubagent);
  const dropped = sessions.length - human.length;
  if (dropped) console.error(`excluded ${dropped} subagent sessions (use --include-subagents to keep)`);
  return human;
}

const USE_CASES = `
Use cases:
  Find and inspect your most recent expensive session
    $ asa list -n 10
    $ asa analyze --claude-session <id>          # tokens, steps, tools, MCP, subagents

  Re-enter a warmed-up session instead of re-explaining from scratch
    $ asa analyze --claude-session <id>          # pick a step id from the Steps table
    $ asa fork --claude-session <id> --at <stepId>
    # → truncated copy under a new session id; the replayed prefix hits prompt cache

  Try a risky refactor without touching the original conversation
    $ asa fork --claude-session <id>             # whole-session fork (claude --fork-session)
    $ asa fork --codex-session <id>              # wraps codex fork

  Drive a session headlessly from a script
    $ asa resume --claude-session <id> -p "run the tests and fix failures"
    $ asa resume --codex-session <id> -p "continue"   # codex exec resume

  Study yourself as a prompter (30 days, both agents)
    $ asa prompter --since 30d --limit 50
    $ asa prompter --deep                        # + LLM-judge pass via claude -p (haiku)

  Feed a dashboard or jq pipeline
    $ asa analyze --claude-session <id> --json | jq '.totals'
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
  .version('1.0.0-rc.1')
  .addHelpText('after', USE_CASES);

program
  .command('list')
  .description('List recent sessions from both agents')
  .option('--agent <agent>', 'claude | codex | all', 'all')
  .option('-n, --limit <n>', 'max sessions per agent', '15')
  .option('--json', 'output JSON')
  .action(async (opts: { agent: string; limit: string; json?: boolean }) => {
    const limit = Number(opts.limit);
    const wantClaude = opts.agent === 'all' || opts.agent === 'claude';
    const wantCodex = opts.agent === 'all' || opts.agent === 'codex';
    const [claude, codex] = await Promise.all([
      wantClaude ? listClaudeSessions() : Promise.resolve([]),
      wantCodex ? listCodexSessions() : Promise.resolve([]),
    ]);
    const rows = [...claude.slice(0, limit), ...codex.slice(0, limit)].sort(
      (a, b) => (b.updatedAt?.getTime() ?? 0) - (a.updatedAt?.getTime() ?? 0),
    );
    if (opts.json) {
      console.log(JSON.stringify(rows, null, 2));
      return;
    }
    for (const ref of rows) {
      const when = ref.updatedAt?.toISOString().replace('T', ' ').slice(0, 16) ?? '?';
      const size = ref.sizeBytes !== undefined ? `${Math.round(ref.sizeBytes / 1024)}kB` : '';
      const label = ref.title ?? ref.cwd ?? '';
      console.log(
        `${when}  ${ref.agent.padEnd(6)} ${ref.id}  ${size.padStart(8)}  ${previewText(label, 48)}`,
      );
    }
    if (!rows.length) console.log('No sessions found.');
  });

addSelectorOptions(
  program
    .command('analyze')
    .description('Analyze a session: tokens, steps, tool calls, MCP usage, subagents'),
)
  .option('--json', 'output the full report as JSON')
  .action(async (opts: SessionSelector & { json?: boolean }) => {
    const ref = await resolveSession(opts);
    const report = analyzeSession(await loadSession(ref));
    console.log(opts.json ? JSON.stringify(report, null, 2) : renderReport(report));
  });

addSelectorOptions(
  program
    .command('resume')
    .description('Resume a session in its original cwd (wraps `claude --resume` / `codex resume`)'),
)
  .option('-p, --prompt <prompt>', 'run headless with this prompt instead of interactively')
  .option('--dry-run', 'print the command instead of running it')
  .action(async (opts: SessionSelector & { prompt?: string; dryRun?: boolean }) => {
    const ref = await resolveSession(opts);
    const session = await loadSession(ref);
    const spawnOpts = { cwd: session.cwd, dryRun: opts.dryRun };
    const code =
      ref.agent === 'claude'
        ? await spawnAgentCli(
            'claude',
            opts.prompt ? ['-p', '--resume', ref.id, opts.prompt] : ['--resume', ref.id],
            spawnOpts,
          )
        : await spawnAgentCli(
            'codex',
            opts.prompt ? ['exec', 'resume', ref.id, opts.prompt] : ['resume', ref.id],
            spawnOpts,
          );
    process.exitCode = code;
  });

addSelectorOptions(
  program
    .command('fork')
    .description(
      'Fork a session (new session id, original untouched). With --at <stepId>, fork a Claude session at a specific step — reusing the warmed-up context up to that point.',
    ),
)
  .option('--at <stepId>', 'Claude only: step id (record uuid from `asa analyze`) to fork at')
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
  $ asa fork --claude-session 092aede3                    # whole-session fork
  $ asa fork --claude-session 092aede3 --at <stepId>      # fork at a step
  $ asa fork --claude-session 092aede3 --at <stepId> -p "try approach B instead"
  $ asa fork --claude-session 092aede3 --at <stepId> --no-launch   # just create it
`,
  )
  .action(
    async (
      opts: SessionSelector & {
        at?: string;
        prompt?: string;
        launch: boolean;
        dryRun?: boolean;
      },
    ) => {
      const ref = await resolveSession(opts);
      const session = await loadSession(ref);
      const spawnOpts = { cwd: session.cwd, dryRun: opts.dryRun };

      if (ref.agent === 'codex') {
        if (opts.at) throw new Error('--at is not supported for Codex sessions yet');
        const args = ['fork', ref.id];
        if (opts.prompt) args.push(opts.prompt);
        process.exitCode = await spawnAgentCli('codex', args, spawnOpts);
        return;
      }

      if (opts.at) {
        const fork = await forkClaudeSessionAtStep(ref.filePath, opts.at);
        console.log(
          `Forked ${shortId(ref.id)} at step ${shortId(opts.at)} → session ${fork.newSessionId}` +
            `\n  ${fork.newFilePath}\n  kept ${fork.keptRecords} records, dropped ${fork.droppedRecords}`,
        );
        if (!opts.launch) return;
        const args = opts.prompt
          ? ['-p', '--resume', fork.newSessionId, opts.prompt]
          : ['--resume', fork.newSessionId];
        process.exitCode = await spawnAgentCli('claude', args, spawnOpts);
        return;
      }

      const args = opts.prompt
        ? ['-p', '--resume', ref.id, '--fork-session', opts.prompt]
        : ['--resume', ref.id, '--fork-session'];
      process.exitCode = await spawnAgentCli('claude', args, spawnOpts);
    },
  );

program
  .command('prompter')
  .description(
    'Analyze the human: prompt specificity, corrections, interruptions, leverage, archetype, lint findings, and a weekly skill curve — aggregated across recent sessions of both agents.',
  )
  .option('--agent <agent>', 'claude | codex | all', 'all')
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
      const sessions = await loadSessionsForPrompter(opts);
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

program.parseAsync(process.argv).catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
