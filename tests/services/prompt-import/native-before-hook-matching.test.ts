import { afterEach, beforeEach, expect, test } from 'bun:test';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';

const epoch = Date.parse('2026-11-10T10:00:00.000Z');
let store: SessionStore;
beforeEach(() => { store = new SessionStore(':memory:'); });
afterEach(() => store.close());

const prompt = (nativePromptId: string, promptText = 'continue', createdAtEpoch = epoch) => ({
  platformSource: 'claude', contentSessionId: 'conversation', project: 'repo',
  nativePromptId, promptText, createdAtEpoch, hookMatchWindowMs: 1000, claimedHookRowIds: new Set<number>(),
});
const sessionId = () => (store.db.prepare('SELECT id FROM sdk_sessions').get() as { id: number }).id;

test('a replayed native turn leaves a nearby hook row for its own transcript turn', () => {
  const first = prompt('first');
  expect(store.importTranscriptUserPrompt(first).reason).toBe('new');
  const hookRowId = store.saveUserPrompt('conversation', 2, 'continue', sessionId(), undefined, undefined, epoch + 100);

  for (let scan = 0; scan < 2; scan++) {
    const claimedHookRowIds = new Set<number>();
    expect(store.importTranscriptUserPrompt({ ...first, claimedHookRowIds }).reason).toBe('already-imported');
    expect(claimedHookRowIds.size).toBe(0);
    expect(store.importTranscriptUserPrompt({ ...prompt('second', 'continue', epoch + 100), claimedHookRowIds }))
      .toEqual({ reason: 'recorded-by-hook', hookRowId });
    expect([...claimedHookRowIds]).toEqual([hookRowId]);
    expect(store.db.prepare('SELECT COUNT(*) AS count FROM user_prompts').get()).toEqual({ count: 2 });
  }
});

test('an existing native identity still validates its text before any hook match', () => {
  expect(store.importTranscriptUserPrompt(prompt('first', 'Original request')).reason).toBe('new');
  store.saveUserPrompt('conversation', 2, 'Changed request', sessionId(), undefined, undefined, epoch + 100);
  const replay = prompt('first', 'Changed request', epoch + 100);
  expect(() => store.importTranscriptUserPrompt(replay)).toThrow('Native prompt identity was reused with different text');
  expect(replay.claimedHookRowIds.size).toBe(0);
});

test.each([
  ['claude', 'another-conversation'],
  ['codex', 'conversation'],
])('native replay detection stays within %s / %s', (platformSource, contentSessionId) => {
  expect(store.importTranscriptUserPrompt(prompt('first')).reason).toBe('new');
  const otherSession = store.createSDKSession(contentSessionId, 'repo', 'continue', undefined, platformSource);
  const hookRowId = store.saveUserPrompt(contentSessionId, 1, 'continue', otherSession, undefined, undefined, epoch);
  expect(store.importTranscriptUserPrompt({ ...prompt('first'), platformSource, contentSessionId }))
    .toEqual({ reason: 'recorded-by-hook', hookRowId });
  expect(store.db.prepare('SELECT COUNT(*) AS count FROM user_prompts').get()).toEqual({ count: 2 });
});
