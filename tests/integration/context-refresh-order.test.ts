import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

for (const integration of ['cursor', 'grok']) {
  describe(`${integration} context publication over HTTP`, () => {
    for (const [scenario, expected] of [
      ['reversed', 'newer snapshot'],
      ['three', 'newest snapshot'],
      ['ordered', 'newer snapshot'],
      ['http-error', 'older snapshot'],
      ['empty', 'older snapshot'],
      ['write-failure', 'older snapshot'],
      ['independent', 'older snapshot'],
    ]) {
      test(`${scenario}: keeps ${expected}`, () => {
        const root = mkdtempSync(path.join(tmpdir(), 'context-refresh-'));
        try {
          const child = Bun.spawnSync([process.execPath, path.join(import.meta.dir, 'context-refresh-order-child.ts')], {
            cwd: path.resolve(import.meta.dir, '../..'),
            env: {
              ...process.env,
              CLAUDE_MEM_DATA_DIR: path.join(root, 'data'),
              CLAUDE_MEM_TELEMETRY: '0',
              CLAUDE_MEM_EXCLUDED_PROJECTS: '',
              CONTEXT_REFRESH_ROOT: root,
              CONTEXT_REFRESH_INTEGRATION: integration,
              CONTEXT_REFRESH_SCENARIO: scenario,
            },
            timeout: 20_000,
          });
          expect(child.exitCode, child.stderr.toString()).toBe(0);
          const result = JSON.parse(child.stdout.toString().trim().split('\n').pop()!);
          expect(result.afterOverlap).toContain(expected);
          expect(result.afterSubsequent).toContain('subsequent snapshot');
          if (scenario === 'independent') expect(result.otherContext).toContain('newer snapshot');
        } finally {
          rmSync(root, { recursive: true, force: true });
        }
      }, 30_000);
    }
  });
}
