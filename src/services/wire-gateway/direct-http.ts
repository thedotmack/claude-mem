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

/** Status and body of a raw HTTP/1.1 response read until the server closed. */
export function parseRawHttpResponse(raw: Buffer): DirectHttpResponse | null {
  const headerEnd = raw.indexOf('\r\n\r\n');
  if (headerEnd === -1) return null;
  const headerLines = raw.subarray(0, headerEnd).toString('latin1').split('\r\n');
  const statusMatch = /^HTTP\/1\.[01] (\d{3})/.exec(headerLines[0] ?? '');
  if (!statusMatch) return null;
  const chunked = headerLines.some((line) => {
    const separator = line.indexOf(':');
    return separator !== -1
      && line.slice(0, separator).trim().toLowerCase() === 'transfer-encoding'
      && line.slice(separator + 1).toLowerCase().includes('chunked');
  });
  const body = raw.subarray(headerEnd + 4);
  const decoded = chunked ? decodeChunkedBody(body) : body;
  if (decoded === null) return null;
  return { statusCode: Number(statusMatch[1]), bodyText: decoded.toString('utf-8') };
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

async function requestOverFetch(url: URL, request: DirectHttpRequest): Promise<DirectHttpResponse | null> {
  try {
    const response = await fetch(url, {
      method: request.method ?? 'GET',
      headers: request.jsonBody === undefined ? { accept: 'application/json' } : { accept: 'application/json', 'content-type': 'application/json' },
      body: request.jsonBody === undefined ? undefined : JSON.stringify(request.jsonBody),
      redirect: 'manual',
      signal: AbortSignal.timeout(request.timeoutMs),
    });
    const bodyText = await readResponseTextWithinLimit(response, request.maximumResponseBytes ?? DIRECT_HTTP_DEFAULT_MAXIMUM_RESPONSE_BYTES);
    return bodyText === null ? null : { statusCode: response.status, bodyText };
  } catch {
    // Unreachable, refused or timed out: no answer.
    return null;
  }
}

/**
 * One HTTP/1.1 request, never through a proxy (for http://). Resolves null
 * when nothing answers in time, the answer is not HTTP, or it is larger than
 * the cap (https:// too) — never throws.
 */
export function requestDirectly(request: DirectHttpRequest): Promise<DirectHttpResponse | null> {
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    return Promise.resolve(null);
  }
  if (url.protocol === 'https:') return requestOverFetch(url, request);
  if (url.protocol !== 'http:') return Promise.resolve(null);
  const maximumResponseBytes = request.maximumResponseBytes ?? DIRECT_HTTP_DEFAULT_MAXIMUM_RESPONSE_BYTES;
  const bodyBytes = request.jsonBody === undefined ? null : Buffer.from(JSON.stringify(request.jsonBody), 'utf-8');
  const headLines = [
    `${request.method ?? 'GET'} ${url.pathname}${url.search} HTTP/1.1`,
    `Host: ${url.host}`,
    'Accept: application/json',
    'Connection: close',
    ...(bodyBytes ? ['Content-Type: application/json', `Content-Length: ${bodyBytes.length}`] : []),
  ];
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const port = Number(url.port || 80);
  return new Promise<DirectHttpResponse | null>((resolve) => {
    const received: Buffer[] = [];
    let receivedBytes = 0;
    let settled = false;
    const finish = (answer: DirectHttpResponse | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(answer);
    };
    const socket = connect({ host, port });
    const timer = setTimeout(() => finish(null), request.timeoutMs);
    socket.on('connect', () => {
      socket.write(`${headLines.join('\r\n')}\r\n\r\n`);
      if (bodyBytes) socket.write(bodyBytes);
    });
    socket.on('data', (chunk: Buffer) => {
      receivedBytes += chunk.length;
      if (receivedBytes > maximumResponseBytes) {
        finish(null);
        return;
      }
      received.push(chunk);
    });
    socket.on('end', () => finish(parseRawHttpResponse(Buffer.concat(received))));
    socket.on('error', () => finish(null));
  });
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
