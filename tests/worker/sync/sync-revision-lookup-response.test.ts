import { describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Substitute only the external MCP client's response. Production MCP parsing,
// SQLite apply, document reconciliation and smart backfill run in the child.
const fixture = String.raw`
  import { SessionStore } from './src/services/sqlite/SessionStore.ts';
  import { SyncApply } from './src/services/sync/SyncApply.ts';
  import { ChromaSync } from './src/services/sync/ChromaSync.ts';
  import { ChromaSyncState } from './src/services/sync/ChromaSyncState.ts';
  import { ChromaMcpManager } from './src/services/sync/ChromaMcpManager.ts';
  const store = new SessionStore(':memory:');
  const chroma = new ChromaSync('lookup-response-fixture');
  const docs = new Map(), deleted = [];
  const manager = ChromaMcpManager.getInstance();
  manager.ensureConnected = async () => {}; // no external process or live collection
  let response = 'valid';
  const json = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });
  manager.client = { callTool: async ({ name: tool, arguments: args }) => {
    if (tool === 'chroma_create_collection') return json({});
    if (tool === 'chroma_get_documents') {
      if (args.where && response !== 'valid') {
        if (response === 'empty-content') return { content: [] };
        if (response === 'non-json') return { content: [{ type: 'text', text: 'temporary lookup failure' }] };
        if (response === 'missing-ids') return json({});
        if (response === 'null-ids') return json({ ids: null });
        if (response === 'object-ids') return json({ ids: {} });
        if (response === 'numeric-ids') return json({ ids: [42] });
        if (response === 'nested-ids') return json({ ids: [['obs_1_narrative']] });
        if (response === 'tool-error') return { isError: true, content: [{ type: 'text', text: 'owned lookup error' }] };
      }
      const ids = args.ids ?? [...docs.keys()].filter(id => args.where.$and.every(condition => Object.entries(condition).every(([key, value]) => docs.get(id).metadata[key] === value)));
      return json({ ids: ids.filter(id => docs.has(id)) });
    }
    if (tool === 'chroma_delete_documents') {
      for (const id of args.ids) { docs.delete(id); deleted.push(id); }
      return json({});
    }
    if (tool === 'chroma_add_documents' || tool === 'chroma_update_documents') {
      if (tool === 'chroma_add_documents' && args.ids.some(id => docs.has(id))) return { isError: true, content: [{ type: 'text', text: 'IDs already exist' }] };
      args.ids.forEach((id, index) => {
        if (tool === 'chroma_add_documents' || docs.has(id)) docs.set(id, { document: args.documents[index], metadata: args.metadatas[index] });
      });
      return json({});
    }
    throw new Error('Unexpected tool ' + tool);
  } };
  const apply = new SyncApply(store.db, { deviceId: 'owned-local', chromaSync: chroma });
  const now = Date.now(), kind = process.env.REVISION_KIND;
  const common = { memory_session_id: 'remote-memory', project: 'project', prompt_number: 1, created_at_epoch: now };
  const body = kind === 'observation' ? { ...common, type: 'discovery', title: null, narrative: 'Old removed body', facts: '[]', concepts: '[]', files_read: '[]', files_modified: '[]' }
    : { ...common, request: 'Old removed body', completed: 'Old removed completion' };
  const op = (rev, body) => ({ seq: String(rev), rev: String(rev), kind, origin_device: 'owned-remote', origin_id: '10', body: JSON.stringify(body), server_ts: now });
  const tick = () => new Promise(resolve => setImmediate(resolve));
  const settle = async () => { for (let i = 0; i < 20; i++) await tick(); };
  apply.applyOps([op(1, body)]); await settle();
  if (process.env.LOOKUP_RESPONSE === 'valid-empty') docs.clear();
  response = process.env.LOOKUP_RESPONSE === 'valid-empty' ? 'valid' : process.env.LOOKUP_RESPONSE;
  apply.applyOps([op(2, { ...body, narrative: null, request: null, completed: null })]); await settle();
  const table = kind === 'observation' ? 'observations' : 'session_summaries';
  const row = store.db.prepare('SELECT * FROM ' + table).get();
  const stateKind = kind === 'observation' ? 'observations' : 'summaries';
  ChromaSyncState.resetCacheForTests();
  const pendingBefore = ChromaSyncState.getPending('project', stateKind);
  const reconciliationBefore = ChromaSyncState.needsFragmentReconciliation('project', stateKind, row.id);
  const failedBackfill = await chroma.ensureBackfilled('project', store);
  const retainedAfterFailure = ChromaSyncState.needsFragmentReconciliation('project', stateKind, row.id);
  response = 'valid';
  const recovered = await chroma.ensureBackfilled('project', store);
  console.log(JSON.stringify({ row, pendingBefore, reconciliationBefore, failedBackfill, retainedAfterFailure, recovered, docs: [...docs], deleted, pendingAfter: ChromaSyncState.getPending('project', stateKind) }));
  store.close();
`;

function run(kind: string, response: string): any {
  const dir = mkdtempSync(join(tmpdir(), 'sync-lookup-response-'));
  try {
    const result = Bun.spawnSync([process.execPath, '-e', fixture], { cwd: join(import.meta.dir, '../../..'), env: { ...process.env, CLAUDE_MEM_DATA_DIR: join(dir, 'data'), CLAUDE_CONFIG_DIR: join(dir, 'config'), REVISION_KIND: kind, LOOKUP_RESPONSE: response }, stdout: 'pipe', stderr: 'pipe' });
    if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
    return JSON.parse(new TextDecoder().decode(result.stdout).trim().split('\n').at(-1)!);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

describe('fragment reconciliation validates production MCP lookup responses', () => {
  for (const kind of ['observation', 'summary']) {
    for (const response of ['empty-content', 'non-json', 'missing-ids', 'null-ids', 'object-ids', 'numeric-ids', 'nested-ids', 'tool-error']) {
      it(`retains ${kind} retry state for ${response} and recovers with a valid lookup`, () => {
        const result = run(kind, response);
        expect(result.row.sync_rev).toBe('2');
        expect(result.pendingBefore).toEqual([result.row.id]);
        expect(result.reconciliationBefore).toBe(true);
        expect(result.failedBackfill).toBe('rows_pending');
        expect(result.retainedAfterFailure).toBe(true);
        expect(result.recovered).toBe('completed');
        expect(result.docs).toEqual([]);
        expect(result.deleted.length).toBeGreaterThan(0);
        expect(result.pendingAfter).toEqual([]);
      });
    }
    it(`accepts a valid empty ID list for an already empty ${kind} collection`, () => {
      const result = run(kind, 'valid-empty');
      expect(result.reconciliationBefore).toBe(false);
      expect(result.pendingBefore).toEqual([]);
      expect(result.failedBackfill).toBe('completed');
      expect(result.recovered).toBe('completed');
      expect(result.deleted).toEqual([]);
      expect(result.docs).toEqual([]);
    });
  }
});
