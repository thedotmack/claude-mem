import { describe, it, expect, mock, beforeEach, afterEach } from 'bun:test';
import { fetchWithRetry } from '../src/shared/fetch-with-retry.js';

describe('fetch-with-retry', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe('successful requests', () => {
    it('should return response on first successful attempt', async () => {
      const mockResponse = new Response('success', { status: 200 });
      globalThis.fetch = mock(() => Promise.resolve(mockResponse));

      const result = await fetchWithRetry('http://localhost/test');

      expect(result).toBe(mockResponse);
      expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    });

    it('should pass options to fetch', async () => {
      const mockResponse = new Response('success', { status: 200 });
      globalThis.fetch = mock(() => Promise.resolve(mockResponse));

      await fetchWithRetry('http://localhost/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data: 'test' })
      });

      expect(globalThis.fetch).toHaveBeenCalledWith(
        'http://localhost/test',
        expect.objectContaining({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' }
        })
      );
    });
  });

  describe('transient error handling', () => {
    it('should retry on ECONNRESET and succeed', async () => {
      const mockResponse = new Response('success', { status: 200 });
      let attempts = 0;

      globalThis.fetch = mock(() => {
        attempts++;
        if (attempts === 1) {
          const error = new Error('fetch failed');
          (error as any).cause = { code: 'ECONNRESET' };
          return Promise.reject(error);
        }
        return Promise.resolve(mockResponse);
      });

      const result = await fetchWithRetry('http://localhost/test', undefined, {
        baseDelayMs: 1 // Speed up test
      });

      expect(result).toBe(mockResponse);
      expect(attempts).toBe(2);
    });

    it('should retry on ECONNREFUSED and succeed', async () => {
      const mockResponse = new Response('success', { status: 200 });
      let attempts = 0;

      globalThis.fetch = mock(() => {
        attempts++;
        if (attempts === 1) {
          const error = new Error('fetch failed');
          (error as any).cause = { code: 'ECONNREFUSED' };
          return Promise.reject(error);
        }
        return Promise.resolve(mockResponse);
      });

      const result = await fetchWithRetry('http://localhost/test', undefined, {
        baseDelayMs: 1
      });

      expect(result).toBe(mockResponse);
      expect(attempts).toBe(2);
    });

    it('should retry on EPIPE and succeed', async () => {
      const mockResponse = new Response('success', { status: 200 });
      let attempts = 0;

      globalThis.fetch = mock(() => {
        attempts++;
        if (attempts === 1) {
          const error = new Error('fetch failed');
          (error as any).cause = { code: 'EPIPE' };
          return Promise.reject(error);
        }
        return Promise.resolve(mockResponse);
      });

      const result = await fetchWithRetry('http://localhost/test', undefined, {
        baseDelayMs: 1
      });

      expect(result).toBe(mockResponse);
      expect(attempts).toBe(2);
    });

    it('should retry on ETIMEDOUT and succeed', async () => {
      const mockResponse = new Response('success', { status: 200 });
      let attempts = 0;

      globalThis.fetch = mock(() => {
        attempts++;
        if (attempts === 1) {
          const error = new Error('fetch failed');
          (error as any).cause = { code: 'ETIMEDOUT' };
          return Promise.reject(error);
        }
        return Promise.resolve(mockResponse);
      });

      const result = await fetchWithRetry('http://localhost/test', undefined, {
        baseDelayMs: 1
      });

      expect(result).toBe(mockResponse);
      expect(attempts).toBe(2);
    });

    it('should retry up to max retries then fail', async () => {
      let attempts = 0;

      globalThis.fetch = mock(() => {
        attempts++;
        const error = new Error('fetch failed');
        (error as any).cause = { code: 'ECONNRESET' };
        return Promise.reject(error);
      });

      await expect(
        fetchWithRetry('http://localhost/test', undefined, {
          retries: 3,
          baseDelayMs: 1
        })
      ).rejects.toThrow('fetch failed');

      expect(attempts).toBe(4); // Initial + 3 retries
    });

    it('should detect transient error from message when cause.code is missing', async () => {
      const mockResponse = new Response('success', { status: 200 });
      let attempts = 0;

      globalThis.fetch = mock(() => {
        attempts++;
        if (attempts === 1) {
          return Promise.reject(new Error('Connection reset: ECONNRESET'));
        }
        return Promise.resolve(mockResponse);
      });

      const result = await fetchWithRetry('http://localhost/test', undefined, {
        baseDelayMs: 1
      });

      expect(result).toBe(mockResponse);
      expect(attempts).toBe(2);
    });
  });

  describe('non-transient error handling', () => {
    it('should not retry on non-transient errors', async () => {
      let attempts = 0;

      globalThis.fetch = mock(() => {
        attempts++;
        return Promise.reject(new Error('Some other error'));
      });

      await expect(
        fetchWithRetry('http://localhost/test', undefined, {
          retries: 3,
          baseDelayMs: 1
        })
      ).rejects.toThrow('Some other error');

      expect(attempts).toBe(1); // No retries
    });

    it('should not retry on TypeError', async () => {
      let attempts = 0;

      globalThis.fetch = mock(() => {
        attempts++;
        return Promise.reject(new TypeError('Invalid URL'));
      });

      await expect(
        fetchWithRetry('http://localhost/test', undefined, {
          retries: 3,
          baseDelayMs: 1
        })
      ).rejects.toThrow('Invalid URL');

      expect(attempts).toBe(1);
    });
  });

  describe('retry options', () => {
    it('should use custom retry count', async () => {
      let attempts = 0;

      globalThis.fetch = mock(() => {
        attempts++;
        const error = new Error('fetch failed');
        (error as any).cause = { code: 'ECONNRESET' };
        return Promise.reject(error);
      });

      await expect(
        fetchWithRetry('http://localhost/test', undefined, {
          retries: 5,
          baseDelayMs: 1
        })
      ).rejects.toThrow();

      expect(attempts).toBe(6); // Initial + 5 retries
    });

    it('should use default options when not specified', async () => {
      const mockResponse = new Response('success', { status: 200 });
      globalThis.fetch = mock(() => Promise.resolve(mockResponse));

      const result = await fetchWithRetry('http://localhost/test');

      expect(result).toBe(mockResponse);
    });
  });
});
