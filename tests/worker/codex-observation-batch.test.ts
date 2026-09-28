import { afterEach, describe, expect, it } from 'bun:test';
import { CodexProvider } from '../../src/services/worker/CodexProvider.js';
import { SessionManager } from '../../src/services/worker/SessionManager.js';
import { queuedObservationPrompt, boundObservationPrompt } from '../../src/services/worker/codex-observation-batch.js';
import { ClassifiedProviderError } from '../../src/services/worker/provider-errors.js';
import { SettingsDefaultsManager } from '../../src/shared/SettingsDefaultsManager.js';
import type { PendingMessage, PendingMessageWithId } from '../../src/services/worker-types.js';
const originalLoad = SettingsDefaultsManager.loadFromFile;
afterEach(() => { SettingsDefaultsManager.loadFromFile = originalLoad; });
function harness(count = 8, chars = 32000) {
  SettingsDefaultsManager.loadFromFile = (() => ({ ...SettingsDefaultsManager.getAllDefaults(),
    CLAUDE_MEM_CODEX_OBSERVATION_BATCH_SIZE: String(count), CLAUDE_MEM_CODEX_OBSERVATION_BATCH_MAX_CHARS: String(chars),
  })) as any;
  const manager = new SessionManager(null as any);
  const session: any = { sessionDbId: 1, contentSessionId: 'test', memorySessionId: 'test',
    project: 'test', abortController: new AbortController(), claimedMessageIds: [], earliestPendingTimestamp: null,
    conversationHistory: [], lastPromptNumber: 1, cumulativeInputTokens: 0, cumulativeOutputTokens: 0 };
  (manager as any).sessions.set(1, session);
  const buffer = manager.getMessageBuffer();
  const provider: any = new CodexProvider(null as any, manager);
  provider.conversationMaxChars = () => 1000000;
  const enqueue = (message: Partial<PendingMessage> = {}) => buffer.enqueue(1, {
    type: 'observation', tool_name: 'Read', tool_input: { path: 'file' }, tool_response: 'data', prompt_number: 1, ...message });
  const first = () => manager.claimNextObservation(1, () => true)!;
  const render = (m: PendingMessageWithId) => provider.observationTurnPrompt(session, m, queuedObservationPrompt(m).split('\n').slice(1).join('\n'));
  const process = (m: PendingMessageWithId) => provider.processObservationMessage(session, m, undefined,
    { model: '', apiKey: 'test' }, m._originalTimestamp, undefined);
  return { manager, session, buffer, provider, enqueue, first, render, process };
}
describe('Codex observation batching', () => {
  it('takes at most eight available observations in FIFO order with metadata', () => {
    const h = harness(); const ids = Array.from({ length: 10 }, (_, i) => h.enqueue({ toolUseId: `tool-${i}` }));
    const first = h.first(); const prompt = h.render(first);
    expect(h.session.claimedMessageIds).toEqual(ids.slice(0, 8));
    expect(prompt.indexOf('tool-0')).toBeLessThan(prompt.indexOf('tool-7'));
    expect(prompt).not.toContain('tool-8'); expect(prompt).toContain(String(first._originalTimestamp));
    expect(h.buffer.getPendingCount(1)).toBe(10);
  });
  it('does not wait for more work', () => {
    const h = harness(); h.enqueue(); const prompt = h.render(h.first());
    expect(prompt).toContain('Read'); expect(h.session.claimedMessageIds).toHaveLength(1);
  });
  for (const barrier of [{ type: 'summarize' }, { prompt_number: 2 }, { agentId: 'other' }, { cwd: 'other' }]) {
    it(`stops before barrier ${JSON.stringify(barrier)}`, () => {
      const h = harness(); const id = h.enqueue(); h.enqueue(barrier as any); h.enqueue();
      h.render(h.first()); expect(h.session.claimedMessageIds).toEqual([id]);
    });
  }
  it('enforces aggregate character cap without claiming the item that does not fit', () => {
    const h = harness(8, 4000); h.enqueue({ tool_response: 'a'.repeat(1500) }); h.enqueue({ tool_response: 'b'.repeat(1500) });
    expect(h.render(h.first()).length).toBeLessThanOrEqual(4000);
    expect(h.session.claimedMessageIds).toHaveLength(1);
    const prompt = boundObservationPrompt('<parameters>' + 'x'.repeat(5000) + '</parameters><outcome>tail</outcome>', 1000);
    expect(prompt.length).toBeLessThanOrEqual(1000); expect(prompt).toContain('<elided chars='); expect(prompt).toContain('</parameters>');
  });
  it('acknowledges exactly the included batch after successful accepted skip', async () => {
    const h = harness(2); const ids = [h.enqueue(), h.enqueue(), h.enqueue()];
    h.provider.query = async () => ({ content: 'Skipping' });
    await h.process(h.first());
    expect(h.buffer.getPendingCount(1)).toBe(1);
    expect(h.buffer.getMessagesByIds(1, ids).map(m => m._persistentId)).toEqual([ids[2]]);
  });
  for (const kind of ['transient', 'quota_exhausted'] as const) {
    it(`retains failed batch and restores FIFO after ${kind}`, async () => {
      const h = harness(2); const ids = [h.enqueue(), h.enqueue(), h.enqueue()];
      h.provider.query = async () => { throw new ClassifiedProviderError('fixture', { kind, cause: null }); };
      await expect(h.process(h.first())).rejects.toThrow('fixture');
      expect(h.session.claimedMessageIds).toEqual(ids.slice(0, 2)); expect(h.buffer.getPendingCount(1)).toBe(3);
      await h.manager.resetProcessingToPending(1); expect(h.first()._persistentId).toBe(ids[0]);
    });
  }
  it('does not acknowledge a response arriving after abort', async () => {
    const h = harness(); h.enqueue(); h.enqueue();
    h.provider.query = async () => { h.session.abortController.abort(); return { content: 'Skipping' }; };
    await expect(h.process(h.first())).rejects.toThrow(); expect(h.buffer.getPendingCount(1)).toBe(2);
  });
  it('retains and unclaims inputs when the conversation recycles before send', async () => {
    const h = harness(); const ids = [h.enqueue(), h.enqueue()];
    h.provider.conversationMaxChars = () => 1;
    h.session.conversationHistory = [{ role: 'user', content: 'full' }];
    h.provider.query = async () => { throw new Error('must not send'); };
    await h.process(h.first());
    expect(h.session.abortReason).toBe('overflow:recycle');
    expect(h.buffer.getPendingCount(1)).toBe(2);
    expect(h.session.claimedMessageIds).toEqual([]);
    expect(h.buffer.claimNextMatching(1, () => true)?._persistentId).toBe(ids[0]);
  });
  it('uses configured count and falls back for invalid bounds', () => {
    for (const [count, chars, expected] of [[1, 32000, 1], [0, 2, 8], [33, 128001, 8]]) {
      const h = harness(count, chars); for (let i = 0; i < 9; i++) h.enqueue();
      expect(h.render(h.first()).length).toBeLessThanOrEqual(32000);
      expect(h.session.claimedMessageIds).toHaveLength(expected);
    }
  });

  it('preserves the session after an unexpected storage failure', () => {
    const h = harness(); h.enqueue(); h.render(h.first());
    expect(() => h.provider.handleSessionError(new Error('storage failed'), h.session)).toThrow('processing failed');
    expect(h.session.abortReason).toBe('transport:transient');
    expect(h.buffer.getPendingCount(1)).toBe(1);
  });

});
