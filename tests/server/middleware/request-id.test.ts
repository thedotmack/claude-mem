// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'bun:test';
import express from 'express';
import { isAcceptableRequestId, requestIdMiddleware } from '../../../src/server/middleware/request-id.js';

describe('Phase 12 — request_id middleware', () => {
  it('mints a request id when none is provided', async () => {
    const app = express();
    app.use(requestIdMiddleware());
    app.get('/echo', (req, res) => {
      res.json({ id: req.requestId ?? null });
    });
    const server = app.listen(0);
    try {
      const port = (server.address() as { port: number }).port;
      const resp = await fetch(`http://127.0.0.1:${port}/echo`);
      expect(resp.headers.get('x-request-id')).toBeTruthy();
      const body = await resp.json() as { id: string };
      expect(body.id.length).toBeGreaterThan(0);
      expect(body.id).toBe(resp.headers.get('x-request-id'));
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  it('honors a safe inbound X-Request-Id header', async () => {
    const app = express();
    app.use(requestIdMiddleware());
    app.get('/echo', (req, res) => {
      res.json({ id: req.requestId ?? null });
    });
    const server = app.listen(0);
    try {
      const port = (server.address() as { port: number }).port;
      const resp = await fetch(`http://127.0.0.1:${port}/echo`, {
        headers: { 'X-Request-Id': 'abc-123_DEF' },
      });
      const body = await resp.json() as { id: string };
      expect(body.id).toBe('abc-123_DEF');
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  it('rejects unsafe inbound request ids by minting a fresh uuid', async () => {
    const app = express();
    app.use(requestIdMiddleware());
    app.get('/echo', (req, res) => {
      res.json({ id: req.requestId ?? null });
    });
    const server = app.listen(0);
    try {
      const port = (server.address() as { port: number }).port;
      const resp = await fetch(`http://127.0.0.1:${port}/echo`, {
        headers: { 'X-Request-Id': '<script>alert(1)</script>' },
      });
      const body = await resp.json() as { id: string };
      expect(body.id).not.toBe('<script>alert(1)</script>');
      expect(isAcceptableRequestId(body.id)).toBe(true);
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  it('isAcceptableRequestId enforces the safe-charset, length contract', () => {
    expect(isAcceptableRequestId('abc-123')).toBe(true);
    expect(isAcceptableRequestId('A1_B2-C3')).toBe(true);
    expect(isAcceptableRequestId('')).toBe(false);
    expect(isAcceptableRequestId('a'.repeat(65))).toBe(false);
    expect(isAcceptableRequestId('foo bar')).toBe(false);
    expect(isAcceptableRequestId('-leading-dash')).toBe(false);
    expect(isAcceptableRequestId('with"quote')).toBe(false);
  });
});
