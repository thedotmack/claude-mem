import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { Database } from 'bun:sqlite';
import { cursorAdapter } from '../../../src/cli/adapters/cursor.js';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';
import { SessionManager } from '../../../src/services/worker/SessionManager.js';
import { ingestObservation, setIngestContext } from '../../../src/services/worker/http/shared.js';
import { extractObservationFileEvidence } from '../../../src/services/worker/agents/ResponseProcessor.js';
import { SettingsDefaultsManager } from '../../../src/shared/SettingsDefaultsManager.js';

// https://cursor.com/docs/hooks#aftermcpexecution: tool_input and result_json
// are JSON strings. Decode that host envelope before the worker serializes it.
describe('Cursor MCP JSON envelopes through local ingestion', () => {
  let db: Database;
  let store: SessionStore;
  let manager: SessionManager;
  let settings: ReturnType<typeof spyOn>;
  let sessionId: number;
  let started: number[];

  beforeEach(() => {
    settings = spyOn(SettingsDefaultsManager, 'loadFromFile').mockReturnValue({
      ...SettingsDefaultsManager.getAllDefaults(), CLAUDE_MEM_MEDIA_CAPTURE_ENABLED: 'false',
    });
    db = new Database(':memory:');
    store = new SessionStore(db, { syncOpsEnabled: false });
    sessionId = store.createSDKSession('cursor-json-session', 'project', 'Write the config.', undefined, 'cursor');
    store.saveUserPrompt('cursor-json-session', 1, 'Write the config.', sessionId);
    const dbManager = { getSessionStore: () => store, getSessionById: (id: number) => store.getSessionById(id) };
    manager = new SessionManager(dbManager as never);
    started = [];
    setIngestContext({ dbManager: dbManager as never, sessionManager: manager,
      eventBroadcaster: { broadcastObservationQueued() {} } as never,
      ensureGeneratorRunning: async id => { started.push(id); },
    });
  });

  afterEach(() => {
    manager.discardBufferedWork(sessionId);
    store.close();
    settings.mockRestore();
  });

  async function capture(response: Record<string, unknown>) {
    const input = cursorAdapter.normalizeInput({
      conversation_id: 'cursor-json-session', cwd: process.cwd(), hook_event_name: 'afterMCPExecution',
      tool_name: 'write_file', mcp_server_name: 'filesystem', tool_use_id: 'cursor-json-call',
      tool_input: JSON.stringify({ path: 'src/config.ts', content: 'export const configured = true;' }), result_json: JSON.stringify(response),
    });
    expect((await ingestObservation({ contentSessionId: input.sessionId, platformSource: 'cursor',
      cwd: input.cwd, toolName: input.toolName!, toolInput: input.toolInput,
      toolResponse: input.toolResponse, toolUseId: input.toolUseId,
    })).ok).toBe(true);
    expect(started).toEqual([sessionId]);
    const message = manager.getMessageBuffer().claimNextMatching(sessionId, () => true)!;
    const receipt = db.query('SELECT tool_input, tool_response FROM tool_uses WHERE tool_use_id=?').get('cursor-json-call') as {
      tool_input: string; tool_response: string;
    };
    return { message, receipt };
  }

  it('keeps structured MCP arguments in receipts and completed-file evidence', async () => {
    const { message, receipt } = await capture({ content: [{ type: 'text', text: 'export const configured = true;' }] });
    expect(extractObservationFileEvidence([message]).files_modified).toEqual(['src/config.ts']);
    expect(JSON.parse(receipt.tool_input)).toEqual({ path: 'src/config.ts', content: 'export const configured = true;' });
    expect(JSON.parse(receipt.tool_response)).toEqual({ content: [{ type: 'text', text: 'export const configured = true;' }] });
  });

  it('retains MCP isError as a structured failure in the observer and receipt', async () => {
    const response = { isError: true, content: [{ type: 'text', text: 'Permission denied' }] };
    const { message, receipt } = await capture(response);
    expect(JSON.parse(receipt.tool_response)).toEqual(response);
    expect(JSON.parse(message.tool_response!)).toEqual(response);
    expect(extractObservationFileEvidence([message]).files_modified).toEqual([]);
  });

  it('leaves ordinary shell text and already structured MCP values intact', () => {
    const shell = cursorAdapter.normalizeInput({ conversation_id: 'shell', cwd: process.cwd(),
      command: 'cat data.json', output: '{"isError":true}',
    });
    expect(shell.toolResponse).toEqual({ output: '{"isError":true}' });
    const input = { path: 'src/config.ts' };
    const result = { content: [{ type: 'text', text: 'ok' }] };
    const mcp = cursorAdapter.normalizeInput({ conversation_id: 'mcp', cwd: process.cwd(),
      tool_name: 'read_file', mcp_server_name: 'filesystem', tool_input: input, result_json: result,
    });
    expect(mcp.toolInput).toBe(input);
    expect(mcp.toolResponse).toBe(result);
  });
});
