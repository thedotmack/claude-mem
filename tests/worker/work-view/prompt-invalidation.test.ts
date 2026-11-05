import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';
import { WorkViewRoutes } from '../../../src/services/worker/http/routes/WorkViewRoutes.js';
import { onContextInvalidation, type ContextInvalidation } from '../../../src/shared/context-invalidation.js';

let directory: string, store: SessionStore, routes: WorkViewRoutes, sessionId: number;
let events: ContextInvalidation[], unsubscribe: () => void;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'work-view-prompt-invalidation-'));
  const databasePath = join(directory, 'source.db');
  store = new SessionStore(databasePath, { syncOpsEnabled: false });
  sessionId = store.createSDKSession('conversation', 'project', 'First ask', undefined, 'claude');
  store.saveUserPrompt('conversation', 1, 'First ask', sessionId);
  routes = new WorkViewRoutes({ databasePath, ledgerDir: null, humanCopy: null, autoRefresh: null, focusShares: null,
    reviewPath: join(directory, 'reviews.db'), setupStatePath: join(directory, 'setup.json') });
  events = [];
  unsubscribe = onContextInvalidation(event => {
    if (event.changes?.kinds.includes('prompt')) {
      // No event may publish an uncommitted prompt, even through the nested
      // saveUserPrompt inside the native receipt transaction.
      expect(store.db.inTransaction).toBe(false);
      events.push(event);
    }
  });
});

afterEach(() => {
  unsubscribe(); routes.close(); store.close();
  rmSync(directory, { recursive: true, force: true });
});

const background = () => (routes as any).backgroundSnapshot();
const importedPrompt = () => ({
  content_session_id: 'conversation', session_db_id: sessionId, platform_source: 'claude', prompt_number: 2,
  prompt_text: 'New committed ask', created_at: new Date().toISOString(), created_at_epoch: Date.now(),
});
const transcriptPrompt = () => ({
  contentSessionId: 'conversation', platformSource: 'claude', project: 'project', nativePromptId: 'transcript-turn',
  promptText: 'New committed ask', createdAtEpoch: Date.now(), hookMatchWindowMs: 0, claimedHookRowIds: new Set<number>(),
});

describe('committed prompts invalidate cached My Work activity', () => {
  for (const source of ['hook', 'native', 'transcript', 'import'] as const) {
    it(`refreshes a ${source} prompt before the 120-second cache deadline`, async () => {
      const before = await background();
      if (source === 'hook') store.saveUserPrompt('conversation', 2, 'New committed ask', sessionId);
      else if (source === 'native') store.saveNativeUserPrompt('conversation', sessionId, 'native-turn', 'New committed ask');
      else if (source === 'transcript') store.importTranscriptUserPrompt(transcriptPrompt());
      else store.importUserPrompt(importedPrompt());
      expect(events).toHaveLength(1);
      expect(events[0].scope).toEqual({ projects: ['project'] });
      const after = await background();
      expect(after.revision).not.toBe(before.revision);
      expect(JSON.stringify(after)).toContain('New committed ask');
    });
  }

  it('does not emit again for native retries, imported duplicates or private transcript prompts', () => {
    store.saveNativeUserPrompt('conversation', sessionId, 'native-turn', 'New committed ask');
    store.saveNativeUserPrompt('conversation', sessionId, 'native-turn', 'New committed ask');
    store.importUserPrompt(importedPrompt());
    expect(store.importTranscriptUserPrompt({ ...transcriptPrompt(), promptText: '<private>secret</private>' }).reason).toBe('private');
    expect(events).toHaveLength(1);
  });

  for (const source of ['hook', 'native', 'transcript', 'import'] as const) {
    it(`does not emit a ${source} prompt rolled back by its enclosing transaction`, async () => {
      const before = await background();
      expect(() => store.db.transaction(() => {
        if (source === 'hook') store.saveUserPrompt('conversation', 2, 'New committed ask', sessionId);
        else if (source === 'native') store.saveNativeUserPrompt('conversation', sessionId, 'native-turn', 'New committed ask');
        else if (source === 'transcript') store.importTranscriptUserPrompt(transcriptPrompt());
        else store.importUserPrompt(importedPrompt());
        expect(events).toHaveLength(0);
        throw new Error('rollback the outer operation');
      })()).toThrow('rollback the outer operation');
      expect(events).toHaveLength(0);
      expect(store.getPromptNumberFromUserPrompts('conversation', sessionId)).toBe(1);
      expect((await background()).revision).toBe(before.revision);
    });
  }

  it('does not announce a native insert whose own transaction failed', () => {
    store.db.exec("CREATE TRIGGER reject_prompt BEFORE INSERT ON user_prompts BEGIN SELECT RAISE(ABORT, 'fixture rollback'); END");
    expect(() => store.saveNativeUserPrompt('conversation', sessionId, 'native-turn', 'New committed ask')).toThrow('fixture rollback');
    expect(events).toHaveLength(0);
    expect(store.getPromptNumberFromUserPrompts('conversation', sessionId)).toBe(1);
  });
});
