import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { Database } from 'bun:sqlite';
import { postHogCaptureCalls } from '../preload';
import { __resetTelemetryForTests } from '../../src/services/telemetry/telemetry';
import { telemetryBuffer } from '../../src/services/telemetry/buffer';
import { recordWorkStateInstruction, recordWorkStateMcp, recordWorkStatePrompt, recordWorkStateTool } from '../../src/services/telemetry/work-state';
import { workStateOutcome, workStatePlatform, workStateTool } from '../../src/shared/work-state-telemetry';
import { scrubProperties } from '../../src/services/telemetry/scrub';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import * as consent from '../../src/services/telemetry/consent';
import { WORK_STATE_REPLAY_WINDOW_MS, recordWorkStatePrivacy, isPublicWorkStateTurn } from '../../src/services/telemetry/work-state';

let db: Database;
let oldConsent: string | undefined;
let oldDnt: string | undefined;
const epoch = Date.now();
const attribution = { enqueuedAtEpochMs: epoch, contentSessionId: 'private-session', platformSource: 'codex', agentId: 'private-agent', agentType: 'private-type' };
const saved = { content: [{ type: 'text', text: 'Saved to "private title" in private/project. Still open in it: private content' }] };

beforeEach(() => {
  oldConsent = process.env.CLAUDE_MEM_TELEMETRY;
  oldDnt = process.env.DO_NOT_TRACK;
  process.env.CLAUDE_MEM_TELEMETRY = '1';
  delete process.env.DO_NOT_TRACK;
  __resetTelemetryForTests();
  telemetryBuffer.__resetForTests();
  postHogCaptureCalls.length = 0;
  db = new Database(':memory:');
});

afterEach(() => {
  db.close();
  telemetryBuffer.__resetForTests();
  __resetTelemetryForTests();
  if (oldConsent === undefined) delete process.env.CLAUDE_MEM_TELEMETRY; else process.env.CLAUDE_MEM_TELEMETRY = oldConsent;
  if (oldDnt === undefined) delete process.env.DO_NOT_TRACK; else process.env.DO_NOT_TRACK = oldDnt;
});

function events() {
  telemetryBuffer.flush();
  return postHogCaptureCalls.filter(call => call.event === 'work_state_usage_rollup').map(call => call.properties);
}

