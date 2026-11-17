// Finish Setup's "Stop import" (plan Phase 8, E9): after Stop no request to cmem.ai's /api/import starts, what cmem.ai
// already acknowledged stays counted and stays there, nothing is deleted, and only an explicit start sends again.
import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';
import { HISTORY_IMPORT_BATCH, HistoryImport, type HistoryImportState } from '../../../src/services/setup/history-import.js';
import { HISTORY_IMPORT_RUN_STATES, historyImportRunning } from '../../../src/shared/setup-funnel.js';
import { logger } from '../../../src/utils/logger.js';

let store: SessionStore;
beforeEach(() => { store = new SessionStore(':memory:'); });
afterEach(() => store.close());

function seed(count: number) {
  const id = store.createSDKSession('c-stop', 'stop', 'prompt');
  store.updateMemorySessionId(id, 'm-stop');
  for (let index = 0; index < count; index++) {
    store.storeObservation('m-stop', 'stop', { type: 'discovery', title: `stop ${index}`, subtitle: null, facts: [], narrative: `narrative ${index}`, concepts: [], files_read: [], files_modified: [] }, 1, 0, 1_700_000_000_000 + index);
  }
}
const localRows = () => (store.db.prepare('SELECT COUNT(*) AS rows FROM observations').get() as { rows: number }).rows;

/** A handle the import may close without closing the test store. */
const handle = () => ({ prepare: store.db.prepare.bind(store.db), close() {} }) as never;

/** Every change the import reported, in order. */
const watch = (run: HistoryImport) => { const seen: HistoryImportState[] = []; run.subscribe(state => seen.push(state)); return seen; };

/** Lets every timer and network callback that is due run, so a request that would start after Stop has started. */
const settle = () => new Promise(resolve => setTimeout(resolve, 50));

/**
 * A fake cmem.ai that counts every /api/import request and keeps what it was sent, the way the real one skips rows it
 * already has. `hold` decides, per request number (1-based), whether it answers at once or holds the request open.
 * A held request saves its rows first unless `savesHeld` is false: cmem.ai may or may not write a batch whose answer
 * never reaches the worker.
 */
function fakeCmem({ hold = () => false, honorCancel = true, savesHeld = true }: { hold?: (request: number) => boolean; honorCancel?: boolean; savesHeld?: boolean } = {}) {
  const kept = new Set<string>();
  const requests: Array<{ url: string; count: number; signal: AbortSignal | null | undefined }> = [];
  const held: Array<() => void> = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const titles = (JSON.parse(String(init.body)) as { observations: Array<{ title: string }> }).observations.map(row => row.title);
    requests.push({ url, count: titles.length, signal: init.signal });
    const holding = hold(requests.length);
    let imported = 0;
    if (!holding || savesHeld) for (const title of titles) { if (!kept.has(title)) imported++; kept.add(title); }
    const answer = () => Response.json({ stats: { observationsImported: imported, observationsSkipped: titles.length - imported } });
    if (!holding) return answer();
    return new Promise<Response>((resolve, reject) => {
      held.push(() => resolve(answer()));
      // Like fetch: a cancelled request rejects with the abort reason, whatever the server did with it.
      if (honorCancel) init.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
    });
  }) as unknown as typeof fetch;
  return { kept, requests, held, fetchImpl, imports: () => requests.filter(request => request.url === 'https://cmem.test/api/import').length };
}

