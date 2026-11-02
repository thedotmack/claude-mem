import { describe, it, expect, mock, beforeEach, afterEach, spyOn } from 'bun:test';
import type { Request, Response, NextFunction } from 'express';
import { logger } from '../../src/utils/logger.js';

import {
  AppError,
  createErrorResponse,
  errorHandler,
  notFoundHandler,
} from '../../src/services/server/ErrorHandler.js';

let loggerSpies: ReturnType<typeof spyOn>[] = [];

describe('ErrorHandler', () => {
  beforeEach(() => {
    loggerSpies = [
      spyOn(logger, 'info').mockImplementation(() => {}),
      spyOn(logger, 'debug').mockImplementation(() => {}),
      spyOn(logger, 'warn').mockImplementation(() => {}),
      spyOn(logger, 'error').mockImplementation(() => {}),
    ];
  });

  afterEach(() => {
    loggerSpies.forEach(spy => spy.mockRestore());
    mock.restore();
  });

  describe('AppError', () => {
    it('should extend Error', () => {
      const error = new AppError('Test error');
      expect(error).toBeInstanceOf(Error);
      expect(error).toBeInstanceOf(AppError);
    });

    it('should set default statusCode to 500', () => {
      const error = new AppError('Test error');
      expect(error.statusCode).toBe(500);
    });

    it('should set custom statusCode', () => {
      const error = new AppError('Not found', 404);
      expect(error.statusCode).toBe(404);
    });

    it('should set error code when provided', () => {
      const error = new AppError('Invalid input', 400, 'INVALID_INPUT');
      expect(error.code).toBe('INVALID_INPUT');
    });

    it('should set details when provided', () => {
      const details = { field: 'email', reason: 'invalid format' };
      const error = new AppError('Validation failed', 400, 'VALIDATION_ERROR', details);
      expect(error.details).toEqual(details);
    });

    it('should set message correctly', () => {
      const error = new AppError('Something went wrong');
      expect(error.message).toBe('Something went wrong');
    });

    it('should set name to AppError', () => {
      const error = new AppError('Test error');
      expect(error.name).toBe('AppError');
    });

    it('should handle all parameters together', () => {
      const details = { userId: 123 };
      const error = new AppError('User not found', 404, 'USER_NOT_FOUND', details);

      expect(error.message).toBe('User not found');
      expect(error.statusCode).toBe(404);
      expect(error.code).toBe('USER_NOT_FOUND');
      expect(error.details).toEqual(details);
      expect(error.name).toBe('AppError');
    });
  });

  describe('createErrorResponse', () => {
    it('should create basic error response with error and message', () => {
      const response = createErrorResponse('Error', 'Something went wrong');

      expect(response.error).toBe('Error');
      expect(response.message).toBe('Something went wrong');
      expect(response.code).toBeUndefined();
      expect(response.details).toBeUndefined();
    });

    it('should include code when provided', () => {
      const response = createErrorResponse('ValidationError', 'Invalid input', 'INVALID_INPUT');

      expect(response.error).toBe('ValidationError');
      expect(response.message).toBe('Invalid input');
      expect(response.code).toBe('INVALID_INPUT');
      expect(response.details).toBeUndefined();
    });

    it('should include details when provided', () => {
      const details = { fields: ['email', 'password'] };
      const response = createErrorResponse('ValidationError', 'Multiple errors', 'VALIDATION_ERROR', details);

      expect(response.error).toBe('ValidationError');
      expect(response.message).toBe('Multiple errors');
      expect(response.code).toBe('VALIDATION_ERROR');
      expect(response.details).toEqual(details);
    });

    it('should not include code or details keys when not provided', () => {
      const response = createErrorResponse('Error', 'Basic error');

      expect(Object.keys(response)).toEqual(['error', 'message']);
    });

    it('should handle empty string code as falsy and exclude it', () => {
      const response = createErrorResponse('Error', 'Test', '');

      expect(response.code).toBeUndefined();
    });
  });

  describe('errorHandler middleware', () => {
    let mockRequest: Partial<Request>;
    let mockResponse: Partial<Response>;
    let mockNext: NextFunction;
    let statusSpy: ReturnType<typeof mock>;
    let jsonSpy: ReturnType<typeof mock>;

    beforeEach(() => {
      statusSpy = mock(() => mockResponse);
      jsonSpy = mock(() => mockResponse);

      mockRequest = {
        method: 'GET',
        path: '/api/test',
      };

      mockResponse = {
        status: statusSpy as unknown as Response['status'],
        json: jsonSpy as unknown as Response['json'],
      };

      mockNext = mock(() => {});
    });

    it('should handle AppError with custom status code', () => {
      const error = new AppError('Not found', 404, 'NOT_FOUND');

      errorHandler(
        error,
        mockRequest as Request,
        mockResponse as Response,
        mockNext
      );

      expect(statusSpy).toHaveBeenCalledWith(404);
      expect(jsonSpy).toHaveBeenCalled();

      const responseBody = jsonSpy.mock.calls[0][0];
      expect(responseBody.error).toBe('AppError');
      expect(responseBody.message).toBe('Not found');
      expect(responseBody.code).toBe('NOT_FOUND');
    });

    it('should handle AppError with details', () => {
      const details = { resourceId: 'abc123' };
      const error = new AppError('Resource not found', 404, 'RESOURCE_NOT_FOUND', details);

      errorHandler(
        error,
        mockRequest as Request,
        mockResponse as Response,
        mockNext
      );

      const responseBody = jsonSpy.mock.calls[0][0];
      expect(responseBody.details).toEqual(details);
    });

    it('should handle generic Error with 500 status code', () => {
      const error = new Error('Something went wrong');

      errorHandler(
        error,
        mockRequest as Request,
        mockResponse as Response,
        mockNext
      );

      expect(statusSpy).toHaveBeenCalledWith(500);

      const responseBody = jsonSpy.mock.calls[0][0];
      expect(responseBody.error).toBe('Error');
      expect(responseBody.message).toBe('Something went wrong');
      expect(responseBody.code).toBeUndefined();
      expect(responseBody.details).toBeUndefined();
    });

    it('should not call next after handling error', () => {
      const error = new AppError('Test error', 400);

      errorHandler(
        error,
        mockRequest as Request,
        mockResponse as Response,
        mockNext
      );

      expect(mockNext).not.toHaveBeenCalled();
    });

    it('should use error name in response', () => {
      const error = new TypeError('Invalid type');

      errorHandler(
        error,
        mockRequest as Request,
        mockResponse as Response,
        mockNext
      );

      const responseBody = jsonSpy.mock.calls[0][0];
      expect(responseBody.error).toBe('TypeError');
    });

    it('should handle AppError with default 500 status', () => {
      const error = new AppError('Server error');

      errorHandler(
        error,
        mockRequest as Request,
        mockResponse as Response,
        mockNext
      );

      expect(statusSpy).toHaveBeenCalledWith(500);
    });
  });

  describe('notFoundHandler', () => {
    let mockRequest: Partial<Request>;
    let mockResponse: Partial<Response>;
    let statusSpy: ReturnType<typeof mock>;
    let jsonSpy: ReturnType<typeof mock>;

    beforeEach(() => {
      statusSpy = mock(() => mockResponse);
      jsonSpy = mock(() => mockResponse);

      mockResponse = {
        status: statusSpy as unknown as Response['status'],
        json: jsonSpy as unknown as Response['json'],
      };
    });

    it('should return 404 status', () => {
      mockRequest = {
        method: 'GET',
        path: '/api/unknown',
      };

      notFoundHandler(mockRequest as Request, mockResponse as Response);

      expect(statusSpy).toHaveBeenCalledWith(404);
    });

    it('should include method and path in message', () => {
      mockRequest = {
        method: 'POST',
        path: '/api/users',
      };

      notFoundHandler(mockRequest as Request, mockResponse as Response);

      const responseBody = jsonSpy.mock.calls[0][0];
      expect(responseBody.error).toBe('NotFound');
      expect(responseBody.message).toBe('Cannot POST /api/users');
    });

    it('should handle DELETE method', () => {
      mockRequest = {
        method: 'DELETE',
        path: '/api/items/123',
      };

      notFoundHandler(mockRequest as Request, mockResponse as Response);

      const responseBody = jsonSpy.mock.calls[0][0];
      expect(responseBody.message).toBe('Cannot DELETE /api/items/123');
    });

    it('should handle PUT method', () => {
      mockRequest = {
        method: 'PUT',
        path: '/api/config',
      };

      notFoundHandler(mockRequest as Request, mockResponse as Response);

      const responseBody = jsonSpy.mock.calls[0][0];
      expect(responseBody.message).toBe('Cannot PUT /api/config');
    });

    it('should return structured error response', () => {
      mockRequest = {
        method: 'GET',
        path: '/missing',
      };

      notFoundHandler(mockRequest as Request, mockResponse as Response);

      const responseBody = jsonSpy.mock.calls[0][0];
      expect(Object.keys(responseBody)).toEqual(['error', 'message']);
    });
  });
});

describe('errorHandler with express.json request-body errors', () => {
  it('answers 400 for malformed JSON and 413 for an oversized body instead of 500', async () => {
    const express = (await import('express')).default;
    const app = express();
    app.use(express.json({ limit: '1kb' }));
    app.post('/api/echo', (req, res) => { res.json(req.body); });
    app.use(errorHandler);
    const errorSpy = spyOn(logger, 'error').mockImplementation(() => {});
    const server = await new Promise<import('node:http').Server>(resolve => {
      const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
    });
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('no listener');
      const post = (body: string) => fetch(`http://127.0.0.1:${address.port}/api/echo`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body,
      });

      expect((await post('{"broken": ')).status).toBe(400);
      expect((await post(JSON.stringify({ text: 'x'.repeat(4096) }))).status).toBe(413);
      expect((await post('{"ok":true}')).status).toBe(200);
    } finally {
      errorSpy.mockRestore();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
});
