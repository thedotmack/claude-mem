/**
 * Tests for bufferedPostRequest (worker-utils.ts layer 2 fallback)
 *
 * Verifies:
 * 1. Client mode refuses to start without CLAUDE_MEM_SERVER_HOST (validated in worker-service
 *    integration; here we test that client mode detection gates the buffer path).
 * 2. bufferedPostRequest falls through to workerHttpRequest on success.
 * 3. bufferedPostRequest buffers on failure in client mode.
 * 4. bufferedPostRequest throws in standalone mode on failure.
 */

import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from 'bun:test';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'fs';
import path from 'path';
import os from 'os';
import { logger } from '../../src/utils/logger.js';

// ─── helpers ──────────────────────────────────────────────────────────────────

let tmpDir: string;
let loggerSpies: ReturnType<typeof spyOn>[] = [];

// Cache-clear helpers — worker-utils caches port/host after first read
async function clearWorkerUtilsCache() {
  const mod = await import('../../src/shared/worker-utils.js');
  mod.clearPortCache();
}

// Reset module-level env vars set during tests
function setNetworkMode(mode: 'standalone' | 'client' | 'server') {
  process.env.CLAUDE_MEM_NETWORK_MODE = mode;
}

function clearNetworkMode() {
  delete process.env.CLAUDE_MEM_NETWORK_MODE;
}

// ─── setup / teardown ─────────────────────────────────────────────────────────

beforeEach(async () => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), 'buffered-post-test-'));

  // Point settings at our temp dir so OfflineBuffer writes there
  process.env.CLAUDE_MEM_DATA_DIR = tmpDir;
  process.env.CLAUDE_MEM_NODE_NAME = 'test-node';

  loggerSpies = [
    spyOn(logger, 'info').mockImplementation(() => {}),
    spyOn(logger, 'debug').mockImplementation(() => {}),
    spyOn(logger, 'warn').mockImplementation(() => {}),
    spyOn(logger, 'error').mockImplementation(() => {}),
  ];

  await clearWorkerUtilsCache();
});

afterEach(async () => {
  loggerSpies.forEach(s => s.mockRestore());
  clearNetworkMode();
  delete process.env.CLAUDE_MEM_DATA_DIR;
  delete process.env.CLAUDE_MEM_NODE_NAME;
  rmSync(tmpDir, { recursive: true, force: true });
  await clearWorkerUtilsCache();
});

// ─── tests ────────────────────────────────────────────────────────────────────

