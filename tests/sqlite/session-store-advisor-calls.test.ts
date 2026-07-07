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

  function baseCall(sessionDbId: number, contentSessionId: string, overrides: Record<string, unknown> = {}) {
    return {
      sessionDbId,
      contentSessionId,
      project: 'test-project',
      platformSource: 'claude',
      toolUseId: 'srvtoolu_default',
      advice: 'default advice',
      occurredAtEpoch: 1000,
      ...overrides,
    };
  }

  describe('recordAdvisorCall / getAdvisorCallById', () => {
    it('persists the full advice text and context pointer verbatim', () => {
      const sessionDbId = createSession('content-advisor-1');

      const result = store.recordAdvisorCall({
        sessionDbId,
        contentSessionId: 'content-advisor-1',
        project: 'test-project',
        platformSource: 'claude',
        toolUseId: 'srvtoolu_abc123',
        advisorModel: 'claude-fable-5',
        cwd: '/repo',
        lastUserMessage: 'why is this failing?',
        transcriptPath: '/tmp/transcript.jsonl',
        transcriptLineNumber: 42,
        advice: 'Long detailed advice text that must survive round-tripping intact.',
        occurredAtEpoch: 1000,
      });

      expect(result.inserted).toBe(true);
      expect(result.id).toBeGreaterThan(0);

      const call = store.getAdvisorCallById(result.id);
      expect(call).not.toBeNull();
      expect(call!.advice).toBe('Long detailed advice text that must survive round-tripping intact.');
      expect(call!.tool_use_id).toBe('srvtoolu_abc123');
      expect(call!.advisor_model).toBe('claude-fable-5');
      expect(call!.last_user_message).toBe('why is this failing?');
      expect(call!.transcript_path).toBe('/tmp/transcript.jsonl');
      expect(call!.transcript_line_number).toBe(42);
      expect(call!.project).toBe('test-project');
      expect(call!.platform_source).toBe('claude');
      expect(call!.session_db_id).toBe(sessionDbId);
      expect(call!.occurred_at_epoch).toBe(1000);
    });

    it('ignores a duplicate tool_use_id and reports the existing row', () => {
      const sessionDbId = createSession('content-advisor-dedup');

      const first = store.recordAdvisorCall(baseCall(sessionDbId, 'content-advisor-dedup', {
        toolUseId: 'srvtoolu_dup', advice: 'first insert',
      }));
      const second = store.recordAdvisorCall(baseCall(sessionDbId, 'content-advisor-dedup', {
        toolUseId: 'srvtoolu_dup', advice: 'replayed insert',
      }));

      expect(first.inserted).toBe(true);
      expect(second.inserted).toBe(false);
      expect(second.id).toBe(first.id);

      const rows = store.getAdvisorCalls(0, 10, 'test-project');
      expect(rows.items).toHaveLength(1);
      expect(rows.items[0].advice).toBe('first insert');
    });

    it('accepts null context fields', () => {
      const sessionDbId = createSession('content-advisor-2');

      const result = store.recordAdvisorCall(baseCall(sessionDbId, 'content-advisor-2', {
        toolUseId: 'srvtoolu_nulls', advice: 'advice with no transcript pointer',
      }));

      const call = store.getAdvisorCallById(result.id);
      expect(call!.advisor_model).toBeNull();
      expect(call!.cwd).toBeNull();
      expect(call!.last_user_message).toBeNull();
      expect(call!.transcript_path).toBeNull();
      expect(call!.transcript_line_number).toBeNull();
    });

    it('returns null for an unknown id', () => {
      expect(store.getAdvisorCallById(999999)).toBeNull();
    });
  });

  describe('getAdvisorCalls', () => {
    it('orders results by occurred_at_epoch descending and paginates', () => {
      const sessionDbId = createSession('content-advisor-3');

      store.recordAdvisorCall(baseCall(sessionDbId, 'content-advisor-3', { toolUseId: 'srvtoolu_1', advice: 'first', occurredAtEpoch: 1000 }));
      store.recordAdvisorCall(baseCall(sessionDbId, 'content-advisor-3', { toolUseId: 'srvtoolu_2', advice: 'second', occurredAtEpoch: 2000 }));
      store.recordAdvisorCall(baseCall(sessionDbId, 'content-advisor-3', { toolUseId: 'srvtoolu_3', advice: 'third', occurredAtEpoch: 3000 }));

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

      store.recordAdvisorCall(baseCall(sessionA, 'content-advisor-4a', { toolUseId: 'srvtoolu_a', project: 'project-a', advice: 'for a' }));
      store.recordAdvisorCall(baseCall(sessionB, 'content-advisor-4b', { toolUseId: 'srvtoolu_b', project: 'project-b', advice: 'for b' }));

      const result = store.getAdvisorCalls(0, 10, 'project-a');
      expect(result.items.map(i => i.advice)).toEqual(['for a']);
    });
  });
});
