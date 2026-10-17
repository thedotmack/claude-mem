// The hook spool's `session_init` kind (wire gateway plan Phase 5 task 1) and
// the two ingest facts the wire gateway relies on (Phase 5 task 2, plan §0.8):
// - Does ingestObservation re-queue an observation whose
//   (content_session_id, tool_use_id) already exists? It did, after a worker
//   restart (the queue's dedupe is in memory only); a tool use already linked
//   to an observation is now skipped. One not linked yet is still queued, so a
//   generation lost to a crash is retried.
// - What happens to an observation for an unknown session? It is NOT dropped:
//   createSDKSession registers the session (project from cwd, or 'unknown')
//   and the observation is queued under prompt 0. The wire assembler still
//   emits session_init first, so the observation lands under its prompt.
import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, readdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createHash } from 'crypto';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';
import { SettingsDefaultsManager } from '../../src/shared/SettingsDefaultsManager.js';
import { ingestObservation, ingestSessionInit, setIngestContext } from '../../src/services/worker/http/shared.js';
import { drainHookSpool } from '../../src/services/worker/hook-spool-drain.js';
import { HookSpool, hookSpoolKeyFor } from '../../src/shared/hook-spool.js';
import { remoteSpoolEnvelopeSchema } from '../../src/shared/hook-spool-remote.js';
import { logger } from '../../src/utils/logger.js';

let spoolDir: string;
let store: SessionStore;
let sessionManager: Record<string, ReturnType<typeof mock>>;
const spies: Array<ReturnType<typeof spyOn>> = [];

beforeEach(() => {
  spies.push(
    spyOn(SettingsDefaultsManager, 'loadFromFile').mockImplementation(() => SettingsDefaultsManager.getAllDefaults()),
    spyOn(logger, 'debug').mockImplementation(() => {}),
    spyOn(logger, 'info').mockImplementation(() => {}),
    spyOn(logger, 'warn').mockImplementation(() => {}),
    spyOn(logger, 'error').mockImplementation(() => {}),
  );
  spoolDir = mkdtempSync(join(tmpdir(), 'claude-mem-spool-session-init-'));
  store = new SessionStore(new Database(':memory:'));
  sessionManager = {
    queueObservation: mock(() => {}),
    queueSummarize: mock(() => {}),
    requestSessionWrapup: mock(async () => {}),
    getSession: mock(() => undefined),
    initializeSession: mock((_sessionDbId: number, _prompt: string, _promptNumber: number, project: string) => ({ project })),
  };
  setIngestContext({
    sessionManager: sessionManager as any,
    dbManager: { getSessionStore: () => store, getCloudSync: () => null, getChromaSync: () => null } as any,
    eventBroadcaster: {
      broadcastNewPrompt: mock(() => {}),
      broadcastSessionStarted: mock(() => {}),
      broadcastObservationQueued: mock(() => {}),
      broadcastSummarizeQueued: mock(() => {}),
    } as any,
    ensureGeneratorRunning: mock(async () => {}),
  });
});

afterEach(() => {
  spies.splice(0).forEach(spy => spy.mockRestore());
  store.close();
  rmSync(spoolDir, { recursive: true, force: true });
});

function countRows(table: string): number {
  return (store.db.prepare(`SELECT COUNT(*) AS rowCount FROM ${table}`).get() as { rowCount: number }).rowCount;
}

