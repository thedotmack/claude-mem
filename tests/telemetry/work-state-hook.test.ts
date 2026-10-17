import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { spoolWorkStateInstruction, spoolWorkStateMcpResult, workStateModelText } from '../../src/cli/work-state-telemetry';
import { settleHookSpoolNudges } from '../../src/cli/spool-hook-event';
import { WORK_STATE_RULE } from '../../src/services/context/sections/WorkStateRenderer';
import { useTempHookSpoolDataDir, spooledEntries } from '../helpers/temp-hook-spool';
import { workStateOutcome } from '../../src/shared/work-state-telemetry';
import { observationHandler } from '../../src/cli/handlers/observation';
import { getEventHandler } from '../../src/cli/handlers/index';
import { hookCommand } from '../../src/cli/hook-command';
import { installFakeStdin, restoreStdin } from '../fake-stdin';
import { HookStdoutError } from '../../src/shared/hook-io';
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

  for (const platform of ['claude-code', 'codex', 'cursor']) {
    it(`measures final ${platform} adapter output after stdout flush`, async () => {
      const handler = spyOn(getEventHandler('context'), 'execute').mockResolvedValue({
        workStateTelemetry: 'measure',
        hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: WORK_STATE_RULE },
      });
      const original = process.stdout.write;
      const chunks: string[] = [];
      process.stdout.write = ((chunk: string, done: () => void) => {
        expect(spooledEntries('work_state_telemetry')).toHaveLength(0);
        chunks.push(String(chunk));
        done();
        return true;
      }) as typeof process.stdout.write;
      installFakeStdin(JSON.stringify({ session_id: 'real-hook', conversation_id: 'real-hook', cwd: temporary.dataDir }));
      try {
        await hookCommand(platform, 'context', { skipExit: true });
        expect(chunks.join('')).not.toContain('workStateTelemetry');
        const [receipt] = spooledEntries('work_state_telemetry');
        expect(receipt.payload.state).toBe(platform === 'cursor' ? 'missing' : 'returned');
      } finally {
        handler.mockRestore();
        process.stdout.write = original;
        restoreStdin();
      }
    });
  }

  it('does not record an instruction handoff when stdout fails with EPIPE', async () => {
    const handler = spyOn(getEventHandler('context'), 'execute').mockResolvedValue({
      workStateTelemetry: 'measure',
      hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: WORK_STATE_RULE },
    });
    const original = process.stdout.write;
    process.stdout.write = ((_chunk: string, done: (error?: Error) => void) => {
      done(Object.assign(new Error('closed pipe'), { code: 'EPIPE' }));
      return false;
    }) as typeof process.stdout.write;
    installFakeStdin(JSON.stringify({ session_id: 'pipe-failed', cwd: temporary.dataDir }));
    try {
      await expect(hookCommand('codex', 'context', { skipExit: true })).rejects.toBeInstanceOf(HookStdoutError);
      expect(spooledEntries('work_state_telemetry')).toHaveLength(0);
    } finally {
      handler.mockRestore();
      process.stdout.write = original;
      restoreStdin();
    }
  });

  it('ignores human hints while recognizing raw and Antigravity model context', () => {
    expect(workStateModelText({ systemMessage: WORK_STATE_RULE })).toBe('');
    expect(workStateModelText(WORK_STATE_RULE)).toBe(WORK_STATE_RULE);
    expect(workStateModelText({ injectSteps: [{ ephemeralMessage: WORK_STATE_RULE }] })).toBe(WORK_STATE_RULE);
  });

  it('counts a complete returned block, including a cache-shaped return, but not a partial rule', () => {
    spoolWorkStateInstruction(input, WORK_STATE_RULE + '\n\nStill open:\nprivate task');
    spoolWorkStateInstruction(input, WORK_STATE_RULE.slice(0, -10));
    const entries = spooledEntries('work_state_telemetry');
    expect(entries.map(e => e.payload.state).sort()).toEqual(['missing', 'returned']);
    expect(JSON.stringify(entries)).not.toContain('private task');
    expect(entries[0].payload.agentRole).toBe('unknown');
  });

  it('keeps disabled, excluded and unknown context distinct', () => {
    process.env.CLAUDE_MEM_WORK_STATE_ENABLED = 'false';
    spoolWorkStateInstruction(input, '');
    spoolWorkStateInstruction(input, '', 'excluded');
    spoolWorkStateInstruction(input, '', 'unknown');
    expect(spooledEntries('work_state_telemetry').map(e => e.payload.state).sort()).toEqual(['disabled', 'excluded', 'unknown']);
  });

  it('preserves unknown MCP attribution and spools pre-worker failures', () => {
    spoolWorkStateMcpResult('work_state_write', { isError: true, content: [{ type: 'text', text: 'Service initializing' }] });
    const [entry] = spooledEntries('work_state_telemetry');
    expect(entry.payload).toMatchObject({ kind: 'mcp', platformSource: 'unknown', outcome: 'error', tool: 'write' });
  });

  it('does not spool after telemetry opt-out', () => {
    process.env.DO_NOT_TRACK = '1';
    spoolWorkStateInstruction(input, WORK_STATE_RULE);
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
