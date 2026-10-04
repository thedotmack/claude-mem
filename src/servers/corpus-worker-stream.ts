/**
 * MCP-side client for the long corpus endpoints (build / rebuild / prime /
 * reprime / query). Asks the worker for SSE (`Accept: text/event-stream`), then
 * waits on liveness instead of a wall clock: the worker pings every 10 s, so
 * 30 s of silence means the worker is gone. One absolute cap (15 min) bounds a
 * worker that pings forever without finishing.
 *
 * Returns the same parsed JSON body the JSON mode returns, and throws the same
 * `Worker API error (<status>): <json>` error, so callWorker's MCP output is
 * unchanged. Runs under Node (MCP server): WHATWG streams only.
 */

import { buildWorkerUrl, fetchStreamWithIdleTimeout } from '../shared/worker-utils.js';
import { readSseEvents } from '../shared/sse-reader.js';

export const CORPUS_STREAM_IDLE_TIMEOUT_MS = 30_000;
export const CORPUS_STREAM_ABSOLUTE_CAP_MS = 15 * 60_000;

export interface CorpusStreamTiming {
  idleTimeoutMs: number;
  absoluteCapMs: number;
}

const DEFAULT_CORPUS_STREAM_TIMING: CorpusStreamTiming = {
  idleTimeoutMs: CORPUS_STREAM_IDLE_TIMEOUT_MS,
  absoluteCapMs: CORPUS_STREAM_ABSOLUTE_CAP_MS,
};

const CORPUS_TERMINAL_EVENT_NAMES = ['result', 'error'] as const;

async function readAllText(chunks: AsyncIterable<Uint8Array>): Promise<string> {
  const decoder = new TextDecoder();
  let text = '';
  for await (const chunk of chunks) text += decoder.decode(chunk, { stream: true });
  return text + decoder.decode();
}

export async function postCorpusRequestOverSse(
  endpoint: string,
  body: Record<string, unknown>,
  timing: CorpusStreamTiming = DEFAULT_CORPUS_STREAM_TIMING
): Promise<unknown> {
  const streamed = await fetchStreamWithIdleTimeout(
    buildWorkerUrl(endpoint),
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify(body),
    },
    { idleTimeoutMs: timing.idleTimeoutMs, absoluteCapMs: timing.absoluteCapMs }
  );

  // Rejected before the stream opened (e.g. validateBody 400): plain JSON error, as today.
  if (!streamed.ok) {
    throw new Error(`Worker API error (${streamed.status}): ${await readAllText(streamed.chunks)}`);
  }

  // A worker that predates SSE answers with its single JSON body.
  const contentType = streamed.headers.get('content-type') ?? '';
  if (!contentType.includes('text/event-stream')) {
    return JSON.parse(await readAllText(streamed.chunks));
  }

  // Leaving the loop early closes the body iterator, which releases the request and its timers.
  for await (const sseEvent of readSseEvents(streamed.chunks, { terminalEventNames: CORPUS_TERMINAL_EVENT_NAMES })) {
    if (sseEvent.event === 'result') {
      return JSON.parse(sseEvent.data);
    }
    if (sseEvent.event === 'error') {
      const { status, ...errorBody } = JSON.parse(sseEvent.data) as { status: number } & Record<string, unknown>;
      throw new Error(`Worker API error (${status}): ${JSON.stringify(errorBody)}`);
    }
  }
  // readSseEvents throws StreamEndedEarlyError when no terminal event arrived.
  throw new Error(`Corpus stream for ${endpoint} ended without a terminal event`);
}
