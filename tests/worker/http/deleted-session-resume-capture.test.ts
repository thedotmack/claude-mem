// A session the user deleted in the viewer keeps out everything from before
// the deletion, but a resumed conversation's new work is captured again
// (follow-up to #5321, whose tombstone blocked the content session id forever).
// Hook path: the hooks' request bodies against the real worker routes,
// SessionManager and SessionStore, over HTTP.
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';
import { deleteSessionLikeTheViewer, startCaptureWorker, type CaptureWorker } from '../../helpers/deleted-session-capture-fixture.js';

const CONTENT_SESSION = 'resumed-conversation';

describe('a deleted session on the hook path', () => {
  let dir: string;
  let worker: CaptureWorker;
  let store: SessionStore;
  let generatorStarts: string[];

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'cmem-deleted-resume-'));
    worker = await startCaptureWorker();
    store = worker.store;
    generatorStarts = worker.generatorStarts;
  });

  afterEach(async () => {
    await worker.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const post = (route: string, body: object) => worker.post(route, body);
  // The UserPromptSubmit hook's init body, stamped with the hook's clock
  // (tests/cli/handlers/session-init-event-time.test.ts pins that the hook sends it).
  const hookPrompt = (prompt: string) => post('init', {
    contentSessionId: CONTENT_SESSION, project: 'resume-project', prompt, platformSource: 'claude',
    cwd: dir, eventOccurredAtEpochMs: Date.now(),
  });
  // The PostToolUse hook's live handoff body, stamped with the hook's clock.
  const hookToolUse = (toolUseId: string, eventOccurredAtEpochMs?: number | null) => post('observations', {
    contentSessionId: CONTENT_SESSION, platformSource: 'claude', tool_name: 'Read',
    tool_input: { file_path: join(dir, `${toolUseId}.ts`) }, tool_response: `contents of ${toolUseId}`,
    cwd: dir, tool_use_id: toolUseId, enqueuedAtEpochMs: Date.now(),
    ...(eventOccurredAtEpochMs === undefined ? {} : { eventOccurredAtEpochMs }),
  });
  const sessionRows = () => worker.sessionRows(CONTENT_SESSION);
  const toolUseIds = () => worker.toolUseIds(CONTENT_SESSION);
  const promptTexts = () => worker.promptTexts(CONTENT_SESSION);
  const deletionSkipsLogged = () => worker.deletionSkipsLogged();

  /** A live conversation the user then deletes in the viewer; returns a time from before the deletion. */
  async function liveConversationThenDeleted(): Promise<number> {
    const beforeDeletion = Date.now();
    await hookPrompt('first prompt, before the deletion');
    expect(await hookToolUse('toolu_before', beforeDeletion)).toEqual({ status: 'queued' });
    deleteSessionLikeTheViewer(store, 'claude', CONTENT_SESSION);
    expect(sessionRows()).toHaveLength(0);
    // A resumed conversation's next turn comes later than the deletion.
    await Bun.sleep(5);
    return beforeDeletion;
  }

  it('captures a resumed conversation\'s new prompt, tool use and observation after the session was deleted', async () => {
    await liveConversationThenDeleted();
    const startsBeforeResume = generatorStarts.length;

    await hookPrompt('resumed prompt, after the deletion');
    expect(sessionRows()).toHaveLength(1);
    expect(promptTexts()).toEqual(['resumed prompt, after the deletion']);

    expect(await hookToolUse('toolu_after', Date.now())).toEqual({ status: 'queued' });
    // A host that posts live without a source time is taken as now.
    expect(await hookToolUse('toolu_live_host')).toEqual({ status: 'queued' });
    expect(toolUseIds()).toEqual(['toolu_after', 'toolu_live_host']);
    // New live work reaches the observer the normal way, through a live start.
    expect(generatorStarts.slice(startsBeforeResume)).toContain('observation');

    // The recreated session takes its end-of-turn summary again.
    expect(await post('summarize', {
      contentSessionId: CONTENT_SESSION, platformSource: 'claude',
      last_assistant_message: 'resumed turn done', cwd: dir, enqueuedAtEpochMs: Date.now(),
    })).toEqual({ status: 'queued' });
  });

  it('keeps content from before the deletion out, even after the resumed conversation recreated the session', async () => {
    const beforeDeletion = await liveConversationThenDeleted();

    // A delayed handoff of a tool use that happened before the deletion.
    expect(await hookToolUse('toolu_late_old', beforeDeletion)).toEqual({ status: 'skipped', reason: 'session_deleted' });
    expect(sessionRows()).toHaveLength(0);

    await hookPrompt('resumed prompt, after the deletion');
    expect(await hookToolUse('toolu_after', Date.now())).toEqual({ status: 'queued' });
    const startsAfterResume = generatorStarts.length;

    // The session exists again, and old content still stays out: a stale
    // tool use, a stale prompt, and anything that cannot prove its time.
    expect(await hookToolUse('toolu_late_old_2', beforeDeletion)).toEqual({ status: 'skipped', reason: 'session_deleted' });
    expect(await hookToolUse('toolu_no_source_time', null)).toEqual({ status: 'skipped', reason: 'session_deleted' });
    expect(await post('init', {
      contentSessionId: CONTENT_SESSION, platformSource: 'claude', project: 'p', cwd: dir,
      prompt: 'stale prompt from before the deletion', eventOccurredAtEpochMs: beforeDeletion,
    })).toEqual({ skipped: true, reason: 'session_deleted' });

    expect(toolUseIds()).toEqual(['toolu_after']);
    expect(promptTexts()).toEqual(['resumed prompt, after the deletion']);
    // Nothing old was queued or started provider work.
    expect(generatorStarts.length).toBe(startsAfterResume);
    // Every skip says why.
    expect(deletionSkipsLogged().length).toBeGreaterThanOrEqual(4);
  });
});

