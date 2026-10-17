import { gzipSync } from 'node:zlib';
import { createServer, type Server, type Socket } from 'node:net';

/**
 * A fake model vendor for wire gateway tests. It records what it got (method,
 * path, query, headers, raw body bytes, whether the client went away) and
 * plays a scripted reply. The idea is magpie's `fake` upstream
 * (internal/gateway/gateway_test.go:23-70, MIT, Copyright (c) 2026 yetone).
 *
 * It speaks HTTP/1.1 straight over node:net, because both of Bun's HTTP
 * servers hide something these tests must see (probed on Bun 1.3.9):
 * - Bun.serve ends a response cleanly even when its body stream errors, so it
 *   cannot cut a stream mid-way.
 * - Bun's node:http server reports no client disconnect at all once the
 *   request body has been read (no 'close', 'aborted' or socket event), and
 *   fires the request's 'close' on every normal request, so an abort cannot
 *   be told apart.
 * A raw socket shows both: destroy() cuts, and 'close' before the reply
 * finished is an abort. Keep-alive is supported, so connection reuse (and
 * fetch's replay-on-reuse) is observable.
 */

export interface RecordedUpstreamRequest {
  method: string;
  path: string;
  query: string;
  headers: Record<string, string>;
  body: Uint8Array;
  /** Set when the client closed the connection before the reply finished (the gateway cancelled upstream). */
  aborted: boolean;
  /** Which TCP connection carried it (1-based, in accept order). */
  connectionNumber: number;
}

export type FakeUpstreamReply =
  /** A JSON (or any) body, sent whole. A string body is sent byte-for-byte. */
  | { kind: 'json'; status?: number; body: unknown; headers?: Record<string, string> }
  /** text/event-stream, one chunk per entry, `delayMs` before each chunk after the first. */
  /** omitContentType: no content-type header at all, as ChatGPT's Codex backend streams. */
  | { kind: 'sse'; status?: number; chunks: string[]; delayMs?: number; headers?: Record<string, string>; omitContentType?: boolean }
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

const STATUS_TEXT: Record<number, string> = { 200: 'OK', 400: 'Bad Request', 401: 'Unauthorized', 404: 'Not Found', 429: 'Too Many Requests', 500: 'Internal Server Error', 529: 'Overloaded' };

function headBlock(status: number, headers: Record<string, string>): string {
  const lines = [`HTTP/1.1 ${status} ${STATUS_TEXT[status] ?? 'Status'}`];
  for (const [name, value] of Object.entries(headers)) lines.push(`${name}: ${value}`);
  return `${lines.join('\r\n')}\r\n\r\n`;
}

function chunkFrame(text: string): Buffer {
  const bytes = Buffer.from(text);
  return Buffer.concat([Buffer.from(`${bytes.length.toString(16)}\r\n`), bytes, Buffer.from('\r\n')]);
}

interface ParsedRequestHead {
  method: string;
  target: string;
  headers: Record<string, string>;
  headerBytes: number;
}

function parseRequestHead(buffered: Buffer): ParsedRequestHead | null {
  const end = buffered.indexOf('\r\n\r\n');
  if (end === -1) return null;
  const [requestLine, ...headerLines] = buffered.subarray(0, end).toString('latin1').split('\r\n');
  const [method, target] = requestLine.split(' ');
  const headers: Record<string, string> = {};
  for (const line of headerLines) {
    const colon = line.indexOf(':');
    const name = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    headers[name] = headers[name] === undefined ? value : `${headers[name]}, ${value}`;
  }
  return { method, target, headers, headerBytes: end + 4 };
}

