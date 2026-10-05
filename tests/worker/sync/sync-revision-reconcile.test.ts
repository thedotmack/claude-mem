import { describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The captured external MCP contract keeps a stateful document collection.
// SQLite apply, row formatters, conflict reconciliation and backfill are real.
const fixture = String.raw`
  import { SessionStore } from './src/services/sqlite/SessionStore.ts';
  import { SyncApply } from './src/services/sync/SyncApply.ts';
  import { ChromaSync } from './src/services/sync/ChromaSync.ts';
  import { ChromaSyncState } from './src/services/sync/ChromaSyncState.ts';
  import { ChromaMcpManager } from './src/services/sync/ChromaMcpManager.ts';
  const store = new SessionStore(':memory:');
  const chroma = new ChromaSync('revision-reconcile-fixture');
  const docs = new Map(), deleted = [], calls = [];
  let release, started = false, failDelete = false;
  const blocked = new Promise(resolve => release = resolve);
  const kind = process.env.REVISION_KIND, mode = process.env.REVISION_MODE;
  ChromaMcpManager.getInstance().callTool = async (tool, args) => {
    calls.push(tool);
    if (tool === 'chroma_create_collection') return {};
    if (tool === 'chroma_get_documents') {
      const ids = args.ids ?? [...docs.keys()].filter(id => args.where.$and.every(condition => Object.entries(condition).every(([key, value]) => docs.get(id).metadata[key] === value)));
      return { ids: ids.filter(id => docs.has(id)) };
    }
    if (tool === 'chroma_delete_documents') {
      if (failDelete) { failDelete = false; throw new Error('owned deletion failure'); }
      for (const id of args.ids) { docs.delete(id); deleted.push(id); }
      return {};
    }
    if (tool === 'chroma_add_documents' || tool === 'chroma_update_documents') {
      if (mode === 'order' && !started) { started = true; await blocked; }
      if (tool === 'chroma_add_documents' && args.ids.some(id => docs.has(id))) throw new Error('IDs already exist');
      args.ids.forEach((id, index) => {
        if (tool === 'chroma_add_documents' || docs.has(id)) docs.set(id, { document: args.documents[index], metadata: args.metadatas[index] });
      });
      return {};
    }
    throw new Error('Unexpected tool ' + tool);
  };
  const apply = new SyncApply(store.db, { deviceId: 'owned-local', chromaSync: chroma });
  const now = Date.now();
  const common = { memory_session_id: 'remote-memory', project: 'project', prompt_number: 1, created_at_epoch: now };
  const body = kind === 'observation' ? { ...common, type: 'discovery', title: 'Old title', narrative: 'Old body', facts: '["Old fact one","Old fact two"]', concepts: '[]', files_read: '[]', files_modified: '[]' }
    : kind === 'summary' ? { ...common, request: 'Old body', completed: 'Old completion' }
    : { ...common, content_session_id: 'remote-host', prompt_text: 'Old body', platform_source: 'claude' };
  const op = (rev, body) => ({ seq: String(rev), rev: String(rev), kind, origin_device: 'owned-remote', origin_id: '10', body: JSON.stringify(body), server_ts: now });
  const tick = () => new Promise(resolve => setImmediate(resolve));
  const wait = async predicate => { for (let i = 0; i < 100; i++) { if (predicate()) return; await tick(); } throw new Error('Fixture did not settle'); };
  apply.applyOps([op(1, body)]);
  if (mode === 'order') await wait(() => started); else await wait(() => docs.size > 0);
  const revised = mode === 'order' ? { ...body, title: 'New title', narrative: 'New body', facts: '[]', request: 'New body', completed: null, prompt_text: 'New body' }
    : mode === 'partial' ? { ...body, title: 'New title', narrative: null, facts: '["New fact"]', request: 'New body', completed: null }
    : { ...body, title: null, narrative: null, facts: '[]', request: null, completed: null };
  if (mode === 'retry') failDelete = true;
  apply.applyOps([op(2, revised)]);
  await tick(); await tick();
  const overlapping = [...docs.values()].some(doc => doc.document.includes('New body'));
  if (mode === 'order') { release(); await wait(() => [...docs.values()].some(doc => doc.document.includes('New body'))); }
  await tick(); await tick();
  let pendingBefore, outcome;
  if (mode === 'retry') {
    ChromaSyncState.resetCacheForTests(); // exercise the persisted retry flag
    pendingBefore = ChromaSyncState.getPending('project', kind === 'observation' ? 'observations' : 'summaries');
    outcome = await chroma.ensureBackfilled('project', store);
  }
  const table = kind === 'observation' ? 'observations' : kind === 'summary' ? 'session_summaries' : 'user_prompts';
  const row = store.db.prepare('SELECT * FROM ' + table).get();
  console.log(JSON.stringify({ docs: [...docs], deleted, overlapping, row, pendingBefore, outcome, state: ChromaSyncState.get('project'), calls }));
  store.close();
`;

function run(kind: string, mode: string): any {
  const dir = mkdtempSync(join(tmpdir(), 'sync-reconcile-'));
  try {
    const result = Bun.spawnSync([process.execPath, '-e', fixture], { cwd: join(import.meta.dir, '../../..'), env: { ...process.env, CLAUDE_MEM_DATA_DIR: join(dir, 'data'), CLAUDE_CONFIG_DIR: join(dir, 'config'), REVISION_KIND: kind, REVISION_MODE: mode }, stdout: 'pipe', stderr: 'pipe' });
    if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
    return JSON.parse(new TextDecoder().decode(result.stdout).trim().split('\n').at(-1)!);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

describe('remote revisions reconcile the production Chroma writer', () => {
  for (const kind of ['observation', 'summary']) {
    it(`removes disappeared ${kind} fragments even when the row becomes empty`, () => {
      const result = run(kind, 'shrink');
      expect(result.row.sync_rev).toBe('2');
      expect(result.docs).toEqual([]);
      expect(result.deleted.length).toBeGreaterThan(0);
    });
    it(`updates surviving ${kind} fragments without deleting their deterministic IDs`, () => {
      const result = run(kind, 'partial');
      const surviving = kind === 'observation' ? `obs_${result.row.id}_fact_0` : `summary_${result.row.id}_request`;
      expect(result.docs.map(([id]: any) => id)).toEqual([surviving]);
      expect(result.deleted).not.toContain(surviving);
      expect(result.docs[0][1].document).toContain('New');
    });
    it(`retries failed ${kind} fragment deletion on backfill`, () => {
      const result = run(kind, 'retry');
      expect(result.pendingBefore).toEqual([result.row.id]);
      expect(result.outcome).toBe('completed');
      expect(result.docs).toEqual([]);
      expect(result.state.pending?.[kind === 'observation' ? 'observations' : 'summaries'] ?? []).toEqual([]);
    });
  }
  for (const kind of ['observation', 'summary', 'prompt']) {
    it(`keeps a delayed older ${kind} write ahead of the newer revision`, () => {
      const result = run(kind, 'order');
      expect(result.overlapping).toBe(false);
      expect(result.row.sync_rev).toBe('2');
      expect(result.docs.map(([, doc]: any) => doc.document).join('\n')).toContain('New body');
      expect(result.docs.map(([, doc]: any) => doc.document).join('\n')).not.toContain('Old');
    });
  }
});
