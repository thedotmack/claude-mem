import { describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// SQLite, ProjectMerge, SyncApply and both ChromaSync instances are real. Only
// the external MCP transport is substituted. Record metadata updates merge
// supplied keys, as chromadb 1.5.9's rust/sqlite/src/helpers.rs does.
const fixture = String.raw`
  import { join } from 'node:path';
  import { SessionStore } from './src/services/sqlite/SessionStore.ts';
  import { SyncApply } from './src/services/sync/SyncApply.ts';
  import { ChromaSync } from './src/services/sync/ChromaSync.ts';
  import { ChromaSyncState } from './src/services/sync/ChromaSyncState.ts';
  import { ChromaMcpManager } from './src/services/sync/ChromaMcpManager.ts';
  import { mergeProjectInto } from './src/services/infrastructure/ProjectMerge.ts';
  const dataDirectory = process.env.CLAUDE_MEM_DATA_DIR;
  const dbPath = join(dataDirectory, 'claude-mem.db');
  const store = new SessionStore(dbPath);
  const docs = new Map(), patches = [];
  let pauseLookup = false, reached, release;
  const lookupReached = new Promise(resolve => reached = resolve);
  const lookupGate = new Promise(resolve => release = resolve);
  ChromaMcpManager.getInstance().callTool = async (tool, args) => {
    if (tool === 'chroma_create_collection') return {};
    if (tool === 'chroma_get_documents') {
      const ids = (args.ids ?? [...docs.keys()].filter(id =>
        Object.entries(args.where ?? {}).every(([key, value]) =>
          value && typeof value === 'object' && '$in' in value
            ? value.$in.includes(docs.get(id).metadata[key])
            : docs.get(id).metadata[key] === value
        )
      )).filter(id => docs.has(id));
      const snapshot = {
        ids,
        documents: ids.map(id => docs.get(id).document),
        metadatas: ids.map(id => ({ ...docs.get(id).metadata }))
      };
      if (pauseLookup && args.where?.sqlite_id?.$in) {
        pauseLookup = false;
        // The server completed the GET. Hold only its response, allowing the
        // next client to finish its write even on a single-request server.
        reached();
        await lookupGate;
      }
      return snapshot;
    }
    if (tool === 'chroma_delete_documents') {
      for (const id of args.ids) docs.delete(id);
      return {};
    }
    if (tool === 'chroma_add_documents' || tool === 'chroma_update_documents') {
      if (tool === 'chroma_add_documents' && args.ids.some(id => docs.has(id))) {
        throw new Error('IDs already exist');
      }
      args.ids.forEach((id, index) => {
        const previous = docs.get(id);
        if (tool === 'chroma_add_documents' || previous) {
          docs.set(id, {
            document: args.documents ? args.documents[index] : previous.document,
            metadata: { ...previous?.metadata, ...args.metadatas[index] }
          });
        }
      });
      if (!args.documents) patches.push(args);
      return {};
    }
    throw new Error('Unexpected Chroma call: ' + tool);
  };
  const kind = process.env.MERGE_KIND;
  const table = kind === 'observation' ? 'observations' : 'session_summaries';
  const stateKind = kind === 'observation' ? 'observations' : 'summaries';
  const source = 'feature-worktree', target = 'parent-repo';
  const now = 1_800_000_000_000;
  const body = {
    memory_session_id: 'remote-memory', content_session_id: 'remote-host',
    project: source, platform_source: 'claude', created_at_epoch: now,
    prompt_number: 1, type: 'discovery', title: 'Retired deployment',
    narrative: 'Use the old blue cluster.', facts: '["Old credential"]',
    concepts: '["old-cluster"]', files_read: '["old/config.ts"]', files_modified: '[]',
    request: 'Use the old blue cluster.', completed: 'Old rollout'
  };
  const op = (rev, content) => ({
    seq: String(rev), rev: String(rev), kind, origin_device: 'remote-device',
    origin_id: '10', body: JSON.stringify(content), server_ts: now + rev
  });
  const apply = new SyncApply(store.db, {
    deviceId: 'local-device', chromaSync: new ChromaSync('claude-mem')
  });
  const drain = () => Promise.all([...apply.chromaWrites.values()]);
  apply.applyOps([op(1, body)]);
  await drain();
  pauseLookup = true;
  const merging = mergeProjectInto({ from: source, into: target, dataDirectory });
  await Promise.race([lookupReached, merging.then(() => {
    throw new Error('Project merge did not reach the metadata lookup');
  })]);
  try {
    // The local merge increments the saved row's revision to 2.
    apply.applyOps([op(3, {
      ...body, merged_into_project: target, created_at_epoch: now + 5_000,
      prompt_number: 2, title: 'Current deployment', narrative: 'Use the new green cluster.',
      facts: '["New credential"]', concepts: '["new-cluster"]',
      files_read: '["new/config.ts"]', request: 'Use the new green cluster.', completed: 'New rollout'
    })]);
    await drain();
  } finally {
    release();
  }
  const result = await merging;
  store.close();
  const reopened = new SessionStore(dbPath);
  const row = reopened.db.query('SELECT * FROM ' + table).get();
  reopened.close();
  ChromaSyncState.resetCacheForTests();
  console.log(JSON.stringify({
    result, row, docs: [...docs.values()], patches,
    watermark: ChromaSyncState.get(source)[stateKind],
    pending: ChromaSyncState.getPending(source, stateKind)
  }));
`;

function run(kind: string): any {
  const dir = mkdtempSync(join(tmpdir(), 'project-merge-chroma-race-'));
  try {
    const result = Bun.spawnSync([process.execPath, '-e', fixture], {
      cwd: join(import.meta.dir, '../../..'),
      env: { ...process.env, CLAUDE_MEM_DATA_DIR: dir,
        CLAUDE_CONFIG_DIR: join(dir, 'config'), CLAUDE_MEM_CHROMA_ENABLED: 'true', MERGE_KIND: kind },
      stdout: 'pipe', stderr: 'pipe'
    });
    if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
    return JSON.parse(new TextDecoder().decode(result.stdout).trim().split('\n').at(-1)!);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('project merge preserves concurrent semantic revisions', () => {
  for (const kind of ['observation', 'summary']) {
    it(`patches only project membership after a newer ${kind} finishes syncing`, () => {
      const result = run(kind);
      expect(result.result.chromaFailed).toBe(0);
      expect(result.result.chromaUpdates).toBe(1);
      expect(result.row.sync_rev).toBe('3');
      expect(result.row.merged_into_project).toBe('parent-repo');
      expect(result.watermark).toBe(result.row.id);
      expect(result.pending).toEqual([]);
      expect(result.docs).toHaveLength(2);
      for (const doc of result.docs) {
        expect(doc.document).not.toContain('Old');
        expect(doc.document).not.toContain('old blue');
        expect(doc.metadata.sqlite_id).toBe(result.row.id);
        expect(doc.metadata.doc_type).toBe(kind === 'observation' ? 'observation' : 'session_summary');
        expect(doc.metadata.project).toBe('feature-worktree');
        expect(doc.metadata.platform_source).toBe('claude');
        expect(doc.metadata.created_at_epoch).toBe(result.row.created_at_epoch);
        expect(doc.metadata.merged_into_project).toBe('parent-repo');
        if (kind === 'observation') {
          expect(doc.metadata.title).toBe('Current deployment');
          expect(doc.metadata.concepts).toBe('new-cluster');
          expect(doc.metadata.files_read).toBe('new/config.ts');
        } else {
          expect(doc.metadata.prompt_number).toBe(2);
        }
      }
      expect(result.patches).toHaveLength(1);
      expect(result.patches[0].metadatas).toEqual([
        { merged_into_project: 'parent-repo' }, { merged_into_project: 'parent-repo' }
      ]);
    });
  }
});
