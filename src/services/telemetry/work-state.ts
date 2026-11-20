import { createHash } from 'crypto';
import type { Database } from 'bun:sqlite';
import { hasTelemetryConsent } from './telemetry.js';
import { telemetryBuffer } from './buffer.js';
import { isSubagentEvent } from '../../shared/subagent-predicate.js';

import { workStatePlatform, workStateTool, workStateOutcome, type WorkStateAttribution, type InstructionState, type WorkStateOutcome } from '../../shared/work-state-telemetry.js';

const initialized = new WeakMap<Database, number>();
export const WORK_STATE_REPLAY_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const hash = (...parts: string[]) => createHash('sha256').update(parts.join('\0')).digest('hex');

function ensureStorage(db: Database): void {
  if (!initialized.has(db)) {
    // Local hashed identities only. This table is deliberately not cloud synced.
    // Keeping receipts across restarts prevents transcript replays counting twice.
    db.run('CREATE TABLE IF NOT EXISTS work_state_telemetry_receipts (key TEXT PRIMARY KEY, state TEXT, created_at_epoch INTEGER NOT NULL DEFAULT 0)');
    const columns = db.query('PRAGMA table_info(work_state_telemetry_receipts)').all() as Array<{ name: string }>;
    if (!columns.some(column => column.name === 'created_at_epoch')) db.run('ALTER TABLE work_state_telemetry_receipts ADD COLUMN created_at_epoch INTEGER NOT NULL DEFAULT 0');
    db.run('CREATE INDEX IF NOT EXISTS idx_work_state_telemetry_age ON work_state_telemetry_receipts(created_at_epoch)');
    initialized.set(db, 0);
  }
  const now = Date.now();
  if (now - initialized.get(db)! >= 60 * 60 * 1000) {
    db.query('DELETE FROM work_state_telemetry_receipts WHERE created_at_epoch < ?').run(now - WORK_STATE_REPLAY_WINDOW_MS);
    initialized.set(db, now);
  }
}

function prepare(db: Database): boolean {
  if (!hasTelemetryConsent()) return false;
  ensureStorage(db);
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
  return db.query('INSERT OR IGNORE INTO work_state_telemetry_receipts (key, created_at_epoch) VALUES (?, ?)').run(key, Date.now()).changes > 0;
}

function inReplayWindow(at: number | undefined): boolean {
  return typeof at === 'number' && Number.isFinite(at) && at >= Date.now() - WORK_STATE_REPLAY_WINDOW_MS;
}

/** Content-free latest turn boundary; a missing or older boundary is not public evidence. */
export function recordWorkStatePrivacy(db: Database, a: WorkStateAttribution, isPrivate: boolean): void {
  safely(() => {
    // Only a recent, timestamped public submission can reopen public coverage.
    // Untimestamped transcript replay must never clear a private boundary.
    if (!isPrivate && !inReplayWindow(a.enqueuedAtEpochMs)) return;
    // Privacy boundaries remain local even while analytics is opted out, so
    // opting back in during a private turn cannot revive an old public state.
    ensureStorage(db);
    const at = Number.isFinite(a.enqueuedAtEpochMs) ? a.enqueuedAtEpochMs! : Date.now();
    const row = db.query('SELECT state FROM work_state_telemetry_receipts WHERE key = ?').get(`privacy:${scope(a)}`) as { state: string } | null;
    if (row?.state) {
      try {
        const previous = JSON.parse(row.state);
        if (previous.at > at || (!isPrivate && previous.private && previous.at === at)) return;
      } catch {}
    }
    db.query('INSERT OR REPLACE INTO work_state_telemetry_receipts (key, state, created_at_epoch) VALUES (?, ?, ?)')
      .run(`privacy:${scope(a)}`, JSON.stringify({ private: isPrivate, at }), Date.now());
  });
}

export function isPublicWorkStateTurn(db: Database, a: WorkStateAttribution): boolean {
  try {
    if (!prepare(db) || !inReplayWindow(a.enqueuedAtEpochMs)) return false;
    const row = db.query('SELECT state FROM work_state_telemetry_receipts WHERE key = ?').get(`privacy:${scope(a)}`) as { state: string } | null;
    if (!row?.state) return false;
    const boundary = JSON.parse(row.state);
    return boundary.private === false && Number.isFinite(boundary.at) && boundary.at <= a.enqueuedAtEpochMs!;
  } catch { return false; }
}

/** Best effort like the existing telemetry transport; never fail application work. */
function safely(run: () => void): void { try { run(); } catch {} }

export function recordWorkStateInstruction(db: Database, a: WorkStateAttribution, state: InstructionState, eventId: string): void {
  safely(() => {
    const at = a.enqueuedAtEpochMs ?? Date.now();
    if (!prepare(db) || !inReplayWindow(at) || !claim(db, `instruction-event:${hash(eventId)}`)) return;
    const latest = lastInstruction(db, a);
    if (!latest || at >= latest.at) {
      db.query('INSERT OR REPLACE INTO work_state_telemetry_receipts (key, state, created_at_epoch) VALUES (?, ?, ?)').run(`instruction:${scope(a)}`, JSON.stringify({ state, at }), Date.now());
    }
    telemetryBuffer.record('work_state_usage', null, { ...properties(db, a), instruction_state: state, [`instruction_${state}_count`]: 1 });
  });
}

export function recordWorkStatePrompt(db: Database, a: WorkStateAttribution, promptId: number): void {
  safely(() => {
    if (!inReplayWindow(a.enqueuedAtEpochMs)) return;
    if (!prepare(db) || !claim(db, `prompt:${hash(a.contentSessionId, String(promptId), workStatePlatform(a.platformSource))}`)) return;
    const first = claim(db, `session:${scope(a)}`);
    telemetryBuffer.record('work_state_usage', null, { ...properties(db, a), captured_prompt_count: 1, captured_session_count: first ? 1 : 0 });
  });
}

export function recordWorkStateTool(db: Database, a: WorkStateAttribution, toolUseId: string | undefined, name: string, response: unknown): void {
  safely(() => {
    if (!prepare(db) || !inReplayWindow(a.enqueuedAtEpochMs)) return;
    // Unknown identity has its own diagnostic count, never inflates usage.
    if (!toolUseId) {
      telemetryBuffer.record('work_state_usage', null, { ...properties(db, a), unidentified_tool_event_count: 1 });
      return;
    }
    // Match tool_uses identity: a replay may improve host attribution, but it
    // is still the same call and must not be counted a second time.
    if (!claim(db, `tool:${hash(a.contentSessionId, toolUseId)}`)) return;
    const tool = workStateTool(name);
    telemetryBuffer.record('work_state_usage', null, {
      ...properties(db, a), captured_tool_count: 1,
      ...(tool === 'native_todo' ? { native_todo_count: 1 }
        : tool ? { [`captured_${tool}_count`]: 1, [`captured_${tool}_${workStateOutcome(tool, response)}_count`]: 1 } : {}),
    });
  });
}

/** MCP execution receipts also cover failures before a worker route is reached. */
export function recordWorkStateMcp(db: Database, tool: 'read' | 'write', outcome: WorkStateOutcome, eventId: string, at: number = Date.now()): void {
  safely(() => {
    if (!prepare(db) || !inReplayWindow(at) || !claim(db, `mcp:${hash(eventId)}`)) return;
    telemetryBuffer.record('work_state_usage', null, {
      platform: 'unknown', agent_role: 'unknown', instruction_state: 'unknown',
      [`mcp_${tool}_count`]: 1, [`mcp_${tool}_${outcome}_count`]: 1,
    });
  });
}
