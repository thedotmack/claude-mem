// SPDX-License-Identifier: Apache-2.0

import type { Application } from 'express';
import type { RouteHandler } from '../../services/server/Server.js';

type NodeHandler = ReturnType<typeof import('better-auth/node').toNodeHandler>;

let cachedHandler: NodeHandler | null = null;

async function getBetterAuthHandler(): Promise<NodeHandler> {
  if (!cachedHandler) {
    const [{ toNodeHandler }, { auth }] = await Promise.all([
      import('better-auth/node'),
      import('./auth.js'),
    ]);
    cachedHandler = toNodeHandler(auth);
  }
  return cachedHandler;
}

export class BetterAuthRoutes implements RouteHandler {
  setupRoutes(app: Application): void {
    app.all('/api/auth/*splat', async (req, res) => {
      const handler = await getBetterAuthHandler();
      await handler(req, res);
    });
  }
}
