// A turn whose entire prompt was redacted (<private>...</private>) must still
// anchor its prompt number. Before the tombstone, the turn left no user_prompts
// row: the next ingest's getPromptNumberFromUserPrompts(..., at-or-before)
// resolved it to the previous public prompt's number, PrivacyCheckValidator
// read that public text, and the private turn's tool content was ingested and
// dispatched to the paid observer under a public prompt number.
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';
import { PrivacyCheckValidator } from '../../src/services/worker/validation/PrivacyCheckValidator.js';

describe('private prompt tombstone anchoring', () => {
  let store: SessionStore;
  let tempDir: string;
  let sessionDbId: number;
  const contentSessionId = 'tombstone-session';

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'private-tombstone-'));
    store = new SessionStore(join(tempDir, 'test.db'));
    sessionDbId = store.createSDKSession(contentSessionId, 'tombstone-project', 'unused initial prompt');

    // Turn #1: a normal public prompt.
    store.saveUserPrompt(contentSessionId, 1, 'fix the login bug', sessionDbId, undefined, undefined, 1_000);
    // Turn #2: entirely private — the tombstone the session-init route writes.
    store.savePrivatePromptTombstone(contentSessionId, sessionDbId, 2, 2_000);
  });

  afterEach(() => {
    store.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('suppresses ingestion for a tool use that arrives during the private turn', () => {
    const promptNumber = store.getPromptNumberFromUserPrompts(contentSessionId, sessionDbId, 3_000);
    expect(promptNumber).toBe(2);

    const decision = PrivacyCheckValidator.checkUserPromptPrivacy(
      store, contentSessionId, promptNumber, 'observation', sessionDbId, { tool_name: 'Bash' }
    );
    expect(decision.allow).toBe(false);
    if (!decision.allow) expect(decision.reason).toBe('private');
  });

  it('keeps ingesting a tool use that arrives during the public turn before it', () => {
    const promptNumber = store.getPromptNumberFromUserPrompts(contentSessionId, sessionDbId, 1_500);
    expect(promptNumber).toBe(1);

    const decision = PrivacyCheckValidator.checkUserPromptPrivacy(
      store, contentSessionId, promptNumber, 'observation', sessionDbId
    );
    expect(decision.allow).toBe(true);
    if (decision.allow) expect(decision.prompt).toBe('fix the login bug');
  });

  it('keeps #2794 semantics: a number with no row at all is still allowed', () => {
    const decision = PrivacyCheckValidator.checkUserPromptPrivacy(
      store, contentSessionId, 99, 'observation', sessionDbId
    );
    expect(decision.allow).toBe(true);
    if (decision.allow) expect(decision.prompt).toBe('');
  });

  it('numbers the next public turn after the private one instead of inheriting', () => {
    const nextNumber = store.getPromptNumberFromUserPrompts(contentSessionId, sessionDbId) + 1;
    expect(nextNumber).toBe(3);
  });

  it('stores no prompt text in the tombstone row', () => {
    expect(store.getUserPrompt(contentSessionId, 2, sessionDbId)).toBe('');
  });

  it('never surfaces the tombstone as the latest prompt text', () => {
    expect(store.getLatestPromptTextFromUserPrompts(contentSessionId, sessionDbId)).toBe('fix the login bug');
  });

  it('is idempotent on a hook retry whose first response was lost', () => {
    const inserted = store.savePrivatePromptTombstone(contentSessionId, sessionDbId, 2, 2_500);
    expect(inserted).toBe(false);
    // The retry must not push the next turn's number past the anchored turn.
    expect(store.getPromptNumberFromUserPrompts(contentSessionId, sessionDbId)).toBe(2);
  });
});
