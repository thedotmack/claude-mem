/**
 * Tests for Express error handling middleware
 *
 * Mock Justification (~11% mock code):
 * - Logger spies: Suppress console output during tests (standard practice)
 * - Express req/res mocks: Required because Express middleware expects these
 *   objects - testing the actual formatting and status code logic
 *
 * What's NOT mocked: AppError class, createErrorResponse function (tested directly)
 */
import { describe, it, expect, mock, beforeEach, afterEach, spyOn } from 'bun:test';
import type { Request, Response, NextFunction } from 'express';
import { logger } from '../../src/utils/logger.js';

import {
  AppError,
  createErrorResponse,
  errorHandler,
  notFoundHandler,
} from '../../src/services/server/ErrorHandler.js';

// Spy on logger methods to suppress output during tests
// Using spyOn instead of mock.module to avoid polluting global module cache
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

      // Empty string is falsy, so code should not be set
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
