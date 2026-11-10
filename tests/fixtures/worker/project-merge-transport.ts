import { createServer } from 'node:http';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';
import { runProjectMergeCommand } from '../../../src/services/infrastructure/ProjectMerge.js';
import { fetchWithTimeout } from '../../../src/shared/worker-utils.js';

const mode = process.argv[2];
const dataDirectory = process.env.CLAUDE_MEM_DATA_DIR!;
writeFileSync(join(dataDirectory, 'settings.json'), JSON.stringify({ CLAUDE_MEM_CHROMA_ENABLED: 'false' }));
const store = new SessionStore(join(dataDirectory, 'claude-mem.db'));
const sessionId = store.createSDKSession('source-session', 'frontend', 'prompt');
store.ensureMemorySessionIdRegistered(sessionId, 'source-memory');
store.importObservation({
  memory_session_id: 'source-memory', project: 'frontend', text: 'retained memory',
  type: 'discovery', title: 'Source observation', subtitle: null, narrative: null,
  facts: null, concepts: null, files_read: null, files_modified: null,
  prompt_number: 1, discovery_tokens: 0,
  created_at: '2026-11-01T00:00:00.000Z', created_at_epoch: Date.parse('2026-11-01T00:00:00.000Z'),
});
const queuedBefore = store.db.query('SELECT COUNT(*) AS n FROM sync_outbox').get() as { n: number };
const received: unknown[] = [];
const server = createServer(async (request, response) => {
  let body = '';
  for await (const chunk of request) body += chunk.toString();
  received.push({ path: request.url, method: request.method, body: JSON.parse(body) });
  if (mode === 'reset') request.socket.destroy();
  // In the deadline case, the live worker still owns its accepted operation
  // but has not sent response headers. A client timeout cannot prove refusal.
});
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
if (!address || typeof address === 'string') throw new Error('Expected a loopback port');
if (mode === 'refused') await new Promise<void>(resolve => server.close(() => resolve()));
let transportError: unknown;
let failure: unknown;
let result: Awaited<ReturnType<typeof runProjectMergeCommand>> | undefined;
try {
  result = await runProjectMergeCommand({ from: 'frontend', into: 'work', dataDirectory }, async (pathname, options = {}) => {
    try {
      return await fetchWithTimeout(`http://127.0.0.1:${address.port}${pathname}`, {
        method: options.method, headers: options.headers, body: options.body,
      }, 1000);
    } catch (error) {
      transportError = error;
      throw error;
    }
  });
} catch (error) { failure = error; }
try {
  const row = store.db.query('SELECT merged_into_project FROM observations').get();
  const queuedAfter = store.db.query('SELECT COUNT(*) AS n FROM sync_outbox').get() as { n: number };
  console.log(JSON.stringify({
    received, result: result ?? null, rejected: failure !== undefined,
    preservedError: failure !== undefined && failure === transportError,
    timeout: failure instanceof Error && failure.name === 'WorkerRequestTimeoutError',
    row, newOperations: queuedAfter.n - queuedBefore.n,
  }));
} finally {
  server.closeAllConnections();
  if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
  store.close();
}