export async function startFakeUpstream(initialScript: FakeUpstreamScript = { kind: 'json', body: { ok: true } }): Promise<FakeUpstream> {
  let script = initialScript;
  const requests: RecordedUpstreamRequest[] = [];
  const sockets = new Set<Socket>();
  let connectionCount = 0;

  async function playReply(reply: FakeUpstreamReply, socket: Socket, isHead: boolean, markReplyFinished: () => void): Promise<'keep' | 'closed'> {
    const write = (data: string | Buffer) => {
      if (!socket.destroyed) socket.write(data);
    };
    const sendWhole = (status: number, headers: Record<string, string>, body: Buffer) => {
      write(headBlock(status, { ...headers, 'content-length': String(body.length) }));
      if (!isHead) write(body);
    };
    const streamChunks = async (chunks: string[], delayMs: number) => {
      for (let index = 0; index < chunks.length; index++) {
        if (index > 0 && delayMs > 0) await sleep(delayMs);
        write(chunkFrame(chunks[index]));
      }
    };
    switch (reply.kind) {
      case 'json': {
        const body = typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body);
        sendWhole(reply.status ?? 200, { 'content-type': 'application/json', ...reply.headers }, Buffer.from(body));
        return 'keep';
      }
      case 'gzip':
        sendWhole(reply.status ?? 200, { 'content-type': reply.contentType ?? 'application/json', 'content-encoding': 'gzip' }, gzipSync(reply.body));
        return 'keep';
      case 'sse':
        write(headBlock(reply.status ?? 200, {
          ...(reply.omitContentType ? {} : { 'content-type': 'text/event-stream' }),
          'transfer-encoding': 'chunked',
          ...reply.headers,
        }));
        await streamChunks(reply.chunks, reply.delayMs ?? 0);
        write('0\r\n\r\n');
        return 'keep';
      case 'error-after-200':
        write(headBlock(200, { 'content-type': 'text/event-stream', 'transfer-encoding': 'chunked' }));
        await streamChunks([...reply.chunks, reply.errorEvent], 0);
        write('0\r\n\r\n');
        return 'keep';
      case 'cut':
        write(headBlock(200, { 'content-type': 'text/event-stream', 'transfer-encoding': 'chunked' }));
        await streamChunks(reply.chunks, reply.delayMs ?? 0);
        await sleep(reply.delayMs ?? 0);
        // Tear the TCP connection down before the terminating chunk. The
        // fake did this itself, so it is no client abort.
        markReplyFinished();
        socket.destroy();
        return 'closed';
      case 'hang':
        // Never answer; the client's disconnect closes the connection.
        await new Promise<void>(resolve => socket.once('close', () => resolve()));
        return 'closed';
    }
  }

  const server: Server = createServer(socket => {
    connectionCount++;
    const connectionNumber = connectionCount;
    sockets.add(socket);
    let buffered = Buffer.alloc(0);
    let inFlight: RecordedUpstreamRequest | null = null;
    let busy = false;

    socket.on('close', () => {
      sockets.delete(socket);
      if (inFlight) inFlight.aborted = true;
    });
    socket.on('error', () => undefined);

    const serveBuffered = async () => {
      if (busy) return;
      busy = true;
      try {
        for (;;) {
          const head = parseRequestHead(buffered);
          if (!head) return;
          if (head.headers['transfer-encoding']) {
            throw new Error('fake upstream reads Content-Length bodies only');
          }
          const bodyLength = Number(head.headers['content-length'] ?? 0);
          if (buffered.length < head.headerBytes + bodyLength) return;
          const body = new Uint8Array(buffered.subarray(head.headerBytes, head.headerBytes + bodyLength));
          buffered = buffered.subarray(head.headerBytes + bodyLength);

          const url = new URL(head.target, 'http://fake-upstream');
          const recorded: RecordedUpstreamRequest = {
            method: head.method,
            path: url.pathname,
            query: url.search,
            headers: head.headers,
            body,
            aborted: false,
            connectionNumber,
          };
          requests.push(recorded);
          inFlight = recorded;
          const reply = typeof script === 'function' ? script(recorded) : script;
          const connection = await playReply(reply, socket, head.method === 'HEAD', () => {
            inFlight = null;
          });
          if (connection === 'closed') return;
          inFlight = null;
          if (head.headers.connection?.toLowerCase() === 'close') {
            socket.end();
            return;
          }
        }
      } finally {
        busy = false;
      }
    };

    socket.on('data', (data: Buffer) => {
      buffered = Buffer.concat([buffered, data]);
      void serveBuffered();
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
      for (const socket of sockets) socket.destroy();
      await new Promise<void>(resolve => server.close(() => resolve()));
    },
  };
}
