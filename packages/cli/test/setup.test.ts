import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readRetention, writeRetention } from '../src/setup.js';

describe('retention read/write', () => {
  it('reads default when unset and preserves other settings on write', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'asa-setup-'));
    const settingsPath = join(dir, 'settings.json');
    await writeFile(settingsPath, JSON.stringify({ permissions: { allow: ['Bash(ls:*)'] } }));

    const before = readRetention(dir);
    expect(before.current).toBeUndefined();
    expect(before.effective).toBe(30);

    writeRetention(settingsPath, 365);
    const after = readRetention(dir);
    expect(after.current).toBe(365);
    const settings = JSON.parse(await readFile(settingsPath, 'utf8'));
    expect(settings.permissions.allow).toEqual(['Bash(ls:*)']);
  });

  it('handles a missing settings file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'asa-setup-'));
    expect(readRetention(dir).effective).toBe(30);
    writeRetention(join(dir, 'settings.json'), 90);
    expect(readRetention(dir).current).toBe(90);
  });
});
