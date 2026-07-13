import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { SessionStore } from '../src/services/sqlite/SessionStore.js';
import { PaginationHelper } from '../src/services/worker/PaginationHelper.js';
import { MAX_STORED_PROMPT_CHARS } from '../src/services/sqlite/prompt-storage.js';

describe('SessionStore', () => {
  let store: SessionStore;

  beforeEach(() => {
    store = new SessionStore(':memory:');
  });

  afterEach(() => {
    store.close();
  });

  it('should correctly count user prompts', () => {
    const claudeId = 'claude-session-1';
    store.createSDKSession(claudeId, 'test-project', 'initial prompt');
    
    expect(store.getPromptNumberFromUserPrompts(claudeId)).toBe(0);

    store.saveUserPrompt(claudeId, 1, 'First prompt');
    expect(store.getPromptNumberFromUserPrompts(claudeId)).toBe(1);

    store.saveUserPrompt(claudeId, 2, 'Second prompt');
    expect(store.getPromptNumberFromUserPrompts(claudeId)).toBe(2);

    store.createSDKSession('claude-session-2', 'test-project', 'initial prompt');
    store.saveUserPrompt('claude-session-2', 1, 'Other prompt');
    expect(store.getPromptNumberFromUserPrompts(claudeId)).toBe(2);
  });

  it('should find recent duplicate user prompts', () => {
    const contentSessionId = 'duplicate-session-store';
    store.createSDKSession(contentSessionId, 'test-project', 'initial prompt');
    const promptId = store.saveUserPrompt(contentSessionId, 1, 'Repeated prompt');

    const duplicate = store.findRecentDuplicateUserPrompt(contentSessionId, 'Repeated prompt', 10_000);

    expect(duplicate?.id).toBe(promptId);
    expect(duplicate?.prompt_number).toBe(1);
    expect(duplicate?.prompt_text).toBe('Repeated prompt');
  });

  it('should not find duplicate user prompts outside the dedupe window', () => {
    const contentSessionId = 'old-duplicate-session-store';
    store.createSDKSession(contentSessionId, 'test-project', 'initial prompt');
    const promptId = store.saveUserPrompt(contentSessionId, 1, 'Repeated prompt');
    store.db.prepare('UPDATE user_prompts SET created_at_epoch = ? WHERE id = ?')
      .run(Date.now() - 20_000, promptId);

    const duplicate = store.findRecentDuplicateUserPrompt(contentSessionId, 'Repeated prompt', 10_000);

    expect(duplicate).toBeUndefined();
  });

  it('should normalize oversized prompts before duplicate lookup', () => {
    const contentSessionId = 'oversized-duplicate-session-store';
    const oversizedPrompt = `<claude-mem-context>ignored</claude-mem-context>${'A'.repeat(MAX_STORED_PROMPT_CHARS + 250)}`;
    store.createSDKSession(contentSessionId, 'test-project', 'initial prompt');
    const promptId = store.saveUserPrompt(contentSessionId, 1, oversizedPrompt);

    const duplicate = store.findRecentDuplicateUserPrompt(contentSessionId, oversizedPrompt, 10_000);

    expect(duplicate?.id).toBe(promptId);
    expect(duplicate?.prompt_number).toBe(1);
    expect(duplicate?.prompt_text.length).toBe(MAX_STORED_PROMPT_CHARS);
  });

  it('should clear sdk_sessions.user_prompt when completed first prompt history exists for that session', () => {
    const contentSessionId = 'completed-canonical-session-store';
    const sessionId = store.createSDKSession(contentSessionId, 'test-project', 'Initial prompt');
    store.saveUserPrompt(contentSessionId, 1, 'Initial prompt', sessionId);

    store.markSessionCompleted(sessionId);

    const row = store.db.prepare(
      'SELECT status, user_prompt FROM sdk_sessions WHERE id = ?'
    ).get(sessionId) as { status: string; user_prompt: string | null };

    expect(row.status).toBe('completed');
    expect(row.user_prompt).toBeNull();
  });

  it('should preserve sdk_sessions.user_prompt when completed first prompt history is absent', () => {
    const contentSessionId = 'completed-partial-history-session-store';
    const sessionId = store.createSDKSession(contentSessionId, 'test-project', 'Initial prompt');
    store.saveUserPrompt(contentSessionId, 2, 'Follow-up prompt', sessionId);

    store.markSessionCompleted(sessionId);

    const row = store.db.prepare(
      'SELECT status, user_prompt FROM sdk_sessions WHERE id = ?'
    ).get(sessionId) as { status: string; user_prompt: string | null };

    expect(row.status).toBe('completed');
    expect(row.user_prompt).toBe('Initial prompt');
  });

  it('should not clear a completed session from another platform with the same content id', () => {
    const contentSessionId = 'completed-platform-shared-session-store';
    const claudeSessionId = store.createSDKSession(contentSessionId, 'test-project', 'Claude prompt', undefined, 'claude');
    const codexSessionId = store.createSDKSession(contentSessionId, 'test-project', 'Codex prompt', undefined, 'codex');
    store.saveUserPrompt(contentSessionId, 1, 'Codex prompt', codexSessionId);

    store.markSessionCompleted(claudeSessionId);
    store.markSessionCompleted(codexSessionId);

    const claude = store.db.prepare(
      'SELECT status, user_prompt FROM sdk_sessions WHERE id = ?'
    ).get(claudeSessionId) as { status: string; user_prompt: string | null };
    const codex = store.db.prepare(
      'SELECT status, user_prompt FROM sdk_sessions WHERE id = ?'
    ).get(codexSessionId) as { status: string; user_prompt: string | null };

    expect(claude.status).toBe('completed');
    expect(claude.user_prompt).toBe('Claude prompt');
    expect(codex.status).toBe('completed');
    expect(codex.user_prompt).toBeNull();
  });

  it('should hide only older duplicate prompts from paginated prompt results', () => {
    const contentSessionId = 'paginated-duplicate-session-store';
    store.createSDKSession(contentSessionId, 'test-project', 'initial prompt');
    const olderDuplicateId = store.saveUserPrompt(contentSessionId, 1, 'Repeated prompt');
    const newerDuplicateId = store.saveUserPrompt(contentSessionId, 2, 'Repeated prompt');
    const uniquePromptId = store.saveUserPrompt(contentSessionId, 3, 'Unique prompt');

    const now = Date.now();
    store.db.prepare('UPDATE user_prompts SET created_at_epoch = ? WHERE id = ?').run(now, olderDuplicateId);
    store.db.prepare('UPDATE user_prompts SET created_at_epoch = ? WHERE id = ?').run(now + 5000, newerDuplicateId);
    store.db.prepare('UPDATE user_prompts SET created_at_epoch = ? WHERE id = ?').run(now + 6000, uniquePromptId);

    const helper = new PaginationHelper({
      getSessionStore: () => store,
    } as any);

    const ids = helper.getPrompts(0, 10).items.map(prompt => prompt.id);

    expect(ids).toContain(newerDuplicateId);
    expect(ids).toContain(uniquePromptId);
    expect(ids).not.toContain(olderDuplicateId);
  });

  it('should hide older duplicate prompts when timestamps are identical', () => {
    const contentSessionId = 'same-ms-duplicate-session-store';
    store.createSDKSession(contentSessionId, 'test-project', 'initial prompt');
    const olderDuplicateId = store.saveUserPrompt(contentSessionId, 1, 'Repeated prompt');
    const newerDuplicateId = store.saveUserPrompt(contentSessionId, 2, 'Repeated prompt');

    const sameTimestamp = Date.now();
    store.db.prepare('UPDATE user_prompts SET created_at_epoch = ? WHERE id IN (?, ?)')
      .run(sameTimestamp, olderDuplicateId, newerDuplicateId);

    const helper = new PaginationHelper({
      getSessionStore: () => store,
    } as any);

    const ids = helper.getPrompts(0, 10).items.map(prompt => prompt.id);

    expect(ids).toContain(newerDuplicateId);
    expect(ids).not.toContain(olderDuplicateId);
  });

  it('should store observation with timestamp override', () => {
    const claudeId = 'claude-sess-obs';
    const memoryId = 'memory-sess-obs';
    const sdkId = store.createSDKSession(claudeId, 'test-project', 'initial prompt');

    store.updateMemorySessionId(sdkId, memoryId);

    const obs = {
      type: 'discovery',
      title: 'Test Obs',
      subtitle: null,
      facts: [],
      narrative: 'Testing',
      concepts: [],
      files_read: [],
      files_modified: []
    };

    const pastTimestamp = 1600000000000; 

    const result = store.storeObservation(
      memoryId, // Use memorySessionId for FK reference
      'test-project',
      obs,
      1,
      0,
      pastTimestamp
    );

    expect(result.createdAtEpoch).toBe(pastTimestamp);

    const stored = store.getObservationById(result.id);
    expect(stored).not.toBeNull();
    expect(stored?.created_at_epoch).toBe(pastTimestamp);

    expect(new Date(stored!.created_at).getTime()).toBe(pastTimestamp);
  });

  it('sets session identity (memory_session_id + worker_port) before an observation can be accepted (#2533)', () => {
    const claudeId = 'claude-identity-1';
    const memoryId = 'memory-identity-1';
    const sdkId = store.createSDKSession(claudeId, 'test-project', 'initial prompt');

    // Fresh session has NO identity yet: memory_session_id is NULL and an
    // observation insert would violate the NOT NULL FK — nothing can be stored.
    const before = store.getSessionById(sdkId);
    expect(before?.memory_session_id).toBeNull();

    // Identity registration is the gate that runs before storeObservations.
    store.ensureMemorySessionIdRegistered(sdkId, memoryId, 37742);

    const after = store.getSessionById(sdkId);
    expect(after?.memory_session_id).toBe(memoryId);
    const portRow = store.db.prepare('SELECT worker_port FROM sdk_sessions WHERE id = ?').get(sdkId) as { worker_port: number | null };
    expect(portRow.worker_port).toBe(37742);

    // Only AFTER identity is set can an observation be accepted into the table.
    const result = store.storeObservation(memoryId, 'test-project', {
      type: 'discovery',
      title: 'Identity gate',
      subtitle: null,
      facts: [],
      narrative: 'Stored only after identity was registered',
      concepts: [],
      files_read: [],
      files_modified: []
    }, 1);
    const stored = store.getObservationById(result.id);
    expect(stored?.memory_session_id).toBe(memoryId);
  });

  it('should store summary with timestamp override', () => {
    const claudeId = 'claude-sess-sum';
    const memoryId = 'memory-sess-sum';
    const sdkId = store.createSDKSession(claudeId, 'test-project', 'initial prompt');

    store.updateMemorySessionId(sdkId, memoryId);

    const summary = {
      request: 'Do something',
      investigated: 'Stuff',
      learned: 'Things',
      completed: 'Done',
      next_steps: 'More',
      notes: null
    };

    const pastTimestamp = 1650000000000;

    const result = store.storeSummary(
      memoryId, // Use memorySessionId for FK reference
      'test-project',
      summary,
      1,
      0,
      pastTimestamp
    );

    expect(result.createdAtEpoch).toBe(pastTimestamp);

    const stored = store.getSummaryForSession(memoryId);
    expect(stored).not.toBeNull();
    expect(stored?.created_at_epoch).toBe(pastTimestamp);
  });
});
