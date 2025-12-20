/**
 * BaseRouteHandler
 *
 * Base class for all route handlers providing:
 * - Automatic try-catch wrapping with error logging
 * - Integer parameter validation
 * - Required body parameter validation
 * - Standard HTTP response helpers (APIError format)
 * - Centralized error handling
 */

import { Request, Response } from 'express';
import { logger } from '../../../utils/logger.js';
import type { APIError } from '../../worker-types.js';

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
   * Send 400 Bad Request response (standard APIError format)
   */
  protected badRequest(res: Response, message: string, code?: string, details?: unknown): void {
    const errorResponse: APIError = { error: message };
    if (code) errorResponse.code = code;
    if (details) errorResponse.details = details;
    res.status(400).json(errorResponse);
  }

  /**
   * Send 404 Not Found response (standard APIError format)
   */
  protected notFound(res: Response, message: string, code?: string, details?: unknown): void {
    const errorResponse: APIError = { error: message };
    if (code) errorResponse.code = code;
    if (details) errorResponse.details = details;
    res.status(404).json(errorResponse);
  }

  /**
   * Centralized error logging and response (standard APIError format)
   */
  protected handleError(res: Response, error: Error, context?: string): void {
    logger.failure('WORKER', context || 'Request failed', {}, error);
    const errorResponse: APIError = {
      error: error.message,
      code: error.name !== 'Error' ? error.name : undefined
    };
    res.status(500).json(errorResponse);
  }
}
