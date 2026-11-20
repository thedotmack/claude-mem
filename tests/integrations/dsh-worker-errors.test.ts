import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { WorkerClient } from '../../src/integrations/dsh-plugin/worker.js';

async function withWorker(body: unknown, run: (client: WorkerClient) => Promise<void>) {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(body));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  try {
    await run(new WorkerClient({ baseUrl: `http://127.0.0.1:${address.port}`, timeoutMs: 1_000 }));
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}

test('timeline rejects the worker MCP error envelope even when HTTP succeeds', async () => {
  await withWorker({ isError: true, content: [{ type: 'text', text: 'Invalid observation anchor: must be a positive safe integer' }] }, async client => {
    await assert.rejects(client.timeline({ anchor: -1 }), {
      code: 'MEM_PROVIDER_ERROR',
      message: 'Invalid observation anchor: must be a positive safe integer',
    });
  });
});

test('query errors without readable text remain errors', async () => {
  await withWorker({ isError: true, content: [{ type: 'image', data: 'ignored' }] }, async client => {
    await assert.rejects(client.search({ query: 'missing' }), { code: 'MEM_PROVIDER_ERROR' });
  });
});

test('successful MCP text and observation arrays retain their existing projections', async () => {
  await withWorker({ isError: false, content: [{ type: 'text', text: 'No observations found.' }] }, async client => {
    assert.deepEqual(await client.search({ query: 'missing' }), { items: [], content: 'No observations found.' });
  });
  await withWorker([{ id: 7, title: 'Saved result' }], async client => {
    assert.deepEqual((await client.getObservations({ ids: [7] })).items, [{ id: 7, title: 'Saved result' }]);
  });
});
