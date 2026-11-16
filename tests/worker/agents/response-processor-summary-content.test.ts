import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';
import { SessionManager } from '../../../src/services/worker/SessionManager.js';
import { processAgentResponse, snapshotResponseContext } from '../../../src/services/worker/agents/ResponseProcessor.js';
import { SettingsDefaultsManager } from '../../../src/shared/SettingsDefaultsManager.js';
import { parseAgentXml } from '../../../src/sdk/parser.js';
import { logger } from '../../../src/utils/logger.js';
import type { DatabaseManager } from '../../../src/services/worker/DatabaseManager.js';
import type { WorkerRef } from '../../../src/services/worker/agents/types.js';

let store: SessionStore;
let db: DatabaseManager;
let manager: SessionManager;
let session: ReturnType<SessionManager['initializeSession']>;
let messages: ReturnType<SessionManager['getMessageIterator']>;
let settingsSpy: ReturnType<typeof spyOn>;
let warnSpy: ReturnType<typeof spyOn>;
let worker: WorkerRef;
const broadcast = mock(() => {});
const interaction = mock(() => {});
const status = mock(() => {});

beforeEach(() => {
  settingsSpy = spyOn(SettingsDefaultsManager, 'loadFromFile').mockImplementation(() => ({
    ...SettingsDefaultsManager.getAllDefaults(),
    CLAUDE_MEM_FOLDER_CLAUDEMD_ENABLED: 'false',
    CLAUDE_MEM_TELEGRAM_ENABLED: 'false',
    CLAUDE_MEM_NOTION_ENABLED: 'false',
    CLAUDE_MEM_GROK_BOT_AWARENESS_ENABLED: 'false',
    CLAUDE_MEM_GROK_BOT_INJECT_ENABLED: 'false',
    CLAUDE_MEM_LINE_ANCHORS_ENABLED: 'false',
  }));
  warnSpy = spyOn(logger, 'warn').mockImplementation(() => {});
  broadcast.mockClear(); interaction.mockClear(); status.mockClear();
  worker = { sseBroadcaster: { broadcast }, recordAiInteraction: interaction, broadcastProcessingStatus: status };
  store = new SessionStore(':memory:');
  db = {
    getSessionById: (id: number) => store.getSessionById(id),
    getSessionStore: () => store, getChromaSync: () => null, getCloudSync: () => null,
  } as unknown as DatabaseManager;
  manager = new SessionManager(db);
  const sid = store.createSDKSession('summary-content', 'test-project', 'Fix login');
  session = manager.initializeSession(sid, undefined, 1);
  session.memorySessionId = 'summary-memory';
  store.ensureMemorySessionIdRegistered(sid, session.memorySessionId);
  session.lastGeneratorSource = 'summarize';
  messages = manager.getMessageIterator(sid);
});

afterEach(async () => {
  session.abortController.abort();
  await messages.return(undefined);
  manager.removeSessionImmediate(session.sessionDbId);
  store.close();
  warnSpy.mockRestore(); settingsSpy.mockRestore();
});

const rows = () => store.db.query('SELECT request, investigated, learned, completed, next_steps, notes FROM session_summaries ORDER BY id').all();
const respond = (text: string) => processAgentResponse(text, session, db, manager, worker, 10, null, 'SDK', undefined, undefined, {
  ...snapshotResponseContext(session),
  promptNumber: manager.getClaimedMessages(session.sessionDbId)[0]?.prompt_number ?? session.lastPromptNumber,
});
async function claimSummary(prompt = 1) {
  manager.queueSummarize(session.sessionDbId, 'Synthetic assistant response', prompt);
  expect((await messages.next()).value.type).toBe('summarize');
}

