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
 *   {"event":"progress","stage":"...","elapsedMs":N,"port":N}
 *   {"event":"error","message":"..."}
 */

import http from 'http';
import fs from 'fs';
import { ChromaMcpManager } from '../../../src/services/sync/ChromaMcpManager.js';
import { getSupervisor } from '../../../src/supervisor/index.js';
import { getWorkerPort, getWorkerHost } from '../../../src/shared/worker-utils.js';
import { paths } from '../../../src/shared/paths.js';

/**
 * Progress is reported through an append-only EVENTS FILE as well as stdout.
 * The stdout copy is for humans reading the redirected log; the file copy is
 * the CONTRACT. A redirected stdout can be buffered, and a single small line
 * written by a process that then idles can sit unflushed indefinitely — this
 * gate's CI runs died on exactly that shape (the ready line only became
 * visible when the fixture was killed at the 600s cap). The file write cannot
 * hit that: it is a syscall on every call.
 *
 * The path arrives as argv[2], NOT through the environment: a variable written
 * to process.env by the test runner does not survive its child_process call
 * (bun snapshots the environment at startup), so the env-var version of this
 * handshake never wrote a single event — and the stdout fallback in the reader
 * hid that, so every local run "passed" while CI still hung.
 */
const EVENTS_FILE = process.argv[2] ?? null;

function emit(payload: Record<string, unknown>): void {
  const line = `${JSON.stringify(payload)}\n`;
  process.stdout.write(line);
  if (EVENTS_FILE) {
    try {
      fs.appendFileSync(EVENTS_FILE, line, 'utf-8');
    } catch {
      // Best effort — stdout remains the fallback channel.
    }
  }
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
  const startedAt = Date.now();
  // The port rides along on every stage: the parent needs it to sweep a
  // listener left behind even if this fixture never reaches `ready`.
  const progress = (stage: string): void =>
    emit({ event: 'progress', stage, elapsedMs: Date.now() - startedAt, port });

  progress('port-bound');

  const manager = ChromaMcpManager.getInstance();
  const collection = `ghost_fixture_${Date.now()}`;
  progress('create-collection-start');
  await manager.callTool('chroma_create_collection', { collection_name: collection });
  progress('create-collection-done');
  await manager.callTool('chroma_add_documents', {
    collection_name: collection,
    documents: ['ghost fixture document'],
    ids: [`fixture_${Date.now()}`],
  });
  progress('add-documents-done');

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
