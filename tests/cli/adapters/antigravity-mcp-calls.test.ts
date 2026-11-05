import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { antigravityCliAdapter } from '../../../src/cli/adapters/antigravity-cli.js';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';
import { setIngestContext, ingestObservation } from '../../../src/services/worker/http/shared.js';
import { buildAgentView, readAgentRecords } from '../../../src/services/work-view/agent-view.mjs';
import { reduceWorkState } from '../../../src/services/work-view/data-source.mjs';
import { logger } from '../../../src/utils/logger.js';

// Real agy 1.4.9 PostToolUse payloads (#5093): an MCP call arrives as
// `call_mcp_tool` with { ServerName, ToolName, Arguments }, and no payload
// carries a tool-call id.
const fixture = JSON.parse(readFileSync(join(import.meta.dir, '../../fixtures/hosts/antigravity-cli-1.4.9-post-tool-use.json'), 'utf8'));
const CONVERSATION = fixture.callMcpTool.conversationId as string;

/** The captured call_mcp_tool envelope, calling another claude-mem tool. */
function agyMcpCall(toolName: string, args: Record<string, unknown>, overrides: Record<string, unknown> = {}) {
  const payload = structuredClone(fixture.callMcpTool);
  payload.toolCall.args.ToolName = toolName;
  payload.toolCall.args.Arguments = args;
  return { ...payload, ...overrides };
}

describe('antigravityCliAdapter - MCP calls and tool-call identity (agy 1.4.9 payloads)', () => {
  it('names a call_mcp_tool step after the MCP tool it called, with that tool\'s own arguments', () => {
    const result = antigravityCliAdapter.normalizeInput(fixture.callMcpTool);
    expect(result.toolName).toBe('mcp__claude-mem__smart_outline');
    expect(result.toolInput).toEqual({ file_path: '/home/user/project/dump.sh' });
    expect(result.toolResponse).toEqual({ status: 'completed' });
  });

  it('gives every PostToolUse a stable tool-use id from the conversation and step', () => {
    expect(antigravityCliAdapter.normalizeInput(fixture.callMcpTool).toolUseId).toBe(`${CONVERSATION}-step-4`);
    const command = antigravityCliAdapter.normalizeInput(fixture.runCommand);
    expect(command.toolUseId).toBe(`${CONVERSATION}-step-2`);
    expect(command.toolName).toBe('run_command');
  });

  it('gives no id when agy sends no step index, and none to invocation events', () => {
    const { stepIdx: _drop, ...noStep } = fixture.runCommand;
    expect(antigravityCliAdapter.normalizeInput(noStep).toolUseId).toBeUndefined();
    const invocation = antigravityCliAdapter.normalizeInput({
      conversationId: CONVERSATION, workspacePaths: ['/home/user/project'], invocationNum: 1, initialNumSteps: 0,
    });
    expect(invocation.toolUseId).toBeUndefined();
  });

  it('keeps an unrecognised call_mcp_tool shape as agy sent it', () => {
    const odd = { ...fixture.callMcpTool, toolCall: { name: 'call_mcp_tool', args: { Something: 'else' } } };
    const result = antigravityCliAdapter.normalizeInput(odd);
    expect(result.toolName).toBe('call_mcp_tool');
    expect(result.toolInput).toEqual({ Something: 'else' });
  });
});

describe('an agy work_state_write attaches to its own conversation in My Work (#5093)', () => {
  let store: SessionStore;
  let workspace: string;
  let loggerSpies: ReturnType<typeof spyOn>[] = [];

  beforeEach(() => {
    loggerSpies = (['info', 'debug', 'warn', 'error', 'dataIn'] as const).map((level) => spyOn(logger, level).mockImplementation(() => {}));
    store = new SessionStore(new Database(':memory:'));
    workspace = mkdtempSync(join(tmpdir(), 'agy-workspace-'));
    setIngestContext({
      sessionManager: { queueObservation: async () => {} } as any,
      dbManager: { getSessionStore: () => store } as any,
      eventBroadcaster: { broadcastObservationQueued: mock(() => {}) } as any,
      ensureGeneratorRunning: mock(async () => {}),
    });
  });

  afterEach(() => {
    loggerSpies.forEach((spy) => spy.mockRestore());
    store.close();
    rmSync(workspace, { recursive: true, force: true });
  });

  async function ingestAgy(raw: Record<string, unknown>) {
    const input = antigravityCliAdapter.normalizeInput(raw);
    return ingestObservation({
      contentSessionId: input.sessionId!,
      platformSource: 'antigravity-cli',
      toolName: input.toolName!,
      toolInput: input.toolInput,
      toolResponse: input.toolResponse,
      cwd: input.cwd,
      toolUseId: input.toolUseId,
    });
  }

  it('records the write under the agy conversation, and its request_status reaches that conversation\'s card', async () => {
    const fields = { task: 'Ship the agy fix', request_status: 'done' };
    await ingestAgy(agyMcpCall('work_state_write', { list: 'release', fields }, { workspacePaths: [workspace] }));

    const [row] = store.queryToolUses({ contentSessionId: CONVERSATION });
    expect(row?.tool_name).toBe('mcp__claude-mem__work_state_write');
    expect(row?.platform_source).toBe('antigravity-cli');

    // The work-state entry the MCP server saved for that call.
    const entries = [{ id: 1, project: row!.project, list_name: 'release', fields: JSON.stringify(fields), created_at_epoch: row!.created_at_epoch }];
    const state = reduceWorkState(entries, { currentProject: row!.project, currentProjectScope: [row!.project] });
    const view = buildAgentView(state, readAgentRecords(store.db, { workState: state, now: row!.created_at_epoch + 1000 }), { now: row!.created_at_epoch + 1000 });

    const group = view.agents.find((agent: any) => agent.work.some((work: any) => work.title === 'Ship the agy fix'));
    expect(group.kind).toBe('session');
    expect(group.platformSource).toBe('antigravity-cli');
    expect(group.contentSessionId).toBe(CONVERSATION);
    const work = group.work.find((item: any) => item.title === 'Ship the agy fix');
    expect(work.attribution.source).toBe('captured-work-state-call');
    expect(work.requestStatus).toBe('done');
    expect(view.coverage.unattributedWork).toBe(0);
  });

  it('a replayed PostToolUse for the same step does not add a second row', async () => {
    const raw = agyMcpCall('work_state_write', { list: 'release', fields: { task: 'Once' } }, { workspacePaths: [workspace] });
    await ingestAgy(raw);
    await ingestAgy(raw);
    expect(store.queryToolUses({ contentSessionId: CONVERSATION })).toHaveLength(1);
  });

  it('an agy memory search is no longer stored or observed as a new tool call', async () => {
    const result = await ingestAgy(agyMcpCall('search', { query: 'agy' }, { workspacePaths: [workspace] }));
    expect(result).toEqual({ ok: true, status: 'skipped', reason: 'memory_retrieval' });
    expect(store.queryToolUses({})).toHaveLength(0);
  });
});
