import { HookSpool, remoteHookSpoolReceipt, type HookSpoolKind, type HookSpoolPayloadByKind } from '../shared/hook-spool.js';
import { workerHttpRequest, getWorkerHost } from '../shared/worker-utils.js';
import { resolveWorkerScriptPath } from '../shared/worker-utils.js';
import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { resolveDataDir } from '../shared/paths.js';
import { sanitizeEnv } from '../supervisor/env-sanitizer.js';
import { loadFromFileOnce } from '../shared/hook-settings.js';
import { selectRuntime } from '../services/hooks/runtime-selector.js';
import { REMOTE_SPOOL_PROTOCOL_VERSION, REMOTE_SPOOL_TIMEOUT_MS, REMOTE_SPOOL_MAX_ENTRIES,
  usesRemoteHookSpool, remoteHookSpoolToken } from '../shared/hook-spool-remote.js';
import { logger } from '../utils/logger.js';

export const SPOOL_NUDGE_TIMEOUT_MS = 250;

const nudgesInFlight = new Set<Promise<void>>();
let pendingNudge: Promise<void> | null = null;
let remoteUploadRequested = false;

export async function uploadRemoteHookSpool(): Promise<void> {
  const settings = loadFromFileOnce();
  const token = remoteHookSpoolToken(settings.CLAUDE_MEM_WORKER_INGEST_TOKEN);
  if (!token) {
    logger.warn('HOOK', 'Remote hook capture is queued locally; configure CLAUDE_MEM_WORKER_INGEST_TOKEN on the client and worker');
    return;
  }
  let deadline: number | null = null;
  let attempted = 0;
  let failed = false;
  const canContinue = () => {
    // Queue discovery runs in the uploader, outside the hook's latency budget.
    deadline ??= Date.now() + REMOTE_SPOOL_TIMEOUT_MS;
    return Date.now() < deadline && attempted < REMOTE_SPOOL_MAX_ENTRIES && !failed;
  };
  await new HookSpool().drain(async entry => {
      attempted++;
      try {
        const remaining = Math.max(1, deadline! - Date.now());
        const response = await workerHttpRequest('/api/spool/ingest', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ protocolVersion: REMOTE_SPOOL_PROTOCOL_VERSION, entry }),
          timeoutMs: remaining,
          idleTimeoutMs: remaining,
        });
        if (!response.ok) {
          let rejection: unknown;
          try { rejection = await response.json(); } catch {}
          if (response.status === 413 || (response.status === 400 && rejection !== null
            && typeof rejection === 'object' && (rejection as Record<string, unknown>).code === 'INVALID_SPOOL_ENTRY')) {
            logger.error('HOOK', 'Remote worker rejected a capture event; preserving it in corrupt/ and continuing', { status: response.status });
            return 'rejected';
          }
          throw new Error(`Remote spool ingestion returned HTTP ${response.status}`);
        }
        const ack: unknown = await response.json();
        if (ack === null || typeof ack !== 'object'
          || (ack as Record<string, unknown>).protocolVersion !== REMOTE_SPOOL_PROTOCOL_VERSION
          || (ack as Record<string, unknown>).status !== 'accepted'
          || (ack as Record<string, unknown>).receipt !== remoteHookSpoolReceipt(entry)) {
          throw new Error('Remote worker did not acknowledge the exact spool event');
        }
        return true;
      } catch (error: unknown) {
        failed = true;
        logger.warn('HOOK', 'Remote hook capture remains queued locally; the next hook retries delivery', {
          error: error instanceof Error ? error.message : String(error),
        });
        return false;
      }
  }, undefined, { shouldContinue: canContinue, verifyUnchanged: true, maxEntries: REMOTE_SPOOL_MAX_ENTRIES });
}

