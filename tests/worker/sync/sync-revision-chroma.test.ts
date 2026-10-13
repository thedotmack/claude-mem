import { describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Keep persisted Chroma watermarks and module-level paths inside a child-owned
// fixture. The external document writer is captured; SQLite apply and Chroma's
// live row-to-document formatting are the production implementations.
const fixture = String.raw`
  import { SessionStore } from './src/services/sqlite/SessionStore.ts';
  import { SyncApply } from './src/services/sync/SyncApply.ts';
  import { ChromaSync } from './src/services/sync/ChromaSync.ts';
  import { ChromaMcpManager } from './src/services/sync/ChromaMcpManager.ts';
  const store = new SessionStore(':memory:');
  const chroma = new ChromaSync('revision-fixture');
  chroma.ensureCollectionExists = async () => {};
  ChromaMcpManager.getInstance().callTool = async () => ({ ids: [] });
  const writes = [];
  chroma.addDocuments = async documents => {
    writes.push(documents);
    return documents.length;
  };
  const apply = new SyncApply(store.db, { deviceId: 'local-fixture', chromaSync: chroma });
  const kind = process.env.REVISION_KIND;
  const now = Date.now();
  const common = { memory_session_id: 'remote-memory', project: 'project', prompt_number: 1, created_at_epoch: now };
  const body = kind === 'observation'
    ? { ...common, type: 'discovery', title: 'Original title', narrative: 'Original narrative', facts: '[]', concepts: '[]', files_read: '[]', files_modified: '[]' }
    : kind === 'summary'
      ? { ...common, request: 'Original request', learned: 'Original learning' }
      : { ...common, content_session_id: 'remote-host', prompt_text: 'Original prompt', platform_source: 'claude' };
  const makeOp = (seq, rev, body) => ({ seq: String(seq), rev: String(rev), kind, origin_device: 'remote-device', origin_id: '10', body: JSON.stringify(body), server_ts: now });
  apply.applyOps([makeOp(1, 1, body)]);
  await new Promise(resolve => setImmediate(resolve));
  const updated = { ...body, title: 'Revised title', narrative: 'Revised narrative', request: 'Revised request', learned: 'Revised learning', prompt_text: 'Revised prompt' };
  apply.applyOps([makeOp(2, 2, updated)]);
  await new Promise(resolve => setImmediate(resolve));
  const table = kind === 'observation' ? 'observations' : kind === 'summary' ? 'session_summaries' : 'user_prompts';
  const row = store.db.prepare('SELECT * FROM ' + table).get();
  const cursor = apply.getCursor();
  apply.applyOps([makeOp(3, 1, body)]);
  await new Promise(resolve => setImmediate(resolve));
  console.log(JSON.stringify({ writes, row, cursor, finalCursor: apply.getCursor() }));
  store.close();
`;

describe('pulled row revisions reach Chroma', () => {
  for (const kind of ['observation', 'summary', 'prompt']) {
    it(`forwards the revised ${kind} content and keeps stale revisions inert`, () => {
      const dir = mkdtempSync(join(tmpdir(), 'sync-revision-chroma-'));
      try {
        const run = Bun.spawnSync([process.execPath, '-e', fixture], {
          cwd: join(import.meta.dir, '../../..'),
          env: { ...process.env, CLAUDE_MEM_DATA_DIR: join(dir, 'data'), CLAUDE_CONFIG_DIR: join(dir, 'config'), REVISION_KIND: kind },
          stdout: 'pipe', stderr: 'pipe',
        });
        if (run.exitCode !== 0) throw new Error(new TextDecoder().decode(run.stderr));
        const result = JSON.parse(new TextDecoder().decode(run.stdout).trim().split('\n').at(-1)!);
        expect(result.cursor).toBe('2');
        expect(result.finalCursor).toBe('3');
        expect(result.row.sync_rev).toBe('2');
        expect(result.row.synced_at).not.toBeNull();
        expect(result.writes).toHaveLength(2);
        const documents = result.writes[1].map((doc: { document: string }) => doc.document).join('\n');
        expect(documents).toContain(kind === 'observation' ? 'Revised narrative' : kind === 'summary' ? 'Revised request' : 'Revised prompt');
        expect(documents).not.toContain('Original');
        expect(result.writes[1][0].metadata.sqlite_id).toBe(result.row.id);
      } finally { rmSync(dir, { recursive: true, force: true }); }
    });
  }
});