describe('hook spool session_init', () => {
  it('keys an init by session + platform + native prompt id, hashing an id that cannot be a filename', () => {
    const sessionKey = createHash('sha256').update('s-1').update('\0').update('codex').digest('hex');
    expect(hookSpoolKeyFor('session_init', { contentSessionId: 's-1', platformSource: 'codex', nativePromptId: 'turn-1' })).toBe(`${sessionKey}-turn-1`);
    const wireId = 'wire:0123456789abcdef0123456789abcdef';
    expect(hookSpoolKeyFor('session_init', { contentSessionId: 's-1', platformSource: 'codex', nativePromptId: wireId }))
      .toBe(`${sessionKey}-${createHash('sha256').update(wireId).digest('hex')}`);

    // The same turn spooled twice is one file.
    const spool = new HookSpool(join(spoolDir, 'spool'));
    spool.enqueue('session_init', { contentSessionId: 's-1', platformSource: 'codex', prompt: 'hi', nativePromptId: wireId });
    spool.enqueue('session_init', { contentSessionId: 's-1', platformSource: 'codex', prompt: 'hi', nativePromptId: wireId });
    expect(readdirSync(spool.directory).filter(name => name.endsWith('.json'))).toHaveLength(1);
  });

  it('a remote uploader may carry session_init entries', () => {
    const entry = { kind: 'session_init', payload: { contentSessionId: 's-1', platformSource: 'codex', prompt: 'hi', nativePromptId: 'turn-1', cwd: '/x' }, enqueuedAtEpochMs: 1 };
    expect(remoteSpoolEnvelopeSchema.safeParse({ protocolVersion: 1, entry }).success).toBe(true);
    const badId = { ...entry, payload: { ...entry.payload, nativePromptId: 'has space' } };
    expect(remoteSpoolEnvelopeSchema.safeParse({ protocolVersion: 1, entry: badId }).success).toBe(false);
  });

  it('an init enqueued before an observation of the same session drains first, so the observation lands under its prompt', async () => {
    const spool = new HookSpool(join(spoolDir, 'spool'));
    spool.enqueue('session_init', { contentSessionId: 'wire-s', platformSource: 'codex', prompt: 'list the files', nativePromptId: 'turn-1', cwd: '/Users/me/proj' });
    spool.enqueue('observation', {
      contentSessionId: 'wire-s', platformSource: 'codex', toolName: 'shell', toolInput: { cmd: 'ls' }, toolResponse: 'a.ts', toolUseId: 'call_1', cwd: '/Users/me/proj',
    });

    expect(await drainHookSpool(spool)).toEqual({ drained: 2, retained: 0, quarantined: 0, expired: 0 });
    const sessionDbId = store.findSessionDbIdByContentSessionId('wire-s', 'codex');
    expect(countRows('user_prompts')).toBe(1);
    expect(sessionManager.initializeSession).toHaveBeenCalledWith(sessionDbId, 'list the files', 1, 'proj');
    expect(sessionManager.queueObservation.mock.calls[0][1]).toMatchObject({ toolUseId: 'call_1', prompt_number: 1 });

    // Re-spooled after it drained (a producer restart): the native id makes it a duplicate.
    spool.enqueue('session_init', { contentSessionId: 'wire-s', platformSource: 'codex', prompt: 'list the files', nativePromptId: 'turn-1', cwd: '/Users/me/proj' });
    await drainHookSpool(spool);
    expect(countRows('user_prompts')).toBe(1);
  });

  it('an init that conflicts with a saved prompt (same native id, other words) is dropped, not retried forever', async () => {
    const spool = new HookSpool(join(spoolDir, 'spool'));
    spool.enqueue('session_init', { contentSessionId: 'wire-c', platformSource: 'codex', prompt: 'first words', nativePromptId: 'turn-1' });
    await drainHookSpool(spool);
    spool.enqueue('session_init', { contentSessionId: 'wire-c', platformSource: 'codex', prompt: 'other words', nativePromptId: 'turn-1' });
    expect(await drainHookSpool(spool)).toEqual({ drained: 1, retained: 0, quarantined: 0, expired: 0 });
    expect(countRows('user_prompts')).toBe(1);
  });

  it('ingestSessionInit reports a private prompt and an internal payload without saving a prompt', async () => {
    expect(await ingestSessionInit({ contentSessionId: 'p', platformSource: 'codex', prompt: '<private>secret</private>' }))
      .toMatchObject({ status: 'skipped', reason: 'private' });
    expect(countRows('user_prompts')).toBe(0);
  });
});

describe('ingest facts the wire gateway relies on', () => {
  it('a tool use already linked to an observation is not queued again; one not linked yet is', async () => {
    const payload = { contentSessionId: 'dup-s', platformSource: 'codex', toolName: 'shell', toolInput: { cmd: 'ls' }, toolResponse: 'a', toolUseId: 'call_dup', cwd: '/Users/me/proj' };
    expect(await ingestObservation(payload)).toMatchObject({ ok: true });
    // Not linked yet (the generation may have been lost): a replay is queued.
    expect(await ingestObservation(payload)).toMatchObject({ ok: true });
    expect(sessionManager.queueObservation).toHaveBeenCalledTimes(2);

    store.linkToolUsesToObservation({ contentSessionId: 'dup-s', toolUseIds: ['call_dup'], observationId: 7 });
    expect(await ingestObservation(payload)).toEqual({ ok: true, status: 'skipped', reason: 'tool_use_already_observed' });
    expect(sessionManager.queueObservation).toHaveBeenCalledTimes(2);
    expect(countRows('tool_uses')).toBe(1);
  });

  it('an observation for an unknown session registers the session instead of being dropped', async () => {
    const result = await ingestObservation({ contentSessionId: 'never-initialized', platformSource: 'codex', toolName: 'shell', toolUseId: 'call_x', cwd: '/Users/me/proj' });
    expect(result).toMatchObject({ ok: true });
    expect(store.findSessionDbIdByContentSessionId('never-initialized', 'codex')).not.toBeNull();
    expect(sessionManager.queueObservation.mock.calls[0][1]).toMatchObject({ prompt_number: 0 });
  });

  it('an explicit project files an observation that has no cwd; a cwd still wins', async () => {
    await ingestObservation({ contentSessionId: 'unattributed-s', platformSource: 'codex', toolName: 'shell', toolUseId: 'call_u', project: 'codex-unattributed' });
    const project = (contentSessionId: string) => (store.db.prepare('SELECT project FROM sdk_sessions WHERE content_session_id = ?').get(contentSessionId) as { project: string }).project;
    expect(project('unattributed-s')).toBe('codex-unattributed');

    await ingestObservation({ contentSessionId: 'attributed-s', platformSource: 'codex', toolName: 'shell', toolUseId: 'call_a', cwd: '/Users/me/proj', project: 'codex-unattributed' });
    expect(project('attributed-s')).toBe('proj');
  });
});
