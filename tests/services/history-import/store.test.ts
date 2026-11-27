import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';
import { HistoryReplayStore } from '../../../src/services/history-import/store.js';

// Storage invariants use abstract row inputs. They do not evaluate transcripts or inference quality.
describe('historical observation storage', () => {
  let sessions: SessionStore;
  let replay: HistoryReplayStore;
  const result = { title: 'Index entry', type: 'discovery', subtitle: null, narrative: null,
    facts: [], concepts: [], files_read: [], files_modified: [] };
  const source = (at: number) => ({ key: String(at), sourceDigest: 'digest-' + at, source: 'claude' as const,
    conversationId: '1', messageId: String(at), project: 'Dates', projectId: 'p1', projectOrigin: 'export' as const, at });
  beforeEach(() => { sessions = new SessionStore(':memory:'); replay = new HistoryReplayStore(sessions); });
  afterEach(() => sessions.close());

  it('keeps distinct source dates and native provenance, including identical observer outputs', () => {
    const late = replay.commit(source(2000), [result], 'local-model');
    const early = replay.commit(source(1000), [result], 'local-model');
    expect(early.ids[0]).not.toBe(late.ids[0]);
    const timeline = sessions.getTimelineAroundObservation(late.ids[0], 2000, 1, 0, 'Dates').observations;
    expect(timeline.map(o => [o.id, o.created_at_epoch])).toEqual([[early.ids[0], 1000], [late.ids[0], 2000]]);
    const row = sessions.db.query<{ metadata: string; generated_by_model: string; created_at: string }, [number]>(
      'SELECT metadata, generated_by_model, created_at FROM observations WHERE id = ?').get(early.ids[0])!;
    expect(JSON.parse(row.metadata).importSource).toMatchObject({ provider: 'claude', conversationId: '1',
      messageId: '1000', projectId: 'p1', projectOrigin: 'export', occurredAt: new Date(1000).toISOString() });
    expect(row.generated_by_model).toBe('local-model');
    expect(row.created_at).toBe(new Date(1000).toISOString());
    expect(sessions.db.query('SELECT started_at_epoch, completed_at_epoch, platform_source, status FROM sdk_sessions').get())
      .toEqual({ started_at_epoch: 1000, completed_at_epoch: 2000, platform_source: 'claude', status: 'completed' });
  });

  it('commits once, records valid skips, preserves deletions and rejects changed sources', () => {
    const first = replay.commit(source(1000), [result], 'local-model');
    expect(replay.commit(source(1000), [result], 'other-model')).toMatchObject({ ids: first.ids, existing: true });
    expect(replay.commit(source(2000), [], 'local-model')).toEqual({ ids: [], titles: [] });
    expect(replay.lookup('2000', 'digest-2000')).toEqual({ ids: [], titles: [] });
    expect(() => replay.lookup('1000', 'different')).toThrow('changed');
    sessions.db.query('DELETE FROM observations WHERE id = ?').run(first.ids[0]);
    expect(replay.commit(source(1000), [result], 'local-model')).toEqual({ ids: [], titles: [], existing: true });
    const session = sessions.db.query<{ platform_source: string; content_session_id: string; memory_session_id: string }, []>(
      'SELECT platform_source, content_session_id, memory_session_id FROM sdk_sessions').get()!;
    sessions.markSessionDeleted(session.platform_source, session.content_session_id, session.memory_session_id);
    sessions.db.run('DELETE FROM sdk_sessions');
    expect(replay.commit(source(3000), [result], 'local-model')).toEqual({ ids: [], titles: [] });
    expect(sessions.db.query('SELECT count(*) AS n FROM observations').get()).toEqual({ n: 0 });
  });

  it('rolls back rows and receipts together when the final receipt cannot be committed', () => {
    sessions.db.run(`CREATE TRIGGER fail_receipt BEFORE INSERT ON history_replay_receipts
      BEGIN SELECT RAISE(ABORT, 'rejected'); END`);
    expect(() => replay.commit(source(1000), [result], 'local-model')).toThrow('rejected');
    expect(replay.lookup('1000')).toBeUndefined();
    expect(sessions.db.query('SELECT count(*) AS n FROM observations').get()).toEqual({ n: 0 });
    sessions.db.run('DROP TRIGGER fail_receipt');
    expect(replay.commit(source(1000), [result], 'local-model').ids).toHaveLength(1);
  });
});
