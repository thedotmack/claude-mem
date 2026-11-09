import { expect, it } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getToolPath } from '../../src/npx-cli/install/tool-path.js';

it('skips unusable install-path candidates and selects the runnable file', () => {
  const root = mkdtempSync(join(tmpdir(), 'cmem-tool-path-'));
  try {
    const directory = join(root, 'stale');
    const executable = join(root, 'current.exe');
    mkdirSync(directory);
    const invalid = [directory];
    if (process.platform !== 'win32') {
      const file = join(root, 'not-executable');
      writeFileSync(file, '', { mode: 0o644 });
      invalid.push(file);
    }
    writeFileSync(executable, '', { mode: 0o755 });
    const missing = join(root, 'missing');
    expect(getToolPath(missing, invalid)).toBeNull();
    expect(getToolPath(missing, [...invalid, executable])).toBe(executable);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
