import { describe, expect, it } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

// The client is a declared local process fixture, not a Codex/model producer.
// Imports happen in the private child HOME before any production settings load.
function run(scenario: string) {
  const root = mkdtempSync(join(tmpdir(), 'claude-mem-codex-admission-'));
  const home = join(root, 'home'); mkdirSync(home);
  const modules = {
    pool: new URL('../src/services/worker/CodexAppServerPool.ts', import.meta.url).href,
    retry: new URL('../src/services/worker/retry.ts', import.meta.url).href,
    budget: new URL('../src/services/worker/paid-send-budget.ts', import.meta.url).href,
    errors: new URL('../src/services/worker/provider-errors.ts', import.meta.url).href,
    provider: new URL('../src/services/worker/CodexProvider.ts', import.meta.url).href,
  };
  const driver = join(root, 'driver.ts');
  writeFileSync(driver, `
    import { spawn } from 'node:child_process';
    const { CodexAppServerPool } = await import(${JSON.stringify(modules.pool)});
    const { withRetry } = await import(${JSON.stringify(modules.retry)});
    const { PaidSendBudget } = await import(${JSON.stringify(modules.budget)});
    const { ClassifiedProviderError } = await import(${JSON.stringify(modules.errors)});
    const scenario = ${JSON.stringify(scenario)};
    const starts = [], exits = []; const children = new Set();
    let busy = 0, peak = 0, calls = 0;
    const pool = new CodexAppServerPool(1, () => ({
      runTurn(options) { return new Promise((resolve, reject) => {
        options.signal?.throwIfAborted(); options.beforeSend?.();
        const duration = scenario === 'active-deadline' || scenario === 'shutdown' ? 4000
          : scenario === 'retry' ? 20 : 350;
        const exitCode = scenario === 'retry' && calls++ === 0 ? 75 : 0;
        const child = spawn(process.execPath, ['-e',
          'setTimeout(()=>{process.stdout.write("native-work-complete");process.exit(' + exitCode + ')},' + duration + ')'],
          { signal: options.signal, env: { HOME: process.env.HOME, PATH: process.env.PATH } });
        children.add(child); busy++; peak = Math.max(peak, busy);
        starts.push({ prompt: options.prompt, pid: child.pid });
        let stdout = '', error;
        child.stdout.on('data', data => stdout += data);
        child.on('error', value => error = value);
        // Keep the slot until the real child has exited, including abort cleanup.
        child.on('close', (code, signal) => {
          children.delete(child); busy--; exits.push({ pid: child.pid, code, signal });
          if (code === 75) reject(new ClassifiedProviderError('native fixture refusal', {
            kind: 'rate_limit', paidSendOutcome: 'refused_before_work', cause: null,
          }));
          else if (error || code !== 0) reject(error ?? new Error('native child exit ' + code));
          else resolve({ content: stdout });
        });
      }); }, async close() { for (const child of children) child.kill(); }
    }));
    let provider;
    if (scenario === 'provider') {
      const { CodexProvider } = await import(${JSON.stringify(modules.provider)});
      provider = Object.create(CodexProvider.prototype); provider.appServer = pool;
    }
    const budgets = Array.from({ length: 4 }, (_, i) => new PaidSendBudget(i));
    function request(i, timeoutMs, signal) {
      if (provider) return provider.runTurnWithRetry(String(i), {
        codexPath: 'unused-native-fixture', model: '', reasoningEffort: null,
      }, timeoutMs, signal, budgets[i]);
      const options = { label: 'Codex', maxRetries: 1, baseDelayMs: 1, maxDelayMs: 1,
        perAttemptTimeoutMs: timeoutMs, abortSignal: signal, paidSendBudget: budgets[i] };
      const turn = (client, attemptSignal) => client.runTurn({
        codexPath: 'unused-native-fixture', model: '', reasoningEffort: null,
        timeoutMs, prompt: String(i), signal: attemptSignal,
      });
      // Exercise the original public composition on the unchanged baseline,
      // and the admission-scoped public operation when available.
      return typeof pool.withClient === 'function'
        ? pool.withClient((client, admittedSignal) => withRetry(attemptSignal => turn(client, attemptSignal), {
            ...options, abortSignal: admittedSignal,
          }), signal)
        : withRetry(attemptSignal => turn(pool, attemptSignal), options);
    }
    let results;
    try {
      if (scenario === 'queued-cancel' || scenario === 'shutdown') {
        const cancellation = new AbortController();
        const first = request(0, 10000);
        const second = request(1, 10000, cancellation.signal);
        const all = Promise.allSettled([first, second]);
        while (!starts.length) await new Promise(resolve => setTimeout(resolve, 0));
        if (scenario === 'queued-cancel') cancellation.abort(new Error('queued cancellation'));
        else await pool.close();
        results = await all;
      } else {
        const count = scenario === 'queue' || scenario === 'provider' ? 4 : 1;
        const timeout = scenario === 'active-deadline' ? 100 : 1000;
        results = await Promise.allSettled(Array.from({ length: count }, (_, i) => request(i, timeout)));
      }
    } finally { await pool.close(); }
    console.log('NATIVE_RECEIPT:' + JSON.stringify({ starts, exits, peak, childrenRemaining: children.size,
      results: results.map((result, i) => ({ status: result.status, spent: budgets[i].spentPaidSends,
        code: result.status === 'rejected' ? result.reason.code : undefined,
        content: result.status === 'fulfilled' ? result.value.content : undefined })) }));
  `);
  try {
    const result = spawnSync(process.execPath, [driver], {
      cwd: root, env: { HOME: home, PATH: process.env.PATH, TMPDIR: root, TEMP: root, TMP: root,
        DO_NOT_TRACK: '1', CLAUDE_MEM_TELEMETRY: '0', CLAUDE_MEM_TELEMETRY_ERRORS: '0' }, encoding: 'utf8', timeout: 4500,
    });
    expect(result.status, result.stderr).toBe(0);
    const line = result.stdout.split('\n').find(value => value.startsWith('NATIVE_RECEIPT:'));
    expect(line).toBeDefined();
    const receipt = JSON.parse(line!.slice('NATIVE_RECEIPT:'.length));
    expect(receipt.childrenRemaining).toBe(0);
    expect(receipt.exits.map((exit: any) => exit.pid).sort()).toEqual(receipt.starts.map((start: any) => start.pid).sort());
    expect(receipt.peak).toBe(1);
    return receipt;
  } finally { rmSync(root, { recursive: true, force: true }); }
}

