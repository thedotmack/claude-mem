// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from 'crypto';
import type { NextFunction, Request, RequestHandler, Response } from 'express';

// Phase 12 — request_id middleware. Mints a UUID per inbound request and
// attaches it to req.requestId so route handlers, ingest services, and
// generation jobs can correlate logs back to the original HTTP call. Honors
// an inbound `X-Request-Id` header so an upstream load balancer / gateway
// can supply the id, but rejects non-conformant values to keep audit rows
// clean (UUID v4 OR a small whitelist of [a-zA-Z0-9-_] up to 64 chars).
//
// Anti-pattern guard: never trust the inbound id for auth — this is purely
// an audit/log correlator. Auth still flows through requirePostgresServerAuth.

const REQUEST_ID_HEADER = 'x-request-id';
const REQUEST_ID_MAX_LENGTH = 64;
const REQUEST_ID_SAFE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9\-_]{0,63}$/;

declare module 'express-serve-static-core' {
  interface Request {
    requestId?: string;
  }
}

export function requestIdMiddleware(): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const inbound = req.header(REQUEST_ID_HEADER);
    const accepted = inbound && isAcceptableRequestId(inbound) ? inbound : randomUUID();
    req.requestId = accepted;
    res.setHeader('X-Request-Id', accepted);
    next();
  };
}

export function isAcceptableRequestId(value: string): boolean {
  if (typeof value !== 'string') return false;
  if (value.length === 0 || value.length > REQUEST_ID_MAX_LENGTH) return false;
  return REQUEST_ID_SAFE_PATTERN.test(value);
}
