import { describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// A separate process keeps the real store/route intact when neighbouring
// route tests install process-wide module mocks.
const fixture = String.raw`
  import express from 'express';
  import { SessionStore } from './src/services/sqlite/SessionStore.ts';
  import { DataRoutes } from './src/services/worker/http/routes/DataRoutes.ts';
  const store = new SessionStore(':memory:');
  const bodies = ['你好\0😀' + 'x'.repeat(60_000), null];
  const ids = bodies.map((body, i) => store.upsertToolUse({
    toolUseId: 'call-' + i, contentSessionId: 'host', project: 'Project',
    toolName: 'Read', toolInput: body, toolResponse: body, createdAtEpoch: 100 + i,
  }));
  store.upsertToolUse({ toolUseId: 'other', contentSessionId: 'host', project: 'Other', toolName: 'Edit' });
  const originalPrepare = store.db.prepare.bind(store.db);
  let rawPayloadBytesRead = 0;
  store.db.prepare = function(sql, ...args) {
    const statement = originalPrepare(sql, ...args);
    const originalAll = statement.all.bind(statement);
    statement.all = function(...params) {
      const rows = originalAll(...params);
      for (const row of rows) {
        for (const field of ['tool_input', 'tool_response']) {
          if (typeof row[field] === 'string') rawPayloadBytesRead += Buffer.byteLength(row[field], 'utf8');
        }
      }
      return rows;
    };
    return statement;
  };
  const app = express(); app.use(express.json());
  new DataRoutes({}, { getSessionStore: () => store }, {}, {}, {}, Date.now()).setupRoutes(app);
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const url = 'http://127.0.0.1:' + server.address().port;
  try {
    const listing = await (await fetch(url + '/api/tool-uses?project=project&orderBy=date_asc&tool_name=Read')).json();
    const listingPayloadBytesRead = rawPayloadBytesRead;
    const page = await (await fetch(url + '/api/tool-uses?project=PROJECT&orderBy=date_asc&limit=1&offset=1')).json();
    const batch = await (await fetch(url + '/api/tool-uses/batch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: [ids[0]] }) })).json();
    console.log(JSON.stringify({ listing, page, ids, listingPayloadBytesRead, expectedBytes: Buffer.byteLength(bodies[0], 'utf8'), batchMatches: batch[0].tool_response === bodies[0] }));
  } finally {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    store.close();
  }
`;

describe('tool-use index payload projection', () => {
  it('keeps stored bodies inside SQLite while preserving byte counts, scopes and explicit disclosure', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tool-use-index-'));
    try {
      const run = Bun.spawnSync([process.execPath, '-e', fixture], {
        cwd: join(import.meta.dir, '../../../..'),
        env: { ...process.env, CLAUDE_MEM_DATA_DIR: join(dir, 'data'), CLAUDE_CONFIG_DIR: join(dir, 'config') },
        stdout: 'pipe', stderr: 'pipe',
      });
      if (run.exitCode !== 0) throw new Error(new TextDecoder().decode(run.stderr));
      const result = JSON.parse(new TextDecoder().decode(run.stdout).trim().split('\n').at(-1)!);
      expect(result.listing.toolUses.map((row: { id: number }) => row.id)).toEqual(result.ids);
      expect(result.listing.toolUses[0].tool_input_bytes).toBe(result.expectedBytes);
      expect(result.listing.toolUses[0].tool_response_bytes).toBe(result.expectedBytes);
      expect(result.listing.toolUses[1].tool_input_bytes).toBe(0);
      expect(result.listing.toolUses[1].tool_response_bytes).toBe(0);
      expect(result.page.toolUses.map((row: { id: number }) => row.id)).toEqual([result.ids[1]]);
      expect(result.batchMatches).toBe(true);
      expect(result.listingPayloadBytesRead).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
