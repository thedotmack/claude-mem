/**
 * Zod body-validation middleware — PATHFINDER-2026-04-22 Plan 06 Phase 2.
 *
 * Canonical signature: given a Zod schema, parse `req.body` with `safeParse`.
 * On failure, respond 400 with `{ error: 'ValidationError', issues: [...] }`
 * and stop. On success, replace `req.body` with the parsed (typed) value and
 * call `next()`.
 *
 * Principles:
 *   - Principle 2 — Fail-fast over grace-degrade. No try/catch swallow,
 *     no coercion, no "best-effort" defaults.
 *   - Principle 6 — One helper, N callers. Every validated POST/PUT
 *     across `src/services/worker/http/routes/` uses this one middleware
 *     wrapped around a per-route Zod schema declared at the top of its
 *     owning route file.
 */

import type { RequestHandler } from 'express';
import type { ZodTypeAny } from 'zod';

export const validateBody = <S extends ZodTypeAny>(schema: S): RequestHandler =>
  (req, res, next) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      res.status(400).json({
        error: 'ValidationError',
        issues: result.error.issues.map(i => ({
          path: i.path,
          message: i.message,
          code: i.code,
        })),
      });
      return;
    }
    req.body = result.data;
    next();
  };
