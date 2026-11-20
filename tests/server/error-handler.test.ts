import { describe, it, expect, mock, beforeEach, afterEach, spyOn } from 'bun:test';
import type { Request, Response, NextFunction } from 'express';
import { logger } from '../../src/utils/logger.js';

import {
  AppError,
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

  it('notFoundHandler returns the method and path in a structured 404', () => {
    const status = mock(() => response);
    const json = mock(() => response);
    const response = { status, json } as unknown as Response;

    notFoundHandler({ method: 'POST', path: '/api/users' } as Request, response);

    expect(status).toHaveBeenCalledWith(404);
    expect(json).toHaveBeenCalledWith({ error: 'NotFound', message: 'Cannot POST /api/users' });
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
