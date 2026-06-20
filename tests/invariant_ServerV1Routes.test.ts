import express from 'express';
import request from 'supertest';
import { ServerV1Routes } from '../../../src/server/routes/v1/ServerV1Routes';
import Database from 'better-sqlite3';

describe('Protected endpoints reject unauthenticated requests', () => {
  let app: express.Express;

  beforeAll(() => {
    app = express();
    app.use(express.json());
    const db = new Database(':memory:');
    const routes = new ServerV1Routes({
      getDatabase: () => db,
      authMode: 'api-key',
      apiKeys: [{ key: 'valid-secret-key-12345', name: 'test' }],
    } as any);
    routes.register(app);
  });

  const protectedEndpoints = [
    { method: 'get' as const, path: '/v1/projects' },
    { method: 'post' as const, path: '/v1/projects' },
    { method: 'get' as const, path: '/v1/projects/some-id' },
  ];

  const badAuthHeaders = [
    { desc: 'no auth header', header: undefined },
    { desc: 'malformed token', header: 'Bearer %%%invalid-garbage%%%' },
    { desc: 'wrong key', header: 'Bearer wrong-key-entirely' },
    { desc: 'empty bearer', header: 'Bearer ' },
  ];

  test.each(
    protectedEndpoints.flatMap(ep => badAuthHeaders.map(auth => ({ ...ep, ...auth })))
  )('$method $path rejects $desc', async ({ method, path, header }) => {
    const req = request(app)[method](path);
    if (header !== undefined) req.set('Authorization', header);
    if (method === 'post') req.send({ name: 'test' });
    const res = await req;
    expect([401, 403]).toContain(res.status);
  });

  test('public endpoint /healthz remains accessible without auth', async () => {
    const res = await request(app).get('/healthz');
    expect(res.status).toBe(200);
  });
});