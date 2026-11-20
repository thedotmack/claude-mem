import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { WorkerClient } from '../../src/integrations/dsh-plugin/worker.js';
import { MemError } from '../../src/integrations/dsh-plugin/types.js';

async function withWorker(handler: (response: ServerResponse) => void, run: (url: string) => Promise<void>) {
  const server = createServer((_request, response) => handler(response));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}

const operations = {
  json: (client: WorkerClient, signal?: AbortSignal) => client.search({ query: 'example' }, signal),
  text: (client: WorkerClient, signal?: AbortSignal) => client.context({ cwd: '/work/project' }, signal),
};

for (const [kind, request] of Object.entries(operations)) {
  test(`${kind} response-body timeout keeps the MEM_TIMEOUT error code`, async () => {
    await withWorker(response => {
      response.writeHead(200, { 'content-type': kind === 'json' ? 'application/json' : 'text/plain' });
      response.flushHeaders();
      response.write(kind === 'json' ? '[' : 'partial context');
    }, async baseUrl => {
      await assert.rejects(request(new WorkerClient({ baseUrl, timeoutMs: 100 })), error =>
        error instanceof MemError && error.code === 'MEM_TIMEOUT');
    });
  });

  test(`${kind} caller cancellation during the body is MEM_ABORTED`, async () => {
    const controller = new AbortController();
    await withWorker(response => {
      response.writeHead(200);
      response.flushHeaders();
      response.write(kind === 'json' ? '[' : 'partial context');
      setTimeout(() => controller.abort(new Error('caller stopped')), 20);
    }, async baseUrl => {
      await assert.rejects(request(new WorkerClient({ baseUrl, timeoutMs: 2_000 }), controller.signal), error =>
        error instanceof MemError && error.code === 'MEM_ABORTED');
    });
  });

  for (const status of [500, 503]) {
    test(`${kind} retains HTTP ${status} when the error body is interrupted`, async () => {
      await withWorker(response => {
        response.writeHead(status, { 'content-length': '100' });
        response.flushHeaders();
        response.write('partial diagnostic');
        setTimeout(() => response.destroy(), 20);
      }, async baseUrl => {
        await assert.rejects(request(new WorkerClient({ baseUrl, timeoutMs: 2_000 })), error =>
          error instanceof MemError && error.code === 'MEM_PROVIDER_ERROR' && error.message.includes(`HTTP ${status}`));
      });
    });
  }

  test(`${kind} timeout while reading an HTTP 500 body remains MEM_TIMEOUT`, async () => {
    await withWorker(response => {
      response.writeHead(500);
      response.flushHeaders();
      response.write('partial failure');
    }, async baseUrl => {
      await assert.rejects(request(new WorkerClient({ baseUrl, timeoutMs: 100 })), error =>
        error instanceof MemError && error.code === 'MEM_TIMEOUT');
    });
  });

  test(`${kind} cancellation while reading an HTTP 503 body remains MEM_ABORTED`, async () => {
    const controller = new AbortController();
    await withWorker(response => {
      response.writeHead(503);
      response.flushHeaders();
      response.write('partial failure');
      setTimeout(() => controller.abort(), 20);
    }, async baseUrl => {
      await assert.rejects(request(new WorkerClient({ baseUrl, timeoutMs: 2_000 }), controller.signal), error =>
        error instanceof MemError && error.code === 'MEM_ABORTED');
    });
  });
}

test('caller cancellation before response headers is MEM_ABORTED', async () => {
  const controller = new AbortController();
  await withWorker(() => controller.abort(), async baseUrl => {
    await assert.rejects(new WorkerClient({ baseUrl, timeoutMs: 2_000 }).search({ query: 'q' }, controller.signal), error =>
      error instanceof MemError && error.code === 'MEM_ABORTED');
  });
});

test('malformed JSON is a typed provider error', async () => {
  await withWorker(response => response.end('not json'), async baseUrl => {
    await assert.rejects(new WorkerClient({ baseUrl, timeoutMs: 2_000 }).search({ query: 'q' }), error =>
      error instanceof MemError && error.code === 'MEM_PROVIDER_ERROR');
  });
});

test('complete JSON and context bodies still succeed', async () => {
  await withWorker(response => response.end('[]'), async baseUrl => {
    const client = new WorkerClient({ baseUrl, timeoutMs: 2_000 });
    assert.deepEqual(await client.search({ query: 'q' }), { items: [] });
    assert.equal(await client.context({ cwd: '/work/project' }), '[]');
  });
});
