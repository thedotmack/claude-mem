import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  resolveWorkerAddress,
  ensureSocketsDirectory,
  getWorkerSocketPath,
  cleanStaleSocketFiles,
  prepareSocketForListening,
  platformSupportsUnixSockets,
  resetPlatformSupportCache,
  workerSocketExists,
  type WorkerAddress
} from '../../src/supervisor/socket-manager.js';

describe('socket-manager', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    // Restore environment
    process.env = { ...originalEnv };
    resetPlatformSupportCache();
  });

  describe('platformSupportsUnixSockets', () => {
    it('should return a boolean', () => {
      resetPlatformSupportCache();
      const result = platformSupportsUnixSockets();
      expect(typeof result).toBe('boolean');
    });

    it('should cache the result', () => {
      resetPlatformSupportCache();
      const first = platformSupportsUnixSockets();
      const second = platformSupportsUnixSockets();
      expect(first).toBe(second);
    });
  });

  describe('getWorkerSocketPath', () => {
    it('should return a path ending with worker.sock', () => {
      const socketPath = getWorkerSocketPath();
      expect(socketPath).toMatch(/worker\.sock$/);
    });

    it('should include sockets directory', () => {
      const socketPath = getWorkerSocketPath();
      expect(socketPath).toContain('sockets');
    });
  });

  describe('resolveWorkerAddress', () => {
    it('should return socket type on Unix-like systems by default', () => {
      resetPlatformSupportCache();
      delete process.env.CLAUDE_MEM_WORKER_TRANSPORT;

      const address = resolveWorkerAddress();

      if (platformSupportsUnixSockets()) {
        expect(address.type).toBe('socket');
        if (address.type === 'socket') {
          expect(address.socketPath).toMatch(/worker\.sock$/);
        }
      } else {
        expect(address.type).toBe('tcp');
      }
    });

    it('should return tcp type when transport is forced to tcp via override', () => {
      const address = resolveWorkerAddress({ transport: 'tcp', port: 37777, host: '127.0.0.1' });

      expect(address.type).toBe('tcp');
      if (address.type === 'tcp') {
        expect(address.host).toBe('127.0.0.1');
        expect(address.port).toBe(37777);
      }
    });

    it('should respect settingsOverride transport', () => {
      const address = resolveWorkerAddress({ transport: 'tcp' });

      expect(address.type).toBe('tcp');
    });

    it('should use override port and host', () => {
      const address = resolveWorkerAddress({ transport: 'tcp', port: 12345, host: '0.0.0.0' });

      expect(address.type).toBe('tcp');
      if (address.type === 'tcp') {
        expect(address.port).toBe(12345);
        expect(address.host).toBe('0.0.0.0');
      }
    });
  });

  describe('ensureSocketsDirectory', () => {
    it('should create the sockets directory', () => {
      ensureSocketsDirectory();
      const socketPath = getWorkerSocketPath();
      const socketsDir = socketPath.replace(/\/[^/]+$/, '');
      expect(existsSync(socketsDir)).toBe(true);
    });
  });

  describe('cleanStaleSocketFiles', () => {
    let testDir: string;

    beforeEach(() => {
      testDir = join(tmpdir(), `socket-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
      mkdirSync(testDir, { recursive: true });
    });

    afterEach(() => {
      try {
        rmSync(testDir, { recursive: true, force: true });
      } catch {
        // Ignore cleanup errors
      }
    });

    it('should not throw when sockets directory does not exist', () => {
      // cleanStaleSocketFiles looks at the default sockets dir
      // Just verify it doesn't throw
      expect(() => cleanStaleSocketFiles()).not.toThrow();
    });
  });

  describe('prepareSocketForListening', () => {
    let testDir: string;
    let testSocket: string;

    beforeEach(() => {
      testDir = join(tmpdir(), `socket-prep-${Date.now()}-${Math.random().toString(36).slice(2)}`);
      mkdirSync(testDir, { recursive: true });
      testSocket = join(testDir, 'test.sock');
    });

    afterEach(() => {
      try {
        rmSync(testDir, { recursive: true, force: true });
      } catch {
        // Ignore cleanup errors
      }
    });

    it('should remove existing socket file', () => {
      // Create a fake socket file
      writeFileSync(testSocket, '');
      expect(existsSync(testSocket)).toBe(true);

      prepareSocketForListening(testSocket);

      expect(existsSync(testSocket)).toBe(false);
    });

    it('should not throw when socket file does not exist', () => {
      expect(() => prepareSocketForListening(testSocket)).not.toThrow();
    });
  });

  describe('workerSocketExists', () => {
    it('should return a boolean', () => {
      const result = workerSocketExists();
      expect(typeof result).toBe('boolean');
    });
  });

  describe('WorkerAddress type discrimination', () => {
    it('should discriminate socket addresses', () => {
      const addr: WorkerAddress = { type: 'socket', socketPath: '/tmp/test.sock' };
      expect(addr.type).toBe('socket');
      if (addr.type === 'socket') {
        expect(addr.socketPath).toBe('/tmp/test.sock');
      }
    });

    it('should discriminate tcp addresses', () => {
      const addr: WorkerAddress = { type: 'tcp', host: '127.0.0.1', port: 37777 };
      expect(addr.type).toBe('tcp');
      if (addr.type === 'tcp') {
        expect(addr.host).toBe('127.0.0.1');
        expect(addr.port).toBe(37777);
      }
    });
  });
});
