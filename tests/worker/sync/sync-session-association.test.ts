import { describe, expect, it } from 'bun:test';
import { setImmediate } from 'node:timers/promises';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';
import { SessionSearch } from '../../../src/services/sqlite/SessionSearch.js';
import { getNativeContentOperation } from '../../../src/services/sync/CloudSync.js';
import { buildContentOperation, buildMutationOperation } from '../../../src/services/sync/CanonicalContent.js';
import { decodeChanges } from '../../../src/services/sync/SyncClient.js';
import { SyncApply, type ChromaSyncLike } from '../../../src/services/sync/SyncApply.js';

const CONTENT = 'codex-content-session';
const MEMORY = 'remote-memory-session';
const PROJECT = 'association-project';
const REMOTE = 'association-remote';
const NOW = 1_790_000_000_000;

function fixture(at = NOW) {
  const source = new SessionStore(':memory:');
  const target = new SessionStore(':memory:');
  const earlyPrompt = source.saveUserPrompt(CONTENT, 1, 'Build the project', undefined, undefined, undefined, at);
  const earlyOperation = getNativeContentOperation(source.db, 'prompt', String(earlyPrompt), REMOTE)!.operation;
  const session = source.createSDKSession(CONTENT, PROJECT, 'Build the project', undefined, 'codex');
  source.ensureMemorySessionIdRegistered(session, MEMORY);
  const observation = source.storeObservation(MEMORY, PROJECT, {
    type: 'discovery', title: 'Remote Codex evidence', subtitle: null, narrative: 'Useful persisted evidence',
    facts: [], concepts: ['how-it-works'], files_read: [], files_modified: [],
  }, 1, 0, at).id;
  const summary = source.storeSummary(MEMORY, PROJECT, {
    request: 'Remote Codex request', investigated: '', learned: '', completed: 'Done', next_steps: '', notes: null,
  }, 1, 0, at).id;
  const prompt = source.saveUserPrompt(CONTENT, 1, 'Build the project', session, undefined, undefined, at);
  const vectors = new Map<string, string | undefined>();
  const chroma: ChromaSyncLike = {
    syncObservation: async (id, _memory, _project, _body, _number, _epoch, platform, _replace, current) => {
      expect(target.db.inTransaction).toBe(false);
      vectors.set(`observation:${id}`, current?.()?.row.platform_source ?? platform);
    },
    syncSummary: async (id, _memory, _project, _body, _number, _epoch, platform, _replace, current) => {
      expect(target.db.inTransaction).toBe(false);
      vectors.set(`summary:${id}`, current?.()?.row.platform_source ?? platform);
    },
    syncUserPrompt: async (id, _memory, _project, _body, _number, _epoch, platform, current) => {
      expect(target.db.inTransaction).toBe(false);
      vectors.set(`prompt:${id}`, current?.()?.platform_source ?? platform);
    },
  };
  const apply = new SyncApply(target.db, { deviceId: 'association-local', chromaSync: chroma });
  let seq = 0;
  const publish = (kind: 'observation' | 'summary' | 'prompt', id: number) => {
    const operation = getNativeContentOperation(source.db, kind, String(id), REMOTE)!.operation;
    return apply.applyOps(decodeChanges([{ ...operation, seq: String(++seq), server_ts: String(at) }]));
  };
  const publishOperation = (operation: ReturnType<typeof buildContentOperation>) =>
    apply.applyOps(decodeChanges([{ ...operation, seq: String(++seq), server_ts: String(at) }]));
  const publishEarly = () => apply.applyOps(decodeChanges([{ ...earlyOperation, seq: String(++seq), server_ts: String(at) }]));
  const associateEarly = () => apply.applyOps(decodeChanges([{ ...buildMutationOperation({ originDeviceId: REMOTE, entityRev: '2', mutation: {
    op: 'set_prompt_session', target: { origin_device_id: REMOTE, origin_local_id: String(earlyPrompt) },
    fields: { memory_session_id: MEMORY, content_session_id: CONTENT, platform_source: 'codex', project: PROJECT },
  } }), seq: String(++seq), server_ts: String(at) }]));
  return { source, target, apply, publish, publishOperation, publishEarly, associateEarly, observation, summary, prompt, vectors,
    close: () => { source.close(); target.close(); } };
}

