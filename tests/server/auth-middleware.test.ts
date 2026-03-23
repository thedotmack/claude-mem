/**
 * Tests for createAuthMiddleware
 *
 * Mock Justification (~10% mock code):
 * - Logger spies: Suppress console output during tests (standard practice)
 * - Express req/res mocks: Required because Express middleware expects these
 *   objects - testing the actual auth logic (IP check, token comparison, timing-safe equality)
 *
 * What's NOT mocked: timingSafeEqual (crypto built-in), token comparison logic
 *
 * Note: Imports from auth-middleware.ts directly (not middleware.ts) because
 * middleware.ts imports express at runtime which is not installed in test env.
 * auth-middleware.ts uses only `import type` from express — zero runtime dependency.
 */
import { describe, it, expect, mock, beforeEach, afterEach, spyOn } from 'bun:test';
import type { Request, Response, NextFunction } from 'express';

// Import after note: no mock.module needed — auth-middleware.ts has no runtime express dep
import { logger } from '../../src/utils/logger.js';
import { createAuthMiddleware } from '../../src/services/worker/http/auth-middleware.js';

// Spy on logger methods to suppress output during tests
let loggerSpies: ReturnType<typeof spyOn>[] = [];

// Helper to build a minimal mock Request
function mockReq(overrides: Partial<{
  ip: string | undefined;
  connection: { remoteAddress: string };
  path: string;
  headers: Record<string, string>;
}> = {}): Request {
  return {
    ip: '127.0.0.1',
    connection: { remoteAddress: '127.0.0.1' },
    path: '/api/test',
    headers: {},
    ...overrides,
  } as unknown as Request;
}

// Helper to build a mock Response that captures status + json calls
function mockRes(): { res: Response; statusCode: () => number | undefined; jsonBody: () => any } {
  let _statusCode: number | undefined;
  let _jsonBody: any;

  const jsonFn = mock((body: any) => { _jsonBody = body; return res; });
  const statusFn = mock((code: number) => { _statusCode = code; return res; });

  const res = {
    status: statusFn as unknown as Response['status'],
    json: jsonFn as unknown as Response['json'],
  } as unknown as Response;

  return {
    res,
    statusCode: () => _statusCode,
    jsonBody: () => _jsonBody,
  };
}

