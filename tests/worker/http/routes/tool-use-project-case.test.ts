import { describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const fixture = String.raw`
  import express from 'express';
  import { SessionStore } from './src/services/sqlite/SessionStore.ts';
  import { DataRoutes } from './src/services/worker/http/routes/DataRoutes.ts';
  const store = new SessionStore(':memory:');
  const id = store.upsertToolUse({ toolUseId: 'call-1', contentSessionId: 'host-1', project: 'MyProject', toolName: 'Read', toolInput: '{}', toolResponse: 'file contents' });
  const app = express(); app.use(express.json());
  new DataRoutes({}, { getSessionStore: () => store }, {}, {}, {}, Date.now()).setupRoutes(app);
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const url = 'http://127.0.0.1:' + server.address().port;
  try {
    const listing = await (await fetch(url + '/api/tool-uses?project=myproject')).json();
    const batch = await (await fetch(url + '/api/tool-uses/batch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: [id], project: 'MYPROJECT' }) })).json();
    const unrelated = await (await fetch(url + '/api/tool-uses?project=other')).json();
    console.log(JSON.stringify({ id, listing, batch, unrelated, counts: store.countToolUses({ project: 'mYpRoJeCt' }) }));
  } finally { await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); store.close(); }
`;

describe('raw tool reads share the case-insensitive project scope', () => {
  it('lists, fetches, and counts stored tool uses after a project case change', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tool-use-project-case-'));
    try {
      const run = Bun.spawnSync([process.execPath, '-e', fixture], {
        cwd: join(import.meta.dir, '../../../..'),
        env: { ...process.env, CLAUDE_MEM_DATA_DIR: join(dir, 'data'), CLAUDE_CONFIG_DIR: join(dir, 'config') }, stdout: 'pipe', stderr: 'pipe',
      });
      if (run.exitCode !== 0) throw new Error(new TextDecoder().decode(run.stderr));
      const result = JSON.parse(new TextDecoder().decode(run.stdout).trim().split('\n').at(-1)!);
      expect(result.listing.toolUses.map((row: { id: number }) => row.id)).toEqual([result.id]);
      expect(result.batch.map((row: { id: number }) => row.id)).toEqual([result.id]);
      expect(result.counts).toEqual([{ tool_name: 'Read', uses: 1 }]);
      expect(result.unrelated.toolUses).toEqual([]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
