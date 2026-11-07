// The hosted gallery's read path: a browser on the viewer origin asks for
// /api/media/* and the gate forwards it to the real worker media routes, whose
// guard (isTrustedMediaRead) accepts only loopback, own-page requests. This
// proves the gate strips what the guard refuses (Origin, Referer, proxy
// headers) and keeps Sec-Fetch-Site, so My Work's thumbnails load on the web.
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import express from 'express';
import type { Server } from 'node:http';
import { createGate, SESSION_COOKIE } from '../src/gate.js';
import { signToken } from '../src/token.js';
import { MediaRoutes } from '../../../src/services/worker/http/routes/MediaRoutes.js';
import type { MediaMetadata } from '../../../src/services/media/store.js';

const SECRET = 'x'.repeat(40);
const OWNER = 'user-owner';
const PUBLIC_ORIGIN = 'https://viewer.example';
const ID = '11111111-1111-4111-8111-111111111111';
const WEBP = Buffer.from('RIFF\u0000\u0000\u0000\u0000WEBPVP8 ', 'latin1');

const metadata: MediaMetadata = {
  id: ID, state: 'ready', recipe: 'screenshot-v1', encoderVersion: 'fixture',
  viewer: { sha256: 'a'.repeat(64), width: 2, height: 2, byteLength: WEBP.byteLength, mimeType: 'image/webp' },
  llm: { sha256: 'b'.repeat(64), width: 2, height: 2, byteLength: WEBP.byteLength, mimeType: 'image/webp' },
  failureCode: null, capturedAt: 1,
};

let worker: Server;
let workerOrigin: string;
const resolved: string[] = [];

beforeAll(async () => {
  const app = express();
  new MediaRoutes(() => ({
    getMetadata: () => metadata,
    readVariant: async () => WEBP,
    ownerSourceDetails: () => { throw new Error('the gallery never reads owner details'); },
  }), async (id) => { resolved.push(id); }).setupRoutes(app);
  await new Promise<void>((resolve) => {
    worker = app.listen(0, '127.0.0.1', () => {
      const address = worker.address();
      if (!address || typeof address === 'string') throw new Error('Missing worker address');
      workerOrigin = `http://127.0.0.1:${address.port}`;
      resolve();
    });
  });
});

afterAll(() => new Promise<void>((resolve) => worker.close(() => resolve())));

function gate() {
  return createGate({ ownerUserId: OWNER, secret: SECRET, upstreamOrigin: workerOrigin, publicOrigin: PUBLIC_ORIGIN, signInUrl: 'https://cmem.example/work' });
}

/** What a browser sends for an <img> or same-origin fetch on the hosted page, plus what Fly's proxy adds. */
function browserHeaders(signedIn = true): Record<string, string> {
  return {
    ...(signedIn ? { Cookie: `${SESSION_COOKIE}=${signToken(SECRET, { sub: OWNER, aud: 'session', exp: Math.floor(Date.now() / 1000) + 3600 })}` } : {}),
    Origin: PUBLIC_ORIGIN,
    Referer: `${PUBLIC_ORIGIN}/`,
    'Sec-Fetch-Site': 'same-origin',
    'X-Forwarded-For': '203.0.113.9',
    'X-Forwarded-Proto': 'https',
    'Fly-Client-IP': '203.0.113.9',
  };
}

describe('hosted media reads through the gate', () => {
  it('the worker guard refuses these browser headers when they reach it unchanged', async () => {
    const direct = await fetch(`${workerOrigin}/api/media/${ID}/llm`, { headers: browserHeaders() });
    expect(direct.status).toBe(403);
  });

  it('serves the thumbnail, the full image and the batch status to the signed-in owner', async () => {
    const thumbnail = await gate()(new Request(`${PUBLIC_ORIGIN}/api/media/${ID}/llm`, { headers: browserHeaders() }));
    expect(thumbnail.status).toBe(200);
    expect(thumbnail.headers.get('content-type')).toBe('image/webp');
    expect(thumbnail.headers.get('cache-control')).toBe('private, no-store');
    expect(Buffer.from(await thumbnail.arrayBuffer()).equals(WEBP)).toBe(true);

    const full = await gate()(new Request(`${PUBLIC_ORIGIN}/api/media/${ID}/viewer`, { headers: browserHeaders() }));
    expect(full.status).toBe(200);

    const status = await gate()(new Request(`${PUBLIC_ORIGIN}/api/media/status?ids=${ID}`, { headers: browserHeaders() }));
    expect(status.status).toBe(200);
    expect(await status.json()).toEqual({ attachments: [{ id: ID, state: 'ready' }] });
    // The hosted worker downloads replica bytes on these reads.
    expect(resolved).toContain(ID);
  });

  it('answers 401 to a browser without a session and never reaches the worker', async () => {
    resolved.length = 0;
    const response = await gate()(new Request(`${PUBLIC_ORIGIN}/api/media/${ID}/llm`, { headers: browserHeaders(false) }));
    expect(response.status).toBe(401);
    expect(resolved).toEqual([]);
  });
});
