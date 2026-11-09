import { workerHttpRequest, getWorkerHost } from '../shared/worker-utils.js';
import { loadFromFileOnce } from '../shared/hook-settings.js';
import { remoteHookSpoolReceipt, type HookSpoolEntry } from '../shared/hook-spool.js';
import { remoteHookSpoolToken, usesRemoteHookSpool, REMOTE_SPOOL_PROTOCOL_VERSION } from '../shared/hook-spool-remote.js';
import { logger } from '../utils/logger.js';
import { deliverLiveObserverHandoff } from '../shared/live-observer-handoff.js';

/** One live handoff, no disk outbox, background child, or delivery retry. */
export { LIVE_OBSERVER_HANDOFF_TIMEOUT_MS } from '../shared/live-observer-handoff.js';
const handoffs = new Set<Promise<void>>();

export function sendLiveObserverEvent(entry: HookSpoolEntry): string {
  const receipt = remoteHookSpoolReceipt(entry);
  const handoff = deliver(entry).catch(() => {
    // An ambiguous handoff is never resent: the worker may already have it.
    logger.debug('HOOK', 'Live observer handoff unavailable; skipped event', { kind: entry.kind });
  });
  handoffs.add(handoff);
  void handoff.finally(() => handoffs.delete(handoff));
  return receipt;
}

export async function settleLiveObserverEvents(): Promise<void> {
  await Promise.all([...handoffs]);
}

async function deliver(entry: HookSpoolEntry): Promise<void> {
  const settings = loadFromFileOnce();
  let path: string;
  let body: unknown;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (usesRemoteHookSpool(getWorkerHost(), settings.CLAUDE_MEM_HOOK_SPOOL_TRANSPORT, settings.CLAUDE_MEM_WORKER_URL)) {
    const token = remoteHookSpoolToken(settings.CLAUDE_MEM_WORKER_INGEST_TOKEN);
    if (!token) return;
    path = '/api/spool/ingest';
    headers.Authorization = `Bearer ${token}`;
    body = { protocolVersion: REMOTE_SPOOL_PROTOCOL_VERSION, entry };
  } else if (entry.kind === 'observation' || entry.kind === 'file_edit') {
    path = '/api/sessions/observations';
    // The route reads only the snake_case tool fields. Sending the camelCase
    // copies too would double a large result past the worker's 5mb JSON cap.
    const { toolName, toolInput, toolResponse, ...rest } = entry.payload;
    body = { ...rest, tool_name: toolName, tool_input: toolInput, tool_response: toolResponse,
      enqueuedAtEpochMs: entry.enqueuedAtEpochMs };
  } else if (entry.kind === 'summarize') {
    path = '/api/sessions/summarize';
    const { lastAssistantMessage, ...rest } = entry.payload;
    body = { ...rest, last_assistant_message: lastAssistantMessage,
      enqueuedAtEpochMs: entry.enqueuedAtEpochMs };
  } else {
    throw new Error(`Not a live observer event: ${entry.kind}`);
  }
  await deliverLiveObserverHandoff(timeoutMs => workerHttpRequest(path, { method: 'POST', headers,
    body: JSON.stringify(body), timeoutMs, idleTimeoutMs: timeoutMs }));
}
