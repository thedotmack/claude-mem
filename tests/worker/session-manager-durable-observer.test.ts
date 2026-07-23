import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { SessionManager } from '../../src/services/worker/SessionManager.js';
import type { DatabaseManager } from '../../src/services/worker/DatabaseManager.js';

function managerFor(db: Database): SessionManager {
  const dbManager = {
    getConnection: () => db,
    getSessionById: () => ({
      content_session_id: 'content-session',
      project: 'project',
      platform_source: 'claude',
      user_prompt: 'prompt',
      memory_session_id: null,
    }),
    getSessionStore: () => ({
      getPromptNumberFromUserPrompts: () => 1,
    }),
  } as unknown as DatabaseManager;
  const manager = new SessionManager(dbManager);
  manager.initializeDurableObserverStore();
  return manager;
}

describe('SessionManager durable observer admission', () => {
  test('restores an unconfirmed source event into a fresh manager after restart', async () => {
    const db = new Database(':memory:');
    const first = managerFor(db);
    await first.queueObservation(17, {
      tool_name: 'Read',
      tool_input: { path: 'src/a.ts' },
      tool_response: { type: 'text', text: 'a' },
      prompt_number: 1,
      toolUseId: 'event-17',
    });

    const firstIterator = first.getMessageIterator(17);
    const firstClaim = await firstIterator.next();
    expect(firstClaim.done).toBe(false);
    await firstIterator.return?.();

    const restarted = managerFor(db);
    const iterator = restarted.getMessageIterator(17);
    const recovered = await iterator.next();
    expect(recovered.done).toBe(false);
    expect(recovered.value).toMatchObject({ toolUseId: 'event-17', tool_name: 'Read' });
    await iterator.return?.();
  });

  test('does not admit a duplicate source event after recovery', async () => {
    const db = new Database(':memory:');
    const first = managerFor(db);
    const event = {
      tool_name: 'Read',
      tool_input: { path: 'src/a.ts' },
      tool_response: { type: 'text', text: 'a' },
      prompt_number: 1,
      toolUseId: 'event-18',
    };
    await first.queueObservation(18, event);

    const restarted = managerFor(db);
    await restarted.queueObservation(18, event);

    expect(restarted.getMessageBuffer().getPendingCount(18)).toBe(1);
  });

  test('restores the bounded conversation checkpoint with its observer generation', () => {
    const db = new Database(':memory:');
    const first = managerFor(db);
    const session = first.initializeSession(19);
    session.observerGeneration = 3;
    session.conversationHistory.push({ role: 'assistant', content: 'durable context' });
    first.checkpointObserverSession(session);

    const restarted = managerFor(db);
    const recovered = restarted.initializeSession(19);
    expect(recovered.observerGeneration).toBe(3);
    expect(recovered.conversationHistory).toEqual([{ role: 'assistant', content: 'durable context' }]);
  });
});
