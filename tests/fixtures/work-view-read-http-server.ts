import { WorkViewReadWorkerClient } from '../../src/services/work-view/WorkViewReadWorkerClient.js';

const databasePath = process.env.WORK_VIEW_READ_FIXTURE_DB;
if (!databasePath) throw new Error('WORK_VIEW_READ_FIXTURE_DB is required');
const reader = new WorkViewReadWorkerClient({ databasePath, ledgerDir: null, pollIntervalMs: 1000 });
const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === '/health') return Response.json({ status: 'ok' });
    if (path !== '/read') return new Response('Not found', { status: 404 });
    console.log('WORK_VIEW_READ_STARTED');
    try {
      const { agentView } = await reader.read(0, '');
      return Response.json({ connected: agentView.source.connected, requests: agentView.humanRequests.length });
    } catch (error) {
      return new Response(error instanceof Error ? error.message : String(error), { status: 500 });
    }
  },
});
console.log(`READER_HTTP_PORT=${server.port}`);