describe('late remote session associations', () => {
  for (const platform of ['codex', 'claude']) {
    it(`adopts a ${platform} identity when its memories arrived before its first prompt`, async () => {
      const f = fixture();
      try {
        f.source.db.run('UPDATE sdk_sessions SET platform_source = ?', [platform]);
        f.publish('observation', f.observation);
        f.publish('summary', f.summary);
        await setImmediate();
        expect([...f.vectors.values()]).toEqual(['claude', 'claude']);
        const result = f.publish('prompt', f.prompt);
        expect(result.quarantined).toBe(0);
        await setImmediate();
        const catalog = f.target.getSessionCatalog({ project: PROJECT }).sessions;
        expect(catalog).toHaveLength(1);
        expect(catalog[0].content_session_id).toBe(CONTENT);
        expect(catalog[0].platform_source).toBe(platform);
        const search = new SessionSearch(f.target.db);
        expect(search.searchObservations(undefined, { project: PROJECT, platformSource: platform })).toHaveLength(1);
        expect(search.searchSessions(undefined, { project: PROJECT, platformSource: platform })).toHaveLength(1);
        expect(new Set(f.vectors.values())).toEqual(new Set([platform]));
      } finally { await setImmediate(); f.close(); }
    });
  }

  it('learns the same identity from a prompt-session mutation and refreshes its previously orphaned prompt', async () => {
    const f = fixture();
    try {
      f.publish('observation', f.observation);
      f.publish('summary', f.summary);
      f.publishEarly();
      await setImmediate();
      expect(new Set(f.vectors.values())).toEqual(new Set(['claude']));
      expect(f.associateEarly().quarantined).toBe(0);
      await setImmediate();
      expect(f.target.getSessionCatalog({ project: PROJECT }).sessions[0].content_session_id).toBe(CONTENT);
      expect(new Set(f.vectors.values())).toEqual(new Set(['codex']));
    } finally { await setImmediate(); f.close(); }
  });

  it('does not rename a native memory session when a remote association arrives', async () => {
    const f = fixture();
    try {
      const nativeId = f.target.createSDKSession('native-content', PROJECT, 'Native prompt');
      f.target.ensureMemorySessionIdRegistered(nativeId, MEMORY);
      f.publish('observation', f.observation);
      expect(f.publish('prompt', f.prompt).quarantined).toBe(0);
      expect(f.target.db.query('SELECT content_session_id, platform_source FROM sdk_sessions WHERE id = ?').get(nativeId))
        .toEqual({ content_session_id: 'native-content', platform_source: 'claude' });
      await setImmediate();
      expect(new Set(f.vectors.values())).toEqual(new Set(['claude']));
    } finally { await setImmediate(); f.close(); }
  });

  it('keeps the authoritative native session when its content identity is already occupied', async () => {
    const f = fixture();
    try {
      const nativeId = f.target.createSDKSession(CONTENT, PROJECT, 'Native prompt', undefined, 'codex');
      f.target.saveUserPrompt(CONTENT, 1, 'Native prompt', nativeId);
      f.publish('observation', f.observation);
      await setImmediate();
      const result = f.publish('prompt', f.prompt);
      expect(result.quarantined).toBe(0);
      const native = f.target.db.query('SELECT memory_session_id, content_session_id, platform_source FROM sdk_sessions WHERE id = ?').get(nativeId);
      expect(native).toEqual({ memory_session_id: null, content_session_id: CONTENT, platform_source: 'codex' });
      expect(f.target.db.query('SELECT COUNT(*) AS count FROM sdk_sessions').get()).toEqual({ count: 2 });
      expect(new SessionSearch(f.target.db).searchObservations(undefined, { project: PROJECT, platformSource: 'codex' })).toHaveLength(1);
      await setImmediate();
      expect(new Set(f.vectors.values())).toEqual(new Set(['codex']));
    } finally { await setImmediate(); f.close(); }
  });
});

