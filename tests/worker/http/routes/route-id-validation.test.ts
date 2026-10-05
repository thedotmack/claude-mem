import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import express from 'express';
import type { Server } from 'node:http';
import { AdvisorRoutes } from '../../../../src/services/worker/http/routes/AdvisorRoutes.js';

let server: Server;
let endpoint: string;
const lookedUp: number[] = [];
beforeAll(async () => {
  const app = express();
  const routes = new AdvisorRoutes({ getSessionStore: () => ({
    getAdvisorCallById: (id: number) => {
      lookedUp.push(id);
      return id === 1 ? { id: 1, advice: 'owned-row' } : undefined;
    },
  }) } as any);
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
});
describe('numeric detail route identities', () => {
  for (const id of ['1junk', '1.9', '1e2', '-1', '9007199254740993']) {
    it(`rejects ${id} before looking up a different numeric identity`, async () => {
      const before = lookedUp.length;
      const response = await fetch(`${endpoint}/api/advisor-call/${id}`);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: 'Invalid id' });
      expect(lookedUp.length).toBe(before);
    });
  }
  it('keeps full decimal IDs and not-found results', async () => {
    const hit = await fetch(`${endpoint}/api/advisor-call/1`);
    expect(hit.status).toBe(200);
    expect(await hit.json()).toEqual({ id: 1, advice: 'owned-row' });
    expect((await fetch(`${endpoint}/api/advisor-call/2`)).status).toBe(404);
  });
});
