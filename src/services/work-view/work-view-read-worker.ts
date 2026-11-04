import { parentPort, workerData } from 'node:worker_threads';
import { WorkStateSource } from './data-source.mjs';
import { boundedDurationMs, type WorkViewReaderMessage, type WorkViewReadResponse, type WorkViewReadStarted } from './WorkViewReadProtocol.js';

if (!parentPort) throw new Error('Work view reader requires a worker thread');

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
