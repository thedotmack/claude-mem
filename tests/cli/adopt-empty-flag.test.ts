import { expect, it } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// `adopt --branch ""` must be a usage error, not "no branch filter":
// an empty filter would adopt every merged or orphaned worktree.
const workerService = join(import.meta.dir, '..', '..', 'src', 'services', 'worker-service.ts');

for (const flag of ['--branch', '--cwd']) {
  it(`rejects adopt ${flag} with an empty value`, () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'cmem-adopt-empty-flag-')));
    try {
      const run = Bun.spawnSync([process.execPath, workerService, 'adopt', '--dry-run', flag, ''], {
        env: { ...process.env, HOME: root, USERPROFILE: root, CLAUDE_MEM_DATA_DIR: join(root, 'data'), CLAUDE_CONFIG_DIR: join(root, 'config'), CLAUDE_MEM_TELEMETRY: '0' },
        cwd: root,
        stdout: 'pipe', stderr: 'pipe',
      });
      expect(run.exitCode).toBe(1);
      expect(new TextDecoder().decode(run.stderr)).toContain('Usage: adopt');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
}
