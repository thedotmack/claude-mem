import { afterEach, describe, expect, it, mock } from 'bun:test';
import { CodexProvider } from '../../src/services/worker/CodexProvider.js';
import { SessionManager } from '../../src/services/worker/SessionManager.js';
import { SettingsDefaultsManager } from '../../src/shared/SettingsDefaultsManager.js';
import type { PendingMessage, PendingMessageWithId } from '../../src/services/worker-types.js';

// R4-12: the skip contract gives a rejected batch one retry, keyed on the
// batch. A Codex retry claims the observations queued behind the head since
// the first try, so a batch that kept growing was retried once per growth
// step instead of once.

const originalLoad = SettingsDefaultsManager.loadFromFile;
afterEach(() => { SettingsDefaultsManager.loadFromFile = originalLoad; });

function harness() {
  SettingsDefaultsManager.loadFromFile = (() => ({ ...SettingsDefaultsManager.getAllDefaults() })) as any;
  const manager = new SessionManager(null as any);
  const session: any = {
    sessionDbId: 1, contentSessionId: 'test', memorySessionId: 'test', project: 'test',
    abortController: new AbortController(), claimedMessageIds: [], earliestPendingTimestamp: null,
    conversationHistory: [], lastPromptNumber: 1, cumulativeInputTokens: 0, cumulativeOutputTokens: 0,
    consecutiveInvalidOutputs: 0, invalidOutputBatchKey: null, lastGeneratorSource: 'ingest',
  };
  (manager as any).sessions.set(1, session);
  const buffer = manager.getMessageBuffer();
  const db = {
    getSessionStore: () => ({
      storeObservations: mock(() => ({ observationIds: [], summaryId: null })),
      ensureMemorySessionIdRegistered: () => 'test',
    }),
    getChromaSync: () => null,
    getCloudSync: () => null,
  };
  const provider: any = new CodexProvider(db as any, manager);
  provider.conversationMaxChars = () => 1_000_000;
  // Neither observation XML nor the skip sentinel: a rejected reply.
  provider.query = async () => ({ content: 'I looked at the file.' });
  const enqueue = (message: Partial<PendingMessage> = {}) => buffer.enqueue(1, {
    type: 'observation', tool_name: 'Read', tool_input: { path: 'file' }, tool_response: 'data', prompt_number: 1, ...message,
  });
  // One generator attempt: reset like getMessageIterator, claim the head, process it.
  const attempt = async () => {
    session.abortController = new AbortController();
    session.abortReason = undefined;
    await manager.resetProcessingToPending(1);
    const head = manager.claimNextObservation(1, () => true)! as PendingMessageWithId;
    session.lastGeneratorSource = 'ingest';
    await provider.processObservationMessage(session, head, undefined, { model: '', apiKey: 'x' }, head._originalTimestamp, undefined);
    return session.abortReason as string | undefined;
  };
  return { buffer, enqueue, attempt };
}

describe('a growing Codex batch keeps its one retry', () => {
  it('drops the batch on its second rejection even though it grew in between', async () => {
    const h = harness();
    h.enqueue();
    expect(await h.attempt()).toMatch(/^output_retry:/);

    h.enqueue(); // queued behind the head before the retry; the retry folds it in
    expect(await h.attempt()).toBeUndefined(); // dropped, not retried again
    expect(h.buffer.getPendingCount(1)).toBe(0);
  });
});
