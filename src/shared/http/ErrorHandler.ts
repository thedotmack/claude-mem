
import { Request, Response, NextFunction, ErrorRequestHandler } from 'express';
import { logger } from '../../utils/logger.js';

export interface ErrorResponse {
  error: string;
  message: string;
  code?: string;
  details?: unknown;
}

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

export const errorHandler: ErrorRequestHandler = (
  err: Error | AppError,
  req: Request,
  res: Response,
  _next: NextFunction
): void => {
  const statusCode = err instanceof AppError ? err.statusCode : 500;

  logger.error('HTTP', `Error handling ${req.method} ${req.path}`, {
    statusCode,
    error: err.message,
    code: err instanceof AppError ? err.code : undefined
  }, err);

  const response = createErrorResponse(
    err.name || 'Error',
    err.message,
    err instanceof AppError ? err.code : undefined,
    err instanceof AppError ? err.details : undefined
  );

  res.status(statusCode).json(response);
};

export function notFoundHandler(req: Request, res: Response): void {
  res.status(404).json(createErrorResponse(
    'NotFound',
    `Cannot ${req.method} ${req.path}`
  ));
}

export function asyncHandler<T>(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<T>
): (req: Request, res: Response, next: NextFunction) => void {
  return (req: Request, res: Response, next: NextFunction): void => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}
