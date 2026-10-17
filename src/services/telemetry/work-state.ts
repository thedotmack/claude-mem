import { createHash } from 'crypto';
import type { Database } from 'bun:sqlite';
import { resolveTelemetryConsent, loadTelemetryConfig } from './consent.js';
import { telemetryBuffer } from './buffer.js';
import { isSubagentEvent } from '../../shared/subagent-predicate.js';

import { workStatePlatform, workStateTool, workStateOutcome, type WorkStateAttribution, type InstructionState, type WorkStateOutcome } from '../../shared/work-state-telemetry.js';

const initialized = new WeakSet<Database>();
const hash = (...parts: string[]) => createHash('sha256').update(parts.join('\0')).digest('hex');

function prepare(db: Database): boolean {
  // Do not even create local telemetry state when the owner opts out.
  if (!resolveTelemetryConsent(process.env, loadTelemetryConfig())) return false;
  if (!initialized.has(db)) {
    // Local hashed identities only. This table is deliberately not cloud synced.
    // Keeping receipts across restarts prevents transcript replays counting twice.
    db.run('CREATE TABLE IF NOT EXISTS work_state_telemetry_receipts (key TEXT PRIMARY KEY, state TEXT)');
    initialized.add(db);
  }
  return true;
}

function scope(a: WorkStateAttribution): string {
  return hash(workStatePlatform(a.platformSource), a.contentSessionId, a.agentId ?? '');
}

function lastInstruction(db: Database, a: WorkStateAttribution): { state: InstructionState; at: number } | null {
  const row = db.query('SELECT state FROM work_state_telemetry_receipts WHERE key = ?').get(`instruction:${scope(a)}`) as { state: string } | null;
  if (!row?.state) return null;
  try {
    const value = JSON.parse(row.state);
    return value && ['returned', 'disabled', 'excluded', 'missing', 'unknown'].includes(value.state)
      && Number.isFinite(value.at) ? value : null;
  } catch { return null; }
}

function properties(db: Database, a: WorkStateAttribution): Record<string, unknown> {
  const instruction = lastInstruction(db, a);
  // A delayed tool event must never inherit an instruction handed off later.
  // Keep only the latest handoff: older ambiguous activity stays unknown.
  const instructionState = instruction && Number.isFinite(a.enqueuedAtEpochMs)
    && instruction.at <= a.enqueuedAtEpochMs! ? instruction.state : 'unknown';
  return {
    platform: workStatePlatform(a.platformSource),
    agent_role: a.agentRole ?? (isSubagentEvent(a.agentId, a.agentType) ? 'subagent' : a.agentId || a.agentType ? 'main' : 'unknown'),
    instruction_state: instructionState,
  };
}

function claim(db: Database, key: string): boolean {
  return db.query('INSERT OR IGNORE INTO work_state_telemetry_receipts (key) VALUES (?)').run(key).changes > 0;
}

/** Best effort like the existing telemetry transport; never fail application work. */
function safely(run: () => void): void { try { run(); } catch {} }

export function recordWorkStateInstruction(db: Database, a: WorkStateAttribution, state: InstructionState, eventId: string): void {
  safely(() => {
    if (!prepare(db) || !claim(db, `instruction-event:${hash(eventId)}`)) return;
    const at = a.enqueuedAtEpochMs ?? Date.now();
    const latest = lastInstruction(db, a);
    if (!latest || at >= latest.at) {
      db.query('INSERT OR REPLACE INTO work_state_telemetry_receipts (key, state) VALUES (?, ?)').run(`instruction:${scope(a)}`, JSON.stringify({ state, at }));
    }
    telemetryBuffer.record('work_state_usage', null, { ...properties(db, a), instruction_state: state, [`instruction_${state}_count`]: 1 });
  });
}

export function recordWorkStatePrompt(db: Database, a: WorkStateAttribution, promptId: number): void {
  safely(() => {
    if (!prepare(db) || !claim(db, `prompt:${hash(a.contentSessionId, String(promptId), workStatePlatform(a.platformSource))}`)) return;
    const first = claim(db, `session:${scope(a)}`);
    telemetryBuffer.record('work_state_usage', null, { ...properties(db, a), captured_prompt_count: 1, captured_session_count: first ? 1 : 0 });
  });
}

export function recordWorkStateTool(db: Database, a: WorkStateAttribution, toolUseId: string | undefined, name: string, response: unknown): void {
  safely(() => {
    if (!prepare(db)) return;
    // Unknown identity has its own diagnostic count, never inflates usage.
    if (!toolUseId) {
      telemetryBuffer.record('work_state_usage', null, { ...properties(db, a), unidentified_tool_event_count: 1 });
      return;
    }
    if (!claim(db, `tool:${hash(workStatePlatform(a.platformSource), a.contentSessionId, toolUseId)}`)) return;
    const tool = workStateTool(name);
    telemetryBuffer.record('work_state_usage', null, {
      ...properties(db, a), captured_tool_count: 1,
      ...(tool === 'native_todo' ? { native_todo_count: 1 }
        : tool ? { [`captured_${tool}_count`]: 1, [`captured_${tool}_${workStateOutcome(tool, response)}_count`]: 1 } : {}),
    });
  });
}

/** MCP execution receipts also cover failures before a worker route is reached. */
export function recordWorkStateMcp(db: Database, tool: 'read' | 'write', outcome: WorkStateOutcome, eventId: string): void {
  safely(() => {
    if (!prepare(db) || !claim(db, `mcp:${hash(eventId)}`)) return;
    telemetryBuffer.record('work_state_usage', null, {
      platform: 'unknown', agent_role: 'unknown', instruction_state: 'unknown',
      [`mcp_${tool}_count`]: 1, [`mcp_${tool}_${outcome}_count`]: 1,
    });
  });
}
