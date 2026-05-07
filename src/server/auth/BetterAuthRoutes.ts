// SPDX-License-Identifier: Apache-2.0

import type { Application } from 'express';
import type { Database } from 'bun:sqlite';
import type { RouteHandler } from '../../services/server/Server.js';

type NodeHandler = ReturnType<typeof import('better-auth/node').toNodeHandler>;

const cachedHandlers = new WeakMap<Database, NodeHandler>();

async function getBetterAuthHandler(database: Database): Promise<NodeHandler> {
  const cachedHandler = cachedHandlers.get(database);
  if (cachedHandler) {
    return cachedHandler;
  }

  const [{ toNodeHandler }, { createAuth }] = await Promise.all([
    import('better-auth/node'),
    import('./auth.js'),
  ]);
  const handler = toNodeHandler(createAuth(database));
  cachedHandlers.set(database, handler);
  return handler;
}

export class BetterAuthRoutes implements RouteHandler {
  constructor(private readonly getDatabase: () => Database) {}

  setupRoutes(app: Application): void {
    app.all('/api/auth/*splat', async (req, res, next) => {
      try {
        const handler = await getBetterAuthHandler(this.getDatabase());
        await handler(req, res);
      } catch (error) {
        next(error);
      }
    });
  }
}
