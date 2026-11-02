import { afterEach, expect, it } from 'bun:test';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';
let store: SessionStore;
afterEach(() => store?.close());
function setup() {
  store = new SessionStore(':memory:');
  const sid = store.createSDKSession('content', 'project', 'prompt');
  for (const [number, epoch] of [[5, 100], [7, 200]]) {
    store.importUserPrompt({ content_session_id: 'content', platform_source: 'claude-code',
      prompt_number: number, prompt_text: `turn ${number}`, created_at: new Date(epoch).toISOString(), created_at_epoch: epoch });
  }
  return sid;
}
it('continues native prompt numbering after a partial history import', () => {
  const sid = setup();
  expect(store.saveNativeUserPrompt('content', sid, 'next-turn', 'new ask').promptNumber).toBe(8);
});
it('uses the persisted prompt number for delayed events, not the row count', () => {
  const sid = setup();
  expect(store.getPromptNumberFromUserPrompts('content', sid, 150)).toBe(5);
  expect(store.getPromptNumberFromUserPrompts('content', sid, 50)).toBe(0);
  expect(store.getPromptNumberFromUserPrompts('content', sid, 250)).toBe(7);
});
