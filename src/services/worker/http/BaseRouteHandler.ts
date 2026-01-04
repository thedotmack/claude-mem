/**
 * BaseRouteHandler
 *
 * Base class for all route handlers providing:
 * - Automatic try-catch wrapping with error logging
 * - Integer parameter validation
 * - Required body parameter validation
 * - Standard HTTP response helpers
 * - Centralized error handling
 */

import { Request, Response } from 'express';
import { logger } from '../../../utils/logger.js';

export abstract class BaseRouteHandler {
  /**
   * Wrap handler with automatic try-catch and error logging
   */
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
        logger.error('HTTP', 'Route handler error', { path: req.path }, error as Error);
        this.handleError(res, error as Error);
      }
    };
  }

  /**
   * Parse and validate integer parameter
   * Returns the integer value or sends 400 error response
   */
  protected parseIntParam(req: Request, res: Response, paramName: string): number | null {
    const value = parseInt(req.params[paramName], 10);
    if (isNaN(value)) {
      this.badRequest(res, `Invalid ${paramName}`);
      return null;
    }
    return value;
  }

  /**
   * Validate required body parameters
   * Returns true if all required params present, sends 400 error otherwise
   */
  protected validateRequired(req: Request, res: Response, params: string[]): boolean {
    for (const param of params) {
      if (req.body[param] === undefined || req.body[param] === null) {
        this.badRequest(res, `Missing ${param}`);
        return false;
      }
    }
    return true;
  }

  /**
   * Send 400 Bad Request response
   */
  protected badRequest(res: Response, message: string): void {
    res.status(400).json({ error: message });
  }

  /**
   * Send 404 Not Found response
   */
  protected notFound(res: Response, message: string): void {
    res.status(404).json({ error: message });
  }

  /**
   * Centralized error logging and response
   * Checks headersSent to avoid "Cannot set headers after they are sent" errors
   */
  protected handleError(res: Response, error: Error, context?: string): void {
    logger.failure('WORKER', context || 'Request failed', {}, error);
    if (!res.headersSent) {
      res.status(500).json({ error: error.message });
    }
  }
}