const native = process.platform === 'win32' ? describe.skip : describe;
native('Codex pool admission deadlines and accounting (native local client)', () => {
  it('gives queued work a full execution deadline after FIFO admission', () => {
    const receipt = run('queue');
    expect(receipt.results.map((result: any) => result.status)).toEqual(Array(4).fill('fulfilled'));
    expect(receipt.results.map((result: any) => result.spent)).toEqual([1, 1, 1, 1]);
    expect(receipt.starts.map((start: any) => start.prompt)).toEqual(['0', '1', '2', '3']);
    expect(receipt.exits.every((exit: any) => exit.code === 0)).toBe(true);
  });
  it('does not send or charge a cancelled queued request', () => {
    const receipt = run('queued-cancel');
    expect(receipt.results.map((result: any) => result.status)).toEqual(['fulfilled', 'rejected']);
    expect(receipt.results.map((result: any) => result.spent)).toEqual([1, 0]);
    expect(receipt.starts.map((start: any) => start.prompt)).toEqual(['0']);
  });
  it('still times out and accounts for a genuinely slow active request', () => {
    const receipt = run('active-deadline');
    expect(receipt.results[0]).toMatchObject({ status: 'rejected', code: 'deadline_exceeded', spent: 1 });
    expect(receipt.starts).toHaveLength(1);
    expect(receipt.exits[0].signal).toBe('SIGTERM');
  });
  it('closes active and queued work without charging the unadmitted job', () => {
    const receipt = run('shutdown');
    expect(receipt.results.map((result: any) => result.status)).toEqual(['rejected', 'rejected']);
    expect(receipt.results[1].spent).toBe(0);
    expect(receipt.starts).toHaveLength(1);
  });
  it('retains one refusal retry and charges only the completed send', () => {
    const receipt = run('retry');
    expect(receipt.results[0]).toMatchObject({ status: 'fulfilled', spent: 1 });
    expect(receipt.exits.map((exit: any) => exit.code)).toEqual([75, 0]);
  });
  it('exercises the actual production provider method with the native local client', () => {
    const receipt = run('provider');
    expect(receipt.results.map((result: any) => result.status)).toEqual(Array(4).fill('fulfilled'));
    expect(receipt.results.map((result: any) => result.spent)).toEqual([1, 1, 1, 1]);
    expect(receipt.starts.map((start: any) => start.prompt)).toEqual(['0', '1', '2', '3']);
    expect(receipt.exits.every((exit: any) => exit.code === 0)).toBe(true);
  });
});
