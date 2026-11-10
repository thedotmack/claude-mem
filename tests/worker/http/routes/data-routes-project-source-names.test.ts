import { expect, it } from 'bun:test';
import express from 'express';
import { SessionStore } from '../../../../src/services/sqlite/SessionStore.js';
import { DataRoutes } from '../../../../src/services/worker/http/routes/DataRoutes.js';

for (const platformSource of ['constructor', '__proto__']) {
  it(`serves the SQLite project catalog for the accepted source ${platformSource}`, async () => {
    const store = new SessionStore(':memory:');
    store.createSDKSession('ordinary', 'ordinary-project', 'ordinary prompt');
    store.createSDKSession('custom', 'custom-project', 'custom prompt', undefined, platformSource);
    store.createSDKSession('custom-second', 'custom-project', 'same project', undefined, platformSource);
    const routes = new DataRoutes({} as any, { getSessionStore: () => store } as any,
      {} as any, {} as any, {} as any, Date.now());
    const app = express();
    routes.setupRoutes(app);
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>(resolve => server.once('listening', resolve));
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('No test HTTP port');
      const response = await fetch(`http://127.0.0.1:${address.port}/api/projects`);
      expect(response.status).toBe(200);
      const catalog = await response.json() as {
        projects: string[]; sources: string[]; projectsBySource: Record<string, string[]>;
      };
      expect(catalog.sources).toEqual(['claude', platformSource]);
      expect(Object.hasOwn(catalog.projectsBySource, platformSource)).toBe(true);
      expect(catalog.projectsBySource[platformSource]).toEqual(['custom-project']);
      expect(catalog.projectsBySource.claude).toEqual(['ordinary-project']);
      expect(catalog.projects.toSorted()).toEqual(['custom-project', 'ordinary-project']);
    } finally {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      store.close();
    }
  });
}
