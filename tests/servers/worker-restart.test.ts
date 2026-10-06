import { describe, expect, it, mock } from 'bun:test';
import { createServer } from 'node:net';
import { isConnectionRefusedError } from '../../src/shared/connection-errors.js';
import { withWorkerRestartOnRefusedConnection } from '../../src/servers/worker-restart.js';

/** A loopback port with nothing listening on it, so a request to it is refused. */
async function closedLoopbackPort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address() as { port: number };
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

describe('withWorkerRestartOnRefusedConnection (MCP callWorker)', () => {
  it('starts a worker that refused the connection, then sends the request once more', async () => {
    const port = await closedLoopbackPort();
    let worker: ReturnType<typeof Bun.serve> | null = null;
    const sendRequest = mock(async () => (await fetch(`http://127.0.0.1:${port}/api/search`)).text());
    const startWorker = mock(async () => {
      worker = Bun.serve({ hostname: '127.0.0.1', port, fetch: () => new Response('search results') });
      return true;
    });
    try {
      expect(await withWorkerRestartOnRefusedConnection(sendRequest, startWorker)).toBe('search results');
      expect(startWorker).toHaveBeenCalledTimes(1);
      expect(sendRequest).toHaveBeenCalledTimes(2);
    } finally {
      worker?.stop(true);
    }
  });

  it('never restarts or resends when a live worker answered with an error', async () => {
    const answered = new Error('Worker API error (500): boom');
    const sendRequest = mock(async () => { throw answered; });
    const startWorker = mock(async () => true);
    await expect(withWorkerRestartOnRefusedConnection(sendRequest, startWorker)).rejects.toBe(answered);
    expect(startWorker).not.toHaveBeenCalled();
    expect(sendRequest).toHaveBeenCalledTimes(1);
  });

  it('reports the refused connection when the worker may not be started', async () => {
    // CLAUDE_MEM_RUNTIME=server, CLAUDE_MEM_WORKER_AUTOSTART=false, or a boot that failed.
    const port = await closedLoopbackPort();
    const sendRequest = mock(async () => fetch(`http://127.0.0.1:${port}/api/search`));
    const startWorker = mock(async () => false);
    const error = await withWorkerRestartOnRefusedConnection(sendRequest, startWorker).catch((caught: unknown) => caught);
    expect(isConnectionRefusedError(error)).toBe(true);
    expect(startWorker).toHaveBeenCalledTimes(1);
    expect(sendRequest).toHaveBeenCalledTimes(1);
  });

  it('starts the worker at most once per call', async () => {
    const port = await closedLoopbackPort();
    const sendRequest = mock(async () => fetch(`http://127.0.0.1:${port}/api/search`));
    const startWorker = mock(async () => true);
    const error = await withWorkerRestartOnRefusedConnection(sendRequest, startWorker).catch((caught: unknown) => caught);
    expect(isConnectionRefusedError(error)).toBe(true);
    expect(startWorker).toHaveBeenCalledTimes(1);
    expect(sendRequest).toHaveBeenCalledTimes(2);
  });
});