describe('bufferedPostRequest', () => {
  describe('successful request (all modes)', () => {
    it('returns the workerHttpRequest response when the worker replies', async () => {
      // Spin up a tiny Express server on a random port to act as the "worker"
      const express = (await import('express')).default;
      const http = (await import('http')).default;

      const app = express();
      app.use(express.json());
      app.post('/api/test', (_req, res) => res.status(200).json({ ok: true }));

      const server = await new Promise<http.Server>((resolve, reject) => {
        const s = app.listen(0, '127.0.0.1', () => resolve(s));
        s.on('error', reject);
      });

      const addr = server.address() as { port: number };
      const port = addr.port;

      // Override port via env so worker-utils builds the right URL
      process.env.CLAUDE_MEM_WORKER_PORT = String(port);
      process.env.CLAUDE_MEM_WORKER_HOST = '127.0.0.1';
      await clearWorkerUtilsCache();

      setNetworkMode('standalone');

      const { bufferedPostRequest } = await import('../../src/shared/worker-utils.js');
      const response = await bufferedPostRequest('/api/test', JSON.stringify({ hello: 'world' }));

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.ok).toBe(true);

      // No buffer file should exist
      expect(existsSync(path.join(tmpDir, 'buffer.jsonl'))).toBe(false);

      await new Promise<void>(r => { server.closeAllConnections(); server.close(() => r()); });
      delete process.env.CLAUDE_MEM_WORKER_PORT;
      delete process.env.CLAUDE_MEM_WORKER_HOST;
    });
  });

  describe('worker unreachable in client mode', () => {
    it('buffers the request and returns 202', async () => {
      // Point at a port with nothing listening
      process.env.CLAUDE_MEM_WORKER_PORT = '19999';
      process.env.CLAUDE_MEM_WORKER_HOST = '127.0.0.1';
      await clearWorkerUtilsCache();

      setNetworkMode('client');

      const { bufferedPostRequest } = await import('../../src/shared/worker-utils.js');
      const payload = JSON.stringify({ content: 'offline observation' });
      const response = await bufferedPostRequest('/api/sessions/observations', payload);

      expect(response.status).toBe(202);
      const body = await response.json();
      expect(body.buffered).toBe(true);

      // Buffer file should contain exactly one entry
      const bufferPath = path.join(tmpDir, 'buffer.jsonl');
      expect(existsSync(bufferPath)).toBe(true);

      const lines = readFileSync(bufferPath, 'utf-8').trim().split('\n');
      expect(lines.length).toBe(1);

      const entry = JSON.parse(lines[0]);
      expect(entry.path).toBe('/api/sessions/observations');
      expect(entry.method).toBe('POST');
      expect(entry.node).toBe('test-node');
      expect(entry.body.content).toBe('offline observation');

      delete process.env.CLAUDE_MEM_WORKER_PORT;
      delete process.env.CLAUDE_MEM_WORKER_HOST;
    });

    it('accumulates multiple failed requests in the buffer', async () => {
      process.env.CLAUDE_MEM_WORKER_PORT = '19998';
      process.env.CLAUDE_MEM_WORKER_HOST = '127.0.0.1';
      await clearWorkerUtilsCache();

      setNetworkMode('client');

      const { bufferedPostRequest } = await import('../../src/shared/worker-utils.js');

      await bufferedPostRequest('/api/sessions/observations', JSON.stringify({ i: 1 }));
      await bufferedPostRequest('/api/sessions/observations', JSON.stringify({ i: 2 }));
      await bufferedPostRequest('/api/sessions/observations', JSON.stringify({ i: 3 }));

      const bufferPath = path.join(tmpDir, 'buffer.jsonl');
      const lines = readFileSync(bufferPath, 'utf-8').trim().split('\n');
      expect(lines.length).toBe(3);

      delete process.env.CLAUDE_MEM_WORKER_PORT;
      delete process.env.CLAUDE_MEM_WORKER_HOST;
    });
  });

  describe('worker unreachable in standalone mode', () => {
    it('throws the error instead of buffering', async () => {
      process.env.CLAUDE_MEM_WORKER_PORT = '19997';
      process.env.CLAUDE_MEM_WORKER_HOST = '127.0.0.1';
      await clearWorkerUtilsCache();

      setNetworkMode('standalone');

      const { bufferedPostRequest } = await import('../../src/shared/worker-utils.js');
      const payload = JSON.stringify({ content: 'should not buffer' });

      await expect(bufferedPostRequest('/api/sessions/observations', payload)).rejects.toThrow();

      // No buffer file
      expect(existsSync(path.join(tmpDir, 'buffer.jsonl'))).toBe(false);

      delete process.env.CLAUDE_MEM_WORKER_PORT;
      delete process.env.CLAUDE_MEM_WORKER_HOST;
    });
  });

  describe('worker unreachable in server mode', () => {
    it('throws the error instead of buffering', async () => {
      process.env.CLAUDE_MEM_WORKER_PORT = '19996';
      process.env.CLAUDE_MEM_WORKER_HOST = '127.0.0.1';
      await clearWorkerUtilsCache();

      setNetworkMode('server');

      const { bufferedPostRequest } = await import('../../src/shared/worker-utils.js');
      const payload = JSON.stringify({ data: 'test' });

      await expect(bufferedPostRequest('/api/test', payload)).rejects.toThrow();

      expect(existsSync(path.join(tmpDir, 'buffer.jsonl'))).toBe(false);

      delete process.env.CLAUDE_MEM_WORKER_PORT;
      delete process.env.CLAUDE_MEM_WORKER_HOST;
    });
  });
});
