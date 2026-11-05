import { parentPort, workerData } from 'node:worker_threads';
import { WorkStateSource } from './data-source.mjs';
import type { WorkViewReadRequest, WorkViewReadResponse } from './WorkViewReadProtocol.js';

if (!parentPort) throw new Error('Work view reader requires a worker thread');

const source = new WorkStateSource(workerData);
parentPort.on('message', (request: WorkViewReadRequest) => {
  let response: WorkViewReadResponse;
  try {
    source.localDeviceId = request.localDeviceId;
    const read = source.read({ maxActivityAgeMs: request.maxActivityAgeMs });
    response = { id: request.id, ok: true, result: { agentView: read.agentView, agentRevision: source.agentRevision } };
  } catch (error) {
    response = {
      id: request.id,
      ok: false,
      error: { name: error instanceof Error ? error.name : 'Error', message: error instanceof Error ? error.message : String(error) },
    };
  }
  parentPort!.postMessage(response);
});
