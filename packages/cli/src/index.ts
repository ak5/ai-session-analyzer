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

const program = new Command();
program
  .name('asa')
  .description('ai session analyzer — analyze, resume and fork Claude Code & Codex CLI sessions')
  .version('1.0.0-rc.1');

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

program.parseAsync(process.argv).catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
