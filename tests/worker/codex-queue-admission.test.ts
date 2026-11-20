import { describe, expect, it, spyOn } from 'bun:test';
import { CodexAppServerPool } from '../../src/services/worker/CodexAppServerPool.js';
import { CodexProvider } from '../../src/services/worker/CodexProvider.js';
import { withRetry } from '../../src/services/worker/retry.js';
import { PaidSendBudget } from '../../src/services/worker/paid-send-budget.js';
import { ClassifiedProviderError } from '../../src/services/worker/provider-errors.js';
import * as dependencyHealth from '../../src/shared/dependency-health.js';
import * as quotaCooldown from '../../src/shared/quota-cooldown.js';

async function run(scenario: string) {
  const starts: string[] = [];
  const exits: Array<{ code: number | null; aborted: boolean }> = [];
  let busy = 0, peak = 0, calls = 0;
  let onStarted!: () => void;
  const started = new Promise<void>(resolve => { onStarted = resolve; });
  const pool = new CodexAppServerPool(1, () => ({
    runTurn(options) {
      return new Promise<{ content: string }>((resolve, reject) => {
        options.signal?.throwIfAborted();
        options.beforeSend?.();
        const duration = scenario === 'active-deadline' || scenario === 'shutdown' ? 200 : 20;
        const refuse = scenario === 'retry' && calls++ === 0;
        starts.push(options.prompt);
        busy++; peak = Math.max(peak, busy);
        onStarted();
        const finish = (aborted: boolean) => {
          clearTimeout(timer);
          options.signal?.removeEventListener('abort', abort);
          busy--;
          exits.push({ code: aborted ? null : refuse ? 75 : 0, aborted });
          if (aborted) reject(options.signal?.reason);
          else if (refuse) reject(new ClassifiedProviderError('fixture refusal', {
            kind: 'rate_limit', paidSendOutcome: 'refused_before_work', retryAfterMs: 0, cause: null,
          }));
          else resolve({ content: 'work-complete' });
        };
        const timer = setTimeout(() => finish(false), duration);
        const abort = () => {
          clearTimeout(timer);
          setTimeout(() => finish(true), 5);
        };
        options.signal?.addEventListener('abort', abort, { once: true });
      });
    },
    async close() {},
    async recycle() {},
  }));
  const setupSpy = spyOn(dependencyHealth, 'getDependencyStatus').mockReturnValue(null);
  const quotaSpy = spyOn(quotaCooldown, 'getQuotaCooldown').mockReturnValue(null);
  const provider = Object.create(CodexProvider.prototype);
  provider.appServer = pool;
  const budgets = Array.from({ length: 4 }, (_, i) => new PaidSendBudget(i));
  function request(i: number, timeoutMs: number, signal?: AbortSignal) {
    if (scenario === 'provider') return provider.runTurnWithRetry(String(i), {
      codexPath: 'unused-fixture', model: '', reasoningEffort: null,
    }, timeoutMs, signal, budgets[i]);
    return pool.withClient((client, admittedSignal) => withRetry(attemptSignal => client.runTurn({
      codexPath: 'unused-fixture', model: '', reasoningEffort: null,
      timeoutMs, prompt: String(i), signal: attemptSignal,
    }), {
      label: 'Codex', maxRetries: 1, baseDelayMs: 1, maxDelayMs: 1,
      perAttemptTimeoutMs: timeoutMs, abortSignal: admittedSignal, paidSendBudget: budgets[i],
    }), signal);
  }
  try {
    let results: PromiseSettledResult<{ content: string }>[];
    if (scenario === 'queued-cancel' || scenario === 'shutdown') {
      const cancellation = new AbortController();
      const all = Promise.allSettled([request(0, 1000), request(1, 1000, cancellation.signal)]);
      await started;
      if (scenario === 'queued-cancel') cancellation.abort(new Error('queued cancellation'));
      else await pool.close();
      results = await all;
    } else {
      const count = scenario === 'queue' || scenario === 'provider' ? 4 : 1;
      results = await Promise.allSettled(Array.from({ length: count }, (_, i) => request(i, 50)));
    }
    await pool.close();
    expect(busy).toBe(0);
    expect(exits).toHaveLength(starts.length);
    expect(peak).toBe(1);
    return { starts, exits, results: results.map((result, i) => ({
      status: result.status, spent: budgets[i].spentPaidSends,
      code: result.status === 'rejected' ? result.reason.code : undefined,
      content: result.status === 'fulfilled' ? result.value.content : undefined,
    })) };
  } finally {
    await pool.close();
    setupSpy.mockRestore();
    quotaSpy.mockRestore();
  }
}

describe('Codex pool admission deadlines and accounting', () => {
  it('gives queued work a full execution deadline after FIFO admission', async () => {
    const receipt = await run('queue');
    expect(receipt.results.map(result => result.status)).toEqual(Array(4).fill('fulfilled'));
    expect(receipt.results.map(result => result.spent)).toEqual([1, 1, 1, 1]);
    expect(receipt.starts).toEqual(['0', '1', '2', '3']);
    expect(receipt.exits.every(exit => exit.code === 0)).toBe(true);
  });
  it('does not send or charge a cancelled queued request', async () => {
    const receipt = await run('queued-cancel');
    expect(receipt.results.map(result => result.status)).toEqual(['fulfilled', 'rejected']);
    expect(receipt.results.map(result => result.spent)).toEqual([1, 0]);
    expect(receipt.starts).toEqual(['0']);
  });
  it('still times out and accounts for a genuinely slow active request', async () => {
    const receipt = await run('active-deadline');
    expect(receipt.results[0]).toMatchObject({ status: 'rejected', code: 'deadline_exceeded', spent: 1 });
    expect(receipt.starts).toHaveLength(1);
    expect(receipt.exits[0].aborted).toBe(true);
  });
  it('closes active and queued work without charging the unadmitted job', async () => {
    const receipt = await run('shutdown');
    expect(receipt.results.map(result => result.status)).toEqual(['rejected', 'rejected']);
    expect(receipt.results[1].spent).toBe(0);
    expect(receipt.starts).toHaveLength(1);
  });
  it('retains one refusal retry and charges only the completed send', async () => {
    const receipt = await run('retry');
    expect(receipt.results[0]).toMatchObject({ status: 'fulfilled', spent: 1 });
    expect(receipt.exits.map(exit => exit.code)).toEqual([75, 0]);
  });
  it('exercises the actual production provider method with the local client', async () => {
    const receipt = await run('provider');
    expect(receipt.results.map(result => result.status)).toEqual(Array(4).fill('fulfilled'));
    expect(receipt.results.map(result => result.spent)).toEqual([1, 1, 1, 1]);
    expect(receipt.starts).toEqual(['0', '1', '2', '3']);
    expect(receipt.exits.every(exit => exit.code === 0)).toBe(true);
  });
});
