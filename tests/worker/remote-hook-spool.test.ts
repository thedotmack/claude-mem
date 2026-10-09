import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import express from 'express';
import type { Server } from 'http';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'fs';
import * as filesystem from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';
import { HookSpoolRoutes } from '../../src/services/worker/http/routes/HookSpoolRoutes.js';
import { hookSpoolConsumedMarkers } from '../../src/services/worker/hook-spool-drain.js';
import { HookSpool, HOOK_SPOOL_RETRY_WINDOW_MS, remoteHookSpoolReceipt, remoteHookSpoolReceivedKey, type HookSpoolEntry } from '../../src/shared/hook-spool.js';
import { remoteSpoolEnvelopeSchema, usesRemoteHookSpool, remoteHookSpoolToken } from '../../src/shared/hook-spool-remote.js';

let directory: string;
let store: SessionStore;
let spool: HookSpool;
let server: Server;
let address: string;
let token: string;
let drains: number;
const entry: HookSpoolEntry = {
  kind: 'observation', enqueuedAtEpochMs: 1700000000000,
  payload: { contentSessionId: 'remote-session', platformSource: 'codex',
    toolName: 'exec_command', toolInput: { cmd: 'read fixture' }, toolResponse: 'routing fixture',
    toolUseId: 'host-tool-1', cwd: '/repo' },
};

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'claude-mem-remote-spool-'));
  store = new SessionStore(join(directory, 'worker.db'));
  spool = new HookSpool(join(directory, 'server-spool'));
  token = 'test-ingest-token';
  drains = 0;
  const app = express();
  app.use(express.json({ limit: '5mb' }));
  new HookSpoolRoutes(spool, () => hookSpoolConsumedMarkers(store), () => { drains++; }, () => token).setupRoutes(app);
  server = await new Promise<Server>(resolve => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  const bound = server.address();
  if (!bound || typeof bound === 'string') throw new Error('server did not bind');
  address = `http://127.0.0.1:${bound.port}/api/spool/ingest`;
});

afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
  store.close();
  Bun.gc(true);
  rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

function send(value: unknown = entry, authorization: string = 'Bearer test-ingest-token') {
  return fetch(address, { method: 'POST', headers: {
    'Content-Type': 'application/json', Authorization: authorization,
  }, body: JSON.stringify({ protocolVersion: 1, entry: value }) });
}

