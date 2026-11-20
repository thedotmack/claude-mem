import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { removeTempDir } from '../../helpers/temp-dir.js';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';
import { SHARED_WORK_SYNC_PASS_TIMEOUT_MS, SHARED_WORK_SYNC_TERMINATE_TIMEOUT_MS, SharedWorkSync } from '../../../src/services/work-view/SharedWorkSync.js';

/**
 * A shared-work-sync thread stand-in. `silent` accepts a reconcile request and
 * never answers — the alive-but-hung shape of #5374, where the thread stays
 * inside native SQLite without replying, erroring or exiting. `reply` answers
 * on a later microtask, as a real worker thread does, so callers can overlap a
 * pending pass; `reply-sync` answers inside postMessage() itself.
 * `terminateSettles` false is a terminate() that never resolves.
 */
class ScriptedWorker {
  readonly requests: string[] = [];
  terminateCalls = 0;
  private readonly messageListeners: Array<(reply: { changed?: boolean; rulesChanged?: boolean; diagnostic?: unknown }) => void> = [];

  constructor(
    private readonly behavior: 'silent' | 'reply' | 'reply-sync',
    private readonly terminateSettles: boolean,
  ) {}

  postMessage(message: string): void {
    this.requests.push(message);
    if (this.behavior === 'silent') return;
    const answer = () => { for (const listener of this.messageListeners) listener({ changed: false, rulesChanged: false, diagnostic: null }); };
    if (this.behavior === 'reply-sync') answer();
    else queueMicrotask(answer);
  }

  on(event: 'message', listener: (reply: { changed?: boolean; rulesChanged?: boolean; diagnostic?: unknown }) => void): void;
  on(event: 'error', listener: (error: Error) => void): void;
  on(event: 'exit', listener: (code: number) => void): void;
  on(event: 'message' | 'error' | 'exit', listener: (...args: unknown[]) => void): void {
    if (event === 'message') this.messageListeners.push(listener as (reply: { changed?: boolean }) => void);
  }

  ref(): void {}
  unref(): void {}

  terminate(): Promise<number> {
    this.terminateCalls += 1;
    if (!this.terminateSettles) return new Promise(() => {});
    return Promise.resolve(0);
  }
}

const disposals: Array<() => void> = [];
afterEach(async () => { for (const dispose of disposals.splice(0).reverse()) await dispose(); });
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'shared-work-timeout-'));
  disposals.push(() => removeTempDir(directory));
  const databasePath = join(directory, 'claude-mem.db'), ledger = join(directory, 'work-view');
  const store = new SessionStore(databasePath); mkdirSync(ledger);
  disposals.push(() => store.close());
  const options = { databasePath, directory: ledger, deviceId: 'timeout-device', notify() {}, intervalMs: 60_000, enabled: true };
  return { store, options };
}

function rejectionOf(promise: Promise<unknown>): Promise<Error> {
  return promise.then(
    () => { throw new Error('expected the pass to reject'); },
    (error: Error) => error,
  );
}

