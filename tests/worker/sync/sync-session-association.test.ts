import { describe, expect, it } from 'bun:test';
import { setImmediate } from 'node:timers/promises';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';
import { SessionSearch } from '../../../src/services/sqlite/SessionSearch.js';
import { getNativeContentOperation } from '../../../src/services/sync/CloudSync.js';
import { buildMutationOperation } from '../../../src/services/sync/CanonicalContent.js';
import { decodeChanges } from '../../../src/services/sync/SyncClient.js';
import { SyncApply, type ChromaSyncLike } from '../../../src/services/sync/SyncApply.js';

const CONTENT = 'codex-content-session';
const MEMORY = 'remote-memory-session';
const PROJECT = 'association-project';
const REMOTE = 'association-remote';
const NOW = 1_790_000_000_000;

function fixture() {
  const source = new SessionStore(':memory:');
  const target = new SessionStore(':memory:');
  const earlyPrompt = source.saveUserPrompt(CONTENT, 1, 'Build the project', undefined, undefined, undefined, NOW);
  const earlyOperation = getNativeContentOperation(source.db, 'prompt', String(earlyPrompt), REMOTE)!.operation;
  const session = source.createSDKSession(CONTENT, PROJECT, 'Build the project', undefined, 'codex');
  source.ensureMemorySessionIdRegistered(session, MEMORY);
  const observation = source.storeObservation(MEMORY, PROJECT, {
    type: 'discovery', title: 'Remote Codex evidence', subtitle: null, narrative: 'Useful persisted evidence',
    facts: [], concepts: ['how-it-works'], files_read: [], files_modified: [],
  }, 1, 0, NOW).id;
  const summary = source.storeSummary(MEMORY, PROJECT, {
    request: 'Remote Codex request', investigated: '', learned: '', completed: 'Done', next_steps: '', notes: null,
  }, 1, 0, NOW).id;
  const prompt = source.saveUserPrompt(CONTENT, 1, 'Build the project', session, undefined, undefined, NOW);
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
    return apply.applyOps(decodeChanges([{ ...operation, seq: String(++seq), server_ts: String(NOW) }]));
  };
  const publishEarly = () => apply.applyOps(decodeChanges([{ ...earlyOperation, seq: String(++seq), server_ts: String(NOW) }]));
  const associateEarly = () => apply.applyOps(decodeChanges([{ ...buildMutationOperation({ originDeviceId: REMOTE, entityRev: '2', mutation: {
    op: 'set_prompt_session', target: { origin_device_id: REMOTE, origin_local_id: String(earlyPrompt) },
    fields: { memory_session_id: MEMORY, content_session_id: CONTENT, platform_source: 'codex', project: PROJECT },
  } }), seq: String(++seq), server_ts: String(NOW) }]));
  return { source, target, apply, publish, publishEarly, associateEarly, observation, summary, prompt, vectors,
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
