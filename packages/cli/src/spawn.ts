import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

export interface SpawnCliOptions {
  cwd?: string;
  dryRun?: boolean;
}

/**
 * Hand off to the real agent CLI (claude / codex) with inherited stdio, in
 * the session's original cwd so project-scoped session lookup works.
 */
export async function spawnAgentCli(
  command: string,
  args: string[],
  options: SpawnCliOptions = {},
): Promise<number> {
  const cwd = options.cwd && existsSync(options.cwd) ? options.cwd : process.cwd();
  const rendered = `${command} ${args.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(' ')}`;
  if (options.dryRun) {
    console.log(`[dry-run] would run (cwd: ${cwd}):\n  ${rendered}`);
    return 0;
  }
  console.error(`→ ${rendered}  (cwd: ${cwd})`);
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: 'inherit' });
    child.on('error', (err) =>
      reject(
        new Error(`Failed to launch "${command}" — is it installed and on PATH? (${err.message})`),
      ),
    );
    child.on('exit', (code) => resolve(code ?? 0));
  });
}
