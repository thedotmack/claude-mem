import { expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

for (const phase of ['scheduled', 'expanding']) {
  it(`retires a restored task cache before the closing write returns while scope refresh is ${phase}`, () => {
    const directory = mkdtempSync(join(tmpdir(), 'work-state-cache-restart-'));
    try {
      const result = Bun.spawnSync([process.execPath, 'tests/fixtures/context/work-state-cache-restart.ts', phase], {
        cwd: join(import.meta.dir, '../..'),
        env: { ...process.env, CLAUDE_MEM_DATA_DIR: join(directory, 'data'), CLAUDE_CONFIG_DIR: join(directory, 'config') },
        stdout: 'pipe', stderr: 'pipe', timeout: 15_000,
      });
      expect(result.exitCode, new TextDecoder().decode(result.stderr)).toBe(0);
      const outcome = JSON.parse(new TextDecoder().decode(result.stdout).trim().split('\n').at(-1)!);
      expect(outcome.before).toContain('[todo] ship release');
      expect(outcome.status).toBe(200);
      expect(outcome.responseBody).toContain('Nothing in it is open now.');
      expect(outcome.storedFields).toEqual([
        { task: 'ship release', status: 'todo' },
        { task: 'ship release', status: 'done' },
      ]);
      expect(outcome.immediatelyAfterWrite).toBeNull();
      expect(outcome.afterRefresh).toBe('Stored memory');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
}
