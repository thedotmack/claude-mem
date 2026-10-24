import { afterAll, afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { Database } from 'bun:sqlite';
import { readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { gzipSync } from 'zlib';
import { WIRE_GATEWAY_DIR } from '../../src/shared/paths.js';
import { HookSpool, type HookSpoolEntry } from '../../src/shared/hook-spool.js';
import { SettingsDefaultsManager } from '../../src/shared/SettingsDefaultsManager.js';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';
import { setIngestContext } from '../../src/services/worker/http/shared.js';
import { drainHookSpool } from '../../src/services/worker/hook-spool-drain.js';
import {
  PUSH_MAX_EVENTS,
  createHookSpoolPushEventSpool,
  parsePushBody,
  PushEventLedger,
  PushValidationError,
} from '../../src/services/wire-gateway/ingest/push-events.js';
import { logger } from '../../src/utils/logger.js';
import { startWireGatewayForTest, type StartedWireGateway } from './helpers/start-wire-gateway.js';

// Plan Phase 13 task 1: POST /v1/claude-mem/events. Verification: push
// validation and dedupe (the same eventId twice → one row).

const testRoot = join(WIRE_GATEWAY_DIR, 'ways-in-push-test');
const spoolDirectory = join(testRoot, 'hook-spool');
const ledgerFilePath = join(testRoot, 'push-events.jsonl');

let spool: HookSpool;
let store: SessionStore;
let nudges = 0;
const spies: Array<ReturnType<typeof spyOn>> = [];

async function startPushGateway(ledgerPath: string = ledgerFilePath): Promise<StartedWireGateway> {
  return startWireGatewayForTest({
    ingest: { pushSpool: createHookSpoolPushEventSpool({ spool, nudgeWorker: () => { nudges++; } }), pushLedgerFilePath: ledgerPath },
  });
}

async function push(gateway: StartedWireGateway, body: unknown, headers: Record<string, string> = {}): Promise<{ status: number; json: any }> {
  const response = await fetch(`${gateway.baseUrl}/v1/claude-mem/events`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' || body instanceof Uint8Array ? body : JSON.stringify(body),
  });
  return { status: response.status, json: await response.json() };
}

function spooled(kind?: HookSpoolEntry['kind']): HookSpoolEntry[] {
  const entries = spool.entries();
  return kind ? entries.filter(entry => entry.kind === kind) : entries;
}

function countRows(table: string): number {
  return (store.db.prepare(`SELECT COUNT(*) AS rowCount FROM ${table}`).get() as { rowCount: number }).rowCount;
}

const sessionInit = { eventId: 'ev-init-1', kind: 'session_init', platformSource: 'my-tool', contentSessionId: 'push-session-1', prompt: 'refactor the parser', cwd: '/Users/me/proj' };
const observation = { eventId: 'ev-obs-1', kind: 'observation', platformSource: 'my-tool', contentSessionId: 'push-session-1', toolName: 'Read', toolInput: { path: 'a.ts' }, toolResponse: 'export const a = 1;', cwd: '/Users/me/proj' };
const summarize = { eventId: 'ev-sum-1', kind: 'summarize', platformSource: 'my-tool', contentSessionId: 'push-session-1', lastAssistantMessage: 'Done.' };
const sessionEnd = { eventId: 'ev-end-1', kind: 'session_end', platformSource: 'my-tool', contentSessionId: 'push-session-1' };

beforeEach(() => {
  rmSync(testRoot, { recursive: true, force: true });
  spool = new HookSpool(spoolDirectory);
  nudges = 0;
  spies.push(
    spyOn(SettingsDefaultsManager, 'loadFromFile').mockImplementation(() => SettingsDefaultsManager.getAllDefaults()),
    spyOn(logger, 'debug').mockImplementation(() => {}),
    spyOn(logger, 'info').mockImplementation(() => {}),
  );
  store = new SessionStore(new Database(':memory:'));
  setIngestContext({
    sessionManager: {
      queueObservation: mock(() => {}),
      queueSummarize: mock(() => {}),
      requestSessionWrapup: mock(async () => {}),
      getSession: mock(() => undefined),
      initializeSession: mock((_sessionDbId: number, _prompt: string, _promptNumber: number, project: string) => ({ project })),
    } as any,
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
});

afterAll(() => {
  rmSync(testRoot, { recursive: true, force: true });
});

describe('push endpoint validation (all or nothing)', () => {
  it('parses one event or an array, with exactly the spool payload fields', () => {
    const [one] = parsePushBody(JSON.stringify(observation));
    expect(one).toEqual({
      eventId: 'ev-obs-1', kind: 'observation',
      payload: { platformSource: 'my-tool', contentSessionId: 'push-session-1', toolName: 'Read', toolInput: { path: 'a.ts' }, toolResponse: 'export const a = 1;', cwd: '/Users/me/proj' },
    });
    expect(parsePushBody(JSON.stringify([sessionInit, summarize, sessionEnd])).map(event => event.kind)).toEqual(['session_init', 'summarize', 'session_end']);
  });

  const invalid: Array<[string, unknown, number | null, string]> = [
    ['an empty array', [], null, 'body'],
    ['a primitive', 5, null, 'body'],
    ['an array holding a primitive', [5], 0, 'event'],
    ['an unknown kind', { ...observation, kind: 'file_edit' }, 0, 'kind'],
    ['no eventId', { ...observation, eventId: undefined }, 0, 'eventId'],
    ['an eventId over 128 characters', { ...observation, eventId: 'x'.repeat(129) }, 0, 'eventId'],
    ['an eventId with a control character', { ...observation, eventId: 'a\nb' }, 0, 'eventId'],
    ['no contentSessionId', { ...observation, contentSessionId: '' }, 0, 'contentSessionId'],
    ['an observation without toolName', { ...observation, toolName: undefined }, 0, 'toolName'],
    ['a field of another kind', { ...sessionEnd, prompt: 'hi' }, 0, 'prompt'],
    ['a summarize without lastAssistantMessage', { ...summarize, lastAssistantMessage: undefined }, 0, 'lastAssistantMessage'],
    ['a nativePromptId with whitespace', { ...sessionInit, nativePromptId: 'a b' }, 0, 'nativePromptId'],
    // Inherited names are no fields (P3-1).
    ['an inherited name (toString) as a field', { ...sessionEnd, toString: 'x' }, 0, 'toString'],
    ['an inherited name (constructor) as a field', { ...sessionEnd, constructor: 'x' }, 0, 'constructor'],
    ['an inherited name (hasOwnProperty) as a field', { ...observation, hasOwnProperty: 'x' }, 0, 'hasOwnProperty'],
  ];
  for (const [label, body, index, field] of invalid) {
    it(`refuses ${label}, naming the field${index === null ? '' : ' and index'}`, () => {
      let caught: unknown;
      try {
        parsePushBody(JSON.stringify(body));
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(PushValidationError);
      expect((caught as PushValidationError).index).toBe(index);
      expect((caught as PushValidationError).field).toBe(field);
    });
  }

  it(`refuses more than ${PUSH_MAX_EVENTS} events a post`, () => {
    const many = Array.from({ length: PUSH_MAX_EVENTS + 1 }, (_, index) => ({ ...sessionEnd, eventId: `e${index}` }));
    expect(() => parsePushBody(JSON.stringify(many))).toThrow(`send at most ${PUSH_MAX_EVENTS} a post`);
  });

  it('answers 400 {error:{message, index}} and spools nothing of a batch with one bad event', async () => {
    const gateway = await startPushGateway();
    try {
      const answer = await push(gateway, [sessionInit, observation, { ...summarize, lastAssistantMessage: 7 }]);
      expect(answer.status).toBe(400);
      expect(answer.json.error.index).toBe(2);
      expect(answer.json.error.param).toBe('lastAssistantMessage');
      expect(answer.json.error.message).toContain('event 2');
      expect(spooled()).toEqual([]);
    } finally {
      await gateway.stop();
    }
  });

  it('answers 415 without application/json, and 413 over 32 MiB', async () => {
    const gateway = await startPushGateway();
    try {
      expect((await push(gateway, JSON.stringify(observation), { 'content-type': 'text/plain' })).status).toBe(415);
      const tooBig = await push(gateway, `[${' '.repeat(32 * 1024 * 1024)}]`);
      expect(tooBig.status).toBe(413);
      expect(tooBig.json.error.message).toContain('5000 events');
      expect(spooled()).toEqual([]);
    } finally {
      await gateway.stop();
    }
  });
});

describe('push endpoint spooling and dedupe', () => {
  it('spools each event, scrubbed, under its (derived) ids, and nudges the worker', async () => {
    const gateway = await startPushGateway();
    try {
      const secretObservation = { ...observation, eventId: 'ev-obs-secret', toolResponse: 'key sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJ' };
      const answer = await push(gateway, [sessionInit, secretObservation, summarize, sessionEnd]);
      expect(answer.status).toBe(200);
      expect(answer.json).toEqual({
        accepted: 4, skipped: 0,
        records: [
          { index: 0, eventId: 'ev-init-1', status: 'accepted' },
          { index: 1, eventId: 'ev-obs-secret', status: 'accepted' },
          { index: 2, eventId: 'ev-sum-1', status: 'accepted' },
          { index: 3, eventId: 'ev-end-1', status: 'accepted' },
        ],
      });
      expect(nudges).toBe(4);
      const [observed] = spooled('observation');
      expect(String(observed.payload.toolResponse)).not.toContain('sk-ant-api03');
      expect(String(observed.payload.toolResponse)).toContain('[REDACTED');
      // No toolUseId was sent: one derived from the event id, so the worker keeps one row.
      expect((observed.payload as { toolUseId?: string }).toolUseId).toMatch(/^push-[0-9a-f]{32}$/);
      const [init] = spooled('session_init');
      expect((init.payload as { nativePromptId?: string }).nativePromptId).toMatch(/^push-[0-9a-f]{32}$/);
      expect(spooled()).toHaveLength(4);
    } finally {
      await gateway.stop();
    }
  });

  it('the same eventId twice → one spool entry and one row, across posts, a drain and a restart', async () => {
    let gateway = await startPushGateway();
    try {
      expect((await push(gateway, [sessionInit, observation])).json.accepted).toBe(2);
      // In the same post, and in a later post: skipped.
      const again = await push(gateway, [observation, observation]);
      expect(again.json).toEqual({ accepted: 0, skipped: 2, records: [
        { index: 0, eventId: 'ev-obs-1', status: 'skipped' },
        { index: 1, eventId: 'ev-obs-1', status: 'skipped' },
      ] });
      expect(spooled('observation')).toHaveLength(1);
      const sameIdOtherSession = await push(gateway, { ...observation, contentSessionId: 'push-session-2' });
      expect(sameIdOtherSession.json.accepted).toBe(1);
    } finally {
      await gateway.stop();
    }
    expect(await drainHookSpool(spool)).toEqual({ drained: 3, retained: 0, quarantined: 0, expired: 0 });
    expect(countRows('tool_uses')).toBe(2);
    expect(countRows('user_prompts')).toBe(1);

    // A restart reads the ledger back: still skipped.
    gateway = await startPushGateway();
    try {
      expect((await push(gateway, [sessionInit, observation])).json).toMatchObject({ accepted: 0, skipped: 2 });
    } finally {
      await gateway.stop();
    }
    const ledgerLines = readFileSync(ledgerFilePath, 'utf8').trim().split('\n');
    expect(ledgerLines).toHaveLength(3);

    // Even with the ledger gone, the worker's own ids keep one row.
    gateway = await startPushGateway(join(testRoot, 'fresh-ledger.jsonl'));
    try {
      expect((await push(gateway, [sessionInit, observation])).json.accepted).toBe(2);
    } finally {
      await gateway.stop();
    }
    await drainHookSpool(spool);
    expect(countRows('tool_uses')).toBe(2);
    expect(countRows('user_prompts')).toBe(1);
  });

  it('a new eventId sent twice in one post is accepted once, skipped once', async () => {
    const gateway = await startPushGateway();
    try {
      const fresh = { ...observation, eventId: 'ev-new-twice' };
      expect((await push(gateway, [fresh, fresh])).json).toEqual({ accepted: 1, skipped: 1, records: [
        { index: 0, eventId: 'ev-new-twice', status: 'accepted' },
        { index: 1, eventId: 'ev-new-twice', status: 'skipped' },
      ] });
      expect(spooled('observation')).toHaveLength(1);
      expect(readFileSync(ledgerFilePath, 'utf8').trim().split('\n')).toHaveLength(1);
    } finally {
      await gateway.stop();
    }
  });

  it('a re-sent event (ledger lost) overwrites its own pending spool file', async () => {
    let gateway = await startPushGateway();
    try {
      expect((await push(gateway, [sessionInit, observation, summarize, sessionEnd])).json.accepted).toBe(4);
    } finally {
      await gateway.stop();
    }
    gateway = await startPushGateway(join(testRoot, 'lost-ledger.jsonl'));
    try {
      expect((await push(gateway, [sessionInit, observation, summarize, sessionEnd])).json.accepted).toBe(4);
    } finally {
      await gateway.stop();
    }
    expect(spooled().map(entry => entry.kind).sort()).toEqual(['observation', 'session_end', 'session_init', 'summarize']);
  });

  it('takes a gzip body', async () => {
    const gateway = await startPushGateway();
    try {
      const answer = await push(gateway, gzipSync(Buffer.from(JSON.stringify(sessionEnd))), { 'content-encoding': 'gzip' });
      expect(answer.status).toBe(200);
      expect(answer.json.accepted).toBe(1);
      expect(spooled('session_end')).toHaveLength(1);
    } finally {
      await gateway.stop();
    }
  });
});

describe('push event ledger retention (P3-2)', () => {
  it('forgets expired keys while running and keeps the file within twice the live keys', () => {
    const retentionMs = 1_000;
    let now = 0;
    const filePath = join(testRoot, 'retention-ledger.jsonl');
    const ledger = new PushEventLedger(filePath, retentionMs, () => now);
    const lines = () => readFileSync(filePath, 'utf8').split('\n').filter(line => line !== '').length;
    for (let batch = 0; batch < 50; batch++) {
      now = batch * 600;
      ledger.remember([`a${batch}`, `b${batch}`]);
      // Live keys: this batch and the one before (600 ms ago); older ones are past the 1 s retention.
      expect(ledger.has(`a${batch}`)).toBe(true);
      if (batch >= 2) expect(ledger.has(`a${batch - 2}`)).toBe(false);
      expect(lines()).toBeLessThanOrEqual(2 * 4);
    }
    // A fresh process reads back the live keys only.
    const reloaded = new PushEventLedger(filePath, retentionMs, () => now);
    expect(reloaded.has('a49')).toBe(true);
    expect(reloaded.has('a48')).toBe(true);
    expect(reloaded.has('a47')).toBe(false);
  });
});

describe('push endpoint when the spool and then the ledger fail (P3)', () => {
  it('reports the spool\'s error, says the ledger\'s beside it, and still skips what was spooled', async () => {
    const { createPushEventsHandler } = await import('../../src/services/wire-gateway/ingest/push-events.js');
    const { mkdirSync, writeFileSync } = await import('fs');
    mkdirSync(testRoot, { recursive: true });
    // The ledger's folder is a file: every write to the ledger fails.
    writeFileSync(join(testRoot, 'not-a-folder'), '');
    const ledger = new PushEventLedger(join(testRoot, 'not-a-folder', 'push-events.jsonl'), 24 * 60 * 60 * 1000);
    const enqueued: string[] = [];
    const errors: unknown[][] = [];
    spies.push(spyOn(logger, 'error').mockImplementation((...args: unknown[]) => { errors.push(args); }));
    const handler = createPushEventsHandler({
      ledger,
      spool: { enqueue: event => { if (event.eventId === observation.eventId) throw new Error('disk full'); enqueued.push(event.eventId); } },
    });
    const post = (body: unknown) => handler(new Request('http://127.0.0.1/v1/claude-mem/events', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }));
    const response = await post([sessionInit, observation]);
    expect(response.status).toBe(500);
    const json = await response.json() as { error: { message: string; ledgerError?: string; accepted: number } };
    expect(json.error.message).toContain('event 1 could not be spooled: disk full');
    expect(json.error.ledgerError).toContain('could not be written to the ledger file');
    expect(json.error.accepted).toBe(1);
    expect(errors.map(args => String(args[1]))).toEqual([
      'A pushed event could not be spooled',
      'The accepted push events could not be written to the ledger file; this gateway still skips them until it restarts',
    ]);
    // What was spooled is remembered: sent again, it is skipped, not spooled twice.
    const again = await (await post([sessionInit])).json() as { accepted: number; skipped: number };
    expect(again).toMatchObject({ accepted: 0, skipped: 1 });
    expect(enqueued).toEqual([sessionInit.eventId]);
  });
});
