
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
