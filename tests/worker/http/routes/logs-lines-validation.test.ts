import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import express from 'express';
import type { Server } from 'node:http';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LogsRoutes } from '../../../../src/services/worker/http/routes/LogsRoutes.js';

const root = mkdtempSync(join(tmpdir(), 'cm-log-lines-'));
const file = join(root, 'owned.log');
writeFileSync(file, Array.from({ length: 12000 }, (_, i) => `owned-${i}`).join('\n') + '\n');
let currentFile = file;
let server: Server;
let endpoint: string;
beforeAll(async () => {
  const app = express();
  const routes = new LogsRoutes();
  // Exercise the real route and HTTP query parser, pointing solely at our log.
  Object.assign(routes, { getLogFilePath: () => currentFile });
  routes.setupRoutes(app);
  server = await new Promise<Server>(resolve => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing owned listener');
  endpoint = `http://127.0.0.1:${address.port}`;
});
afterAll(async () => {
  if (server) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  rmSync(root, { recursive: true, force: true });
});
describe('GET /api/logs line-count validation', () => {
  for (const query of ['lines=nope', 'lines=-1', 'lines=2tail', 'lines=1.5', 'lines=1&lines=2', 'lines=9007199254740993']) {
    it(`rejects ${query} instead of returning an unintended log window`, async () => {
      const response = await fetch(`${endpoint}/api/logs?${query}`);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: 'lines must be a nonnegative safe integer' });
    });
  }
  it('preserves the default, explicit zero, and an exact tail request', async () => {
    for (const [query, count] of [['', 1000], ['?lines=0', 0], ['?lines=2', 2], ['?lines=10001', 10000]]) {
      const response = await fetch(`${endpoint}/api/logs${query}`);
      expect(response.status).toBe(200);
      expect((await response.json() as { returnedLines: number }).returnedLines).toBe(count);
    }
  });
  it('validates malformed queries even when today has no log file', async () => {
    currentFile = join(root, 'missing.log');
    try {
      const invalid = await fetch(`${endpoint}/api/logs?lines=nope`);
      expect(invalid.status).toBe(400);
      expect(await invalid.json()).toEqual({ error: 'lines must be a nonnegative safe integer' });
      const valid = await fetch(`${endpoint}/api/logs?lines=2`);
      expect(valid.status).toBe(200);
      expect(await valid.json()).toMatchObject({ logs: '', exists: false });
    } finally {
      currentFile = file;
    }
  });

});
