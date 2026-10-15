import { gzipSync } from 'node:zlib';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

/**
 * A fake model vendor for wire gateway tests, on node:http (an HTTP stack
 * independent of the gateway's Bun.serve). It records what it got (method,
 * path, query, headers, raw body bytes, whether the client went away) and
 * plays a scripted reply. The idea is magpie's `fake` upstream
 * (internal/gateway/gateway_test.go:23-70, MIT, Copyright (c) 2026 yetone).
 */

export interface RecordedUpstreamRequest {
  method: string;
  path: string;
  query: string;
  headers: Record<string, string>;
  body: Uint8Array;
  /** Set when the request's signal aborted (the gateway cancelled upstream). */
  aborted: boolean;
}

export type FakeUpstreamReply =
  /** A JSON (or any) body, sent whole. A string body is sent byte-for-byte. */
  | { kind: 'json'; status?: number; body: unknown; headers?: Record<string, string> }
  /** text/event-stream, one chunk per entry, `delayMs` before each chunk after the first. */
  | { kind: 'sse'; status?: number; chunks: string[]; delayMs?: number; headers?: Record<string, string> }
  /** The body gzip-encoded, labelled `content-encoding: gzip`. */
  | { kind: 'gzip'; status?: number; body: string; contentType?: string }
  /** SSE chunks, then the connection is torn down with no end of stream. */
  | { kind: 'cut'; chunks: string[]; delayMs?: number }
  /** HTTP 200 SSE whose stream carries an error event (Anthropic style) and ends. */
  | { kind: 'error-after-200'; chunks: string[]; errorEvent: string }
  /** Never answers until the client goes away. */
  | { kind: 'hang' };

export type FakeUpstreamScript = FakeUpstreamReply | ((request: RecordedUpstreamRequest) => FakeUpstreamReply);

export interface FakeUpstream {
  url: string;
  port: number;
  requests: RecordedUpstreamRequest[];
  setReply(script: FakeUpstreamScript): void;
  stop(): Promise<void>;
}

/** SSE frames from lines: each line becomes `line\n\n` (magpie's `sse` helper). */
export function sse(...lines: string[]): string {
  return lines.map(line => `${line}\n\n`).join('');
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function writeChunks(response: ServerResponse, chunks: string[], delayMs: number): Promise<void> {
  for (let index = 0; index < chunks.length; index++) {
    if (index > 0 && delayMs > 0) await sleep(delayMs);
    if (response.destroyed) return;
    response.write(chunks[index]);
  }
}

async function playReply(reply: FakeUpstreamReply, response: ServerResponse): Promise<void> {
  switch (reply.kind) {
    case 'json': {
      const body = typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body);
      response.writeHead(reply.status ?? 200, { 'content-type': 'application/json', ...reply.headers });
      response.end(body);
      return;
    }
    case 'sse':
      response.writeHead(reply.status ?? 200, { 'content-type': 'text/event-stream', ...reply.headers });
      await writeChunks(response, reply.chunks, reply.delayMs ?? 0);
      response.end();
      return;
    case 'gzip':
      response.writeHead(reply.status ?? 200, { 'content-type': reply.contentType ?? 'application/json', 'content-encoding': 'gzip' });
      response.end(gzipSync(reply.body));
      return;
    case 'cut':
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      await writeChunks(response, reply.chunks, reply.delayMs ?? 0);
      await sleep(reply.delayMs ?? 0);
      // Tear the TCP connection down before the terminating chunk. Bun.serve
      // cannot do this: on Bun 1.3.9 an errored body stream still ends with a
      // clean `0\r\n\r\n`, which is why this fake runs on node:http.
      response.socket?.destroy();
      return;
    case 'error-after-200':
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      await writeChunks(response, [...reply.chunks, reply.errorEvent], 0);
      response.end();
      return;
    case 'hang':
      // Never answer; the client's disconnect closes the response.
      return;
  }
}

export async function startFakeUpstream(initialScript: FakeUpstreamScript = { kind: 'json', body: { ok: true } }): Promise<FakeUpstream> {
  let script = initialScript;
  const requests: RecordedUpstreamRequest[] = [];

  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const url = new URL(request.url ?? '/', 'http://fake-upstream');
    const bodyChunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => bodyChunks.push(chunk));
    request.on('end', () => {
      const headers: Record<string, string> = {};
      for (const [name, value] of Object.entries(request.headers)) {
        if (value !== undefined) headers[name] = Array.isArray(value) ? value.join(', ') : value;
      }
      const recorded: RecordedUpstreamRequest = {
        method: request.method ?? 'GET',
        path: url.pathname,
        query: url.search,
        headers,
        body: new Uint8Array(Buffer.concat(bodyChunks)),
        aborted: false,
      };
      // On Bun's node:http only the request's 'close' fires when the client
      // goes away (probed on 1.3.9); a finished response is not an abort.
      request.on('close', () => {
        if (!response.writableFinished) recorded.aborted = true;
      });
      requests.push(recorded);
      const reply = typeof script === 'function' ? script(recorded) : script;
      void playReply(reply, response);
    });
  });

  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('fake upstream did not bind a TCP port');
  }
  return {
    url: `http://127.0.0.1:${address.port}`,
    port: address.port,
    requests,
    setReply(next) {
      script = next;
    },
    async stop() {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    },
  };
}
