import { randomUUID } from 'crypto';
import { spoolHookEvent } from './spool-hook-event.js';
import { resolveTelemetryConsent, loadTelemetryConfig } from '../services/telemetry/consent.js';
import { isSubagentEvent } from '../shared/subagent-predicate.js';
import { isWorkStateEnabled } from '../shared/work-state-setting.js';
import { loadFromFileOnce } from '../shared/hook-settings.js';
import { workStateOutcome, workStateTool, workStatePlatform, type InstructionState } from '../shared/work-state-telemetry.js';
import type { NormalizedHookInput } from './types.js';
import { WORK_STATE_RULE } from '../services/context/sections/WorkStateRenderer.js';

const mcpProcessId = randomUUID();

/** Model-bound text only; systemMessage is a human hint, not an injection. */
export function workStateModelText(output: unknown): string {
  if (typeof output === 'string') return output;
  if (!output || typeof output !== 'object') return '';
  const value = output as { hookSpecificOutput?: { additionalContext?: unknown }; injectSteps?: Array<{ ephemeralMessage?: unknown }> };
  if (typeof value.hookSpecificOutput?.additionalContext === 'string') return value.hookSpecificOutput.additionalContext;
  if (Array.isArray(value.injectSteps)) return value.injectSteps.map(step => typeof step.ephemeralMessage === 'string' ? step.ephemeralMessage : '').join('\n');
  return '';
}

export function spoolWorkStateInstruction(input: NormalizedHookInput, text: string, reason?: 'excluded' | 'unknown'): void {
  try {
    if (!resolveTelemetryConsent(process.env, loadTelemetryConfig())) return;
    const enabled = isWorkStateEnabled(process.env.CLAUDE_MEM_WORK_STATE_ENABLED ?? loadFromFileOnce().CLAUDE_MEM_WORK_STATE_ENABLED);
    const hasRule = text.includes(WORK_STATE_RULE);
    const state: InstructionState = reason ?? (hasRule ? 'returned' : !enabled ? 'disabled' : 'missing');
    spoolHookEvent('work_state_telemetry', {
      kind: 'instruction', contentSessionId: input.sessionId,
      platformSource: workStatePlatform(input.platform), agentId: input.agentId,
      agentRole: isSubagentEvent(input.agentId, input.agentType) ? 'subagent' : input.agentId || input.agentType ? 'main' : 'unknown',
      state, eventId: randomUUID(),
    });
  } catch { /* Telemetry must not change the hook result. */ }
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
