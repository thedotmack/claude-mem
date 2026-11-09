import { expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = join(import.meta.dir, '../..');
const entry = pathToFileURL(join(root, 'scripts/import-memories.ts')).href;
for (const prefix of ['', '\uFEFF']) {
  it(`imports a UTF-8 JSON file ${prefix ? 'with' : 'without'} a BOM`, () => {
    const data = mkdtempSync(join(tmpdir(), 'import-bom-'));
    try {
      const input = join(data, 'export.json');
      const observations = [{ title: 'synthetic import fixture' }];
      writeFileSync(input, prefix + JSON.stringify({ observations }));
      const child = Bun.spawnSync([process.execPath, '-e', `
        process.argv = [process.execPath, 'import-memories.ts', ${JSON.stringify(input)}];
        globalThis.fetch = async (url, init) => {
          if (!String(url).endsWith('/api/import')) return Response.json({});
          const received = JSON.parse(init.body);
          if (JSON.stringify(received.observations) !== ${JSON.stringify(JSON.stringify(observations))}) {
            throw new Error('import changed the fixture contents');
          }
          console.log('fixture reached import API');
          return Response.json({ stats: { sessionsImported: 0, sessionsSkipped: 0,
            summariesImported: 0, summariesSkipped: 0, observationsImported: 1,
            observationsSkipped: 0, promptsImported: 0, promptsSkipped: 0 } });
        };
        await import(${JSON.stringify(entry)});
      `], { cwd: root, env: { ...process.env, CLAUDE_MEM_DATA_DIR: data, CLAUDE_CONFIG_DIR: join(data, 'config') } });
      expect(child.exitCode, child.stderr.toString()).toBe(0);
      expect(child.stdout.toString()).toContain('fixture reached import API');
    } finally { rmSync(data, { recursive: true, force: true }); }
  });
}