describe('history import Stop', () => {
  it('starts no request after Stop while a batch is on its way, keeps the counts received and ends the run at once', async () => {
    const total = HISTORY_IMPORT_BATCH * 3 + 5;
    seed(total);
    const cmem = fakeCmem({ hold: request => request === 2 });
    const run = new HistoryImport({ openDatabase: handle, origin: () => 'https://cmem.test', token: () => 'cm_pro_token', fetch: cmem.fetchImpl });
    const seen = watch(run);
    run.start();
    // The first batch is acknowledged and the second is on its way.
    while (cmem.imports() < 2) await Bun.sleep(1);
    expect(run.state()).toMatchObject({ state: 'running', sent: HISTORY_IMPORT_BATCH, unconfirmed: 0 });

    const stopped = run.stop();
    expect(stopped).toMatchObject({
      state: 'stopped', total, sent: HISTORY_IMPORT_BATCH, imported: HISTORY_IMPORT_BATCH, skipped: 0,
      unconfirmed: HISTORY_IMPORT_BATCH, percent: Math.floor((HISTORY_IMPORT_BATCH / total) * 100), error: null,
    });
    expect(stopped!.finishedAt).toBeString();
    // Over the moment Stop returns: nothing counts it as running any more.
    expect(historyImportRunning(run.state().state)).toBe(false);
    // The request on its way was cancelled.
    expect(cmem.requests[1].signal?.aborted).toBe(true);

    expect(await run.finished()).toEqual(stopped!);
    await settle();
    expect(cmem.imports()).toBe(2);
    expect(run.state()).toEqual(stopped!);
    // The last word was Stop's: the cancelled request did not turn it into a failure.
    expect(seen.at(-1)).toEqual(stopped!);
    expect(seen.some(state => state.state === 'failed' || state.state === 'done')).toBe(false);
    // Nothing was deleted on either side.
    expect(localRows()).toBe(total);
    expect(cmem.kept.size).toBe(HISTORY_IMPORT_BATCH * 2);
  });

  it('ignores an answer that still arrives after Stop, and sends nothing more', async () => {
    seed(HISTORY_IMPORT_BATCH * 2 + 1);
    // A request whose cancel never takes: its answer arrives after Stop, acknowledging the batch.
    const cmem = fakeCmem({ hold: request => request === 1, honorCancel: false });
    const run = new HistoryImport({ openDatabase: handle, origin: () => 'https://cmem.test', token: () => 'cm_pro_token', fetch: cmem.fetchImpl });
    run.start();
    while (cmem.imports() < 1) await Bun.sleep(1);
    const stopped = run.stop()!;
    expect(stopped).toMatchObject({ state: 'stopped', sent: 0, unconfirmed: HISTORY_IMPORT_BATCH });

    cmem.held[0]();
    expect(await run.finished()).toEqual(stopped);
    await settle();
    expect(cmem.imports()).toBe(1);
    expect(run.state()).toEqual(stopped);
  });

  it('says there is nothing to stop when no upload runs, and only an explicit start sends again', async () => {
    seed(HISTORY_IMPORT_BATCH + 20);
    const cmem = fakeCmem({ hold: request => request === 2 });
    const run = new HistoryImport({ openDatabase: handle, origin: () => 'https://cmem.test', token: () => 'cm_pro_token', fetch: cmem.fetchImpl });
    expect(run.stop()).toBeNull();
    expect(run.state().state).toBe('idle');

    run.start();
    while (cmem.imports() < 2) await Bun.sleep(1);
    run.stop();
    expect(run.stop()).toBeNull();
    await run.finished();
    // No timer, retry or later event starts it by itself.
    await settle();
    expect(cmem.imports()).toBe(2);
    expect(run.state().state).toBe('stopped');
    // A worker restart starts with no run and sends nothing.
    const restarted = new HistoryImport({ openDatabase: handle, origin: () => 'https://cmem.test', token: () => 'cm_pro_token', fetch: cmem.fetchImpl });
    await settle();
    expect(restarted.state().state).toBe('idle');
    expect(cmem.imports()).toBe(2);

    // The person's Continue: a new run sends every batch again. cmem.ai skips what it has, including the batch whose
    // answer never came back (the fake saved it), and the memories it had stay.
    run.start();
    const done = await run.finished();
    expect(done).toMatchObject({ state: 'done', total: HISTORY_IMPORT_BATCH + 20, sent: HISTORY_IMPORT_BATCH + 20, unconfirmed: 0, imported: 0, skipped: HISTORY_IMPORT_BATCH + 20, percent: 100, error: null });
    expect(cmem.requests.map(request => request.count)).toEqual([HISTORY_IMPORT_BATCH, 20, HISTORY_IMPORT_BATCH, 20]);
    expect(cmem.kept.size).toBe(HISTORY_IMPORT_BATCH + 20);
    expect(localRows()).toBe(HISTORY_IMPORT_BATCH + 20);
  });

  it('cancels a real request on its way: the server sees nothing after it', async () => {
    seed(HISTORY_IMPORT_BATCH * 2 + 1);
    let received = 0;
    let cancelled!: () => void;
    const cancelledSeen = new Promise<void>(resolve => { cancelled = resolve; });
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
      received++;
      const body = await request.json() as { observations: unknown[] };
      if (received === 1) return Response.json({ stats: { observationsImported: body.observations.length, observationsSkipped: 0 } });
      // The second batch is held open until the worker gives up on it.
      request.signal.addEventListener('abort', cancelled, { once: true });
      return new Promise<Response>(() => {});
    } });
    try {
      const run = new HistoryImport({ openDatabase: handle, origin: () => server.url.origin, token: () => 'cm_pro_token' });
      run.start();
      while (received < 2) await Bun.sleep(1);
      expect(run.stop()).toMatchObject({ state: 'stopped', sent: HISTORY_IMPORT_BATCH, unconfirmed: HISTORY_IMPORT_BATCH });
      expect(await run.finished()).toMatchObject({ state: 'stopped', sent: HISTORY_IMPORT_BATCH });
      // The server saw the connection go away (bounded: 5s is far past a loopback close).
      await Promise.race([cancelledSeen, Bun.sleep(5000).then(() => { throw new Error('the held request was never cancelled'); })]);
      await settle();
      expect(received).toBe(2);
    } finally { server.stop(true); }
  });

  it('counts only `running` as running among the run states of the one definition, so a stopped upload is over', () => {
    expect(HISTORY_IMPORT_RUN_STATES.filter(historyImportRunning)).toEqual(['running']);
  });

  // Finish Setup words its receipt from these numbers (finish-setup-screen.tsx ImportReceipt; the render test words
  // exactly these): the Continue run gets the stopped run's memories back as skipped, so `imported` alone undercounts.
  for (const [label, savesHeld] of [['cmem.ai never saved it', false], ['cmem.ai saved it before the cancel', true]] as const) {
    it(`128 rows, Stop at ${HISTORY_IMPORT_BATCH} sent, then Continue: the stopped run's memories come back as skipped, not imported (the batch on its way: ${label})`, async () => {
      const total = 128;
      const onItsWay = total - HISTORY_IMPORT_BATCH;
      seed(total);
      const cmem = fakeCmem({ hold: request => request === 2, savesHeld });
      const run = new HistoryImport({ openDatabase: handle, origin: () => 'https://cmem.test', token: () => 'cm_pro_token', fetch: cmem.fetchImpl });
      run.start();
      while (cmem.imports() < 2) await Bun.sleep(1);
      expect(run.stop()).toMatchObject({ state: 'stopped', total, sent: HISTORY_IMPORT_BATCH, imported: HISTORY_IMPORT_BATCH, skipped: 0, unconfirmed: onItsWay });
      await run.finished();

      // The person's Continue.
      run.start();
      const done = await run.finished();
      expect(done).toMatchObject({
        state: 'done', total, sent: total, unconfirmed: 0, percent: 100, error: null,
        imported: savesHeld ? 0 : onItsWay, skipped: savesHeld ? total : HISTORY_IMPORT_BATCH,
      });
      // Every memory is in the account once, whatever the receipt's `imported` says.
      expect(cmem.kept.size).toBe(total);
      expect(localRows()).toBe(total);
    });
  }

  it('a Continue sent before a slow cancel settles runs to done, and the old request\'s answer changes nothing', async () => {
    const total = HISTORY_IMPORT_BATCH + 10;
    seed(total);
    // Request 1 ignores the cancel and answers only when released; every later one answers at once.
    const cmem = fakeCmem({ hold: request => request === 1, honorCancel: false });
    const run = new HistoryImport({ openDatabase: handle, origin: () => 'https://cmem.test', token: () => 'cm_pro_token', fetch: cmem.fetchImpl });
    run.start();
    while (cmem.imports() < 1) await Bun.sleep(1);
    expect(run.stop()).toMatchObject({ state: 'stopped', unconfirmed: HISTORY_IMPORT_BATCH });
    // Continue at once: the stopped run's request is still open, and Stop already let go of that run.
    expect(run.start().state).toBe('running');
    const done = await run.finished();
    expect(done).toMatchObject({ state: 'done', total, sent: total, unconfirmed: 0, error: null });
    // The old run's answer lands now.
    cmem.held[0]();
    await settle();
    expect(run.state()).toEqual(done);
    expect(cmem.imports()).toBe(3);
  });
});

