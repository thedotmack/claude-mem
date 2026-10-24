// SPDX-License-Identifier: Apache-2.0
//
// HTTP to the gateway's own address that never takes a proxy. Bun's fetch
// (and on 1.3.9 node:http too) sends even a loopback request through
// HTTP_PROXY when it is set at launch, and an empty `proxy` option does not
// turn that off (probed on Bun 1.3.9 and 1.4.3). Behind a proxy that does
// not pass loopback on, a fetch could not tell "the gateway is down" from "a
// proxy is in the way" — and `wire connect` would undo itself. So every
// request the CLI or the gateway makes to http://<gateway>/ goes over a plain
// socket here. https:// addresses (a reverse proxy in front of the gateway)
// use fetch: they are not this machine's gateway port.

import { connect } from 'net';

/** Identity answers are small; a status report for every agent stays far below this. */
export const DIRECT_HTTP_DEFAULT_MAXIMUM_RESPONSE_BYTES = 4 * 1024 * 1024;

export interface DirectHttpRequest {
  url: string;
  method?: 'GET' | 'POST';
  /** Sent as JSON with content-type application/json. */
  jsonBody?: unknown;
  timeoutMs: number;
  maximumResponseBytes?: number;
  /** Gives up when it aborts (null; requestDirectlyWithOutcome says `aborted`). */
  signal?: AbortSignal;
}

export interface DirectHttpResponse {
  statusCode: number;
  bodyText: string;
}

/** A chunked body's data, or null when it is incomplete or malformed. Linear in the body. */
function decodeChunkedBody(raw: Buffer): Buffer | null {
  const parts: Buffer[] = [];
  let offset = 0;
  while (offset < raw.length) {
    const lineEnd = raw.indexOf('\r\n', offset);
    if (lineEnd === -1) return null;
    const size = parseInt(raw.subarray(offset, lineEnd).toString('latin1').split(';')[0].trim(), 16);
    if (!Number.isFinite(size) || size < 0) return null;
    if (size === 0) return Buffer.concat(parts);
    const dataStart = lineEnd + 2;
    if (dataStart + size > raw.length) return null;
    parts.push(raw.subarray(dataStart, dataStart + size));
    offset = dataStart + size + 2;
  }
  return null;
}

interface RawHttpHead {
  statusCode: number;
  chunked: boolean;
  /** The Content-Length header's value; null when there is none (or it is not a number). */
  contentLength: number | null;
  body: Buffer;
}

function readRawHttpHead(raw: Buffer): RawHttpHead | null {
  const headerEnd = raw.indexOf('\r\n\r\n');
  if (headerEnd === -1) return null;
  const headerLines = raw.subarray(0, headerEnd).toString('latin1').split('\r\n');
  const statusMatch = /^HTTP\/1\.[01] (\d{3})/.exec(headerLines[0] ?? '');
  if (!statusMatch) return null;
  let chunked = false;
  let contentLength: number | null = null;
  for (const line of headerLines.slice(1)) {
    const separator = line.indexOf(':');
    if (separator === -1) continue;
    const name = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    if (name === 'transfer-encoding' && value.toLowerCase().includes('chunked')) chunked = true;
    if (name === 'content-length' && /^\d+$/.test(value)) contentLength = Number(value);
  }
  return { statusCode: Number(statusMatch[1]), chunked, contentLength, body: raw.subarray(headerEnd + 4) };
}

/** Status and body of a raw HTTP/1.1 response read until the server closed. */
export function parseRawHttpResponse(raw: Buffer): DirectHttpResponse | null {
  const head = readRawHttpHead(raw);
  if (!head) return null;
  const decoded = head.chunked ? decodeChunkedBody(head.body) : head.body;
  if (decoded === null) return null;
  return { statusCode: head.statusCode, bodyText: decoded.toString('utf-8') };
}

/**
 * The response as soon as its own framing says it is whole: Content-Length
 * bytes of body, or a chunked body's last chunk. null while more is due, and
 * for a response only the server's close can end. Needed because Bun 1.3.9's
 * Bun.serve keeps the connection open after a response it sent late (a
 * long-poll), whatever `Connection: close` asked; probed on 1.3.9 and 1.4.3.
 */
export function parseCompleteRawHttpResponse(raw: Buffer): DirectHttpResponse | null {
  const head = readRawHttpHead(raw);
  if (!head) return null;
  if (head.chunked) {
    const decoded = decodeChunkedBody(head.body);
    return decoded === null ? null : { statusCode: head.statusCode, bodyText: decoded.toString('utf-8') };
  }
  if (head.contentLength === null || head.body.length < head.contentLength) return null;
  return { statusCode: head.statusCode, bodyText: head.body.subarray(0, head.contentLength).toString('utf-8') };
}

