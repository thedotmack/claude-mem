/**
 * Fixture host for worker-ghost-port-recovery.test.ts.
 *
 * Impersonates a WORKER THAT DIES OUT-OF-BAND while its chroma-mcp sidecar
 * tree (uvx -> uv -> python) is alive — the exact shape of the ghost-listener
 * bug (plan-15 #3603, reproduced 2026-09-07 and again by the probe that
 * shaped this gate): the test kills THIS process with `taskkill /F /PID`
 * (no `/T`), which runs no shutdown code. The uvx/uv layers read EOF on their
 * MCP stdio pipes and exit, but the persistent chroma-mcp/python sidecar
 * survives holding the inherited listening socket — the port stays LISTENING
 * under this dead PID.
 *
 * IMPORTANT: the parent test must launch this fixture DETACHED (PowerShell
 * Start-Process, the same way spawnDaemon() launches the real worker), NOT as
 * a child of the bun test runner. The runner manages its children with
 * process-tree teardown that does not exist in the production launch path,
 * and the whole point is to reproduce the production shape.
 *
 * Contract with the parent test (stdout redirected to a file, one JSON
 * object per line):
 *   {"event":"ready","pid":N,"port":N,"chromaRootPid":N}
 *   {"event":"error","message":"..."}
 */

import http from 'http';
import fs from 'fs';
import { ChromaMcpManager } from '../../../src/services/sync/ChromaMcpManager.js';
import { getSupervisor } from '../../../src/supervisor/index.js';
import { getWorkerPort, getWorkerHost } from '../../../src/shared/worker-utils.js';
import { paths } from '../../../src/shared/paths.js';

function emit(payload: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

async function main(): Promise<void> {
  const port = getWorkerPort();
  const host = getWorkerHost();

  // 1. Bind the worker port FIRST — the chroma sidecar tree must be spawned
  //    AFTER the listening socket exists, or there is no handle for it to
  //    inherit. The ghost only forms when the socket predates the chain.
  const server = http.createServer((req, res) => {
    if (req.url?.startsWith('/api/health')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', version: '0.0.1-ghost-fixture', pid: process.pid }));
      return;
    }
    if (req.url?.startsWith('/api/readiness')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ready: true }));
      return;
    }
    res.writeHead(404);
    res.end();
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });

  // 2. Build a real chroma-mcp subprocess tree owned by THIS process. Spawned
  //    after the listen above, the chain inherits the listening socket the
  //    way the production worker's sidecar does.
  const manager = ChromaMcpManager.getInstance();
  const collection = `ghost_fixture_${Date.now()}`;
  await manager.callTool('chroma_create_collection', { collection_name: collection });
  await manager.callTool('chroma_add_documents', {
    collection_name: collection,
    documents: ['ghost fixture document'],
    ids: [`fixture_${Date.now()}`],
  });

  const chromaRecord = getSupervisor().getRegistry().getAll().find(r => r.id === 'chroma-mcp');
  if (!chromaRecord?.pid) {
    emit({ event: 'error', message: 'chroma-mcp did not register a pid with the supervisor' });
    process.exit(1);
  }

  fs.mkdirSync(paths.dataDir(), { recursive: true });
  fs.writeFileSync(
    paths.workerPid(),
    JSON.stringify({ pid: process.pid, port, startedAt: new Date().toISOString() }),
    'utf-8'
  );

  emit({ event: 'ready', pid: process.pid, port, chromaRootPid: chromaRecord.pid });

  // 3. Idle until the test kills us. No signal handlers on purpose: a handler
  //    here would shut the tree down cleanly and mask the ghost — the point
  //    is that NOTHING runs when this process dies.
  setInterval(() => {}, 1 << 30);
}

main().catch((error: unknown) => {
  emit({ event: 'error', message: error instanceof Error ? error.message : String(error) });
  process.exit(1);
});
