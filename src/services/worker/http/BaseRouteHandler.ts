
import { Request, Response } from 'express';
import { logger } from '../../../utils/logger.js';
import { AppError } from '../../server/ErrorHandler.js';

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

  protected parseIntParam(req: Request, res: Response, paramName: string): number | null {
    const value = parseInt(req.params[paramName], 10);
    if (isNaN(value)) {
      this.badRequest(res, `Invalid ${paramName}`);
      return null;
    }
    return value;
  }

  protected badRequest(res: Response, message: string): void {
    res.status(400).json({ error: message });
  }

  protected notFound(res: Response, message: string): void {
    res.status(404).json({ error: message });
  }

  protected handleError(res: Response, error: Error, context?: string): void {
    logger.failure('WORKER', context || 'Request failed', {}, error);
    if (!res.headersSent) {
      const statusCode = error instanceof AppError ? error.statusCode : 500;
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
