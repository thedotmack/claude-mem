// SPDX-License-Identifier: Apache-2.0
//
// Records one 'request' usage event per authenticated request, fire-and-forget
// so metering never adds latency to (or fails) the request it is measuring.
// Token/observation metering uses the same PostgresUsageRepository from the
// generation worker; this middleware only covers request counts.

import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { PostgresPool } from '../../storage/postgres/pool.js';
import { PostgresUsageRepository } from '../../storage/postgres/usage.js';
import { logger } from '../../utils/logger.js';

export function meterRequests(pool: PostgresPool): RequestHandler {
  const repo = new PostgresUsageRepository(pool);
  return (req: Request, _res: Response, next: NextFunction) => {
    const teamId = req.authContext?.teamId;
    if (teamId) {
      void repo
        .record({
          teamId,
          projectId: req.authContext?.projectId ?? null,
          kind: 'request',
          metadata: { method: req.method, path: req.path, apiKeyId: req.authContext?.apiKeyId ?? null },
        })
        .catch((error) => {
          logger.warn('HTTP', 'usage metering record failed', {
            error: error instanceof Error ? error.message : String(error),
          });
        });
    }
    next();
  };
}
