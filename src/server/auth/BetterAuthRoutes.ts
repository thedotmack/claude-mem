// SPDX-License-Identifier: Apache-2.0

import type { Application } from 'express';
import type { Database } from 'bun:sqlite';
import type { RouteHandler } from '../../services/server/Server.js';
import { logger } from '../../utils/logger.js';

type NodeHandler = ReturnType<typeof import('better-auth/node').toNodeHandler>;

const cachedHandlers = new WeakMap<Database, Promise<NodeHandler>>();

async function buildBetterAuthHandler(database: Database): Promise<NodeHandler> {
  const [{ toNodeHandler }, { createAuth }, { getMigrations }] = await Promise.all([
    import('better-auth/node'),
    import('./auth.js'),
    import('better-auth/db/migration'),
  ]);
  const auth = createAuth(database);
  // better-auth never creates its own tables, and nothing else in the worker
  // runs its migrations, so a fresh install has no user/session/account
  // tables and every auth request fails with "Database schema mismatch"
  // (#5453). Run the migrations once, before the first request is served.
  const { runMigrations } = await getMigrations(auth.options);
  await runMigrations();
  return toNodeHandler(auth);
}

function getBetterAuthHandler(database: Database): Promise<NodeHandler> {
  const cachedHandler = cachedHandlers.get(database);
  if (cachedHandler) {
    return cachedHandler;
  }

  const handlerPromise = buildBetterAuthHandler(database);
  cachedHandlers.set(database, handlerPromise);
  // A failed build (missing package, failed migration) must not stay cached:
  // the next request retries instead of reusing the same rejection forever.
  handlerPromise.catch(() => {
    if (cachedHandlers.get(database) === handlerPromise) {
      cachedHandlers.delete(database);
    }
  });
  return handlerPromise;
}

export class BetterAuthRoutes implements RouteHandler {
  constructor(private readonly getDatabase: () => Database) {}

  setupRoutes(app: Application): void {
    app.all('/api/auth/*splat', async (req, res, next) => {
      try {
        const handler = await getBetterAuthHandler(this.getDatabase());
        await handler(req, res);
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        logger.warn('HTTP', 'better-auth handler failed', { path: req.path }, err);
        next(error);
      }
    });
  }
}
