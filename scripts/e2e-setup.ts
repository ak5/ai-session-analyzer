/**
 * Prepare the gitignored .e2e/ sandbox homes and generate fixture sessions
 * for the e2e suite, using the REAL claude / codex CLIs pointed at
 * repo-local homes via CLAUDE_CONFIG_DIR / CODEX_HOME.
 *
 *   pnpm e2e:setup                # real CLI runs (needs auth, see below)
 *   pnpm e2e:setup --synthetic    # hand-crafted fixtures, no auth, no cost
 *   pnpm e2e:setup --force        # regenerate even if fixtures exist
 *
 * Auth for real mode:
 * - claude: macOS keeps credentials in the Keychain, which an isolated
 *   CLAUDE_CONFIG_DIR cannot see. The supported bridge is a long-lived token:
 *   run `claude setup-token` once, then either export CLAUDE_CODE_OAUTH_TOKEN
 *   or write the token to .e2e/claude-token (chmod 600). On Linux the script
 *   copies ~/.claude/.credentials.json instead.
 * - codex: the script copies ~/.codex/auth.json into .e2e/codex-home/.
 *
 * Both copies stay inside .e2e/, which this script refuses to touch unless
 * git confirms the path is ignored.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const e2eRoot = join(repoRoot, '.e2e');
const claudeHome = join(e2eRoot, 'claude-home');
const codexHome = join(e2eRoot, 'codex-home');
const synthetic = process.argv.includes('--synthetic');
const force = process.argv.includes('--force');

const CLAUDE_FIXTURE_ID = 'e2ec1aad-0000-4000-8000-000000000001';
const CLAUDE_PROMPT =
  'Use the Bash tool to run exactly `echo e2e-marker` and then reply with exactly: E2E-DONE';
const CODEX_PROMPT = 'Run the command `echo e2e-marker` and then reply with exactly: E2E-DONE';

function fail(message: string): never {
  console.error(`e2e-setup: ${message}`);
  process.exit(1);
}

function assertGitignored(): void {
  // probe a path inside the dir: the `.e2e/` gitignore pattern only matches
  // directories, so checking `.e2e` itself fails while the dir doesn't exist
  const check = spawnSync('git', ['check-ignore', '.e2e/probe'], { cwd: repoRoot });
  if (check.status !== 0) {
    fail('.e2e is not gitignored — refusing to write session/auth data into a tracked path');
  }
}

function projectSlug(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

function claudeProjectDir(): string {
  return join(claudeHome, 'projects', projectSlug(repoRoot));
}

function hasClaudeFixture(): boolean {
  const dir = claudeProjectDir();
  return existsSync(dir) && readdirSync(dir).some((f) => f.endsWith('.jsonl'));
}

function hasCodexFixture(): boolean {
  const dir = join(codexHome, 'sessions');
  if (!existsSync(dir)) return false;
  return readdirSync(dir, { recursive: true }).some((f) => String(f).endsWith('.jsonl'));
}

// --- real mode -------------------------------------------------------------

function resolveClaudeAuthEnv(): Record<string, string> {
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN) return {};
  const tokenFile = join(e2eRoot, 'claude-token');
  if (existsSync(tokenFile)) {
    return { CLAUDE_CODE_OAUTH_TOKEN: readFileSync(tokenFile, 'utf8').trim() };
  }
  const credentials = join(homedir(), '.claude', '.credentials.json');
  if (existsSync(credentials)) {
    // Linux/Windows: credentials are a plain file inside the config dir
    copyFileSync(credentials, join(claudeHome, '.credentials.json'));
    chmodSync(join(claudeHome, '.credentials.json'), 0o600);
    return {};
  }
  fail(
    'no Claude auth for the isolated home. Run `claude setup-token` once, then either\n' +
      '  export CLAUDE_CODE_OAUTH_TOKEN=<token>   or   write it to .e2e/claude-token (chmod 600)\n' +
      'and re-run `pnpm e2e:setup`. (Or use `pnpm e2e:setup --synthetic` — no auth needed.)',
  );
}

function generateClaudeSession(): void {
  const authEnv = resolveClaudeAuthEnv();
  console.log('generating Claude fixture session (haiku, one tiny prompt)…');
  execFileSync(
    'claude',
    [
      '-p',
      '--model', 'haiku',
      '--session-id', CLAUDE_FIXTURE_ID,
      '--allowedTools', 'Bash',
      CLAUDE_PROMPT,
    ],
    {
      cwd: repoRoot,
      env: { ...process.env, ...authEnv, CLAUDE_CONFIG_DIR: claudeHome },
      stdio: 'inherit',
      timeout: 180_000,
    },
  );
}

function generateCodexSession(): void {
  const authSource = join(homedir(), '.codex', 'auth.json');
  const authTarget = join(codexHome, 'auth.json');
  if (!existsSync(authTarget)) {
    if (!existsSync(authSource)) {
      fail(
        'no ~/.codex/auth.json to copy into the isolated CODEX_HOME. Log in to codex first,\n' +
          'or use `pnpm e2e:setup --synthetic`.',
      );
    }
    copyFileSync(authSource, authTarget);
    chmodSync(authTarget, 0o600);
  }
  console.log('generating Codex fixture session (one tiny prompt)…');
  execFileSync('codex', ['exec', '--skip-git-repo-check', CODEX_PROMPT], {
    cwd: repoRoot,
    env: { ...process.env, CODEX_HOME: codexHome },
    stdio: 'inherit',
    timeout: 180_000,
  });
}

// --- synthetic mode --------------------------------------------------------
// Format-faithful hand-written fixtures (see docs/formats.md). Used by CI and
// anywhere auth is unavailable; the e2e suite does not care which mode wrote them.

function writeClaudeSynthetic(): void {
  const dir = claudeProjectDir();
  mkdirSync(dir, { recursive: true });
  const id = CLAUDE_FIXTURE_ID;
  const base = {
    sessionId: id,
    cwd: repoRoot,
    gitBranch: 'main',
    version: '2.1.212',
    userType: 'external',
    isSidechain: false,
  };
  const usage = { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 500 };
  const records = [
    { ...base, type: 'user', uuid: 'e2e-u1', parentUuid: null, timestamp: '2026-07-17T12:00:00.000Z',
      message: { role: 'user', content: CLAUDE_PROMPT } },
    { ...base, type: 'assistant', uuid: 'e2e-a1', parentUuid: 'e2e-u1', requestId: 'req_e2e1',
      timestamp: '2026-07-17T12:00:02.000Z',
      message: { id: 'msg_e2e1', type: 'message', role: 'assistant', model: 'claude-haiku-4-5-20251001',
        content: [{ type: 'tool_use', id: 'toolu_e2e1', name: 'Bash', input: { command: 'echo e2e-marker' } }],
        usage } },
    { ...base, type: 'user', uuid: 'e2e-u2', parentUuid: 'e2e-a1', timestamp: '2026-07-17T12:00:03.000Z',
      message: { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 'toolu_e2e1', content: 'e2e-marker', is_error: false } ] },
      toolUseResult: { stdout: 'e2e-marker', stderr: '', interrupted: false } },
    { ...base, type: 'assistant', uuid: 'e2e-a2', parentUuid: 'e2e-u2', requestId: 'req_e2e2',
      timestamp: '2026-07-17T12:00:05.000Z',
      message: { id: 'msg_e2e2', type: 'message', role: 'assistant', model: 'claude-haiku-4-5-20251001',
        content: [{ type: 'text', text: 'E2E-DONE' }],
        usage: { input_tokens: 15, output_tokens: 5, cache_read_input_tokens: 600 } } },
    { type: 'ai-title', aiTitle: 'Synthetic e2e fixture', sessionId: id },
  ];
  writeFileSync(join(dir, `${id}.jsonl`), records.map((r) => JSON.stringify(r)).join('\n') + '\n');
}

function writeCodexSynthetic(): void {
  const id = randomUUID();
  const dir = join(codexHome, 'sessions', '2026', '07', '17');
  mkdirSync(dir, { recursive: true });
  const lines = [
    { timestamp: '2026-07-17T12:00:00.000Z', type: 'session_meta',
      payload: { id, cwd: repoRoot, cli_version: '0.144.4', originator: 'codex-exec',
        git: { branch: 'main' } } },
    { timestamp: '2026-07-17T12:00:00.100Z', type: 'turn_context',
      payload: { model: 'gpt-5.6-sol', effort: 'low' } },
    { timestamp: '2026-07-17T12:00:00.200Z', type: 'event_msg',
      payload: { type: 'user_message', message: CODEX_PROMPT } },
    { timestamp: '2026-07-17T12:00:00.300Z', type: 'event_msg',
      payload: { type: 'task_started', turn_id: 'e2e-turn-1' } },
    { timestamp: '2026-07-17T12:00:01.000Z', type: 'response_item',
      payload: { type: 'function_call', name: 'exec', call_id: 'call_e2e1',
        arguments: '{"cmd":["echo","e2e-marker"]}' } },
    { timestamp: '2026-07-17T12:00:01.500Z', type: 'response_item',
      payload: { type: 'function_call_output', call_id: 'call_e2e1', output: 'e2e-marker' } },
    { timestamp: '2026-07-17T12:00:02.000Z', type: 'event_msg',
      payload: { type: 'token_count', info: {
        total_token_usage: { input_tokens: 900, cached_input_tokens: 300, output_tokens: 40,
          reasoning_output_tokens: 8, total_tokens: 940 },
        model_context_window: 272000 } } },
    { timestamp: '2026-07-17T12:00:02.500Z', type: 'event_msg',
      payload: { type: 'task_complete', turn_id: 'e2e-turn-1', duration_ms: 2200 } },
  ];
  writeFileSync(
    join(dir, `rollout-2026-07-17T12-00-00-${id}.jsonl`),
    lines.map((l) => JSON.stringify(l)).join('\n') + '\n',
  );
}

// --- main ------------------------------------------------------------------

assertGitignored();
mkdirSync(claudeHome, { recursive: true });
mkdirSync(codexHome, { recursive: true });

if (force || !hasClaudeFixture()) {
  if (synthetic) writeClaudeSynthetic();
  else generateClaudeSession();
} else {
  console.log('Claude fixture already present — skipping (use --force to regenerate)');
}

if (force || !hasCodexFixture()) {
  if (synthetic) writeCodexSynthetic();
  else generateCodexSession();
} else {
  console.log('Codex fixture already present — skipping (use --force to regenerate)');
}

console.log(`\ne2e homes ready under ${e2eRoot}`);
console.log('run the suite with: pnpm test:e2e');
