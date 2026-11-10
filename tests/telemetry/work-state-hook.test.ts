import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { spoolWorkStateMcpInstruction, spoolWorkStateMcpResult } from '../../src/cli/work-state-telemetry';
import { settleHookSpoolNudges } from '../../src/cli/spool-hook-event';
import { useTempHookSpoolDataDir, spooledEntries } from '../helpers/temp-hook-spool';
import { workStateOutcome } from '../../src/shared/work-state-telemetry';
import { observationHandler } from '../../src/cli/handlers/observation';
import { sessionInitHandler, setSessionInitDependenciesForTesting } from '../../src/cli/handlers/session-init';

let temporary: ReturnType<typeof useTempHookSpoolDataDir>;
let oldConsent: string | undefined;
let oldDnt: string | undefined;
let oldEnabled: string | undefined;
const input = { sessionId: 'private-session', cwd: '/private-path', platform: 'codex' };

beforeEach(() => {
  temporary = useTempHookSpoolDataDir();
  oldConsent = process.env.CLAUDE_MEM_TELEMETRY;
  oldDnt = process.env.DO_NOT_TRACK;
  oldEnabled = process.env.CLAUDE_MEM_WORK_STATE_ENABLED;
  process.env.CLAUDE_MEM_TELEMETRY = '1';
  delete process.env.DO_NOT_TRACK;
  process.env.CLAUDE_MEM_WORK_STATE_ENABLED = 'true';
});
afterEach(async () => {
  await settleHookSpoolNudges();
  temporary.restore();
  for (const [key, old] of [['CLAUDE_MEM_TELEMETRY', oldConsent], ['DO_NOT_TRACK', oldDnt], ['CLAUDE_MEM_WORK_STATE_ENABLED', oldEnabled]]) {
    if (old === undefined) delete process.env[key!]; else process.env[key!] = old;
  }
});

describe('work-state hook receipts', () => {
  it('forwards existing agent metadata with the prompt capture', async () => {
    let request: any;
    setSessionInitDependenciesForTesting({
      shouldTrackProject: () => true,
      loadFromFileOnce: () => ({ CLAUDE_MEM_SEMANTIC_INJECT: 'false' }),
      resolveRuntimeContext: () => ({ runtime: 'worker' }),
      isWorkerFallback: () => false,
      executeWithWorkerFallback: async (_path: string, _method: string, body: unknown) => {
        request = body;
        return { sessionDbId: 1, promptNumber: 1 };
      },
    });
    try {
      await sessionInitHandler.execute({ ...input, prompt: 'Read recorded progress', agentId: 'agent-1', agentType: 'Explore' });
      expect(request).toMatchObject({ agentId: 'agent-1', agentType: 'Explore', telemetryPlatformSource: 'codex' });
      expect(request.telemetryPromptEpochMs).toBeGreaterThan(0);
      expect(request.telemetryPromptEpochMs).toBeLessThanOrEqual(Date.now());
    } finally { setSessionInitDependenciesForTesting(); }
  });

  it('counts the MCP server handing off its instructions, with or without the work-state rule', () => {
    spoolWorkStateMcpInstruction(true);
    spoolWorkStateMcpInstruction(false);
    const entries = spooledEntries('work_state_telemetry');
    expect(entries.map(e => e.payload.state).sort()).toEqual(['disabled', 'returned']);
    for (const entry of entries) {
      // An MCP process cannot tell which host session it serves.
      expect(entry.payload).toMatchObject({ kind: 'instruction', platformSource: 'unknown' });
      expect(entry.payload.agentRole).toBeUndefined();
    }
  });

  it('preserves unknown MCP attribution and spools pre-worker failures', () => {
    spoolWorkStateMcpResult('work_state_write', { isError: true, content: [{ type: 'text', text: 'Service initializing' }] });
    const [entry] = spooledEntries('work_state_telemetry');
    expect(entry.payload).toMatchObject({ kind: 'mcp', platformSource: 'unknown', outcome: 'error', tool: 'write' });
  });

  it('does not spool after telemetry opt-out', () => {
    process.env.DO_NOT_TRACK = '1';
    spoolWorkStateMcpInstruction(true);
    spoolWorkStateMcpResult('work_state_write', { isError: true });
    expect(spooledEntries()).toHaveLength(0);
  });

  it('preserves missing host attribution before legacy observation normalization', async () => {
    await observationHandler.execute({ ...input, platform: undefined, toolName: 'TodoWrite', toolUseId: 'native-id', toolResponse: {} });
    const [entry] = spooledEntries('observation');
    expect(entry.payload).toMatchObject({ platformSource: 'claude', telemetryPlatformSource: 'unknown' });
  });

  it('understands Claude host strings and error objects without assuming every reply succeeded', () => {
    expect(workStateOutcome('write', 'Saved to "title" in project.')).toBe('ok');
    expect(workStateOutcome('write', { error: 'Error executing tool: network', is_interrupt: false })).toBe('error');
    expect(workStateOutcome('read', 'Error: service initializing')).toBe('error');
    expect(workStateOutcome('read', 'Worker request failed (HTTP 503).\nService initializing')).toBe('error');
    expect(workStateOutcome('write', JSON.stringify({ content: [{ type: 'text', text: 'Saved to "title" in project.' }] }))).toBe('ok');
    expect(workStateOutcome('read', { content: 'malformed' })).toBe('unknown');
  });
});