describe('work-state usage telemetry', () => {
  it('joins only the exact local agent scope and keeps pre-exposure activity unknown', () => {
    recordWorkStateTool(db, attribution, 'before', 'TodoWrite', {});
    recordWorkStateInstruction(db, { ...attribution, enqueuedAtEpochMs: epoch + 100 }, 'returned', 'context-1');
    recordWorkStateTool(db, { ...attribution, enqueuedAtEpochMs: epoch + 200 }, 'write-1', 'mcp__claude-mem__work_state_write', saved);
    recordWorkStateTool(db, { ...attribution, agentId: 'another-agent' }, 'other', 'TodoWrite', {});
    const rows = events();
    const known = rows.find(row => row.instruction_state === 'returned')!;
    expect(known).toMatchObject({ platform: 'codex', agent_role: 'subagent', instruction_returned_count: 1, captured_write_count: 1, captured_write_ok_count: 1 });
    expect(rows.find(row => row.instruction_state === 'unknown')?.native_todo_count).toBe(2);
  });

  it('deduplicates prompts, sessions, tool replays and MCP spool retries durably', () => {
    for (let i = 0; i < 3; i++) {
      recordWorkStatePrompt(db, attribution, 42);
      recordWorkStateTool(db, attribution, 'one-tool', 'work_state_write', saved);
      recordWorkStateMcp(db, 'write', 'error', 'same-spooled-receipt');
      recordWorkStateInstruction(db, attribution, 'returned', 'same-context-receipt');
    }
    const rows = events();
    expect(rows.reduce((n, r) => n + Number(r.captured_prompt_count ?? 0), 0)).toBe(1);
    expect(rows.reduce((n, r) => n + Number(r.captured_session_count ?? 0), 0)).toBe(1);
    expect(rows.reduce((n, r) => n + Number(r.captured_write_count ?? 0), 0)).toBe(1);
    expect(rows.reduce((n, r) => n + Number(r.mcp_write_error_count ?? 0), 0)).toBe(1);
    expect(rows.reduce((n, r) => n + Number(r.instruction_returned_count ?? 0), 0)).toBe(1);
    recordWorkStateTool(db, attribution, 'one-tool', 'work_state_write', saved);
    expect(events()).toHaveLength(rows.length); // no new rollup after flush
  });

  it('records missing call IDs separately, without claiming distinct reads or writes', () => {
    recordWorkStateTool(db, attribution, undefined, 'work_state_write', saved);
    const row = events()[0];
    expect(row.unidentified_tool_event_count).toBe(1);
    expect(row.captured_write_count).toBeUndefined();
    expect(row.captured_tool_count).toBeUndefined();
  });

  it('never assigns a later handoff to delayed tools or regresses state on an old context replay', () => {
    recordWorkStateInstruction(db, { ...attribution, enqueuedAtEpochMs: epoch + 200 }, 'returned', 'later-handoff');
    recordWorkStateTool(db, { ...attribution, enqueuedAtEpochMs: epoch + 100 }, 'older-tool', 'TodoWrite', {});
    recordWorkStateInstruction(db, { ...attribution, enqueuedAtEpochMs: epoch + 50 }, 'disabled', 'older-handoff');
    recordWorkStateTool(db, { ...attribution, enqueuedAtEpochMs: epoch + 300 }, 'newer-tool', 'TodoWrite', {});
    recordWorkStateTool(db, { ...attribution, enqueuedAtEpochMs: undefined }, 'untimestamped-tool', 'TodoWrite', {});
    const rows = events();
    expect(rows.find(r => r.instruction_state === 'unknown')?.native_todo_count).toBe(1);
    expect(rows.find(r => r.instruction_state === 'returned')?.native_todo_count).toBe(1);
    expect(rows.find(r => r.instruction_state === 'disabled')?.native_todo_count).toBeUndefined();
  });

  it('retains deduplication when the database is reopened after a worker restart', () => {
    const directory = mkdtempSync(join(tmpdir(), 'work-state-receipts-'));
    try {
      let disk = new Database(join(directory, 'test.db'));
      recordWorkStateTool(disk, attribution, 'persisted', 'work_state_write', saved);
      disk.close();
      disk = new Database(join(directory, 'test.db'));
      recordWorkStateTool(disk, attribution, 'persisted', 'work_state_write', saved);
      disk.close();
      expect(events()[0].captured_write_count).toBe(1);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it('does not recount a tool when a replay supplies different host attribution', () => {
    recordWorkStateTool(db, { ...attribution, platformSource: undefined }, 'same-call', 'work_state_write', saved);
    recordWorkStateTool(db, attribution, 'same-call', 'work_state_write', saved);
    const rows = events();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ platform: 'unknown', captured_write_count: 1 });
  });

  it('prunes old receipts but never recounts their old transcript events', () => {
    const base = Date.now();
    const clock = spyOn(Date, 'now').mockReturnValue(base);
    try {
      recordWorkStateTool(db, { ...attribution, enqueuedAtEpochMs: base }, 'expired', 'work_state_write', saved);
      events();
      clock.mockReturnValue(base + WORK_STATE_REPLAY_WINDOW_MS + 1);
      recordWorkStateMcp(db, 'read', 'ok', 'fresh');
      expect(db.query("SELECT COUNT(*) AS n FROM work_state_telemetry_receipts WHERE key LIKE 'tool:%'").get()).toEqual({ n: 0 });
      recordWorkStateTool(db, { ...attribution, enqueuedAtEpochMs: base }, 'expired', 'work_state_write', saved);
      const rows = events();
      expect(rows.reduce((n, r) => n + Number(r.captured_write_count ?? 0), 0)).toBe(1);
      expect(rows.reduce((n, r) => n + Number(r.mcp_read_count ?? 0), 0)).toBe(1);
    } finally { clock.mockRestore(); }
  });

  it('does not count old or untimestamped prompts and cannot reopen public coverage with them', () => {
    const now = Date.now();
    recordWorkStatePrivacy(db, { ...attribution, enqueuedAtEpochMs: now }, true);
    for (const at of [undefined, now - WORK_STATE_REPLAY_WINDOW_MS - 1]) {
      recordWorkStatePrompt(db, { ...attribution, enqueuedAtEpochMs: at }, 100);
      recordWorkStatePrivacy(db, { ...attribution, enqueuedAtEpochMs: at }, false);
    }
    expect(events()).toHaveLength(0);
    expect(isPublicWorkStateTurn(db, { ...attribution, enqueuedAtEpochMs: now + 1 })).toBe(false);
  });

  it('shares the worker consent cache and observes opt-out after its existing TTL', () => {
    const base = Date.now();
    const clock = spyOn(Date, 'now').mockReturnValue(base);
    const config = spyOn(consent, 'loadTelemetryConfig').mockReturnValue({ enabled: true, installId: 'test-install' });
    try {
      for (let i = 0; i < 3; i++) recordWorkStateMcp(db, 'read', 'ok', `cached-${i}`);
      expect(config).toHaveBeenCalledTimes(1);
      events();
      process.env.DO_NOT_TRACK = '1';
      clock.mockReturnValue(base + 30_001);
      recordWorkStateMcp(db, 'read', 'ok', 'after-opt-out');
      expect(events().reduce((n, r) => n + Number(r.mcp_read_count ?? 0), 0)).toBe(3);
    } finally { config.mockRestore(); clock.mockRestore(); }
  });

  it('retains only a local privacy bit during opt-out so re-enabling cannot revive a public turn', () => {
    recordWorkStatePrivacy(db, attribution, false);
    process.env.DO_NOT_TRACK = '1';
    __resetTelemetryForTests();
    recordWorkStatePrivacy(db, attribution, true);
    delete process.env.DO_NOT_TRACK;
    __resetTelemetryForTests();
    expect(isPublicWorkStateTurn(db, { ...attribution, enqueuedAtEpochMs: Date.now() })).toBe(false);
    expect(events()).toHaveLength(0);
  });

  it('preserves a private boundary on timestamp ties and requires a strictly newer public turn', () => {
    recordWorkStatePrivacy(db, attribution, true);
    recordWorkStatePrivacy(db, attribution, false);
    expect(isPublicWorkStateTurn(db, { ...attribution, enqueuedAtEpochMs: epoch + 1 })).toBe(false);
    recordWorkStatePrivacy(db, { ...attribution, enqueuedAtEpochMs: epoch + 1 }, false);
    expect(isPublicWorkStateTurn(db, { ...attribution, enqueuedAtEpochMs: epoch + 2 })).toBe(true);
  });

  it('preserves opt-out before creating local state or emitting events', () => {
    process.env.DO_NOT_TRACK = '1';
    recordWorkStateInstruction(db, attribution, 'returned', 'context');
    recordWorkStateTool(db, attribution, 'write', 'work_state_write', saved);
    recordWorkStateMcp(db, 'write', 'error', 'error');
    expect(db.query("SELECT name FROM sqlite_master WHERE name='work_state_telemetry_receipts'").get()).toBeNull();
    expect(events()).toHaveLength(0);
  });

  it('emits no task, project, raw agent/session ID, content or inferred model', () => {
    recordWorkStateTool(db, attribution, 'private-tool', 'work_state_write', saved);
    const row = events()[0];
    const json = JSON.stringify(row);
    expect(json).not.toContain('private');
    expect(row.model).toBeUndefined();
    expect(row.agent_id).toBeUndefined();
    expect(row.session_id).toBeUndefined();
    expect(db.query('SELECT key FROM work_state_telemetry_receipts').all().every((r: any) => !r.key.includes('private'))).toBe(true);
    expect(scrubProperties({ captured_write_ok_count: 2, agent_role: 'main', title: 'secret', tool_use_id: 'secret', contentSessionId: 'secret' })).toEqual({ captured_write_ok_count: 2, agent_role: 'main' });
  });

  it('keeps MCP failures separate from captured calls and reports disabled/excluded', () => {
    recordWorkStateMcp(db, 'write', 'error', 'network-failed');
    recordWorkStateMcp(db, 'read', 'disabled', 'disabled');
    recordWorkStateInstruction(db, attribution, 'excluded', 'excluded');
    const rows = events();
    expect(rows.find(r => r.platform === 'unknown')).toMatchObject({ agent_role: 'unknown', mcp_write_count: 1, mcp_write_error_count: 1, mcp_read_disabled_count: 1 });
    expect(rows.find(r => r.instruction_state === 'excluded')?.instruction_excluded_count).toBe(1);
    expect(rows.every(r => r.captured_write_count === undefined)).toBe(true);
  });

  it('uses finite platform names and exact tracked tool names', () => {
    expect(workStatePlatform(undefined)).toBe('unknown');
    expect(workStatePlatform('secret-custom-platform')).toBe('other');
    expect(workStatePlatform('claude-code')).toBe('claude');
    expect(workStatePlatform('omp')).toBe('omp');
    expect(workStateTool('mcp__mcp_search__work_state_read')).toBe('read');
    expect(workStateTool('functions.update_plan')).toBe('native_todo');
    expect(workStateTool('Write')).toBeNull();
    expect(workStateTool('work_state_write_suffix')).toBeNull();
  });

  it('classifies only explicit receipts, preserving ambiguous outcomes', () => {
    expect(workStateOutcome('write', saved)).toBe('ok');
    expect(workStateOutcome('write', { isError: true, content: [] })).toBe('error');
    expect(workStateOutcome('write', { content: [{ type: 'text', text: 'Not saved: this project is excluded from claude-mem (CLAUDE_MEM_EXCLUDED_PROJECTS).' }] })).toBe('excluded');
    expect(workStateOutcome('write', { content: [{ type: 'text', text: 'Work state is turned off (CLAUDE_MEM_WORK_STATE_ENABLED=false).' }], isError: true })).toBe('disabled');
    expect(workStateOutcome('write', {})).toBe('unknown');
    expect(workStateOutcome('write', undefined)).toBe('unknown');
  });
});
