/**
 * `asa install-hooks`: give a repo per-step git context. Installs Claude Code
 * UserPromptSubmit/Stop hooks that append {ts, event, session_id, git HEAD,
 * dirty count} to a gitignored .asa/git-trace.jsonl sidecar. The parsers join
 * that trace back onto session steps, so analyze/compare/replay can reason
 * about which commit each prompt ran against.
 *
 * With --jj, also colocates a jj repo (jj git init --colocate): the hook then
 * runs `jj status` per event, forcing a working-copy snapshot into jj's op
 * log — fine-grained, commit-free history of every AI edit between prompts.
 *
 * Codex note: rollouts already record commit_hash at session start;
 * codex has no equivalent per-turn hook surface today.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';

export const TRACE_DIR = '.asa';
export const TRACE_FILE = 'git-trace.jsonl';
const HOOK_SCRIPT_REL = `${TRACE_DIR}/hooks/git-trace.mjs`;
const HOOK_COMMAND = `node "$CLAUDE_PROJECT_DIR/${HOOK_SCRIPT_REL}"`;

export const HOOK_SCRIPT = `#!/usr/bin/env node
// Installed by \`asa install-hooks\` — records git state per prompt/stop into
// ${TRACE_DIR}/${TRACE_FILE} so asa can join session steps to commits.
// Must never print to stdout (UserPromptSubmit stdout becomes agent context).
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

let input = '';
process.stdin.on('data', (chunk) => (input += chunk));
process.stdin.on('end', () => {
  let payload = {};
  try {
    payload = JSON.parse(input);
  } catch {}
  const cwd = payload.cwd || process.cwd();
  const git = (args) => {
    try {
      return execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'ignore'] })
        .toString()
        .trim();
    } catch {
      return undefined;
    }
  };
  const head = git(['rev-parse', 'HEAD']);
  const status = git(['status', '--porcelain']);
  if (existsSync(join(cwd, '.jj'))) {
    // colocated jj: force a working-copy snapshot into the op log
    try {
      execFileSync('jj', ['status'], { cwd, stdio: 'ignore' });
    } catch {}
    // undo/redo (opt-in via .asa/undo-redo marker): a prompt marks a turn
    // boundary — push the current op onto the undo stack, clear redo.
    // Dedupe against the stack tail so a coexisting global marking hook
    // doesn't double-push the same op.
    if (
      payload.hook_event_name === 'UserPromptSubmit' &&
      existsSync(join(cwd, '${TRACE_DIR}', 'undo-redo'))
    ) {
      try {
        const op = execFileSync(
          'jj',
          ['op', 'log', '--ignore-working-copy', '--limit', '1', '--no-graph', '-T', 'self.id().short()'],
          { cwd, stdio: ['ignore', 'pipe', 'ignore'] },
        )
          .toString()
          .trim();
        const sid = payload.session_id || 'default';
        const undoPath = join(cwd, '.jj', 'undo-stack-' + sid);
        const tail = existsSync(undoPath)
          ? readFileSync(undoPath, 'utf8').trim().split('\\n').pop()
          : undefined;
        if (op && op !== tail) {
          appendFileSync(undoPath, op + '\\n');
          writeFileSync(join(cwd, '.jj', 'redo-stack-' + sid), '');
        }
      } catch {}
    }
  }
  const line = {
    ts: new Date().toISOString(),
    event: payload.hook_event_name ?? 'unknown',
    session_id: payload.session_id,
    head,
    branch: git(['rev-parse', '--abbrev-ref', 'HEAD']),
    dirty_files: status === undefined ? undefined : status ? status.split('\\n').length : 0,
  };
  try {
    mkdirSync(join(cwd, '${TRACE_DIR}'), { recursive: true });
    appendFileSync(join(cwd, '${TRACE_DIR}', '${TRACE_FILE}'), JSON.stringify(line) + '\\n');
  } catch {}
  process.exit(0);
});
`;

export interface InstallHooksResult {
  actions: string[];
}

interface HookEntry {
  hooks?: Array<{ type?: string; command?: string }>;
  [k: string]: unknown;
}

function ensureHook(settings: Record<string, unknown>, event: string): boolean {
  const hooks = (settings.hooks ??= {}) as Record<string, HookEntry[]>;
  const entries = (hooks[event] ??= []);
  const present = entries.some((e) => e.hooks?.some((h) => h.command?.includes('git-trace.mjs')));
  if (present) return false;
  entries.push({ hooks: [{ type: 'command', command: HOOK_COMMAND }] });
  return true;
}

/** Resolve the repo root from any path inside it (like git itself does). */
export function resolveRepoRoot(fromPath: string): string {
  if (existsSync(join(fromPath, '.git')) || existsSync(join(fromPath, '.jj'))) return fromPath;
  const probe = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: fromPath });
  const root = probe.status === 0 ? probe.stdout.toString().trim() : '';
  if (!root) throw new Error(`${fromPath} is not inside a git (or jj) repository`);
  return root;
}

export function installGitTraceHooks(fromPath: string, options: { jj?: boolean } = {}): InstallHooksResult {
  const actions: string[] = [];
  const repoPath = resolveRepoRoot(fromPath);
  if (repoPath !== fromPath) actions.push(`resolved repo root: ${repoPath}`);

  const scriptPath = join(repoPath, HOOK_SCRIPT_REL);
  mkdirSync(join(repoPath, TRACE_DIR, 'hooks'), { recursive: true });
  const scriptExisted = existsSync(scriptPath) && readFileSync(scriptPath, 'utf8') === HOOK_SCRIPT;
  if (!scriptExisted) {
    writeFileSync(scriptPath, HOOK_SCRIPT, { mode: 0o755 });
    actions.push(`wrote ${HOOK_SCRIPT_REL}`);
  }

  const settingsPath = join(repoPath, '.claude', 'settings.json');
  mkdirSync(join(repoPath, '.claude'), { recursive: true });
  let settings: Record<string, unknown> = {};
  if (existsSync(settingsPath)) {
    settings = JSON.parse(readFileSync(settingsPath, 'utf8')) as Record<string, unknown>;
  }
  const added = ['UserPromptSubmit', 'Stop'].filter((event) => ensureHook(settings, event));
  if (added.length) {
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
    actions.push(`registered ${added.join('+')} hooks in .claude/settings.json`);
  }

  const gitignorePath = join(repoPath, '.gitignore');
  const gitignore = existsSync(gitignorePath) ? readFileSync(gitignorePath, 'utf8') : '';
  if (!gitignore.split('\n').some((l) => l.trim() === `${TRACE_DIR}/`)) {
    appendFileSync(gitignorePath, `${gitignore.endsWith('\n') || !gitignore ? '' : '\n'}${TRACE_DIR}/\n`);
    actions.push(`gitignored ${TRACE_DIR}/`);
  }

  if (options.jj) {
    actions.push(colocateJj(repoPath));
  }

  if (!actions.length) actions.push('already installed — nothing to do');
  return { actions };
}

/** Colocate a jj repo (idempotent). Standalone so setup can offer it as its own opt-in step. */
export function colocateJj(repoPath: string): string {
  if (existsSync(join(repoPath, '.jj'))) return 'jj already colocated';
  if (spawnSync('jj', ['--version'], { stdio: 'ignore' }).status !== 0) {
    return 'jj not on PATH — skipped colocation (brew install jj)';
  }
  execFileSync('jj', ['git', 'init', '--colocate'], { cwd: repoPath, stdio: 'ignore' });
  return 'colocated jj repo (jj git init --colocate)';
}
