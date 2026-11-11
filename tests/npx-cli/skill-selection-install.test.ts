import { expect, it } from 'bun:test';
import { join } from 'path';

function runFixture(scenario?: string) {
  const args = [process.execPath, join(import.meta.dir, '..', 'fixtures', 'skill-selection-install.ts')];
  const child = Bun.spawnSync(scenario ? [...args, scenario] : args, {
    env: { ...process.env, CLAUDE_MEM_FORBID_REAL_AUTO_UPDATE: '1' },
    stdout: 'pipe', stderr: 'pipe', timeout: 30_000,
  });
  if (!child.success) process.stderr.write(child.stderr);
  expect(child.exitCode).toBe(0);
  return child.stdout.toString();
}

it('applies saved selection at both actual install copy boundaries on every version', () => {
  expect(runFixture()).toContain('skill install/update boundaries passed');
});

it('an invalid saved selection warns at both copy boundaries and does not stop install', () => {
  expect(runFixture('invalid-setting')).toContain('skill install scenario invalid-setting passed');
});

it('a runtime-required skill in the selection stays installed with a warning naming it', () => {
  expect(runFixture('runtime-required')).toContain('skill install scenario runtime-required passed');
});
