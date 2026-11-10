import { describe, expect, it, spyOn } from 'bun:test';
import { setImmediate } from 'node:timers/promises';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';
import { SyncApply, type SyncOp } from '../../../src/services/sync/SyncApply.js';
import { CloudSync } from '../../../src/services/sync/CloudSync.js';
import { ChromaSync } from '../../../src/services/sync/ChromaSync.js';
import { ChromaMcpManager } from '../../../src/services/sync/ChromaMcpManager.js';
import { decodeChanges } from '../../../src/services/sync/SyncClient.js';
import type { CanonicalHubChange, CanonicalWireOp } from '../../../src/services/sync/CanonicalContent.js';

const NOW = 1_800_000_000_000;
const REMOTE = 'remote-device';

function prompt(seq: number, project = 'unknown', rev = 1): SyncOp {
  return { seq: String(seq), kind: 'prompt', origin_device: REMOTE, origin_id: '800', rev: String(rev), server_ts: NOW,
    body: JSON.stringify({ content_session_id: 'conversation', memory_session_id: null, project,
      platform_source: 'codex', prompt_number: 1, prompt_text: 'remember this prompt', created_at_epoch: NOW }) };
}

function repair(seq: number, rev = 2, target = '800'): SyncOp {
  return { seq: String(seq), kind: 'mutation', origin_device: REMOTE, origin_id: `repair-${seq}`, rev: String(rev), server_ts: NOW,
    body: JSON.stringify({ op: 'set_prompt_session', target: { origin_device_id: REMOTE, origin_local_id: target },
      fields: { memory_session_id: 'registered-memory', project: 'correct-project', content_session_id: 'conversation', platform_source: 'codex' } }) };
}

const drain = async () => { for (let i = 0; i < 3; i++) await setImmediate(); };

function fixture(firstWriteGate?: Promise<void>) {
  const store = new SessionStore(':memory:');
  const docs = new Map<string, { text: string; metadata: Record<string, unknown> }>();
  let writes = 0;
  // The real ChromaSync formats documents, serializes row writers and updates
  // duplicate IDs in place. Only the external Chroma transport is replaced.
  const manager = { callTool: async (tool: string, args: any) => {
    expect(store.db.inTransaction).toBe(false);
    if (tool === 'chroma_create_collection') return {};
    if (tool === 'chroma_get_documents') {
      const ids = (args.ids ?? [...docs.keys()]).filter((id: string) => docs.has(id));
      return { ids, documents: ids.map((id: string) => docs.get(id)!.text), metadatas: ids.map((id: string) => docs.get(id)!.metadata) };
    }
    if (tool === 'chroma_add_documents' || tool === 'chroma_update_documents') {
      if (tool === 'chroma_add_documents' && args.ids.some((id: string) => docs.has(id))) throw new Error('IDs already exist');
      if (++writes === 1) await firstWriteGate;
      args.ids.forEach((id: string, index: number) => docs.set(id, {
        text: args.documents?.[index] ?? docs.get(id)!.text, metadata: args.metadatas[index],
      }));
      return {};
    }
    if (tool === 'chroma_delete_documents') { args.ids.forEach((id: string) => docs.delete(id)); return {}; }
    throw new Error(`Unexpected Chroma operation: ${tool}`);
  } };
  const managerSpy = spyOn(ChromaMcpManager, 'getInstance').mockReturnValue(manager as any);
  const apply = new SyncApply(store.db, { deviceId: 'local-device', chromaSync: new ChromaSync('prompt-repair') });
  return { store, apply, docs, writes: () => writes, close: async () => { await drain(); managerSpy.mockRestore(); store.close(); } };
}

