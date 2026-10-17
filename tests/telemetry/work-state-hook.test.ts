import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { spoolWorkStateInstruction, spoolWorkStateMcpResult } from '../../src/cli/work-state-telemetry';
import { settleHookSpoolNudges } from '../../src/cli/spool-hook-event';
import { WORK_STATE_RULE } from '../../src/services/context/sections/WorkStateRenderer';
import { useTempHookSpoolDataDir, spooledEntries } from '../helpers/temp-hook-spool';
import { workStateOutcome } from '../../src/shared/work-state-telemetry';

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

  it('understands Claude host strings and error objects without assuming every reply succeeded', () => {
    expect(workStateOutcome('write', 'Saved to "title" in project.')).toBe('ok');
    expect(workStateOutcome('write', { error: 'Error executing tool: network', is_interrupt: false })).toBe('error');
    expect(workStateOutcome('read', 'Error: service initializing')).toBe('error');
    expect(workStateOutcome('write', JSON.stringify({ content: [{ type: 'text', text: 'Saved to "title" in project.' }] }))).toBe('ok');
    expect(workStateOutcome('read', { content: 'malformed' })).toBe('unknown');
  });
});
