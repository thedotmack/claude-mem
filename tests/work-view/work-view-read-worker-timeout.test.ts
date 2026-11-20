import { describe, expect, it } from 'bun:test';
import type { WorkViewReadRequest, WorkViewReadResponse, WorkViewReadResult } from '../../src/services/work-view/WorkViewReadProtocol.ts';
import { WORK_VIEW_READ_REQUEST_TIMEOUT_MS, WORK_VIEW_READ_TERMINATE_TIMEOUT_MS, WorkViewReadWorkerClient } from '../../src/services/work-view/WorkViewReadWorkerClient.ts';

/**
 * A work-view reader thread stand-in. `silent` accepts a message and never
 * answers. `terminateSettles` false is a terminate() that never resolves,
 * the shape of a reader stuck inside native SQLite code (#5374).
 */
class ScriptedWorker {
  readonly messages: WorkViewReadRequest[] = [];
  terminateCalls = 0;
  private readonly messageListeners: Array<(response: WorkViewReadResponse) => void> = [];

  constructor(
    private readonly behavior: 'silent' | 'reply',
    private readonly terminateSettles: boolean,
  ) {}

  postMessage(message: WorkViewReadRequest | { kind: 'invalidate-activity'; workState?: boolean }): void {
    if (!('kind' in message) || message.kind !== 'view' && message.kind !== 'rules') return;
    this.messages.push(message);
    if (this.behavior !== 'reply') return;
    const result = { agentView: { source: { connected: true } }, agentRevision: 0 } as unknown as WorkViewReadResult;
    const reply: WorkViewReadResponse = { id: message.id, ok: true, result };
    for (const listener of this.messageListeners) listener(reply);
  }

  on(event: 'message', listener: (response: WorkViewReadResponse) => void): void;
  on(event: 'error', listener: (error: Error) => void): void;
  on(event: 'exit', listener: (code: number) => void): void;
  on(event: 'message' | 'error' | 'exit', listener: (...args: unknown[]) => void): void {
    if (event === 'message') this.messageListeners.push(listener as (response: WorkViewReadResponse) => void);
  }

  ref(): void {}
  unref(): void {}

  terminate(): Promise<number> {
    this.terminateCalls += 1;
    if (!this.terminateSettles) return new Promise(() => {});
    return Promise.resolve(0);
  }
}

function rejectionOf(promise: Promise<unknown>): Promise<Error> {
  return promise.then(
    () => { throw new Error('expected the read to reject'); },
    (error: Error) => error,
  );
}

describe('work view reader deadlines', () => {
  it('keeps the same margins as the context reader', () => {
    expect(WORK_VIEW_READ_REQUEST_TIMEOUT_MS).toBeGreaterThanOrEqual(60_000);
    expect(WORK_VIEW_READ_TERMINATE_TIMEOUT_MS).toBeLessThan(WORK_VIEW_READ_REQUEST_TIMEOUT_MS);
  });

  it('rejects every caller when the reader never replies, then reads successfully on a replacement', async () => {
    const workers: ScriptedWorker[] = [];
    const reader = new WorkViewReadWorkerClient({ databasePath: 'unused.db', ledgerDir: null, pollIntervalMs: 1000 }, {
      requestTimeoutMs: 40,
      terminateTimeoutMs: 40,
      createWorker: () => {
        // The hung thread's terminate() never settles. The replacement must
        // still answer without waiting for that call.
        const worker = new ScriptedWorker(workers.length === 0 ? 'silent' : 'reply', workers.length > 0);
        workers.push(worker);
        return worker;
      },
    });

    const started = Date.now();
    const first = rejectionOf(reader.read(0, '', 'snapshot'));
    const second = rejectionOf(reader.read(0, '', 'http'));
    const [firstError, secondError] = await Promise.all([first, second]);
    expect(firstError.message).toBe('Work view reader timed out after 40ms');
    expect(secondError.message).toBe('Work view reader timed out after 40ms');
    expect(workers).toHaveLength(1);
    expect(workers[0].terminateCalls).toBe(1);
    expect(workers[0].messages.map(message => message.kind)).toEqual(['view', 'view']);

    await expect(reader.read(0, '', 'snapshot')).resolves.toBeTruthy();
    expect(workers).toHaveLength(2);
    expect(Date.now() - started).toBeLessThan(2_000);

    await reader.close();
    expect(workers[1].terminateCalls).toBe(1);
  });

  it('returns from close() when terminate() never settles', async () => {
    const workers: ScriptedWorker[] = [];
    const reader = new WorkViewReadWorkerClient({ databasePath: 'unused.db', ledgerDir: null, pollIntervalMs: 1000 }, {
      requestTimeoutMs: 5_000,
      terminateTimeoutMs: 80,
      createWorker: () => {
        const worker = new ScriptedWorker('silent', false);
        workers.push(worker);
        return worker;
      },
    });

    const rejection = rejectionOf(reader.read(0, '', 'snapshot'));
    const started = Date.now();
    await reader.close();
    const elapsed = Date.now() - started;

    expect(elapsed).toBeGreaterThanOrEqual(50);
    expect(elapsed).toBeLessThan(2_000);
    expect(workers[0].terminateCalls).toBe(1);
    await expect(rejection).resolves.toMatchObject({ message: 'Work view reader closed' });
  });

  it('returns from close() as soon as terminate() settles', async () => {
    const reader = new WorkViewReadWorkerClient({ databasePath: 'unused.db', ledgerDir: null, pollIntervalMs: 1000 }, {
      requestTimeoutMs: 5_000,
      terminateTimeoutMs: 5_000,
      createWorker: () => new ScriptedWorker('silent', true),
    });

    const rejection = rejectionOf(reader.read(0, '', 'snapshot'));
    const started = Date.now();
    await reader.close();
    expect(Date.now() - started).toBeLessThan(1_000);
    await expect(rejection).resolves.toMatchObject({ message: 'Work view reader closed' });
  });

  it('reports sane diagnostics counters around a timed-out read', async () => {
    const reader = new WorkViewReadWorkerClient({ databasePath: 'unused.db', ledgerDir: null, pollIntervalMs: 1000 }, {
      requestTimeoutMs: 40,
      terminateTimeoutMs: 40,
      createWorker: () => new ScriptedWorker('silent', true),
    });

    const error = await rejectionOf(reader.read(0, '', 'snapshot'));
    expect(error.message).toBe('Work view reader timed out after 40ms');
    expect(reader.getDiagnostics()).toMatchObject({
      pendingCount: 0,
      maxPendingCount: 1,
      completedReads: 1,
      failedReads: 1,
      lastRead: { purpose: 'snapshot', started: false, ok: false },
    });

    await reader.close();
    expect(reader.getDiagnostics().pendingCount).toBe(0);
  });
});