describe('shared work sync pass deadline', () => {
  test('keeps the same margins as the sibling readers', () => {
    expect(SHARED_WORK_SYNC_PASS_TIMEOUT_MS).toBeGreaterThanOrEqual(60_000);
    expect(SHARED_WORK_SYNC_TERMINATE_TIMEOUT_MS).toBeLessThan(SHARED_WORK_SYNC_PASS_TIMEOUT_MS);
  });

  test('a hung thread rejects the owner-action awaiter, retires the worker, and the next pass uses a replacement', async () => {
    const f = fixture();
    const workers: ScriptedWorker[] = [];
    const sync = new SharedWorkSync(f.store.db, f.options, {
      passTimeoutMs: 40,
      terminateTimeoutMs: 40,
      createWorker: () => {
        const worker = new ScriptedWorker(workers.length === 0 ? 'silent' : 'reply', workers.length > 0);
        workers.push(worker);
        return worker;
      },
    });
    disposals.push(() => sync.close());

    const ownerAction = rejectionOf(sync.prepareOwnerAction());
    const error = await ownerAction;
    expect(error.message).toBe('Shared work sync timed out after 40ms; reopening the worker.');
    expect(workers).toHaveLength(1);
    expect(workers[0].terminateCalls).toBe(1);
    expect(sync.status()).toMatchObject({ enabled: true, error: 'Shared work could not be refreshed; retrying.' });

    // The next pass must open a replacement worker instead of inheriting the
    // hung pass, and a healthy pass still settles through the same promise.
    await expect(sync.reconcile()).resolves.toBeUndefined();
    expect(workers).toHaveLength(2);
    expect(workers[1].terminateCalls).toBe(0);
    expect(sync.status()).toMatchObject({ enabled: true });
  }, 15_000);

  test('a caller coalesced onto a hung pass rejects with it, and later coalescing rides a fresh pass', async () => {
    const f = fixture();
    const workers: ScriptedWorker[] = [];
    const sync = new SharedWorkSync(f.store.db, f.options, {
      passTimeoutMs: 40,
      terminateTimeoutMs: 40,
      createWorker: () => {
        const worker = new ScriptedWorker(workers.length === 0 ? 'silent' : 'reply', false);
        workers.push(worker);
        return worker;
      },
    });
    disposals.push(() => sync.close());

    const first = rejectionOf(sync.reconcile());
    const coalesced = rejectionOf(sync.reconcile());
    const [firstError, coalescedError] = await Promise.all([first, coalesced]);
    expect(firstError.message).toBe('Shared work sync timed out after 40ms; reopening the worker.');
    expect(coalescedError.message).toBe('Shared work sync timed out after 40ms; reopening the worker.');

    // After the timeout the chain must restart fresh: callers coalescing onto
    // the replacement pass resolve with it instead of inheriting the stale
    // rejection from the retired pass. Both late callers arrive while the
    // replacement pass is still pending, so they share one follow-up pass.
    const replacement = sync.reconcile();
    const late = sync.reconcile();
    const later = sync.reconcile();
    expect(workers[1].requests).toHaveLength(1);
    await expect(replacement).resolves.toBeUndefined();
    await expect(late).resolves.toBeUndefined();
    await expect(later).resolves.toBeUndefined();
    expect(workers).toHaveLength(2);
    expect(workers[1].requests).toHaveLength(2);
  }, 15_000);

  test.each(['reply', 'reply-sync'] as const)('a healthy %s cancels the pass deadline and keeps the worker', async behavior => {
    const f = fixture();
    const workers: ScriptedWorker[] = [];
    const sync = new SharedWorkSync(f.store.db, f.options, {
      passTimeoutMs: 40,
      terminateTimeoutMs: 40,
      createWorker: () => {
        const worker = new ScriptedWorker(behavior, true);
        workers.push(worker);
        return worker;
      },
    });
    disposals.push(() => sync.close());

    await expect(sync.reconcile()).resolves.toBeUndefined();
    await new Promise(resolve => setTimeout(resolve, 120));
    expect(workers[0].terminateCalls).toBe(0);
    expect(sync.status()).not.toHaveProperty('error');
    await expect(sync.reconcile()).resolves.toBeUndefined();
    expect(workers).toHaveLength(1);
    expect(workers[0].requests).toHaveLength(2);
  }, 15_000);

  test('close() settles callers and returns while a hung thread never settles terminate()', async () => {
    const f = fixture();
    const workers: ScriptedWorker[] = [];
    const sync = new SharedWorkSync(f.store.db, f.options, {
      passTimeoutMs: 5_000,
      terminateTimeoutMs: 80,
      createWorker: () => {
        const worker = new ScriptedWorker('silent', false);
        workers.push(worker);
        return worker;
      },
    });
    disposals.push(() => sync.close());

    const pass = sync.reconcile();
    const started = Date.now();
    sync.close();
    const elapsed = Date.now() - started;

    expect(elapsed).toBeLessThan(2_000);
    expect(workers[0].terminateCalls).toBe(1);
    await expect(pass).resolves.toBeUndefined();
  }, 15_000);
});