describe('createAuthMiddleware', () => {
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

  describe('localhost bypass', () => {
    const localhostIps = ['127.0.0.1', '::1', '::ffff:127.0.0.1', 'localhost'];

    for (const ip of localhostIps) {
      it(`should pass localhost requests without token — ip=${ip}`, () => {
        const middleware = createAuthMiddleware(() => '');
        const req = mockReq({ ip });
        const { res } = mockRes();
        const next = mock(() => {});

        middleware(req, res, next as unknown as NextFunction);

        expect(next).toHaveBeenCalledTimes(1);
      });
    }

    it('should pass localhost request even when a valid token is configured', () => {
      const middleware = createAuthMiddleware(() => 'secret-token');
      const req = mockReq({ ip: '127.0.0.1' });
      const { res } = mockRes();
      const next = mock(() => {});

      middleware(req, res, next as unknown as NextFunction);

      expect(next).toHaveBeenCalledTimes(1);
    });
  });

  describe('remote request — no token configured', () => {
    it('should reject with 403 when no auth token is configured', () => {
      const middleware = createAuthMiddleware(() => '');
      const req = mockReq({ ip: '192.168.1.100' });
      const { res, statusCode, jsonBody } = mockRes();
      const next = mock(() => {});

      middleware(req, res, next as unknown as NextFunction);

      expect(next).not.toHaveBeenCalled();
      expect(statusCode()).toBe(403);
      expect(jsonBody().error).toBe('forbidden');
      expect(jsonBody().message).toContain('CLAUDE_MEM_AUTH_TOKEN');
    });
  });

  describe('remote request — token configured', () => {
    it('should reject with 401 when Authorization header is missing', () => {
      const middleware = createAuthMiddleware(() => 'secret-token');
      const req = mockReq({ ip: '10.0.0.1', headers: {} });
      const { res, statusCode, jsonBody } = mockRes();
      const next = mock(() => {});

      middleware(req, res, next as unknown as NextFunction);

      expect(next).not.toHaveBeenCalled();
      expect(statusCode()).toBe(401);
      expect(jsonBody().error).toBe('unauthorized');
    });

    it('should reject with 401 when Authorization uses Basic scheme instead of Bearer', () => {
      const middleware = createAuthMiddleware(() => 'secret-token');
      const req = mockReq({
        ip: '10.0.0.1',
        headers: { authorization: 'Basic dXNlcjpwYXNz' },
      });
      const { res, statusCode, jsonBody } = mockRes();
      const next = mock(() => {});

      middleware(req, res, next as unknown as NextFunction);

      expect(next).not.toHaveBeenCalled();
      expect(statusCode()).toBe(401);
      expect(jsonBody().error).toBe('unauthorized');
    });

    it('should reject with 401 when Bearer token is wrong', () => {
      const middleware = createAuthMiddleware(() => 'correct-token');
      const req = mockReq({
        ip: '10.0.0.1',
        headers: { authorization: 'Bearer wrong-token' },
      });
      const { res, statusCode, jsonBody } = mockRes();
      const next = mock(() => {});

      middleware(req, res, next as unknown as NextFunction);

      expect(next).not.toHaveBeenCalled();
      expect(statusCode()).toBe(401);
      expect(jsonBody().error).toBe('unauthorized');
    });

    it('should reject with 401 when Bearer token has correct prefix but different length', () => {
      const middleware = createAuthMiddleware(() => 'correct-token');
      const req = mockReq({
        ip: '10.0.0.1',
        headers: { authorization: 'Bearer short' },
      });
      const { res, statusCode } = mockRes();
      const next = mock(() => {});

      middleware(req, res, next as unknown as NextFunction);

      expect(next).not.toHaveBeenCalled();
      expect(statusCode()).toBe(401);
    });

    it('should pass (call next) when correct Bearer token is provided', () => {
      const TOKEN = 'my-secret-bearer-token';
      const middleware = createAuthMiddleware(() => TOKEN);
      const req = mockReq({
        ip: '10.0.0.1',
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      const { res } = mockRes();
      const next = mock(() => {});

      middleware(req, res, next as unknown as NextFunction);

      expect(next).toHaveBeenCalledTimes(1);
    });

    it('should reject with 401 when Authorization header is just "Bearer " with no token value', () => {
      const middleware = createAuthMiddleware(() => 'secret-token');
      const req = mockReq({
        ip: '10.0.0.1',
        // "Bearer " alone — empty string token after slice(7)
        headers: { authorization: 'Bearer ' },
      });
      const { res, statusCode } = mockRes();
      const next = mock(() => {});

      middleware(req, res, next as unknown as NextFunction);

      expect(next).not.toHaveBeenCalled();
      expect(statusCode()).toBe(401);
    });

    it('should use getAuthToken callback each call — supports dynamic token rotation', () => {
      let tokenValue = 'token-v1';
      const middleware = createAuthMiddleware(() => tokenValue);

      const makeReq = (token: string) => mockReq({
        ip: '10.0.0.1',
        headers: { authorization: `Bearer ${token}` },
      });

      const next1 = mock(() => {});
      const { res: res1 } = mockRes();
      middleware(makeReq('token-v1'), res1, next1 as unknown as NextFunction);
      expect(next1).toHaveBeenCalledTimes(1);

      // Rotate token
      tokenValue = 'token-v2';

      const next2 = mock(() => {});
      const { res: res2, statusCode: sc2 } = mockRes();
      // Old token no longer valid
      middleware(makeReq('token-v1'), res2, next2 as unknown as NextFunction);
      expect(next2).not.toHaveBeenCalled();
      expect(sc2()).toBe(401);

      const next3 = mock(() => {});
      const { res: res3 } = mockRes();
      // New token works
      middleware(makeReq('token-v2'), res3, next3 as unknown as NextFunction);
      expect(next3).toHaveBeenCalledTimes(1);
    });

    it('should fall back to connection.remoteAddress when req.ip is absent', () => {
      const middleware = createAuthMiddleware(() => '');
      // No req.ip, but remoteAddress is remote
      const req = {
        ip: undefined,
        connection: { remoteAddress: '10.0.0.5' },
        path: '/api/test',
        headers: {},
      } as unknown as Request;
      const { res, statusCode } = mockRes();
      const next = mock(() => {});

      middleware(req, res, next as unknown as NextFunction);

      expect(next).not.toHaveBeenCalled();
      expect(statusCode()).toBe(403);
    });
  });

  describe('onAuthRejected callback', () => {
    it('should invoke onAuthRejected when no auth token is configured', () => {
      const rejected: Array<{ ip: string; path: string }> = [];
      const middleware = createAuthMiddleware(() => '', {
        onAuthRejected: (ip, path) => rejected.push({ ip, path }),
      });
      const req = mockReq({ ip: '192.168.1.100', path: '/api/foo' });
      const { res } = mockRes();

      middleware(req, res, mock(() => {}) as unknown as NextFunction);

      expect(rejected).toHaveLength(1);
      expect(rejected[0].ip).toBe('192.168.1.100');
      expect(rejected[0].path).toBe('/api/foo');
    });

    it('should invoke onAuthRejected when Authorization header is missing', () => {
      const rejected: Array<{ ip: string; path: string }> = [];
      const middleware = createAuthMiddleware(() => 'secret', {
        onAuthRejected: (ip, path) => rejected.push({ ip, path }),
      });
      const req = mockReq({ ip: '10.0.0.1', headers: {} });
      const { res } = mockRes();

      middleware(req, res, mock(() => {}) as unknown as NextFunction);

      expect(rejected).toHaveLength(1);
    });

    it('should invoke onAuthRejected when token is invalid', () => {
      const rejected: Array<{ ip: string; path: string }> = [];
      const middleware = createAuthMiddleware(() => 'correct-token', {
        onAuthRejected: (ip, path) => rejected.push({ ip, path }),
      });
      const req = mockReq({
        ip: '10.0.0.1',
        headers: { authorization: 'Bearer wrong-token' },
      });
      const { res } = mockRes();

      middleware(req, res, mock(() => {}) as unknown as NextFunction);

      expect(rejected).toHaveLength(1);
    });

    it('should NOT invoke onAuthRejected when localhost bypasses auth', () => {
      const rejected: Array<{ ip: string; path: string }> = [];
      const middleware = createAuthMiddleware(() => '', {
        onAuthRejected: (ip, path) => rejected.push({ ip, path }),
      });
      const req = mockReq({ ip: '127.0.0.1' });
      const { res } = mockRes();
      const next = mock(() => {});

      middleware(req, res, next as unknown as NextFunction);

      expect(next).toHaveBeenCalledTimes(1);
      expect(rejected).toHaveLength(0);
    });

    it('should NOT invoke onAuthRejected when a valid token is provided', () => {
      const rejected: Array<{ ip: string; path: string }> = [];
      const TOKEN = 'valid-token';
      const middleware = createAuthMiddleware(() => TOKEN, {
        onAuthRejected: (ip, path) => rejected.push({ ip, path }),
      });
      const req = mockReq({
        ip: '10.0.0.1',
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      const { res } = mockRes();
      const next = mock(() => {});

      middleware(req, res, next as unknown as NextFunction);

      expect(next).toHaveBeenCalledTimes(1);
      expect(rejected).toHaveLength(0);
    });

    it('should work without onAuthRejected option (no callback — no throw)', () => {
      const middleware = createAuthMiddleware(() => '');
      const req = mockReq({ ip: '10.0.0.5' });
      const { res } = mockRes();

      expect(() => {
        middleware(req, res, mock(() => {}) as unknown as NextFunction);
      }).not.toThrow();
    });
  });
});
