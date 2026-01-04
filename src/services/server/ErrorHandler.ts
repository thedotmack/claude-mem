/**
 * ErrorHandler - Centralized error handling for Express
 *
 * Provides error handling middleware and utilities for the server.
 */

import { Request, Response, NextFunction, ErrorRequestHandler } from 'express';
import { logger } from '../../utils/logger.js';

/**
 * Standard error response format
 */
export interface ErrorResponse {
  error: string;
  message: string;
  code?: string;
  details?: unknown;
}

/**
 * Application error with additional context
 */
export class AppError extends Error {
  constructor(
    message: string,
    public statusCode: number = 500,
    public code?: string,
    public details?: unknown
  ) {
    super(message);
    this.name = 'AppError';
  }
}

/**
 * Create an error response object
 */
export function createErrorResponse(
  error: string,
  message: string,
  code?: string,
  details?: unknown
): ErrorResponse {
  const response: ErrorResponse = { error, message };
  if (code) response.code = code;
  if (details) response.details = details;
  return response;
}

/**
 * Global error handler middleware
 * Should be registered last in the middleware chain
 */
export const errorHandler: ErrorRequestHandler = (
  err: Error | AppError,
  req: Request,
  res: Response,
  _next: NextFunction
): void => {
  // Determine status code
  const statusCode = err instanceof AppError ? err.statusCode : 500;

  // Log error
  logger.error('HTTP', `Error handling ${req.method} ${req.path}`, {
    statusCode,
    error: err.message,
    code: err instanceof AppError ? err.code : undefined
  }, err);

  // Build response
  const response = createErrorResponse(
    err.name || 'Error',
    err.message,
    err instanceof AppError ? err.code : undefined,
    err instanceof AppError ? err.details : undefined
  );

  // Send response (don't call next, as we've handled the error)
  res.status(statusCode).json(response);
};

/**
 * Not found handler - for routes that don't exist
 */
export function notFoundHandler(req: Request, res: Response): void {
  res.status(404).json(createErrorResponse(
    'NotFound',
    `Cannot ${req.method} ${req.path}`
  ));
}

/**
 * Async wrapper to catch errors in async route handlers
 * Automatically passes errors to Express error handler
 */
export function asyncHandler<T>(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<T>
): (req: Request, res: Response, next: NextFunction) => void {
  return (req: Request, res: Response, next: NextFunction): void => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}
