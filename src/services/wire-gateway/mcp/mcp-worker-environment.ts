// SPDX-License-Identifier: Apache-2.0
//
// The environment the MCP tool table runs in on the wire gateway's /mcp
// (plan Phase 12 task 3): worker calls over a plain socket (direct-http.ts),
// because the gateway is a Bun process whose fetch sends even a loopback
// request through HTTP_PROXY when one is set; and no workspace folder, since
// the daemon's own folder is no agent's checkout. The gateway never starts
// the worker from a tool call (the worker starts the gateway, D14).

import { getWorkerApiRequestTimeoutMs, buildWorkerUrl } from '../../../shared/worker-utils.js';
import type { ClaudeMemToolEnvironment } from '../../../servers/mcp-tool-table.js';
import { CORPUS_STREAM_ABSOLUTE_CAP_MS } from '../../../servers/corpus-worker-stream.js';
import { requestDirectly } from '../direct-http.js';

/** Search and observation answers can be large; far above any real one. */
const MCP_WORKER_RESPONSE_MAX_BYTES = 64 * 1024 * 1024;

/** Statuses a Response may not carry a body with. */
const NULL_BODY_STATUSES = new Set([101, 204, 205, 304]);

export function directHttpToolEnvironment(workerUrlOf: (apiPath: string) => string = buildWorkerUrl): ClaudeMemToolEnvironment {
  return {
    async requestWorker(apiPath, init = {}) {
      const answer = await requestDirectly({
        url: workerUrlOf(apiPath),
        method: init.method ?? (init.jsonBody === undefined ? 'GET' : 'POST'),
        jsonBody: init.jsonBody,
        timeoutMs: getWorkerApiRequestTimeoutMs(),
        maximumResponseBytes: MCP_WORKER_RESPONSE_MAX_BYTES,
      });
      if (!answer) throw new Error(`the worker did not answer ${apiPath.split('?')[0]}`);
      return new Response(NULL_BODY_STATUSES.has(answer.statusCode) ? null : answer.bodyText, { status: answer.statusCode });
    },
    async postCorpus(endpoint, body) {
      // JSON mode (no SSE over a plain socket): the worker answers once, within the corpus cap.
      const answer = await requestDirectly({
        url: workerUrlOf(endpoint),
        method: 'POST',
        jsonBody: body,
        timeoutMs: CORPUS_STREAM_ABSOLUTE_CAP_MS,
        maximumResponseBytes: MCP_WORKER_RESPONSE_MAX_BYTES,
      });
      if (!answer) throw new Error(`the worker did not answer ${endpoint}`);
      if (answer.statusCode !== 200) throw new Error(`Worker API error (${answer.statusCode}): ${answer.bodyText}`);
      return JSON.parse(answer.bodyText) as unknown;
    },
    workspaceFolder: () => null,
    startsWorker: false,
  };
}