describe('generated summaries need progress content before storage', () => {
  for (const [name, body] of [
    ['request only', '<request>Private request text</request>'],
    ['future plans only', '<next_steps>Private future plan</next_steps>'],
    ['request and future plans', '<request>Private request text</request><next_steps>Private future plan</next_steps>'],
    ['empty progress fields', '<request>Private request text</request><investigated></investigated><learned> &#32;&#10; </learned><completed>\t</completed><notes> </notes>'],
    ['empty CDATA', '<notes><![CDATA[]]></notes>'],
    ['whitespace CDATA', '<completed><![CDATA[ \t\n ]]></completed>'],
    ['comment only', '<investigated><!-- not progress --></investigated>'],
    ['comments mixed with empty literals', '<request>Private request text</request><next_steps>Private future plan</next_steps><learned><!-- hidden --><![CDATA[ ]]>&#32;</learned>'],
  ]) {
    it(`ends ${name} without storing, announcing success, or requesting a retry`, async () => {
      await claimSummary();
      session.consecutiveInvalidOutputs = 1;
      session.invalidOutputBatchKey = String(session.claimedMessageIds[0]);
      session.consecutiveContextOverflows = 1;
      session.pendingAgentId = 'fixture-agent';
      session.pendingAgentType = 'fixture-type';
      const raw = `<summary>${body}</summary>`;
      expect(parseAgentXml(raw).valid).toBe(true);
      expect(await respond(raw)).toBeNull();
      expect(rows()).toEqual([]);
      expect(session.lastSummaryStored).toBe(false);
      expect(manager.getTotalQueueDepth()).toBe(0);
      expect(session.claimedMessageIds).toEqual([]);
      expect(session.earliestPendingTimestamp).toBeNull();
      expect(session.abortController.signal.aborted).toBe(false);
      expect(session.abortReason ?? null).toBeNull();
      expect(session.consecutiveInvalidOutputs).toBe(0);
      expect(session.invalidOutputBatchKey).toBeNull();
      expect(session.consecutiveContextOverflows).toBe(0);
      expect(session.pendingAgentId).toBeNull();
      expect(session.pendingAgentType).toBeNull();
      expect(broadcast).not.toHaveBeenCalled();
      expect(interaction).not.toHaveBeenCalled();
      expect(status).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(warnSpy.mock.calls)).toContain('missing_progress_content');
      expect(JSON.stringify(warnSpy.mock.calls)).not.toContain('Private');
      // Already-sent conversation history is not rewritten to manufacture a retry.
      expect(session.conversationHistory.at(-1)?.content).toBe(raw);
    });
  }

  for (const [field, value, expected] of [
    ['notes', 'Migration needs a backup &amp; review.', 'Migration needs a backup & review.'],
    ['investigated', 'Read the JWT expiry handler.', 'Read the JWT expiry handler.'],
    ['learned', 'JWT expiry is measured in seconds.', 'JWT expiry is measured in seconds.'],
    ['completed', 'Corrected the expiry units.', 'Corrected the expiry units.'],
    ['notes', '<![CDATA[中文记录：保留 <summary> 示例。]]>', '<![CDATA[中文记录：保留 <summary> 示例。]]>'],
    ['notes', '&lt;!-- example --&gt;', '<!-- example -->'],
    ['notes', '<![CDATA[<!-- literal example -->]]>', '<![CDATA[<!-- literal example -->]]>'],
    ['notes', '<!-- hidden -->Actual progress', '<!-- hidden -->Actual progress'],
    ['notes', '<![CDATA[&#32;]]>', '<![CDATA[&#32;]]>'],
    ['notes', '&lt;![CDATA[]]&gt;', '<![CDATA[]]>'],
  ]) {
    it(`retains sparse ${field} content: ${expected}`, async () => {
      await claimSummary();
      const result = await respond(`<summary ><${field}>${value}</${field} ></summary >`);
      expect(result?.summaryId).toBeGreaterThan(0);
      expect(rows()).toHaveLength(1);
      expect((rows()[0] as Record<string, unknown>)[field]).toBe(expected);
      expect(session.lastSummaryStored).toBe(true);
      expect(manager.getTotalQueueDepth()).toBe(0);
      expect(broadcast).toHaveBeenCalledTimes(1);
    });
  }

  it('resets a previous success and preserves the next queued summary', async () => {
    await claimSummary();
    await respond('<summary><completed>Previous work</completed></summary>');
    expect(session.lastSummaryStored).toBe(true);
    await claimSummary(2);
    manager.queueSummarize(session.sessionDbId, 'Next assistant response', 3);
    await respond('<summary><request>Missing current progress</request></summary>');
    expect(session.lastSummaryStored).toBe(false);
    expect(rows()).toHaveLength(1);
    expect(manager.getTotalQueueDepth()).toBe(1);
    expect((await messages.next()).value.prompt_number).toBe(3);
    await respond('<summary><notes>Next work is recorded</notes></summary>');
    expect(rows()).toHaveLength(2);
    expect(session.lastSummaryStored).toBe(true);
    expect(manager.getTotalQueueDepth()).toBe(0);
  });

  it('does not wait for a memory session ID to end a content-poor reply', async () => {
    await claimSummary();
    session.memorySessionId = null;
    await respond('<summary><request>Just a request</request></summary>');
    expect(rows()).toEqual([]);
    expect(manager.getTotalQueueDepth()).toBe(0);
    expect(session.abortReason ?? null).toBeNull();
    expect(session.lastSummaryStored).toBe(false);
  });

  it('leaves an init reply outside batch handling', async () => {
    await claimSummary();
    const claimed = [...session.claimedMessageIds];
    session.lastGeneratorSource = 'init';
    await respond('<summary><request>Init request</request></summary>');
    expect(rows()).toEqual([]);
    expect(session.claimedMessageIds).toEqual(claimed);
    expect(manager.getTotalQueueDepth()).toBe(1);
    expect(status).not.toHaveBeenCalled();
  });

  it('keeps a legal skip terminal and leaves malformed-output recovery unchanged', async () => {
    await claimSummary();
    await respond('<skip_summary reason="nothing durable" />');
    expect(rows()).toEqual([]);
    expect(manager.getTotalQueueDepth()).toBe(0);
    expect(session.lastSummaryStored).toBe(false);
    await claimSummary(2);
    await respond('<summary><notes> &#32; </notes></summary>');
    expect(rows()).toEqual([]);
    expect(manager.getTotalQueueDepth()).toBe(1);
    expect(session.abortReason).toBe('output_retry:xml');
  });

  it('clears the answered agent attribution on a skip without a memory ID', async () => {
    await claimSummary();
    session.memorySessionId = null;
    session.pendingAgentId = 'old-agent';
    session.pendingAgentType = 'old-type';
    await respond('<skip_summary />');
    expect(session.pendingAgentId).toBeNull();
    expect(session.pendingAgentType).toBeNull();
    expect(manager.getTotalQueueDepth()).toBe(0);
  });

  it('keeps the truncation diagnostic when rejecting a content-poor reply', async () => {
    await claimSummary();
    session.lastFinishReason = 'MAX_TOKENS';
    await respond('<summary><request>Only a title</request></summary>');
    expect(JSON.stringify(warnSpy.mock.calls)).toContain('"truncated":true');
    expect(manager.getTotalQueueDepth()).toBe(0);
    expect(session.abortReason ?? null).toBeNull();
  });

  it('settles a rejected tool batch even if its completion receipt cannot be written', async () => {
    manager.queueObservation(session.sessionDbId, { tool_name: 'Read', tool_input: {}, tool_response: 'source', prompt_number: 1, toolUseId: 'failed-receipt' });
    await messages.next();
    session.lastGeneratorSource = 'ingest';
    const receipt = spyOn(store, 'markCommittedToolUses').mockImplementation(() => { throw new Error('synthetic storage failure'); });
    try {
      await respond('<summary><request>Only a title</request></summary>');
      expect(manager.getTotalQueueDepth()).toBe(0);
      expect(session.claimedMessageIds).toEqual([]);
      expect(session.lastSummaryStored).toBe(false);
    } finally { receipt.mockRestore(); }
  });

  it('keeps raw tool evidence and completion dedup when a tool turn returns a rejected summary', async () => {
    const rawId = store.upsertToolUse({
      toolUseId: 'tool-content', contentSessionId: session.contentSessionId,
      project: session.project, sessionDbId: session.sessionDbId, platformSource: session.platformSource,
      toolName: 'Read', toolInput: '{"path":"login.ts"}', toolResponse: 'original evidence',
    })!;
    const input = { tool_name: 'Read', tool_input: {}, tool_response: 'original evidence', prompt_number: 1, toolUseId: 'tool-content' };
    manager.queueObservation(session.sessionDbId, input);
    expect((await messages.next()).value.type).toBe('observation');
    session.lastGeneratorSource = 'ingest';
    session.memorySessionId = null;
    await respond('<summary><request>Title without progress</request></summary>');
    expect(rows()).toEqual([]);
    expect(store.hasCommittedToolUse(session.platformSource, session.contentSessionId, 'tool-content')).toBe(true);
    const raw = store.getToolUsesByIds([rawId])[0];
    expect(raw.tool_response).toBe('original evidence');
    expect(raw.observation_id).toBeNull();
    expect(manager.queueObservation(session.sessionDbId, input)).toBe(0);
    expect(manager.getTotalQueueDepth()).toBe(0);
  });
});