describe('prompt session repairs update vector metadata', () => {
  for (const originalProject of ['unknown', 'correct-project']) {
    it(`refreshes an indexed ${originalProject === 'unknown' ? 'orphan' : 'content-keyed'} prompt even when the row echo is stale`, async () => {
      const f = fixture();
      try {
        f.apply.applyOps([prompt(1, originalProject)]);
        await drain();
        expect(f.docs.get('prompt_1')?.metadata).toMatchObject({ memory_session_id: 'conversation', project: originalProject });
        f.apply.applyOps([repair(2)]);
        const echo = prompt(3, 'correct-project', 2);
        echo.body = JSON.stringify({ ...JSON.parse(echo.body), memory_session_id: 'registered-memory' });
        expect(f.apply.applyOps([echo]).skippedStale).toBe(1);
        await drain();
        expect(f.store.db.query(`SELECT s.memory_session_id FROM user_prompts up JOIN sdk_sessions s ON s.id=up.session_db_id`).get())
          .toEqual({ memory_session_id: 'registered-memory' });
        expect(f.docs.get('prompt_1')?.metadata).toMatchObject({
          memory_session_id: 'registered-memory', project: 'correct-project', platform_source: 'codex',
        });
        expect(f.writes()).toBe(2);
      } finally { await f.close(); }
    });
  }

  it('follows the real registration mutation and same-revision row produced by CloudSync.flush', async () => {
    const f = fixture();
    const source = new SessionStore(':memory:');
    const dir = mkdtempSync(join(tmpdir(), 'cmem-prompt-repair-'));
    const changes: CanonicalHubChange[] = [];
    const sync = new CloudSync(source.db, {
      CLAUDE_MEM_CLOUD_SYNC_TOKEN: 'test-token', CLAUDE_MEM_CLOUD_SYNC_USER_ID: 'test-user',
      CLAUDE_MEM_CLOUD_SYNC_HUB_URL: 'https://hub.test', CLAUDE_MEM_CLOUD_SYNC_DEVICE_ID: REMOTE,
      CLAUDE_MEM_CLOUD_SYNC_DEVICE_NAME: 'test',
    }, { settingsPath: join(dir, 'settings.json'), fetchImpl: (async (_input, init) => {
      const { ops } = JSON.parse(String(init?.body)) as { ops: CanonicalWireOp[] };
      const acked = ops.map(wire => {
        const envelope = JSON.parse(wire.body), seq = String(changes.length + 1);
        changes.push({ ...wire, seq, server_ts: String(NOW) });
        return { id: envelope.id, kind: envelope.kind, origin_local_id: envelope.origin_local_id,
          entity_rev: envelope.entity_rev, operation_sha256: wire.operation_sha256, seq };
      });
      return Response.json({ acked, head_seq: String(changes.length), projected_seq: String(changes.length) });
    }) as typeof fetch });
    try {
      const id = source.createSDKSession('conversation', 'correct-project', 'first prompt', undefined, 'codex');
      source.saveUserPrompt('conversation', 1, 'remember this prompt', id);
      await sync.flush();
      f.apply.applyOps(decodeChanges(changes), { requireContiguous: true });
      await drain();
      expect(f.docs.get('prompt_1')?.metadata.memory_session_id).toBe('conversation');
      const firstCount = changes.length;
      source.updateMemorySessionId(id, 'registered-memory');
      await sync.flush();
      const updates = changes.slice(firstCount);
      expect(updates.map(change => { const body = JSON.parse(change.body); return [body.kind, body.entity_rev]; }))
        .toEqual([['mutation', '2'], ['prompt', '2']]);
      const result = f.apply.applyOps(decodeChanges(updates), { requireContiguous: true });
      expect(result.applied).toBe(1);
      expect(result.skippedStale).toBe(1);
      await drain();
      expect(f.docs.get('prompt_1')?.metadata).toMatchObject({
        memory_session_id: 'registered-memory', project: 'correct-project', platform_source: 'codex',
      });
    } finally { sync.stop(); source.close(); rmSync(dir, { recursive: true, force: true }); await f.close(); }
  });

  it('queues the corrected metadata behind an older in-flight write', async () => {
    let release!: () => void;
    const f = fixture(new Promise<void>(resolve => { release = resolve; }));
    try {
      f.apply.applyOps([prompt(1)]);
      await drain();
      f.apply.applyOps([repair(2)]);
      await drain();
      expect(f.writes()).toBe(1);
      release();
      await drain();
      expect(f.docs.get('prompt_1')?.metadata).toMatchObject({ memory_session_id: 'registered-memory', project: 'correct-project' });
    } finally { release(); await f.close(); }
  });

  it('does not forward stale, nonmatching or rolled-back repairs', async () => {
    const f = fixture();
    try {
      f.apply.applyOps([prompt(1, 'unknown', 3)]);
      await drain();
      f.apply.applyOps([repair(2, 2), repair(3, 4, 'missing')]);
      expect(() => f.apply.applyOps([repair(4, 4), prompt(6)], { requireContiguous: true })).toThrow('sequence gap');
      await drain();
      expect(f.writes()).toBe(1);
      expect(f.apply.getCursor()).toBe('3');
      expect(f.docs.get('prompt_1')?.metadata.memory_session_id).toBe('conversation');
    } finally { await f.close(); }
  });
});
