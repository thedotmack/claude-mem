import { expect, it } from 'bun:test';
import { join } from 'path';

it('applies saved selection at both actual install copy boundaries on every version', () => {
  const child = Bun.spawnSync([process.execPath, join(import.meta.dir, '..', 'fixtures', 'skill-selection-install.ts')], {
    env: { ...process.env, CLAUDE_MEM_FORBID_REAL_AUTO_UPDATE: '1' },
    stdout: 'pipe', stderr: 'pipe', timeout: 30_000,
  });
  if (!child.success) process.stderr.write(child.stderr);
  expect(child.exitCode).toBe(0);
  expect(child.stdout.toString()).toContain('skill install/update boundaries passed');
});