describe('remote hook spool receipts', () => {
  it('acknowledges the exact event only after it is in the server spool', async () => {
    const response = await send();
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ protocolVersion: 1, status: 'accepted', receipt: remoteHookSpoolReceipt(entry) });
    expect(spool.entries()).toEqual([entry]);
    expect(drains).toBe(1);
    const filename = readdirSync(spool.directory)[0];
    expect(JSON.parse(readFileSync(join(spool.directory, filename), 'utf8')).enqueuedAtEpochMs).toBe(entry.enqueuedAtEpochMs);
  });

  it('keeps a consumed remote receipt across restart and returns it after a lost ACK', async () => {
    await send();
    let ingested = 0;
    await spool.drain((_entry, mark) => { ingested++; mark(); return true; }, hookSpoolConsumedMarkers(store));
    expect(spool.entries()).toEqual([]);
    expect(store.isHookSpoolEntryConsumed(remoteHookSpoolReceipt(entry))).toBe(true);
    store.close();
    store = new SessionStore(join(directory, 'worker.db'));
    const retried = await send();
    expect(retried.status).toBe(202);
    expect((await retried.json()).receipt).toBe(remoteHookSpoolReceipt(entry));
    await spool.drain(() => { ingested++; return true; }, hookSpoolConsumedMarkers(store));
    expect(ingested).toBe(1);
    expect(spool.entries()).toEqual([]);
  });

  it('deduplicates repeated pending deliveries before ingest', async () => {
    await Promise.all([send(), send(), send()]);
    expect(spool.entries()).toEqual([entry]);
  });

  it('retains transport receipt protection even when the later ingest marker write fails', async () => {
    await send();
    const mark = store.markHookSpoolEntryConsumed.bind(store);
    const failure = spyOn(store, 'markHookSpoolEntryConsumed').mockImplementation((key, at) => {
      if (key.startsWith('remote_')) throw new Error('ingest marker write failed');
      mark(key, at);
    });
    let ingested = 0;
    try {
      await spool.drain((_entry, handedOff) => { ingested++; handedOff(); return true; }, hookSpoolConsumedMarkers(store));
      expect(store.isHookSpoolEntryConsumed(remoteHookSpoolReceivedKey(remoteHookSpoolReceipt(entry)))).toBe(true);
      expect((await send()).status).toBe(202);
      await spool.drain(() => { ingested++; return true; }, hookSpoolConsumedMarkers(store));
      expect(ingested).toBe(1);
    } finally { failure.mockRestore(); }
  });

  it('does not acknowledge a failed transport receipt commit', async () => {
    const failure = spyOn(store, 'markHookSpoolEntryConsumed').mockImplementation(() => { throw new Error('receipt commit failed'); });
    try {
      expect((await send()).status).toBe(500);
      expect(spool.entries()).toEqual([entry]);
      expect(drains).toBe(0);
    } finally { failure.mockRestore(); }
  });

  it('retains a remote receipt when a crash leaves the already-consumed spool file', async () => {
    await send();
    store.markHookSpoolEntryConsumed(remoteHookSpoolReceipt(entry), Date.now());
    let ingested = 0;
    expect((await spool.drain(() => { ingested++; return true; }, hookSpoolConsumedMarkers(store))).drained).toBe(1);
    expect(ingested).toBe(0);
    expect(store.isHookSpoolEntryConsumed(remoteHookSpoolReceipt(entry))).toBe(true);
  });

  it('prunes remote receipts using the existing retry window', async () => {
    store.markHookSpoolEntryConsumed(remoteHookSpoolReceipt(entry), Date.now() - HOOK_SPOOL_RETRY_WINDOW_MS - 1);
    await spool.drain(() => true, hookSpoolConsumedMarkers(store));
    expect(store.isHookSpoolEntryConsumed(remoteHookSpoolReceipt(entry))).toBe(false);
  });

  it('rejects unauthenticated requests without writing or draining', async () => {
    expect((await send(entry, '')).status).toBe(401);
    expect((await send(entry, 'Bearer another-token')).status).toBe(401);
    expect(spool.entries()).toEqual([]);
    expect(drains).toBe(0);
  });

  it('is disabled until the worker has an ingest token', async () => {
    token = '';
    expect((await send()).status).toBe(503);
    expect(spool.entries()).toEqual([]);
  });

  it('does not acknowledge a failed durable write', async () => {
    const failure = spyOn(spool, 'enqueueRemote').mockImplementation(() => { throw new Error('disk full'); });
    try {
      expect((await send()).status).toBe(500);
      expect(spool.entries()).toEqual([]);
      expect(drains).toBe(0);
    } finally { failure.mockRestore(); }
  });

  it('validates every spool kind and rejects malformed payloads', async () => {
    for (const invalid of [
      { ...entry, kind: 'unknown' },
      { ...entry, payload: { ...entry.payload, platformSource: 12 } },
      { ...entry, payload: { ...entry.payload, contentSessionId: '' } },
      { ...entry, payload: { ...entry.payload, toolName: null } },
      { ...entry, enqueuedAtEpochMs: -1 },
      { kind: 'summarize', payload: { contentSessionId: 's', platformSource: 'claude' }, enqueuedAtEpochMs: 1 },
      { kind: 'advisor_calls', payload: { contentSessionId: 's', platformSource: 'claude', calls: [] }, enqueuedAtEpochMs: 1 },
    ]) expect((await send(invalid)).status).toBe(400);
    expect(spool.entries()).toEqual([]);
    expect(drains).toBe(0);
  });

  it('accepts summaries, ends, file edits and advisor calls without caller-selected paths', async () => {
    const common = { contentSessionId: 'other-session', platformSource: 'claude' };
    const entries = [
      { kind: 'file_edit', payload: { ...entry.payload }, enqueuedAtEpochMs: 10 },
      { kind: 'summarize', payload: { ...common, lastAssistantMessage: 'done' }, enqueuedAtEpochMs: 11 },
      { kind: 'session_end', payload: common, enqueuedAtEpochMs: 12 },
      { kind: 'advisor_calls', payload: { ...common, calls: [{ toolUseId: 'advisor-1', advice: 'keep the queue', occurredAtEpoch: 13 }] }, enqueuedAtEpochMs: 13 },
    ];
    for (const value of entries) expect((await send(value)).status).toBe(202);
    expect(spool.entries()).toHaveLength(4);
    expect(remoteSpoolEnvelopeSchema.safeParse({ protocolVersion: 1, entry, filename: '../outside.json' }).success).toBe(false);
  });

  it('does not remove a concurrently replaced client event after an older receipt', async () => {
    const client = new HookSpool(join(directory, 'client-spool'));
    const original = client.enqueue('observation', entry.payload);
    const result = await client.drain(() => {
      client.enqueue('observation', { ...entry.payload, toolResponse: 'new result' });
      return true;
    }, undefined, { verifyUnchanged: true });
    expect(result.retained).toBe(1);
    expect(client.entries()[0].payload).toMatchObject({ toolResponse: 'new result' });
    expect(readFileSync(original, 'utf8')).toContain('new result');
  });

  it('keeps both unacknowledged replacements when the original path is recreated during restore', async () => {
    const client = new HookSpool(join(directory, 'client-spool'));
    client.enqueue('observation', entry.payload);
    const link = filesystem.linkSync;
    const race = spyOn(filesystem, 'linkSync').mockImplementation((source, destination) => {
      client.enqueue('observation', { ...entry.payload, toolResponse: 'replacement C' });
      link(source, destination);
    });
    try {
      await client.drain(() => {
        client.enqueue('observation', { ...entry.payload, toolResponse: 'replacement B' });
        return true;
      }, undefined, { verifyUnchanged: true });
      expect(client.entries().map(e => (e.payload as { toolResponse: unknown }).toolResponse).sort())
        .toEqual(['replacement B', 'replacement C']);
    } finally { race.mockRestore(); }
  });

  it('removes an unchanged acknowledged client file', async () => {
    const client = new HookSpool(join(directory, 'client-spool'));
    client.enqueue('observation', entry.payload);
    expect((await client.drain(() => true, undefined, { verifyUnchanged: true })).drained).toBe(1);
    expect(client.entries()).toEqual([]);
  });

  it('stops at the transport budget without dropping remaining entries', async () => {
    const client = new HookSpool(join(directory, 'client-spool'));
    client.enqueue('observation', entry.payload);
    client.enqueue('session_end', { contentSessionId: 'another', platformSource: 'codex' });
    expect(await client.drain(() => { throw new Error('must not be attempted'); }, undefined,
      { shouldContinue: () => false, verifyUnchanged: true })).toMatchObject({ retained: 2, drained: 0 });
  });
  it('selects the oldest bounded batch while retaining all omitted entries', async () => {
    const client = new HookSpool(join(directory, 'client-spool'));
    for (const time of [30, 10, 20]) client.enqueue('session_end', { contentSessionId: `session-${time}`, platformSource: 'codex' }, time);
    const seen: number[] = [];
    const result = await client.drain(e => { seen.push(e.enqueuedAtEpochMs); return true; }, undefined,
      { maxEntries: 2, verifyUnchanged: true });
    expect(seen).toEqual([10, 20]);
    expect(result).toMatchObject({ drained: 2, retained: 1 });
    expect(client.entries().map(e => e.enqueuedAtEpochMs)).toEqual([30]);
    expect(client.hasEntries()).toBe(true);
    await client.drain(() => true);
    expect(client.hasEntries()).toBe(false);
  });
});

