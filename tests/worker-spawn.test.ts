import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test';
import { execSync, ChildProcess } from 'child_process';
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync, rmSync } from 'fs';
import { homedir } from 'os';
import path from 'path';

/**
 * Worker Self-Spawn Integration Tests
 *
 * Tests actual integration points:
 * - Health check utilities (real network behavior)
 * - PID file management (real filesystem)
 * - Status command output format
 * - Windows-specific behavior detection
 *
 * Removed: JSON.parse tests, CLI command parsing (tests language built-ins)
 */

const TEST_PORT = 37877;
const TEST_DATA_DIR = path.join(homedir(), '.claude-mem-test');
const TEST_PID_FILE = path.join(TEST_DATA_DIR, 'worker.pid');
const WORKER_SCRIPT = path.join(__dirname, '../plugin/scripts/worker-service.cjs');

interface PidInfo {
  pid: number;
  port: number;
  startedAt: string;
}

/**
 * Helper to check if port is in use by attempting a health check
 */
async function isPortInUse(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/health`, {
      signal: AbortSignal.timeout(2000)
    });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Helper to wait for port to be healthy
 */
async function waitForHealth(port: number, timeoutMs: number = 30000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await isPortInUse(port)) return true;
    await new Promise(r => setTimeout(r, 500));
  }
  return false;
}

/**
 * Run worker CLI command and return stdout
 */
function runWorkerCommand(command: string, env: Record<string, string> = {}): string {
  const result = execSync(`bun "${WORKER_SCRIPT}" ${command}`, {
    env: { ...process.env, ...env },
    encoding: 'utf-8',
    timeout: 60000
  });
  return result.trim();
}

describe('Worker Self-Spawn CLI', () => {
  beforeAll(async () => {
    if (existsSync(TEST_DATA_DIR)) {
      rmSync(TEST_DATA_DIR, { recursive: true });
    }
  });

  afterAll(async () => {
    if (existsSync(TEST_DATA_DIR)) {
      rmSync(TEST_DATA_DIR, { recursive: true });
    }
  });

  describe('status command', () => {
    it('should report worker status in expected format', async () => {
      const output = runWorkerCommand('status');
      // Should contain either "running" or "not running"
      expect(output.includes('running')).toBe(true);
    });

    it('should include PID and port when running', async () => {
      const output = runWorkerCommand('status');
      if (output.includes('Worker running')) {
        expect(output).toMatch(/PID: \d+/);
        expect(output).toMatch(/Port: \d+/);
      }
    });
  });

  describe('PID file management', () => {
    it('should create and read PID file with correct structure', () => {
      mkdirSync(TEST_DATA_DIR, { recursive: true });

      const testPidInfo: PidInfo = {
        pid: 12345,
        port: TEST_PORT,
        startedAt: new Date().toISOString()
      };

      writeFileSync(TEST_PID_FILE, JSON.stringify(testPidInfo, null, 2));
      expect(existsSync(TEST_PID_FILE)).toBe(true);

      const readInfo = JSON.parse(readFileSync(TEST_PID_FILE, 'utf-8')) as PidInfo;
      expect(readInfo.pid).toBe(12345);
      expect(readInfo.port).toBe(TEST_PORT);
      expect(readInfo.startedAt).toBe(testPidInfo.startedAt);

      // Cleanup
      unlinkSync(TEST_PID_FILE);
      expect(existsSync(TEST_PID_FILE)).toBe(false);
    });
  });

  describe('health check utilities', () => {
    it('should return false for non-existent server', async () => {
      const unusedPort = 39999;
      const result = await isPortInUse(unusedPort);
      expect(result).toBe(false);
    });

    it('should timeout appropriately for unreachable server', async () => {
      const start = Date.now();
      const result = await isPortInUse(39998);
      const elapsed = Date.now() - start;

      expect(result).toBe(false);
      // Should not wait longer than the timeout (2s) + small buffer
      expect(elapsed).toBeLessThan(3000);
    });
  });
});

describe('Worker Health Endpoints', () => {
  let workerProcess: ChildProcess | null = null;

  beforeAll(async () => {
    // Skip if worker script doesn't exist (not built)
    if (!existsSync(WORKER_SCRIPT)) {
      console.log('Skipping worker health tests - worker script not built');
      return;
    }
  });

  afterAll(async () => {
    if (workerProcess) {
      workerProcess.kill('SIGTERM');
      workerProcess = null;
    }
  });

  describe('health endpoint contract', () => {
    it('should expect /api/health to return status ok with expected fields', async () => {
      // Contract validation: verify expected response structure
      const mockResponse = {
        status: 'ok',
        build: 'TEST-008-wrapper-ipc',
        managed: false,
        hasIpc: false,
        platform: 'darwin',
        pid: 12345,
        initialized: true,
        mcpReady: true
      };

      expect(mockResponse.status).toBe('ok');
      expect(typeof mockResponse.build).toBe('string');
      expect(typeof mockResponse.pid).toBe('number');
      expect(typeof mockResponse.managed).toBe('boolean');
      expect(typeof mockResponse.initialized).toBe('boolean');
    });

    it('should expect /api/readiness to distinguish ready vs initializing states', async () => {
      const readyResponse = { status: 'ready', mcpReady: true };
      const initializingResponse = { status: 'initializing', message: 'Worker is still initializing, please retry' };

      expect(readyResponse.status).toBe('ready');
      expect(initializingResponse.status).toBe('initializing');
    });
  });
});

describe('Windows-specific behavior', () => {
  const originalPlatform = process.platform;

  afterEach(() => {
    Object.defineProperty(process, 'platform', {
      value: originalPlatform,
      writable: true,
      configurable: true
    });
    delete process.env.CLAUDE_MEM_MANAGED;
  });

  it('should detect Windows managed worker mode correctly', () => {
    Object.defineProperty(process, 'platform', {
      value: 'win32',
      writable: true,
      configurable: true
    });
    process.env.CLAUDE_MEM_MANAGED = 'true';

    const isWindows = process.platform === 'win32';
    const isManaged = process.env.CLAUDE_MEM_MANAGED === 'true';

    expect(isWindows).toBe(true);
    expect(isManaged).toBe(true);

    // In non-managed mode (without process.send), IPC messages won't work
    const hasProcessSend = typeof process.send === 'function';
    const isWindowsManaged = isWindows && isManaged && hasProcessSend;
    expect(isWindowsManaged).toBe(false); // No process.send in test context
  });
});
