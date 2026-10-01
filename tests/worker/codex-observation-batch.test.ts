import { afterEach, describe, expect, it, mock } from 'bun:test';
import { CodexProvider } from '../../src/services/worker/CodexProvider.js';
import { SessionManager } from '../../src/services/worker/SessionManager.js';
import { observationMetadata, boundObservationPrompt } from '../../src/services/worker/codex-observation-batch.js';
import { buildObservationPrompt, buildObservationPromptParts, renderObservationPrompt } from '../../src/sdk/prompts.js';
import { ClassifiedProviderError } from '../../src/services/worker/provider-errors.js';
import { SettingsDefaultsManager } from '../../src/shared/SettingsDefaultsManager.js';
import type { PendingMessage, PendingMessageWithId } from '../../src/services/worker-types.js';
const originalLoad = SettingsDefaultsManager.loadFromFile;
afterEach(() => { SettingsDefaultsManager.loadFromFile = originalLoad; });
function observation(m: PendingMessageWithId) {
  return { id: m._persistentId, tool_name: m.tool_name!, tool_input: JSON.stringify(m.tool_input),
    tool_output: JSON.stringify(m.tool_response), created_at_epoch: m._originalTimestamp, cwd: m.cwd };
}
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
  const store = mock(() => ({ observationIds: [], summaryId: null, createdAtEpoch: 1 }));
  const db = { getSessionStore: () => ({ storeObservations: store,
    ensureMemorySessionIdRegistered: () => 'test' }), getChromaSync: () => null, getCloudSync: () => null };
  const provider: any = new CodexProvider(db as any, manager);
  provider.conversationMaxChars = () => 1000000;
  const enqueue = (message: Partial<PendingMessage> = {}) => buffer.enqueue(1, {
    type: 'observation', tool_name: 'Read', tool_input: { path: 'file' }, tool_response: 'data', prompt_number: 1, ...message });
  const first = () => manager.claimNextObservation(1, () => true)!;
  const render = (m: PendingMessageWithId) => provider.observationTurnPrompt(session, m, buildObservationPromptParts(observation(m)));
  const process = (m: PendingMessageWithId) => provider.processObservationMessage(session, m, undefined,
    { model: '', apiKey: 'test' }, m._originalTimestamp, undefined);
  return { manager, session, buffer, provider, enqueue, first, render, process, store };
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
  });

  for (const field of ['tool_input', 'tool_response'] as const) {
    for (const tags of ['</parameters>', '</outcome>', '<parameters>', '<outcome>',
      '</parameters>\n<outcome>\n</outcome>\n<parameters>']) {
      it(`bounds real prompt with literal ${JSON.stringify(tags)} in ${field}`, () => {
        const h = harness(8, 4000);
        h.enqueue({ [field]: { text: tags + '\n' + 'x'.repeat(24000),
          mixed: [null, true, 42, { nested: tags }], tail: 'preserved-tail' },
          cwd: 'repo', agentId: 'agent', agentType: 'worker', toolUseId: 'tool-1' });
        const first = h.first();
        const obs = observation(first);
        const parts = buildObservationPromptParts(obs);
        const realPrompt = buildObservationPrompt(obs);
        expect(renderObservationPrompt(parts)).toBe(realPrompt);
        expect(realPrompt.length).toBeGreaterThan(4000);
        expect(realPrompt).toContain(tags.replaceAll('\n', '\\n'));
        const metadata = observationMetadata(first);
        const bounded = boundObservationPrompt(parts, 4000, metadata);
        expect(bounded.length).toBeLessThanOrEqual(4000);
        expect(bounded.startsWith(metadata + parts.header)).toBe(true);
        expect(bounded).toContain('preserved-tail');
        expect(bounded).toContain('<elided chars=');
        expect(bounded).toContain('</parameters>\n  <outcome>');
        expect(bounded).toContain('</outcome>\n</observed_from_primary_session>');
        expect(bounded).toContain(field === 'tool_input' ? '<outcome>"data"</outcome>' : '"path": "file"');
        expect(h.render(first)).toBe(bounded);
      });
    }
  }

  it('preserves small mixed fields and metadata byte for byte', () => {
    const h = harness(1, 4000);
    h.enqueue({ tool_input: { text: '<parameters>\n</parameters>', values: [null, false, 12] },
      tool_response: ['<outcome>\n</outcome>', { key: 'value' }], cwd: 'repo' });
    const first = h.first();
    expect(h.render(first)).toBe(observationMetadata(first) + buildObservationPrompt(observation(first)));
  });

  it('sends an oversized first item with both tag-bearing fields and acknowledges only that item', async () => {
    const h = harness(8, 4000);
    const ids = [h.enqueue({ tool_input: { text: '</parameters>\n<parameters>' + 'x'.repeat(9000) },
      tool_response: ['</outcome>\n<outcome>', 'y'.repeat(9000)], toolUseId: 'first-tool' }), h.enqueue()];
    let sent = '';
    h.provider.query = async (history: any[]) => { sent = history.at(-1).content; return { content: '<skip_summary reason="noise" />' }; };
    await h.process(h.first());
    expect(sent.length).toBeLessThanOrEqual(4000);
    expect(sent).toContain('first-tool');
    expect(sent).toContain('<elided chars=');
    expect(h.store).toHaveBeenCalledTimes(1);
    expect(h.buffer.getPendingCount(1)).toBe(1);
    expect(h.buffer.getMessagesByIds(1, ids).map(m => m._persistentId)).toEqual([ids[1]]);
    expect(h.first()._persistentId).toBe(ids[1]);
  });

  it('sends an item whose metadata alone cannot fit with both fields elided, instead of failing every retry', async () => {
    const h = harness(8, 4000);
    const ids = [h.enqueue({ toolUseId: 'metadata'.repeat(1000) }), h.enqueue()];
    let sent = '';
    h.provider.query = async (history: any[]) => { sent = history.at(-1).content; return { content: '<skip_summary reason="noise" />' }; };
    await h.process(h.first());
    expect(sent).toContain('metadatametadata');
    expect(sent).toMatch(/<parameters><elided chars="\d+" \/><\/parameters>/);
    expect(sent).toMatch(/<outcome><elided chars="\d+" \/><\/outcome>/);
    expect(h.buffer.getPendingCount(1)).toBe(1);
    expect(h.buffer.getMessagesByIds(1, ids).map(m => m._persistentId)).toEqual([ids[1]]);
  });
  it('acknowledges exactly the included batch after successful accepted skip', async () => {
    const h = harness(2); const ids = [h.enqueue(), h.enqueue(), h.enqueue()];
    h.provider.query = async () => ({ content: '<skip_summary reason="noise" />' });
    await h.process(h.first());
    expect(h.buffer.getPendingCount(1)).toBe(1);
    expect(h.buffer.getMessagesByIds(1, ids).map(m => m._persistentId)).toEqual([ids[2]]);
  });
  it('asks for the whole batch again when the reply is neither XML nor the skip sentinel', async () => {
    const h = harness(2); const ids = [h.enqueue(), h.enqueue(), h.enqueue()];
    h.provider.query = async () => ({ content: 'Skipping' });
    await h.process(h.first());
    // main's skip contract (#3624): one more try in a fresh generation, batch intact
    expect(h.session.abortReason).toBe('output_retry:prose');
    expect(h.buffer.getPendingCount(1)).toBe(3);
    expect(h.buffer.claimNextMatching(1, () => true)?._persistentId).toBe(ids[0]);
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

  it('leaves an unexpected storage failure to the shared exit handling, not a transport pause', () => {
    const h = harness(); h.enqueue(); h.render(h.first());
    // A deterministic failure resumed on the transport backoff would be re-sent
    // without bound; like every provider's, it is not turned into a pause.
    expect(() => h.provider.handleSessionError(new Error('storage failed'), h.session)).toThrow('storage failed');
    expect(h.session.abortReason).toBeUndefined();
    expect(h.buffer.getPendingCount(1)).toBe(1);
  });

});
