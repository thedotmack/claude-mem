import { expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = join(import.meta.dir, '../..');
const entry = pathToFileURL(join(root, 'scripts/import-memories.ts')).href;

for (const signal of ['none', 'count', 'entry', 'both']) {
  const rejected = signal !== 'none';
  const hasCount = signal === 'count' || signal === 'both';
  const hasEntry = signal === 'entry' || signal === 'both';
  it(`${signal}: exits ${rejected ? 'nonzero on rejected rows' : 'zero when rows are only imported or already present'}`, () => {
    const data = mkdtempSync(join(tmpdir(), 'import-exit-'));
    try {
      const input = join(data, 'export.json');
      writeFileSync(input, JSON.stringify({ observations: [] }));
      const result = {
        success: true,
        stats: { sessionsImported: 0, sessionsSkipped: 0, summariesImported: 0, summariesSkipped: 0,
          observationsImported: 1, observationsSkipped: 1, observationsRejected: hasCount ? 1 : 0,
          promptsImported: 0, promptsSkipped: 0 },
        rejected: { observations: hasEntry ? [{ index: 2, reason: 'invalid fixture row' }] : [] },
      };
      const child = Bun.spawnSync([process.execPath, '-e', `
        process.argv = [process.execPath, 'import-memories.ts', ${JSON.stringify(input)}];
        globalThis.fetch = async (url) => Response.json(String(url).endsWith('/api/import')
          ? ${JSON.stringify(result)} : {});
        await import(${JSON.stringify(entry)});
      `], { cwd: root, env: { ...process.env, CLAUDE_MEM_DATA_DIR: data, CLAUDE_CONFIG_DIR: join(data, 'config') } });
      expect(child.exitCode, child.stderr.toString()).toBe(rejected ? 1 : 0);
      expect(child.stdout.toString()).toContain('1 imported, 1 skipped');
      if (hasEntry) expect(child.stdout.toString()).toContain('invalid fixture row');
    } finally { rmSync(data, { recursive: true, force: true }); }
  });
}