describe('history import Stop: what is logged after it', () => {
  /** A cmem.ai whose first request is held until the test says how it ends. */
  function heldRequest() {
    let requests = 0;
    let signal: AbortSignal | undefined;
    let settleHeld!: { resolve: (response: Response) => void; reject: (reason: unknown) => void };
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      requests++;
      signal = init.signal ?? undefined;
      return new Promise<Response>((resolve, reject) => { settleHeld = { resolve, reject }; });
    }) as unknown as typeof fetch;
    return { fetchImpl, requests: () => requests, signal: () => signal!, held: () => settleHeld };
  }
  /** A body that starts and is then cut off by Stop, as a cancelled read fails: with the signal's reason. */
  const cutOffBody = (signal: AbortSignal) => new ReadableStream({ start(controller) {
    controller.enqueue(new TextEncoder().encode('{"stats":'));
    if (signal.aborted) controller.error(signal.reason);
    else signal.addEventListener('abort', () => controller.error(signal.reason), { once: true });
  } });
  const importWarnings = (warn: ReturnType<typeof spyOn>) => warn.mock.calls.filter(([component]) => component === 'IMPORT');

  async function stopWhileHeld(end: (cmem: ReturnType<typeof heldRequest>) => void) {
    seed(HISTORY_IMPORT_BATCH + 1);
    const cmem = heldRequest();
    const run = new HistoryImport({ openDatabase: handle, origin: () => 'https://cmem.test', token: () => 'cm_pro_token', fetch: cmem.fetchImpl });
    run.start();
    while (cmem.requests() < 1) await Bun.sleep(1);
    const stopped = run.stop()!;
    end(cmem);
    expect(await run.finished()).toEqual(stopped);
    await settle();
    expect(cmem.requests()).toBe(1);
  }

  it('stays silent for the cancel itself, on the request and on a body it cut off', async () => {
    const warn = spyOn(logger, 'warn').mockImplementation(() => {});
    try {
      await stopWhileHeld(cmem => cmem.held().reject(cmem.signal().reason));
      store.close(); store = new SessionStore(':memory:');
      await stopWhileHeld(cmem => cmem.held().resolve(new Response(cutOffBody(cmem.signal()), { status: 200 })));
      expect(importWarnings(warn)).toEqual([]);
    } finally { warn.mockRestore(); }
  });

  it('logs any other error that comes after Stop, with its cause', async () => {
    const warn = spyOn(logger, 'warn').mockImplementation(() => {});
    const cause = new TypeError('socket hang up');
    try {
      await stopWhileHeld(cmem => cmem.held().reject(cause));
      expect(importWarnings(warn)).toEqual([['IMPORT', expect.stringContaining('after the person pressed Stop'), { sent: 0 }, cause]]);
    } finally { warn.mockRestore(); }
  });

  it('logs a refusal for the batch on its way at Stop, even when Stop cut its body off', async () => {
    const warn = spyOn(logger, 'warn').mockImplementation(() => {});
    try {
      await stopWhileHeld(cmem => cmem.held().resolve(Response.json({ error: 'Pro required' }, { status: 403 })));
      store.close(); store = new SessionStore(':memory:');
      await stopWhileHeld(cmem => cmem.held().resolve(new Response(cutOffBody(cmem.signal()), { status: 503 })));
      expect(importWarnings(warn)).toEqual([
        ['IMPORT', expect.stringContaining('at Stop with an error'), { status: 403, reason: 'Pro required' }, undefined],
        ['IMPORT', expect.stringContaining('at Stop with an error'), { status: 503, reason: null }, undefined],
      ]);
    } finally { warn.mockRestore(); }
  });
});
