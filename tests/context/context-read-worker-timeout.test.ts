import { describe, expect, it } from 'bun:test';
import type { ContextReadReply, ContextReadRequest } from '../../src/services/context/ContextReadProtocol.ts';
import { ContextReadWorkerClient } from '../../src/services/context/ContextReadWorkerClient.ts';

/**
 * A context-read thread stand-in. `silent` accepts a message and never
 * answers. `terminateSettles` false is a terminate() that never resolves,
 * the shape of a reader stuck inside SQLite (#5374).
 */
class ScriptedWorker {
  readonly messages: ContextReadRequest[] = [];
  terminateCalls = 0;
  private readonly messageListeners: Array<(reply: ContextReadReply) => void> = [];

  constructor(
    private readonly behavior: 'silent' | 'reply',
    private readonly terminateSettles: boolean,
  ) {}

  postMessage(message: ContextReadRequest): void {
    this.messages.push(message);
    if (this.behavior !== 'reply') return;
    const reply: ContextReadReply = { id: message.id, ok: true, result: ['replaced'] };
    for (const listener of this.messageListeners) listener(reply);
  }

  on(event: 'message', listener: (reply: ContextReadReply) => void): void;
  on(event: 'error', listener: (error: Error) => void): void;
  on(event: 'exit', listener: (code: number) => void): void;
  on(event: 'message' | 'error' | 'exit', listener: (...args: unknown[]) => void): void {
    if (event === 'message') this.messageListeners.push(listener as (reply: ContextReadReply) => void);
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

describe('context reader deadlines', () => {
  it('rejects every caller when the reader never replies, then reads successfully on a replacement', async () => {
    const workers: ScriptedWorker[] = [];
    const reader = new ContextReadWorkerClient({
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
    const first = rejectionOf(reader.readKeys(['a']));
    const second = rejectionOf(reader.readKeys(['b']));
    const [firstError, secondError] = await Promise.all([first, second]);
    expect(firstError.message).toBe('Context reader timed out after 40ms');
    expect(secondError.message).toBe('Context reader timed out after 40ms');
    expect(workers).toHaveLength(1);
    expect(workers[0].terminateCalls).toBe(1);
    expect(workers[0].messages.map(message => message.method)).toEqual(['readKeys', 'readKeys']);

    await expect(reader.readKeys(['c'])).resolves.toEqual(['replaced']);
    expect(workers).toHaveLength(2);
    expect(Date.now() - started).toBeLessThan(2_000);

    await reader.close();
    expect(workers[1].terminateCalls).toBe(1);
  });

  it('returns from close() when terminate() never settles', async () => {
    const workers: ScriptedWorker[] = [];
    const reader = new ContextReadWorkerClient({
      requestTimeoutMs: 5_000,
      terminateTimeoutMs: 80,
      createWorker: () => {
        const worker = new ScriptedWorker('silent', false);
        workers.push(worker);
        return worker;
      },
    });

    const rejection = rejectionOf(reader.readKeys(['a']));
    const started = Date.now();
    await reader.close();
    const elapsed = Date.now() - started;

    expect(elapsed).toBeGreaterThanOrEqual(50);
    expect(elapsed).toBeLessThan(2_000);
    expect(workers[0].terminateCalls).toBe(1);
    await expect(rejection).resolves.toMatchObject({ message: 'Context reader closed' });
  });

  it('returns from close() as soon as terminate() settles', async () => {
    const reader = new ContextReadWorkerClient({
      requestTimeoutMs: 5_000,
      terminateTimeoutMs: 5_000,
      createWorker: () => new ScriptedWorker('silent', true),
    });

    const rejection = rejectionOf(reader.readKeys(['a']));
    const started = Date.now();
    await reader.close();
    expect(Date.now() - started).toBeLessThan(1_000);
    await expect(rejection).resolves.toMatchObject({ message: 'Context reader closed' });
  });
});
