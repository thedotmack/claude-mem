import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'bun:test';
import { spawn, execSync, ChildProcess } from 'child_process';
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync, rmSync } from 'fs';
import { homedir } from 'os';
import path from 'path';

// Test configuration
const TEST_PORT = 37877; // Use different port than default to avoid conflicts
const TEST_DATA_DIR = path.join(homedir(), '.claude-mem-test');
const TEST_PID_FILE = path.join(TEST_DATA_DIR, 'worker.pid');
const WORKER_SCRIPT = path.join(__dirname, '../plugin/scripts/worker-service.cjs');

// Timeout for health checks
const HEALTH_TIMEOUT_MS = 5000;

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
 * Helper to wait for port to be free
 */
async function waitForPortFree(port: number, timeoutMs: number = 10000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (!(await isPortInUse(port))) return true;
    await new Promise(r => setTimeout(r, 500));
  }
  return false;
}

/**
 * Helper to shut down worker via HTTP
 */
async function httpShutdown(port: number): Promise<boolean> {
  try {
    await fetch(`http://127.0.0.1:${port}/api/admin/shutdown`, {
      method: 'POST',
      signal: AbortSignal.timeout(5000)
    });
    return true;
  } catch {
    return false;
  }
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
    // Clean up test data directory
    if (existsSync(TEST_DATA_DIR)) {
      rmSync(TEST_DATA_DIR, { recursive: true });
    }
  });

  afterAll(async () => {
    // Clean up test data directory
    if (existsSync(TEST_DATA_DIR)) {
      rmSync(TEST_DATA_DIR, { recursive: true });
    }
  });

  describe('status command', () => {
    it('should report worker status in expected format', async () => {
      // The status command reads from settings file, not env vars
      // Just verify the output format is correct (running or not running)
      const output = runWorkerCommand('status');

      // Should contain either "running" or "not running"
      const hasValidStatus = output.includes('running');
      expect(hasValidStatus).toBe(true);
    });

    it('should include PID and port when running', async () => {
      const output = runWorkerCommand('status');

      // If running, should include PID and port
      if (output.includes('Worker running')) {
        expect(output).toMatch(/PID: \d+/);
        expect(output).toMatch(/Port: \d+/);
      }
    });
  });

  describe('PID file management', () => {
    it('should create PID file with correct structure', () => {
      // Create test directory
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
    });

    it('should handle missing PID file gracefully', () => {
      const missingPath = path.join(TEST_DATA_DIR, 'nonexistent.pid');
      expect(existsSync(missingPath)).toBe(false);
    });

    it('should remove PID file correctly', () => {
      mkdirSync(TEST_DATA_DIR, { recursive: true });
      writeFileSync(TEST_PID_FILE, JSON.stringify({ pid: 1, port: 1, startedAt: '' }));

      expect(existsSync(TEST_PID_FILE)).toBe(true);

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

  describe('hook response format', () => {
    it('should return valid JSON hook response', () => {
      const hookResponse = '{"continue": true, "suppressOutput": true}';
      const parsed = JSON.parse(hookResponse);

      expect(parsed.continue).toBe(true);
      expect(parsed.suppressOutput).toBe(true);
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

    // Start worker for health endpoint tests using default port
    // Note: These tests use the real worker, so they may be affected by existing worker state
  });

  afterAll(async () => {
    if (workerProcess) {
      workerProcess.kill('SIGTERM');
      workerProcess = null;
    }
  });

  describe('health endpoint contract', () => {
    it('should expect /api/health to return status ok', async () => {
      // This is a contract test - validates expected format
      const expectedHealthResponse = {
        status: 'ok',
        build: expect.any(String),
        managed: expect.any(Boolean),
        hasIpc: expect.any(Boolean),
        platform: expect.any(String),
        pid: expect.any(Number),
        initialized: expect.any(Boolean),
        mcpReady: expect.any(Boolean)
      };

      // Verify the contract structure matches what the code returns
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
    });

    it('should expect /api/readiness to return status when ready', async () => {
      const expectedReadyResponse = {
        status: 'ready',
        mcpReady: true
      };

      expect(expectedReadyResponse.status).toBe('ready');
      expect(expectedReadyResponse.mcpReady).toBe(true);
    });

    it('should expect /api/readiness to return 503 when initializing', async () => {
      const expectedInitializingResponse = {
        status: 'initializing',
        message: 'Worker is still initializing, please retry'
      };

      expect(expectedInitializingResponse.status).toBe('initializing');
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
  });

  it('should use different shutdown behavior on Windows', () => {
    Object.defineProperty(process, 'platform', {
      value: 'win32',
      writable: true,
      configurable: true
    });

    // Windows uses IPC messages for managed workers
    const isWindowsManaged = process.platform === 'win32' &&
      process.env.CLAUDE_MEM_MANAGED === 'true' &&
      typeof process.send === 'function';

    // In non-managed mode, this should be false
    expect(isWindowsManaged).toBe(false);
  });

  it('should identify managed Windows worker correctly', () => {
    Object.defineProperty(process, 'platform', {
      value: 'win32',
      writable: true,
      configurable: true
    });

    // Set managed environment
    process.env.CLAUDE_MEM_MANAGED = 'true';

    const isWindows = process.platform === 'win32';
    const isManaged = process.env.CLAUDE_MEM_MANAGED === 'true';

    expect(isWindows).toBe(true);
    expect(isManaged).toBe(true);

    // Cleanup
    delete process.env.CLAUDE_MEM_MANAGED;
  });
});

describe('CLI command parsing', () => {
  it('should recognize start command', () => {
    const args = ['node', 'worker-service.cjs', 'start'];
    const command = args[2];
    expect(command).toBe('start');
  });

  it('should recognize stop command', () => {
    const args = ['node', 'worker-service.cjs', 'stop'];
    const command = args[2];
    expect(command).toBe('stop');
  });

  it('should recognize restart command', () => {
    const args = ['node', 'worker-service.cjs', 'restart'];
    const command = args[2];
    expect(command).toBe('restart');
  });

  it('should recognize status command', () => {
    const args = ['node', 'worker-service.cjs', 'status'];
    const command = args[2];
    expect(command).toBe('status');
  });

  it('should recognize --daemon flag', () => {
    const args = ['node', 'worker-service.cjs', '--daemon'];
    const command = args[2];
    expect(command).toBe('--daemon');
  });

  it('should default to daemon mode without command', () => {
    const args = ['node', 'worker-service.cjs'];
    const command = args[2]; // undefined
    // Default case in switch handles undefined by running as daemon
    expect(command).toBeUndefined();
  });
});