/**
 * A fetch response's body as text, or null once it passes `maximumResponseBytes`
 * (the rest is cancelled, never buffered). A declared Content-Length over the
 * cap is refused before any byte is read.
 */
export async function readResponseTextWithinLimit(response: Response, maximumResponseBytes: number): Promise<string | null> {
  const declaredLength = Number(response.headers.get('content-length') ?? NaN);
  if (Number.isFinite(declaredLength) && declaredLength > maximumResponseBytes) {
    await response.body?.cancel().catch(() => undefined);
    return null;
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let receivedBytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    receivedBytes += value.byteLength;
    if (receivedBytes > maximumResponseBytes) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf-8');
}

/** Why a direct request has no answer. */
export type DirectHttpFailure =
  | { reason: 'aborted' }
  | { reason: 'timeout'; timeoutMs: number }
  | { reason: 'unreachable'; detail: string }
  | { reason: 'too_large'; maximumResponseBytes: number }
  | { reason: 'not_http' }
  /** The server closed the connection without sending a byte (a gateway shutting down, or one that cut a silent connection). */
  | { reason: 'closed' }
  | { reason: 'bad_url'; detail: string };

export type DirectHttpOutcome = { response: DirectHttpResponse } | { failure: DirectHttpFailure };

/** A failure as words, for an error message: `what` names the server asked ("the worker"). */
export function describeDirectHttpFailure(failure: DirectHttpFailure, what: string): string {
  switch (failure.reason) {
    case 'aborted': return `the request to ${what} was aborted`;
    case 'timeout': return `no answer from ${what} within ${failure.timeoutMs} ms`;
    case 'unreachable': return `${what} could not be reached (${failure.detail})`;
    case 'too_large': return `${what} answered more than ${failure.maximumResponseBytes} bytes`;
    case 'not_http': return `${what} answered something that is not HTTP`;
    case 'closed': return `${what} closed the connection without answering`;
    case 'bad_url': return `${what} has no usable address (${failure.detail})`;
  }
}

async function requestOverFetch(url: URL, request: DirectHttpRequest): Promise<DirectHttpOutcome> {
  const maximumResponseBytes = request.maximumResponseBytes ?? DIRECT_HTTP_DEFAULT_MAXIMUM_RESPONSE_BYTES;
  try {
    const response = await fetch(url, {
      method: request.method ?? 'GET',
      headers: request.jsonBody === undefined ? { accept: 'application/json' } : { accept: 'application/json', 'content-type': 'application/json' },
      body: request.jsonBody === undefined ? undefined : JSON.stringify(request.jsonBody),
      redirect: 'manual',
      signal: request.signal ? AbortSignal.any([request.signal, AbortSignal.timeout(request.timeoutMs)]) : AbortSignal.timeout(request.timeoutMs),
    });
    const bodyText = await readResponseTextWithinLimit(response, maximumResponseBytes);
    return bodyText === null ? { failure: { reason: 'too_large', maximumResponseBytes } } : { response: { statusCode: response.status, bodyText } };
  } catch (error) {
    // Aborted by the caller, timed out, or unreachable: said apart.
    if (request.signal?.aborted) return { failure: { reason: 'aborted' } };
    if (error instanceof Error && error.name === 'TimeoutError') return { failure: { reason: 'timeout', timeoutMs: request.timeoutMs } };
    return { failure: { reason: 'unreachable', detail: error instanceof Error ? error.message : String(error) } };
  }
}

const HEAD_END = Buffer.from('\r\n\r\n');
const LAST_CHUNK = Buffer.from('0\r\n\r\n');

/**
 * The bytes of one raw HTTP/1.1 response as they arrive, and the response as
 * soon as its own framing says it is whole (parseCompleteRawHttpResponse).
 * The head is looked for only in each new chunk plus the few bytes before it,
 * and the received bytes are joined only once they can hold the whole
 * response: a body that arrives in many chunks is not copied once per chunk.
 */
export class RawHttpResponseReader {
  private readonly received: Buffer[] = [];
  private receivedBytes = 0;
  /** Where the head's blank line starts; -1 until it has arrived. */
  private headEnd = -1;
  private contentLength: number | null = null;
  /** The last bytes received, as long as HEAD_END / LAST_CHUNK: matches across a chunk boundary. */
  private tail = Buffer.alloc(0);

  get byteLength(): number {
    return this.receivedBytes;
  }

  /** Every byte received so far, joined. */
  all(): Buffer {
    return Buffer.concat(this.received, this.receivedBytes);
  }

  /** Adds a chunk; the response when it is now whole, else null. */
  push(chunk: Buffer): DirectHttpResponse | null {
    const before = this.receivedBytes;
    this.received.push(chunk);
    this.receivedBytes += chunk.length;
    const previousTail = this.tail;
    const joinedTail = Buffer.concat([previousTail, chunk.subarray(Math.max(0, chunk.length - LAST_CHUNK.length))]);
    this.tail = joinedTail.subarray(Math.max(0, joinedTail.length - LAST_CHUNK.length));
    if (this.headEnd === -1) {
      const window = Buffer.concat([previousTail, chunk]);
      const found = window.indexOf(HEAD_END);
      if (found === -1) return null;
      this.headEnd = before - previousTail.length + found;
      const head = readRawHttpHead(this.all());
      this.contentLength = head?.chunked ? null : head?.contentLength ?? null;
    }
    const mayBeWhole = this.contentLength !== null
      ? this.receivedBytes >= this.headEnd + HEAD_END.length + this.contentLength
      : this.tail.equals(LAST_CHUNK);
    return mayBeWhole ? parseCompleteRawHttpResponse(this.all()) : null;
  }
}

/**
 * One HTTP/1.1 request, never through a proxy (for http://), and why there is
 * no answer when there is none: aborted, timed out, unreachable, larger than
 * the cap (https:// too), not HTTP. Never throws.
 */
export function requestDirectlyWithOutcome(request: DirectHttpRequest): Promise<DirectHttpOutcome> {
  let url: URL;
  try {
    url = new URL(request.url);
  } catch (error) {
    return Promise.resolve({ failure: { reason: 'bad_url', detail: error instanceof Error ? error.message : String(error) } });
  }
  if (url.protocol === 'https:') return requestOverFetch(url, request);
  if (url.protocol !== 'http:') return Promise.resolve({ failure: { reason: 'bad_url', detail: `${url.protocol} is not http: or https:` } });
  const maximumResponseBytes = request.maximumResponseBytes ?? DIRECT_HTTP_DEFAULT_MAXIMUM_RESPONSE_BYTES;
  const bodyBytes = request.jsonBody === undefined ? null : Buffer.from(JSON.stringify(request.jsonBody), 'utf-8');
  const headLines = [
    `${request.method ?? 'GET'} ${url.pathname}${url.search} HTTP/1.1`,
    `Host: ${url.host}`,
    'Accept: application/json',
    'Connection: close',
    ...(bodyBytes ? ['Content-Type: application/json', `Content-Length: ${bodyBytes.length}`] : []),
  ];
  if (request.signal?.aborted) return Promise.resolve({ failure: { reason: 'aborted' } });
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const port = Number(url.port || 80);
  return new Promise<DirectHttpOutcome>((resolve) => {
    const reader = new RawHttpResponseReader();
    let settled = false;
    const onAbort = () => finish({ failure: { reason: 'aborted' } });
    const finish = (outcome: DirectHttpOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      request.signal?.removeEventListener('abort', onAbort);
      socket.destroy();
      resolve(outcome);
    };
    const socket = connect({ host, port });
    const timer = setTimeout(() => finish({ failure: { reason: 'timeout', timeoutMs: request.timeoutMs } }), request.timeoutMs);
    request.signal?.addEventListener('abort', onAbort, { once: true });
    socket.on('connect', () => {
      socket.write(`${headLines.join('\r\n')}\r\n\r\n`);
      if (bodyBytes) socket.write(bodyBytes);
    });
    socket.on('data', (chunk: Buffer) => {
      if (reader.byteLength + chunk.length > maximumResponseBytes) {
        finish({ failure: { reason: 'too_large', maximumResponseBytes } });
        return;
      }
      const complete = reader.push(chunk);
      if (complete) finish({ response: complete });
    });
    socket.on('end', () => {
      if (reader.byteLength === 0) {
        finish({ failure: { reason: 'closed' } });
        return;
      }
      const response = parseRawHttpResponse(reader.all());
      finish(response ? { response } : { failure: { reason: 'not_http' } });
    });
    socket.on('error', (error: Error) => finish({ failure: { reason: 'unreachable', detail: error.message } }));
  });
}

/**
 * One HTTP/1.1 request, never through a proxy (for http://). Resolves null
 * when nothing answers in time, the answer is not HTTP, or it is larger than
 * the cap (https:// too) — never throws. requestDirectlyWithOutcome says which.
 */
export async function requestDirectly(request: DirectHttpRequest): Promise<DirectHttpResponse | null> {
  const outcome = await requestDirectlyWithOutcome(request);
  return 'response' in outcome ? outcome.response : null;
}

/** requestDirectly with the body parsed as JSON (`body: null` when it is not JSON); null when nothing answered. */
export async function requestJsonDirectly<T>(request: DirectHttpRequest): Promise<{ statusCode: number; body: T | null } | null> {
  const response = await requestDirectly(request);
  if (!response) return null;
  try {
    return { statusCode: response.statusCode, body: JSON.parse(response.bodyText) as T };
  } catch {
    // An answer that is not JSON: the status still says what happened.
    return { statusCode: response.statusCode, body: null };
  }
}
