import { expect, it, spyOn } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanClaudeMd } from '../../src/cli/claude-md-commands.js';
import { logger } from '../../src/utils/logger.js';

it('reports partial cleanup failure while processing the remaining files', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cmem-clean-status-'));
  const previousCwd = process.cwd();
  const removed = join(dir, 'left', 'CLAUDE.md');
  const remaining = join(dir, 'right', 'CLAUDE.md');
  for (const side of ['left', 'right']) {
    mkdirSync(join(dir, side));
    writeFileSync(join(dir, side, 'CLAUDE.md'), '<claude-mem-context>\nbody\n</claude-mem-context>\n');
  }
  const log = spyOn(logger, 'info').mockImplementation((_category, message) => {
    // Reproduce a file disappearing between discovery and the cleanup pass.
    if (message.startsWith('Found 2 CLAUDE.md')) unlinkSync(removed);
  });
  try {
    process.chdir(dir);
    expect(await cleanClaudeMd(false)).toBe(1);
    expect(existsSync(remaining)).toBe(false);
  } finally {
    process.chdir(previousCwd);
    log.mockRestore();
    rmSync(dir, { recursive: true, force: true });
  }
});
