/**
 * Fixture host for worker-recycle-windows.test.ts.
 *
 * Impersonates a STALE-VERSION claude-mem worker that owns a live chroma-mcp
 * subprocess tree, which is the exact shape #3482 describes: the worker holds
 * the listening socket, and uvx -> uv -> python hang off it as descendants.
 *
 * Deliberately a SEPARATE PROCESS. The production recycle path kills
 * `stalePidInfo.pid` — so that pid has to belong to something other than the
 * test runner, or the test would kill itself. It also has to be the real
 * PARENT of the chroma chain, or a tree-kill would have nothing to prove.
 *
 * Contract with the parent test (stdout, one JSON object per line):
 *   {"event":"ready","pid":N,"port":N,"chromaRootPid":N}
 *   {"event":"error","message":"..."}
 */

import http from 'http';
import fs from 'fs';
import { ChromaMcpManager } from '../../../src/services/sync/ChromaMcpManager.js';
import { getSupervisor } from '../../../src/supervisor/index.js';
import { getWorkerPort, getWorkerHost } from '../../../src/shared/worker-utils.js';
import { paths } from '../../../src/shared/paths.js';

/** Any version the resolved plugin will not match, so the recycle triggers. */
const STALE_VERSION = '0.0.1-stale-fixture';

function emit(payload: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

async function main(): Promise<void> {
  const port = getWorkerPort();
  const host = getWorkerHost();

  // 1. Build a real chroma-mcp subprocess tree owned by THIS process.
  const manager = ChromaMcpManager.getInstance();
  const collection = `recycle_fixture_${Date.now()}`;
  await manager.callTool('chroma_create_collection', { collection_name: collection });
  await manager.callTool('chroma_add_documents', {
    collection_name: collection,
    documents: ['stale worker fixture document'],
    ids: [`fixture_${Date.now()}`],
  });

  const chromaRecord = getSupervisor().getRegistry().getAll().find(r => r.id === 'chroma-mcp');
  if (!chromaRecord?.pid) {
    emit({ event: 'error', message: 'chroma-mcp did not register a pid with the supervisor' });
    process.exit(1);
  }

  // 2. Serve the endpoints the production liveness + version probes read.
  //    isWorkerPortAlive() needs /api/health to be ok; checkVersionMatch()
  //    reads .version from that same body and must see a MISMATCH.
  const server = http.createServer((req, res) => {
    if (req.url?.startsWith('/api/health')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', version: STALE_VERSION, pid: process.pid }));
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

  // 3. Claim ownership of the port the way a real worker does, so
  //    readOwnedWorkerPidInfo() returns THIS pid and the recycle targets us.
  //    No startToken: verifyPidFileOwnership() treats it as optional and
  //    falls back to a liveness check.
  fs.mkdirSync(paths.dataDir(), { recursive: true });
  fs.writeFileSync(
    paths.workerPid(),
    JSON.stringify({ pid: process.pid, port, startedAt: new Date().toISOString() }),
    'utf-8'
  );

  emit({ event: 'ready', pid: process.pid, port, chromaRootPid: chromaRecord.pid });

  // 4. Idle until the recycle kills us. No signal handlers on purpose: a
  //    handler here would let this process shut its own tree down cleanly and
  //    mask whether the production kill reached the descendants.
  setInterval(() => {}, 1 << 30);
}

main().catch((error: unknown) => {
  emit({ event: 'error', message: error instanceof Error ? error.message : String(error) });
  process.exit(1);
});
