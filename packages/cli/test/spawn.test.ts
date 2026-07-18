import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawnAgentCli } from '../src/spawn.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('spawnAgentCli --dry-run', () => {
  it('prints the command without executing and quotes args with spaces', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const code = await spawnAgentCli(
      'claude',
      ['-p', '--resume', 'abc', 'do the thing'],
      { dryRun: true },
    );
    expect(code).toBe(0);
    const printed = log.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(printed).toContain('claude -p --resume abc "do the thing"');
  });

  it('falls back to process.cwd() when the session cwd no longer exists', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await spawnAgentCli('codex', ['resume', 'abc'], {
      dryRun: true,
      cwd: '/nonexistent/gone-project',
    });
    const printed = log.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(printed).toContain(`cwd: ${process.cwd()}`);
  });
});
