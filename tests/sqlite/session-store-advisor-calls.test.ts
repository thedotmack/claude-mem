import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';

describe('SessionStore advisor_calls', () => {
  let store: SessionStore;

  beforeEach(() => {
    store = new SessionStore(':memory:');
  });

  afterEach(() => {
    store.close();
  });

  function createSession(contentSessionId: string, project = 'test-project'): number {
    return store.createSDKSession(contentSessionId, project, 'initial prompt');
  }

  describe('recordAdvisorCall / getAdvisorCallById', () => {
    it('persists the full advice text verbatim', () => {
      const sessionDbId = createSession('content-advisor-1');

      const id = store.recordAdvisorCall({
        sessionDbId,
        contentSessionId: 'content-advisor-1',
        project: 'test-project',
        platformSource: 'claude',
        cwd: '/repo',
        lastUserMessage: 'why is this failing?',
        transcriptPath: '/tmp/transcript.jsonl',
        transcriptLineCount: 42,
        advice: 'Long detailed advice text that must survive round-tripping intact.',
        occurredAtEpoch: 1000,
      });

      expect(id).toBeGreaterThan(0);

      const call = store.getAdvisorCallById(id);
      expect(call).not.toBeNull();
      expect(call!.advice).toBe('Long detailed advice text that must survive round-tripping intact.');
      expect(call!.last_user_message).toBe('why is this failing?');
      expect(call!.transcript_path).toBe('/tmp/transcript.jsonl');
      expect(call!.transcript_line_count).toBe(42);
      expect(call!.project).toBe('test-project');
      expect(call!.platform_source).toBe('claude');
      expect(call!.session_db_id).toBe(sessionDbId);
    });

    it('accepts null context fields', () => {
      const sessionDbId = createSession('content-advisor-2');

      const id = store.recordAdvisorCall({
        sessionDbId,
        contentSessionId: 'content-advisor-2',
        project: 'test-project',
        platformSource: 'claude',
        advice: 'advice with no transcript pointer',
        occurredAtEpoch: 2000,
      });

      const call = store.getAdvisorCallById(id);
      expect(call!.cwd).toBeNull();
      expect(call!.last_user_message).toBeNull();
      expect(call!.transcript_path).toBeNull();
      expect(call!.transcript_line_count).toBeNull();
    });

    it('returns null for an unknown id', () => {
      expect(store.getAdvisorCallById(999999)).toBeNull();
    });
  });

  describe('getAdvisorCalls', () => {
    it('orders results by occurred_at_epoch descending and paginates', () => {
      const sessionDbId = createSession('content-advisor-3');

      store.recordAdvisorCall({
        sessionDbId, contentSessionId: 'content-advisor-3', project: 'test-project',
        platformSource: 'claude', advice: 'first', occurredAtEpoch: 1000,
      });
      store.recordAdvisorCall({
        sessionDbId, contentSessionId: 'content-advisor-3', project: 'test-project',
        platformSource: 'claude', advice: 'second', occurredAtEpoch: 2000,
      });
      store.recordAdvisorCall({
        sessionDbId, contentSessionId: 'content-advisor-3', project: 'test-project',
        platformSource: 'claude', advice: 'third', occurredAtEpoch: 3000,
      });

      const page1 = store.getAdvisorCalls(0, 2, 'test-project');
      expect(page1.items.map(i => i.advice)).toEqual(['third', 'second']);
      expect(page1.hasMore).toBe(true);

      const page2 = store.getAdvisorCalls(2, 2, 'test-project');
      expect(page2.items.map(i => i.advice)).toEqual(['first']);
      expect(page2.hasMore).toBe(false);
    });

    it('filters by project', () => {
      const sessionA = createSession('content-advisor-4a', 'project-a');
      const sessionB = createSession('content-advisor-4b', 'project-b');

      store.recordAdvisorCall({
        sessionDbId: sessionA, contentSessionId: 'content-advisor-4a', project: 'project-a',
        platformSource: 'claude', advice: 'for a', occurredAtEpoch: 1000,
      });
      store.recordAdvisorCall({
        sessionDbId: sessionB, contentSessionId: 'content-advisor-4b', project: 'project-b',
        platformSource: 'claude', advice: 'for b', occurredAtEpoch: 1000,
      });

      const result = store.getAdvisorCalls(0, 10, 'project-a');
      expect(result.items.map(i => i.advice)).toEqual(['for a']);
    });
  });
});
