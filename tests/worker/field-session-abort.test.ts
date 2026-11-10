import { expect, it, spyOn } from 'bun:test';
import { createServer, type Socket } from 'node:net';
import { OpenRouterProvider } from '../../src/services/worker/OpenRouterProvider.js';
import { OpenAICompatProvider } from '../../src/services/worker/OpenAICompatProvider.js';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';
import { SessionManager } from '../../src/services/worker/SessionManager.js';
import { ModeManager } from '../../src/services/domain/ModeManager.js';
import { SettingsDefaultsManager } from '../../src/shared/SettingsDefaultsManager.js';
import * as contextGenerator from '../../src/services/context-generator.js';

async function within<T>(promise: Promise<T>, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), 1000);
    })]);
  } finally { clearTimeout(timer!); }
}

for (const Provider of [OpenRouterProvider, OpenAICompatProvider]) {
  it(`${Provider.name} cancels both live compression requests when the session aborts`, async () => {
    const store = new SessionStore(':memory:', { syncOpsEnabled: false });
    const db = { getSessionStore: () => store, getSessionById: (id: number) => store.getSessionById(id),
      getChromaSync: () => null, getCloudSync: () => null };
    const manager = new SessionManager(db as never);
    const id = store.createSDKSession('owned-compression-abort', 'owned-project', 'Inspect the data.');
    const session = manager.initializeSession(id);
    manager.queueObservation(id, { tool_name: 'Bash', tool_input: { command: 'x'.repeat(20_000) },
      tool_response: { stdout: 'y'.repeat(20_000) }, prompt_number: 1, cwd: process.env.CLAUDE_MEM_DATA_DIR! });
    const settings = spyOn(SettingsDefaultsManager, 'loadFromFile').mockReturnValue({
      ...SettingsDefaultsManager.getAllDefaults(), CLAUDE_MEM_OBSERVE_BARE_PROMPTS: 'false',
      CLAUDE_MEM_FIELD_OPTIMIZE_TIMEOUT_MS: '30000', CLAUDE_MEM_FOLDER_CLAUDEMD_ENABLED: 'false',
    });
    const context = spyOn(contextGenerator, 'generateContext').mockResolvedValue('');
    ModeManager.getInstance().loadMode('code');
    const sockets = new Set<Socket>();
    const requests: string[] = [];
    let announceRequests!: () => void;
    let announceClosed!: () => void;
    const bothRequested = new Promise<void>(resolve => { announceRequests = resolve; });
    const bothClosed = new Promise<void>(resolve => { announceClosed = resolve; });
    let closed = 0;
    // A raw TCP server observes client cancellation before response headers on
    // Bun as well as Node. Hold both requests open until their owner aborts.
    const server = createServer(socket => {
      sockets.add(socket);
      let received = '';
      let counted = false;
      socket.on('data', chunk => {
        received += chunk.toString('utf8');
        const split = received.indexOf('\r\n\r\n');
        if (counted || split === -1) return;
        const length = Number(received.slice(0, split).match(/content-length:\s*(\d+)/i)?.[1]);
        const body = received.slice(split + 4);
        if (Buffer.byteLength(body) < length) return;
        counted = true;
        requests.push(JSON.parse(body).messages[0].content);
        if (requests.length === 2) announceRequests();
      });
      socket.on('error', () => {});
      socket.on('close', () => { sockets.delete(socket); if (counted && ++closed === 2) announceClosed(); });
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const apiUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1/chat/completions`;
    const provider = new Provider(db as never, manager);
    const config = spyOn(provider as any, 'getConfig').mockReturnValue({
      apiKey: 'owned-key', apiKeys: ['owned-key'], model: 'owned/model', apiUrl, fallbackModels: [],
      requiresApiKey: false, preset: { id: 'custom', requiresApiKey: false },
    });
    const contextWindow = spyOn(provider as any, 'resolveContextWindow').mockResolvedValue(40_000);
    let result: Promise<unknown> | undefined;
    try {
      result = provider.startSession(session).catch(error => error);
      await within(bothRequested, 'Both compression fields must reach the owned endpoint');
      expect(requests.every(prompt => prompt.startsWith('Condense the tool payload'))).toBe(true);
      session.abortReason = 'shutdown';
      session.abortController.abort();
      await within(bothClosed, 'Session abort left compression HTTP connections running');
      await within(result, 'Session stayed blocked in field compression after abort');
      expect(requests).toHaveLength(2);
      expect(store.db.query('SELECT COUNT(*) AS count FROM observations').get()).toEqual({ count: 0 });
    } finally {
      session.abortController.abort();
      const serverClosed = new Promise<void>(resolve => server.close(() => resolve()));
      for (const socket of sockets) socket.destroy();
      await result;
      await serverClosed;
      manager.removeSessionImmediate(id);
      settings.mockRestore(); context.mockRestore(); config.mockRestore(); contextWindow.mockRestore();
      store.close();
    }
  }, 6000);
}
