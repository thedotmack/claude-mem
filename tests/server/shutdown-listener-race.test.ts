import { expect, spyOn, test } from 'bun:test';
import { Server } from '../../src/services/server/Server.js';
import { performGracefulShutdown } from '../../src/services/infrastructure/GracefulShutdown.js';
import { getSupervisor } from '../../src/supervisor/index.js';

test.each(['server', 'worker'] as const)('%s shutdown refuses new streams while draining connections', async runtime => {
  const server = new Server({
    getInitializationComplete: () => true,
    getMcpReady: () => true,
    onShutdown: async () => {}, onRestart: async () => {}, workerPath: '',
    getAiStatus: () => ({ provider: 'disabled', authMethod: 'api-key', lastInteraction: null }),
  });
  let accepted = 0;
  server.registerRoutes({ setupRoutes(app) {
    app.get('/held-stream', (_req, res) => {
      accepted++;
      res.setHeader('Content-Type', 'text/event-stream');
      res.write(': open\n\n');
    });
  } });
  await server.listen(0, '127.0.0.1');
  const listener = server.getHttpServer()!;
  const address = listener.address();
  if (!address || typeof address === 'string') throw new Error('no test port');
  const url = `http://127.0.0.1:${address.port}/held-stream`;
  const controller = new AbortController();
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  const supervisor = spyOn(getSupervisor(), 'stop').mockResolvedValue(undefined);
  let closing: Promise<void> | undefined;
  try {
    // Keep one real HTTP response open before shutdown; neither path may wait
    // for its client to cooperate. Select the Windows close-delay branch only
    // after the native listener has bound on the actual host.
    const before = await fetch(url, { signal: controller.signal });
    expect(before.status).toBe(200);
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    closing = runtime === 'server' ? server.close() : performGracefulShutdown({
      server: listener, sessionManager: { async shutdownAll() {} },
    });
    const late = await fetch(url, { signal: controller.signal }).then(() => 'accepted', () => 'refused');
    expect(late).toBe('refused');
    expect(accepted).toBe(1);
    await closing;
    expect(listener.listening).toBe(false);
  } finally {
    controller.abort();
    await closing;
    Object.defineProperty(process, 'platform', platform);
    supervisor.mockRestore();
  }
});
