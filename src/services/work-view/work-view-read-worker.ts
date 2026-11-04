import { parentPort, workerData } from 'node:worker_threads';
import { WorkStateSource } from './data-source.mjs';
import { boundedDurationMs, type WorkViewReaderMessage, type WorkViewReadResponse, type WorkViewReadStarted } from './WorkViewReadProtocol.js';
import { readHistoricalSyncScope } from '../sync/read-history-scope.js';
import { Database } from 'bun:sqlite';
import { SharedLedgerAdapter } from './shared-ledger-adapter.mjs';
import { readSyncQueueInventory, type SyncQueueFlags } from '../sync/SyncQueueEvidence.js';
import { RecoveryError, SyncRecovery, type RecoveryScope } from '../sync/SyncRecovery.js';
import { getNativeContentOperation } from '../sync/CloudSync.js';
import { listConflictEvidence, readLocalConflictEvidence, SyncRecoveryError } from '../sync/SyncConflictEvidence.js';
import type { ContentKind } from '../sync/CanonicalContent.js';

if (!parentPort) throw new Error('Work view reader requires a worker thread');

// This role always runs in a separate worker instance. A historical scan can
// neither stall HTTP nor sit ahead of a requested work-view projection.
if (workerData.kind === 'shared-work-sync') {
  const db = new Database(workerData.databasePath, { readwrite: true, create: false });
  db.exec('PRAGMA busy_timeout = 1000');
  let changed = false;
  let rulesChanged = false;
  const adapter = new SharedLedgerAdapter(db, { directory: workerData.directory, deviceId: workerData.deviceId,
    notify: change => { changed = true; rulesChanged ||= change?.rules === true; } });
  parentPort.on('message', () => {
    changed = false;
    rulesChanged = false;
    let diagnostic: unknown;
    try { diagnostic = adapter.reconcile(); }
    catch { diagnostic = { error: 'Shared work could not be refreshed; retrying.' }; }
    parentPort!.postMessage({ changed, rulesChanged, diagnostic });
  });
} else if (workerData.kind === 'sync-recovery') {
  const db = new Database(workerData.databasePath, { readonly: true });
  db.exec('PRAGMA busy_timeout = 1000');
  parentPort.on('message', (request: { id: number; kind: 'inventory' | 'preview' | 'conflict-evidence' | 'conflict-list'; scope: RecoveryScope; flags: SyncQueueFlags; contentKind: ContentKind; originLocalId: string; limit: number }) => {
    try {
      const recovery = new SyncRecovery(db, workerData.deviceId, {
        snapshotNative: (kind, id) => getNativeContentOperation(db, kind, id, workerData.deviceId),
        flags: () => request.flags,
      });
      const result = request.kind === 'inventory' ? recovery.inventory()
        : request.kind === 'conflict-list' ? listConflictEvidence(db, request.limit)
        : request.kind === 'conflict-evidence' ? readLocalConflictEvidence(db, workerData.deviceId, request.contentKind, request.originLocalId)
        : recovery.preview(request.scope);
      parentPort!.postMessage({ id: request.id, ok: true, result });
    } catch (error) {
      parentPort!.postMessage({ id: request.id, ok: false,
        code: error instanceof RecoveryError || error instanceof SyncRecoveryError ? error.code : 'recovery_read_failed',
        status: error instanceof RecoveryError || error instanceof SyncRecoveryError ? error.status : 503 });
    }
  });
} else if (workerData.kind === 'sync-queue-evidence') {
  // Separate instance from both HTTP projection and history inventory readers.
  const db = new Database(workerData.databasePath, { readonly: true });
  db.exec('PRAGMA busy_timeout = 1000');
  parentPort.on('message', (flags: SyncQueueFlags) => {
    let inventory = null;
    try { inventory = readSyncQueueInventory(db, flags); } catch { /* Preserve the last cached observation on failure. */ }
    parentPort!.postMessage(inventory);
  });
} else if (workerData.kind === 'sync-history-scope') {
  parentPort.on('message', () => {
    let count: number | null = null;
    try { count = readHistoricalSyncScope(workerData.databasePath); } catch { /* Scope is unknown on read failure. */ }
    parentPort!.postMessage(count);
  });
} else {
  const source = new WorkStateSource(workerData);
  parentPort.on('message', (request: WorkViewReaderMessage) => {
    if (request.kind === 'invalidate-activity') { source.invalidateActivity(request.workState); return; }
    const startedAtNs = process.hrtime.bigint();
    parentPort!.postMessage({ id: request.id, started: true } satisfies WorkViewReadStarted);
    const timing = () => ({ readMs: boundedDurationMs(Number(process.hrtime.bigint() - startedAtNs) / 1e6) });
    let response: WorkViewReadResponse;
    try {
      source.localDeviceId = request.localDeviceId;
      const read = request.kind === 'rules'
        ? { agentView: { ...source.readRules(), humanRequests: [], revision: 0 } }
        : source.read({ maxActivityAgeMs: request.maxActivityAgeMs });
      response = { id: request.id, ok: true, result: { agentView: read.agentView, agentRevision: source.agentRevision }, timing: timing() };
    } catch (error) {
      response = {
        id: request.id,
        ok: false,
        error: { name: error instanceof Error ? error.name : 'Error', message: error instanceof Error ? error.message : String(error) },
        timing: timing(),
      };
    }
    parentPort!.postMessage(response);
  });
}
