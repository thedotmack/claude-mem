/**
 * Zod body-validation middleware (minimal — Plan 06 will expand).
 *
 * Plan 05 Phase 3 (PATHFINDER-2026-04-22) adds the blocking
 * `/api/session/end` endpoint and needs body validation now. Plan 06 Phase 2
 * defines this middleware in full (with error-shape conventions, type
 * inference for downstream handlers, etc.); we ship the minimum surface here
 * so Plan 05 doesn't hand-roll its own validation.
 *
 * Contract (this stub): given a Zod schema, parse `req.body`. On parse
 * failure, respond `400` with `{ error: 'invalid_body', issues }` and stop;
 * on success, replace `req.body` with the parsed (typed/coerced) value and
 * call `next()`.
 *
 * Plan 06 will expand this to:
 *   - typed `req.body` via `Request<…, …, z.infer<typeof S>>` mapping
 *   - per-route schema registry for OpenAPI/discovery
 *   - shared error envelope conventions (`{ code, message, details }`)
 *
 * Until Plan 06 lands, only Plan 05's `/api/session/end` consumes this.
 */

import type { Request, Response, NextFunction, RequestHandler } from 'express';
import type { ZodTypeAny } from 'zod';

export function validateBody(schema: ZodTypeAny): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      res.status(400).json({
        error: 'invalid_body',
        issues: result.error.issues,
      });
      return;
    }
    req.body = result.data;
    next();
  };
}