describe('SessionStore deletion cutoff', () => {
  let store: SessionStore;
  beforeEach(() => { store = new SessionStore(new Database(':memory:')); });
  afterEach(() => store.close());

  it('lets only a session recreated after the deletion hold rows, and moves the cutoff on a second deletion', async () => {
    const oldId = store.createSDKSession('c', 'p', '', undefined, 'claude');
    store.updateMemorySessionId(oldId, 'memory-old');
    deleteSessionLikeTheViewer(store, 'claude', 'c');
    const firstDeletion = store.getSessionDeletedAtEpochMs('claude', 'c')!;
    await Bun.sleep(5);

    // No source time, or one not after the deletion: still deleted.
    expect(() => store.createSDKSession('c', 'p', '', undefined, 'claude')).toThrow('session_deleted');
    expect(() => store.createSDKSession('c', 'p', '', undefined, 'claude', firstDeletion)).toThrow('session_deleted');
    // A raw insert dated before the deletion is refused by the trigger.
    expect(() => store.db.prepare(`
      INSERT INTO sdk_sessions (content_session_id, project, platform_source, started_at, started_at_epoch, status)
      VALUES ('c', 'p', 'claude', '2026-07-20T00:00:00.000Z', ?, 'active')
    `).run(firstDeletion)).toThrow('session_deleted');

    const newId = store.createSDKSession('c', 'p', '', undefined, 'claude', Date.now());
    expect(newId).toBeGreaterThan(oldId);
    // The recreated row records its own new memory session, never the deleted one.
    store.updateMemorySessionId(newId, 'memory-new');
    expect(() => store.updateMemorySessionId(newId, 'memory-old')).toThrow('session_deleted');
    // Raw tool data needs the recreated row; the deleted row's id stays refused.
    expect(store.upsertToolUse({
      toolUseId: 'toolu_new', contentSessionId: 'c', sessionDbId: newId, platformSource: 'claude',
      project: 'p', toolName: 'Read', toolInput: '{}',
    })).toBeNumber();
    expect(() => store.upsertToolUse({
      toolUseId: 'toolu_old', contentSessionId: 'c', sessionDbId: oldId, platformSource: 'claude',
      project: 'p', toolName: 'Read', toolInput: '{}',
    })).toThrow('session_deleted');

    const betweenDeletions = Date.now();
    await Bun.sleep(5);
    deleteSessionLikeTheViewer(store, 'claude', 'c');
    expect(store.getSessionDeletedAtEpochMs('claude', 'c')!).toBeGreaterThan(firstDeletion);
    expect(store.isBeforeSessionDeletion('claude', 'c', betweenDeletions)).toBe(true);
    expect(() => store.createSDKSession('c', 'p', '', undefined, 'claude', betweenDeletions)).toThrow('session_deleted');
  });
});