// The receiving device deleted an earlier run of this conversation, and the
// remote resumed it afterwards. v74 lets the post-cutoff work in, but
// block_deleted_sdk_session_rekey refuses to re-key any row into the deleted
// content identity, so adopting it would quarantine the op and lose the prompt.
describe('late remote session associations after a deletion cutoff', () => {
  function resumedAfterDeletion() {
    const f = fixture(Date.now() + 60_000);
    f.target.markSessionDeleted('codex', CONTENT, 'memory-before-deletion');
    return f;
  }

  function memoryStub(f: ReturnType<typeof fixture>) {
    return f.target.db.query('SELECT id, content_session_id, platform_source FROM sdk_sessions WHERE memory_session_id = ?')
      .get(MEMORY) as { id: number; content_session_id: string; platform_source: string };
  }

  it('applies observations-first post-deletion work and adopts the platform without the deleted content id', async () => {
    const f = resumedAfterDeletion();
    try {
      expect(f.publish('observation', f.observation).quarantined).toBe(0);
      expect(f.publish('summary', f.summary).quarantined).toBe(0);
      const result = f.publish('prompt', f.prompt);
      expect(result.quarantined).toBe(0);
      expect(result.applied).toBe(1);
      const stub = memoryStub(f);
      expect(stub).toMatchObject({ content_session_id: MEMORY, platform_source: 'codex' });
      expect(f.target.db.query('SELECT session_db_id FROM user_prompts').all()).toEqual([{ session_db_id: stub.id }]);
      expect(f.target.db.query('SELECT COUNT(*) AS count FROM sync_pull_quarantine').get()).toEqual({ count: 0 });
      expect(new SessionSearch(f.target.db).searchObservations(undefined, { project: PROJECT, platformSource: 'codex' })).toHaveLength(1);
    } finally { await setImmediate(); f.close(); }
  });

  it('folds a post-deletion content-keyed stub into the memory session without the deleted content id', async () => {
    const f = resumedAfterDeletion();
    try {
      // A prompt from an origin session that has no memory id yet gets a
      // content-keyed stub; the observation gets the memory-keyed one; the
      // next prompt carries the association and folds the two together.
      const at = Date.now() + 60_000;
      const contentKeyed = buildContentOperation({
        kind: 'prompt', originDeviceId: REMOTE, originLocalId: '900', entityRev: '1',
        payload: { project: PROJECT, content_session_id: CONTENT, memory_session_id: null, platform_source: 'codex',
          prompt_number: '1', prompt_text: 'Resume the project', created_at: new Date(at).toISOString(), created_at_epoch: String(at) },
      });
      expect(f.publishOperation(contentKeyed).quarantined).toBe(0);
      expect(f.target.db.query('SELECT content_session_id, platform_source FROM sdk_sessions WHERE memory_session_id IS NULL').get())
        .toEqual({ content_session_id: CONTENT, platform_source: 'codex' });
      expect(f.publish('observation', f.observation).quarantined).toBe(0);
      const result = f.publish('prompt', f.prompt);
      expect(result.quarantined).toBe(0);
      expect(result.applied).toBe(1);
      const stub = memoryStub(f);
      expect(stub).toMatchObject({ content_session_id: MEMORY, platform_source: 'codex' });
      expect(f.target.db.query('SELECT session_db_id FROM user_prompts ORDER BY id').all())
        .toEqual([{ session_db_id: stub.id }, { session_db_id: stub.id }]);
      expect(f.target.db.query('SELECT COUNT(*) AS count FROM sdk_sessions').get()).toEqual({ count: 1 });
      expect(f.target.db.query('SELECT COUNT(*) AS count FROM sync_pull_quarantine').get()).toEqual({ count: 0 });
    } finally { await setImmediate(); f.close(); }
  });
});
