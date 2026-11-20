import { randomUUID } from 'crypto';
import { spoolHookEvent } from './spool-hook-event.js';
import { resolveTelemetryConsent, loadTelemetryConfig } from '../services/telemetry/consent.js';
import { workStateOutcome, workStateTool } from '../shared/work-state-telemetry.js';

const mcpProcessId = randomUUID();

/**
 * The work-state rule now reaches the host in this MCP server's instructions,
 * not in the SessionStart hook's output, so the handoff is counted here, once
 * the host has finished initializing with them. Like the MCP tool counts, it
 * carries no host session: an MCP process cannot tell which one it serves.
 */
export function spoolWorkStateMcpInstruction(workStateRuleIncluded: boolean): void {
  try {
    if (!resolveTelemetryConsent(process.env, loadTelemetryConfig())) return;
    spoolHookEvent('work_state_telemetry', {
      kind: 'instruction', contentSessionId: mcpProcessId, platformSource: 'unknown',
      state: workStateRuleIncluded ? 'returned' : 'disabled', eventId: randomUUID(),
    });
  } catch { /* Telemetry must not change the MCP handshake. */ }
}

export function spoolWorkStateMcpResult(name: string, result: unknown): void {
  try {
    const tool = workStateTool(name);
    if (!tool || tool === 'native_todo' || !resolveTelemetryConsent(process.env, loadTelemetryConfig())) return;
    spoolHookEvent('work_state_telemetry', {
      kind: 'mcp', contentSessionId: mcpProcessId, platformSource: 'unknown',
      eventId: randomUUID(), tool, outcome: workStateOutcome(tool, result),
    });
  } catch { /* MCP must return even if telemetry cannot be spooled. */ }
}
