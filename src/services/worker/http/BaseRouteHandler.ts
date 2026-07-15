
import { Request, Response } from 'express';
import { logger } from '../../../utils/logger.js';
import { AppError } from '../../server/ErrorHandler.js';
import { normalizePlatformSource } from '../../../shared/platform-source.js';

export abstract class BaseRouteHandler {
  protected wrapHandler(
    handler: (req: Request, res: Response) => void | Promise<void>
  ): (req: Request, res: Response) => void {
    return (req: Request, res: Response): void => {
      try {
        const result = handler(req, res);
        if (result instanceof Promise) {
          result.catch(error => this.handleError(res, error as Error));
        }
      } catch (error) {
        const normalizedError = error instanceof Error ? error : new Error(String(error));
        logger.error('HTTP', 'Route handler error', { path: req.path }, normalizedError);
        this.handleError(res, normalizedError);
      }
    };
  }

  /**
   * Coerce an Express route/query param to a single string.
   *
   * Express 5 types params and query values as `string | string[]` (repeated
   * keys produce an array). This returns the first element of an array, the
   * string as-is, or '' when the value is absent — giving callers a plain
   * `string` to work with.
   */
  protected toStringParam(value: string | string[] | undefined): string {
    if (Array.isArray(value)) {
      return value[0] ?? '';
    }
    return value ?? '';
  }

  protected parseIntParam(req: Request, res: Response, paramName: string): number | null {
    const value = parseInt(this.toStringParam(req.params[paramName]), 10);
    if (isNaN(value)) {
      this.badRequest(res, `Invalid ${paramName}`);
      return null;
    }
    return value;
  }

  /** Cap the array descent in {@link firstString}. Express only ever nests one
   * level deep (repeated query keys → `string[]`); anything deeper is malformed
   * or hostile input, so a small bound is safe. */
  private static readonly MAX_ARRAY_DEPTH = 8;

  protected static firstString(value: unknown): string | undefined {
    // Walk to the first non-array leaf. `value` is untrusted request input
    // (req.query / req.body), so a crafted deeply-nested array — or a
    // self-referential one (`a[0] = a`) — must never recurse without bound:
    // that overflows the stack (RangeError: Maximum call stack size exceeded)
    // and takes down request handling. Descend iteratively up to a fixed cap
    // and bail rather than follow it forever.
    let current = value;
    for (let depth = 0; depth < BaseRouteHandler.MAX_ARRAY_DEPTH && Array.isArray(current); depth++) {
      current = current[0];
    }
    if (Array.isArray(current)) {
      return undefined; // still nested past the cap — treat as absent
    }
    return typeof current === 'string' && current.trim() ? current : undefined;
  }

  private static rawPlatformSourceFromRequest(req: Request): string | undefined {
    const body = req.body && typeof req.body === 'object' ? req.body as Record<string, unknown> : {};
    const header = req.get?.('x-platform-source')
      ?? req.get?.('x-claude-mem-platform-source');
    return BaseRouteHandler.firstString(req.query.platformSource)
      ?? BaseRouteHandler.firstString(req.query.platform_source)
      ?? BaseRouteHandler.firstString(body.platformSource)
      ?? BaseRouteHandler.firstString(body.platform_source)
      ?? BaseRouteHandler.firstString(header);
  }

  protected getPlatformSourceFromRequest(req: Request): string {
    return normalizePlatformSource(BaseRouteHandler.rawPlatformSourceFromRequest(req));
  }

  protected getOptionalPlatformSourceFromRequest(req: Request): string | undefined {
    const rawPlatformSource = BaseRouteHandler.rawPlatformSourceFromRequest(req);
    return rawPlatformSource ? normalizePlatformSource(rawPlatformSource) : undefined;
  }

  protected badRequest(res: Response, message: string): void {
    res.status(400).json({ error: message });
  }

  protected notFound(res: Response, message: string): void {
    res.status(404).json({ error: message });
  }

  protected handleError(res: Response, error: Error, context?: string): void {
    const statusCode = error instanceof AppError ? error.statusCode : 500;
    // The local failure line (full fidelity) always fires. The Error payload
    // routes through logger.error → the error sink → captureException
    // (Phase 3), which sends a REDACTED $exception to PostHog Error Tracking —
    // consent-gated, kill-switch-gated, and rate-limited. This replaces the old
    // enum-only `error_occurred` event with the real (scrubbed) exception, so we
    // no longer attach a telemetry descriptor here.
    logger.failure('WORKER', context || 'Request failed', undefined, error);
    if (!res.headersSent) {
      const response: Record<string, unknown> = { error: error.message };

      if (error instanceof AppError && error.code) {
        response.code = error.code;
      }

      if (error instanceof AppError && error.details !== undefined) {
        response.details = error.details;
      }

      res.status(statusCode).json(response);
    }
  }
}
