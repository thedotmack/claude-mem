import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { runBrowserSetup, waitForBackgroundWorkToFinish } from '../../src/npx-cli/install/browser-setup.js';
import { INITIAL_SETUP_STATE } from '../../src/shared/setup-state.js';

async function withWorker(
  handle: (request: IncomingMessage, response: ServerResponse) => void,
  run: (url: string, request: typeof fetch, watchdogFired: () => boolean) => Promise<void>,
) {
  const server = createServer(handle);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const originalTimeout = AbortSignal.timeout;
  const deadlines: number[] = [];
  // Exercise real socket and response-body aborts without making every test
  // wait for the full production deadline.
  AbortSignal.timeout = ms => {
    deadlines.push(ms);
    return originalTimeout.call(AbortSignal, Math.min(ms, 150));
  };
  const watchdogController = new AbortController();
  let fired = false;
  const watchdog = setTimeout(() => {
    fired = true;
    watchdogController.abort(new Error('External test watchdog had to interrupt the worker request.'));
  }, 1_500);
  const request = ((url, init) => fetch(url, {
    ...init,
    signal: fired ? init?.signal : init?.signal ? AbortSignal.any([init.signal, watchdogController.signal]) : watchdogController.signal,
  })) as typeof fetch;
  try {
    await run(`http://127.0.0.1:${address.port}`, request, () => fired);
    assert.ok(deadlines.every(ms => ms > 0 && ms <= 5_000), 'Worker request deadlines must be bounded in production too.');
  } finally {
    clearTimeout(watchdog);
    AbortSignal.timeout = originalTimeout;
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}

const log = { info: () => {}, warn: () => {} };

for (const stalled of ['headers', 'body'] as const) {
  test(`setup recovers when a state read stalls in the ${stalled}`, async () => {
    let reads = 0, stage: string | undefined;
    await withWorker((request, response) => {
      if (request.method === 'POST') {
        let body = '';
        request.on('data', chunk => { body += String(chunk); });
        request.on('end', () => { stage = JSON.parse(body).stage; response.end('{}'); });
        return;
      }
      if (++reads === 1) {
        if (stalled === 'body') { response.writeHead(200, { 'content-type': 'application/json' }); response.write('{'); }
        return;
      }
      response.end(JSON.stringify({
        ...INITIAL_SETUP_STATE, alreadyPro: false,
        choice: stage ? { branch: 'home', memoryBilling: 'existing', chosenAt: 'now' } : null,
        status: stage === 'home-ready' ? 'complete' : 'pending',
      }));
    }, async (workerBaseUrl, request, watchdogFired) => {
      const outcome = await runBrowserSetup({
        workerBaseUrl, fetch: request, log, openBrowser: () => {},
        sleep: async () => {}, applyChoice: async () => 'home-ready',
      });
      assert.equal(watchdogFired(), false, 'State polling depended on an external watchdog.');
      assert.equal(outcome.state.status, 'complete');
      assert.ok(reads >= 3);
    });
  });
}

test('a stalled watcher releases setup after checkout has saved paid credentials', async () => {
  let stage: string | undefined, checkout: string | undefined;
  let finishCheckout: ((paid: boolean) => void) | undefined;
  let credentialsSaved = false, stalled = false, paidReports = 0;
  await withWorker((request, response) => {
    if (request.method === 'POST') {
      let body = '';
      request.on('data', chunk => { body += String(chunk); });
      request.on('end', () => {
        const report = JSON.parse(body);
        stage = report.stage;
        if (report.checkout) checkout = report.checkout;
        if (report.checkout === 'paid') paidReports++;
        response.end('{}');
      });
      return;
    }
    if (checkout === 'waiting' && !stalled) {
      stalled = true;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.write('{');
      credentialsSaved = true;
      finishCheckout!(true);
      return;
    }
    response.end(JSON.stringify({
      ...INITIAL_SETUP_STATE, alreadyPro: false,
      choice: stage ? { branch: 'go', memoryBilling: 'hosted', chosenAt: 'now' } : null,
      checkout: stage === 'go-awaiting-checkout' ? { state: checkout ?? 'requested', requests: 1, error: null, updatedAt: 'now' } : null,
      status: checkout === 'paid' ? 'complete' : 'pending',
    }));
  }, async (workerBaseUrl, request, watchdogFired) => {
    const outcome = await runBrowserSetup({
      workerBaseUrl, fetch: request, log, openBrowser: () => {}, pollIntervalMs: 1,
      applyChoice: async () => 'go-awaiting-checkout',
      checkout: { run: () => new Promise<boolean>(resolve => { finishCheckout = resolve; }), reopen: () => {} },
    });
    assert.equal(watchdogFired(), false);
    assert.equal(credentialsSaved, true);
    assert.equal(paidReports, 1);
    assert.equal(outcome.checkoutPaid, true);
    assert.equal(outcome.state.status, 'complete');
  });
});

test('an installer report cannot wait indefinitely for response headers', async () => {
  await withWorker((request, response) => {
    if (request.method !== 'POST') response.end(JSON.stringify({ ...INITIAL_SETUP_STATE, alreadyPro: false }));
  }, async (workerBaseUrl, request, watchdogFired) => {
    await assert.rejects(runBrowserSetup({
      workerBaseUrl, fetch: request, log, openBrowser: () => {}, applyChoice: async () => 'home-ready',
    }), { name: 'TimeoutError' });
    assert.equal(watchdogFired(), false);
  });
});

test('a stalled background-work read is retried instead of failing the restart wait', async () => {
  let reads = 0;
  const warnings: string[] = [];
  await withWorker((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    if (++reads === 1) { response.write('{"backgroundWorkRunning":'); return; }
    response.end('{"backgroundWorkRunning":[]}');
  }, async (workerBaseUrl, request, watchdogFired) => {
    await waitForBackgroundWorkToFinish({
      workerBaseUrl, fetch: request, sleep: async () => {},
      log: { info: () => {}, warn: message => { warnings.push(message); } },
    });
    assert.equal(watchdogFired(), false, 'The restart wait depended on an external watchdog.');
    assert.equal(reads, 2);
    assert.deepEqual(warnings, ['Waiting for the worker to answer…']);
  });
});

test('malformed background-work JSON still fails visibly without allowing a restart', async () => {
  await withWorker((_request, response) => { response.end('{"backgroundWorkRunning":'); }, async (workerBaseUrl, request) => {
    await assert.rejects(waitForBackgroundWorkToFinish({
      workerBaseUrl, fetch: request, log,
      sleep: async () => { throw new Error('Malformed state was silently retried.'); },
    }), /Could not read the worker's background work state/);
  });
});

test('a refused connection to the worker still fails the restart wait', async () => {
  await assert.rejects(waitForBackgroundWorkToFinish({
    workerBaseUrl: 'http://127.0.0.1:9', log,
    sleep: async () => { throw new Error('A lost worker was silently retried.'); },
  }), /Could not read the worker's background work state/);
});

test('an explicit setup-state refusal remains an error rather than a poll retry', async () => {
  let requests = 0;
  await withWorker((_request, response) => {
    requests++;
    response.writeHead(403, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ message: 'This installation is not authorized.' }));
  }, async (workerBaseUrl, request) => {
    await assert.rejects(runBrowserSetup({
      workerBaseUrl, fetch: request, log, openBrowser: () => {}, applyChoice: async () => 'home-ready',
      sleep: async () => { throw new Error('A refused request was retried.'); },
    }), /This installation is not authorized/);
    assert.equal(requests, 1);
  });
});

test('malformed state JSON remains an error rather than an availability retry', async () => {
  await withWorker((_request, response) => { response.end('{invalid json'); }, async (workerBaseUrl, request) => {
    await assert.rejects(runBrowserSetup({
      workerBaseUrl, fetch: request, log, openBrowser: () => {}, applyChoice: async () => 'home-ready',
      sleep: async () => { throw new Error('Malformed state was silently retried.'); },
    }), { name: 'SyntaxError' });
  });
});
