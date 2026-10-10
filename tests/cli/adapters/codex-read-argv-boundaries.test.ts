import { expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { extractFilePaths } from '../../../src/cli/adapters/codex-file-context.js';

for (const name of ['my notes.md', 'notes;draft.md']) {
it(`preserves the ${name} operand in a read-command argv`, () => {
  const dir = mkdtempSync(join(tmpdir(), 'cm-argv-paths-'));
  try {
      writeFileSync(join(dir, name), 'contents');
      expect(Bun.spawnSync({ cmd: ['cat', name], cwd: dir }).stdout.toString()).toBe('contents');
      expect(extractFilePaths('Bash', { command: ['cat', name] }, dir)).toEqual([name]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
}
