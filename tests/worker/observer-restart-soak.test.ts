import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { SessionManager } from '../../src/services/worker/SessionManager.js';
import type { DatabaseManager } from '../../src/services/worker/DatabaseManager.js';

function managerFor(db: Database): SessionManager {
  const databaseManager = {
    getConnection: () => db,
    getSessionById: () => ({
      content_session_id: 'soak-session', project: 'soak', platform_source: 'claude',
      user_prompt: 'soak', memory_session_id: null,
    }),
    getSessionStore: () => ({ getPromptNumberFromUserPrompts: () => 1 }),
  } as unknown as DatabaseManager;
  const manager = new SessionManager(databaseManager);
  manager.initializeDurableObserverStore();
  return manager;
}

test('settles 100 source events exactly once across forced restarts', async () => {
  const db = new Database(':memory:');
  let manager = managerFor(db);

  for (let index = 0; index < 100; index++) {
    await manager.queueObservation(101, {
      tool_name: 'Read', tool_input: { path: `src/${index}.ts` },
      tool_response: { type: 'text', text: String(index) }, prompt_number: index + 1,
      toolUseId: `soak-${index}`,
    });
    const iterator = manager.getMessageIterator(101);
    const next = await iterator.next();
    expect(next.done).toBe(false);
    await manager.confirmClaimedMessages(101);
    await iterator.return?.();

    if ((index + 1) % 10 === 0) manager = managerFor(db);
  }

  expect(manager.getObserverStatus()).toMatchObject({ pending: 0, claimed: 0, settled: 100, quarantined: 0 });
});