describe('worker spool transport selection', () => {
  it('keeps loopback and bind-all workers on filesystem delivery', () => {
    for (const host of ['localhost', '127.0.0.1', '127.0.0.2', '127.1', '0:0:0:0:0:0:0:1', '::1', '[::1]', '::ffff:127.0.0.1', '::ffff:7f00:1', '0.0.0.0', '::']) {
      expect(usesRemoteHookSpool(host)).toBe(false);
    }
  });
  it('uploads to remote workers and supports explicit loopback port forwarding', () => {
    expect(usesRemoteHookSpool('worker.internal')).toBe(true);
    expect(usesRemoteHookSpool('192.0.2.10')).toBe(true);
    expect(usesRemoteHookSpool('127.0.0.1', 'http')).toBe(true);
    expect(usesRemoteHookSpool('worker.internal', 'filesystem')).toBe(false);
    expect(usesRemoteHookSpool('127.0.0.1', ' HTTP ')).toBe(true);
  });
  it('refuses token values that cannot safely be placed in an HTTP header', () => {
    expect(remoteHookSpoolToken(' token ')).toBe('token');
    for (const value of ['token\nheader', 'token\rheader', 'token\0', 'x'.repeat(1025), null, 42]) {
      expect(remoteHookSpoolToken(value)).toBe('');
    }
  });
});