function scheduleRemoteHookSpoolUpload(): void {
  const token = remoteHookSpoolToken(loadFromFileOnce().CLAUDE_MEM_WORKER_INGEST_TOKEN);
  if (!token) {
    logger.warn('HOOK', 'Remote hook capture is queued locally; configure CLAUDE_MEM_WORKER_INGEST_TOKEN on the client and worker');
    return;
  }
  const currentScript = process.argv[1];
  const script = currentScript && /worker-service\.(?:cjs|ts)$/.test(currentScript) && existsSync(currentScript)
    ? currentScript : resolveWorkerScriptPath();
  if (!script) {
    logger.warn('HOOK', 'Remote hook upload entrypoint is unavailable; retaining the outbox');
    return;
  }
  try {
    const child = spawn(process.execPath, [script, 'upload-spool'], {
      cwd: resolveDataDir(), env: sanitizeEnv(process.env),
      detached: true, windowsHide: true, stdio: 'ignore',
    });
    child.on('error', () => logger.warn('HOOK', 'Remote hook uploader could not start; retaining the outbox'));
    child.unref();
  } catch {
    logger.warn('HOOK', 'Remote hook uploader could not start; retaining the outbox');
  }
}

/**
 * Best-effort poke so a running worker drains now rather than on its fs.watch
 * event or safety sweep. Never spawns a worker, never rejects, and its outcome
 * is irrelevant: the spool file is already durable. Started as soon as the
 * event is spooled; hookCommand awaits it (bounded by the 250 ms request
 * timeout) before process.exit, which would otherwise cut it off mid-flight.
 *
 * A nudge still in flight is shared: a standalone transcript watcher catching
 * up spools many events in a burst, and the worker's drain (or its fs.watch of
 * the spool, or its sweep) takes every entry there is.
 */
export function nudgeWorkerToDrainHookSpool(): Promise<void> {
  const settings = loadFromFileOnce();
  if (usesRemoteHookSpool(getWorkerHost(), settings.CLAUDE_MEM_HOOK_SPOOL_TRANSPORT)) {
    remoteUploadRequested = true;
    scheduleRemoteHookSpoolUpload();
    return Promise.resolve();
  }
  if (pendingNudge) return pendingNudge;
  const nudge = (async () => {
    try {
      const response = await workerHttpRequest('/api/spool/nudge', { method: 'POST', timeoutMs: SPOOL_NUDGE_TIMEOUT_MS });
      await response.body?.cancel();
    } catch (error: unknown) {
      logger.debug('HOOK', 'Hook spool nudge not delivered (worker will pick the entry up on its own)', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  })();
  pendingNudge = nudge;
  nudgesInFlight.add(nudge);
  void nudge.finally(() => {
    nudgesInFlight.delete(nudge);
    if (pendingNudge === nudge) pendingNudge = null;
  });
  return nudge;
}

/** Resolves once every nudge this process started has been delivered or timed out (≤ 250 ms). */
export async function settleHookSpoolNudges(): Promise<void> {
  if (!pendingNudge && !remoteUploadRequested && selectRuntime() === 'worker') {
    const settings = loadFromFileOnce();
    if (usesRemoteHookSpool(getWorkerHost(), settings.CLAUDE_MEM_HOOK_SPOOL_TRANSPORT)
      && new HookSpool().hasEntries()) {
      void nudgeWorkerToDrainHookSpool();
    }
  }
  await Promise.all([...nudgesInFlight]);
  remoteUploadRequested = false;
}

/**
 * Write-hook hand-off: persist the event to the hook spool, start the poke to
 * the worker, return. The handler makes no awaited worker call and no
 * readiness wait; only hookCommand's exit waits (≤ 250 ms) for the poke.
 */
export function spoolHookEvent<K extends HookSpoolKind>(kind: K, payload: HookSpoolPayloadByKind[K]): string {
  const entryPath = new HookSpool().enqueue(kind, payload);
  logger.debug('HOOK', 'Hook event spooled for the worker', { kind, entryPath });
  void nudgeWorkerToDrainHookSpool();
  return entryPath;
}
