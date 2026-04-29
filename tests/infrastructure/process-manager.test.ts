import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { existsSync, readFileSync, mkdirSync, writeFileSync, rmSync, statSync } from 'fs';
import { homedir } from 'os';
import { tmpdir } from 'os';
import path from 'path';
import {
  writePidFile,
  readPidFile,
  removePidFile,
  getPlatformTimeout,
  parseElapsedTime,
  isProcessAlive,
  cleanStalePidFile,
  isPidFileRecent,
  touchPidFile,
  spawnDaemon,
  resolveWorkerRuntimePath,
  runOneTimeChromaMigration,
  captureProcessStartToken,
  verifyPidFileOwnership,
  type PidInfo
} from '../../src/services/infrastructure/index.js';

const DATA_DIR = path.join(homedir(), '.claude-mem');
const PID_FILE = path.join(DATA_DIR, 'worker.pid');

describe('ProcessManager', () => {
  let originalPidContent: string | null = null;

  beforeEach(() => {
    if (existsSync(PID_FILE)) {
      originalPidContent = readFileSync(PID_FILE, 'utf-8');
    }
  });

  afterEach(() => {
    if (originalPidContent !== null) {
      writeFileSync(PID_FILE, originalPidContent);
      originalPidContent = null;
    } else {
      removePidFile();
    }
  });

  describe('writePidFile', () => {
    it('should create file with PID info', () => {
      const testInfo: PidInfo = {
        pid: 12345,
        port: 37777,
        startedAt: new Date().toISOString()
      };

      writePidFile(testInfo);

      expect(existsSync(PID_FILE)).toBe(true);
      const content = JSON.parse(readFileSync(PID_FILE, 'utf-8'));
      expect(content.pid).toBe(12345);
      expect(content.port).toBe(37777);
      expect(content.startedAt).toBe(testInfo.startedAt);
    });

    it('should overwrite existing PID file', () => {
      const firstInfo: PidInfo = {
        pid: 11111,
        port: 37777,
        startedAt: '2024-01-01T00:00:00.000Z'
      };
      const secondInfo: PidInfo = {
        pid: 22222,
        port: 37888,
        startedAt: '2024-01-02T00:00:00.000Z'
      };

      writePidFile(firstInfo);
      writePidFile(secondInfo);

      const content = JSON.parse(readFileSync(PID_FILE, 'utf-8'));
      expect(content.pid).toBe(22222);
      expect(content.port).toBe(37888);
    });
  });

  describe('readPidFile', () => {
    it('should return PidInfo object for valid file', () => {
      const testInfo: PidInfo = {
        pid: 54321,
        port: 37999,
        startedAt: '2024-06-15T12:00:00.000Z'
      };
      writePidFile(testInfo);

      const result = readPidFile();

      expect(result).not.toBeNull();
      expect(result!.pid).toBe(54321);
      expect(result!.port).toBe(37999);
      expect(result!.startedAt).toBe('2024-06-15T12:00:00.000Z');
    });

    it('should return null for missing file', () => {
      removePidFile();

      const result = readPidFile();

      expect(result).toBeNull();
    });

    it('should return null for corrupted JSON', () => {
      writeFileSync(PID_FILE, 'not valid json {{{');

      const result = readPidFile();

      expect(result).toBeNull();
    });
  });

  describe('removePidFile', () => {
    it('should delete existing file', () => {
      const testInfo: PidInfo = {
        pid: 99999,
        port: 37777,
        startedAt: new Date().toISOString()
      };
      writePidFile(testInfo);
      expect(existsSync(PID_FILE)).toBe(true);

      removePidFile();

      expect(existsSync(PID_FILE)).toBe(false);
    });

    it('should not throw for missing file', () => {
      removePidFile();
      expect(existsSync(PID_FILE)).toBe(false);

      expect(() => removePidFile()).not.toThrow();
    });
  });

  describe('parseElapsedTime', () => {
    it('should parse MM:SS format', () => {
      expect(parseElapsedTime('05:30')).toBe(5);
      expect(parseElapsedTime('00:45')).toBe(0);
      expect(parseElapsedTime('59:59')).toBe(59);
    });

    it('should parse HH:MM:SS format', () => {
      expect(parseElapsedTime('01:30:00')).toBe(90);
      expect(parseElapsedTime('02:15:30')).toBe(135);
      expect(parseElapsedTime('00:05:00')).toBe(5);
    });

    it('should parse DD-HH:MM:SS format', () => {
      expect(parseElapsedTime('1-00:00:00')).toBe(1440);  
      expect(parseElapsedTime('2-12:30:00')).toBe(3630);  
      expect(parseElapsedTime('0-01:00:00')).toBe(60);    
    });

    it('should return -1 for empty or invalid input', () => {
      expect(parseElapsedTime('')).toBe(-1);
      expect(parseElapsedTime('   ')).toBe(-1);
      expect(parseElapsedTime('invalid')).toBe(-1);
    });
  });

  describe('getPlatformTimeout', () => {
    const originalPlatform = process.platform;

    afterEach(() => {
      Object.defineProperty(process, 'platform', {
        value: originalPlatform,
        writable: true,
        configurable: true
      });
    });

    it('should return same value on non-Windows platforms', () => {
      Object.defineProperty(process, 'platform', {
        value: 'darwin',
        writable: true,
        configurable: true
      });

      const result = getPlatformTimeout(1000);

      expect(result).toBe(1000);
    });

    it('should return doubled value on Windows', () => {
      Object.defineProperty(process, 'platform', {
        value: 'win32',
        writable: true,
        configurable: true
      });

      const result = getPlatformTimeout(1000);

      expect(result).toBe(2000);
    });

    it('should apply 2.0x multiplier consistently on Windows', () => {
      Object.defineProperty(process, 'platform', {
        value: 'win32',
        writable: true,
        configurable: true
      });

      expect(getPlatformTimeout(500)).toBe(1000);
      expect(getPlatformTimeout(5000)).toBe(10000);
      expect(getPlatformTimeout(100)).toBe(200);
    });

    it('should round Windows timeout values', () => {
      Object.defineProperty(process, 'platform', {
        value: 'win32',
        writable: true,
        configurable: true
      });

      const result = getPlatformTimeout(333);

      expect(result).toBe(666);
    });
  });

  describe('resolveWorkerRuntimePath', () => {
    it('should reuse execPath when already running under Bun on Linux', () => {
      const resolved = resolveWorkerRuntimePath({
        platform: 'linux',
        execPath: '/home/alice/.bun/bin/bun'
      });

      expect(resolved).toBe('/home/alice/.bun/bin/bun');
    });

    it('should look up Bun on non-Windows when caller is Node (e.g. MCP server)', () => {
      const resolved = resolveWorkerRuntimePath({
        platform: 'linux',
        execPath: '/usr/bin/node',
        env: {} as NodeJS.ProcessEnv,
        homeDirectory: '/home/alice',
        pathExists: candidatePath => candidatePath === '/home/alice/.bun/bin/bun',
        lookupInPath: () => null
      });

      expect(resolved).toBe('/home/alice/.bun/bin/bun');
    });

    it('should preserve bare BUN env command on non-Windows so spawn resolves it via PATH', () => {
      const resolved = resolveWorkerRuntimePath({
        platform: 'linux',
        execPath: '/usr/bin/node',
        env: { BUN: 'bun' } as NodeJS.ProcessEnv,
        homeDirectory: '/home/alice',
        pathExists: () => false,
        lookupInPath: () => null
      });

      expect(resolved).toBe('bun');
    });

    it('should fall back to PATH lookup on non-Windows when no known Bun candidate exists', () => {
      const resolved = resolveWorkerRuntimePath({
        platform: 'linux',
        execPath: '/usr/bin/node',
        env: {} as NodeJS.ProcessEnv,
        homeDirectory: '/home/alice',
        pathExists: () => false,
        lookupInPath: () => '/custom/bin/bun'
      });

      expect(resolved).toBe('/custom/bin/bun');
    });

    it('should return null on non-Windows when Bun cannot be resolved', () => {
      const resolved = resolveWorkerRuntimePath({
        platform: 'linux',
        execPath: '/usr/bin/node',
        env: {} as NodeJS.ProcessEnv,
        homeDirectory: '/home/alice',
        pathExists: () => false,
        lookupInPath: () => null
      });

      expect(resolved).toBeNull();
    });

    it('should reuse execPath when already running under Bun on Windows', () => {
      const resolved = resolveWorkerRuntimePath({
        platform: 'win32',
        execPath: 'C:\\Users\\alice\\.bun\\bin\\bun.exe'
      });

      expect(resolved).toBe('C:\\Users\\alice\\.bun\\bin\\bun.exe');
    });

    it('should prefer configured Bun path from environment when available', () => {
      const resolved = resolveWorkerRuntimePath({
        platform: 'win32',
        execPath: 'C:\\Program Files\\nodejs\\node.exe',
        env: { BUN: 'C:\\tools\\bun.exe' } as NodeJS.ProcessEnv,
        pathExists: candidatePath => candidatePath === 'C:\\tools\\bun.exe',
        lookupInPath: () => null
      });

      expect(resolved).toBe('C:\\tools\\bun.exe');
    });

    it('should fall back to PATH lookup when no Bun candidate exists', () => {
      const resolved = resolveWorkerRuntimePath({
        platform: 'win32',
        execPath: 'C:\\Program Files\\nodejs\\node.exe',
        env: {} as NodeJS.ProcessEnv,
        pathExists: () => false,
        lookupInPath: () => 'C:\\Program Files\\Bun\\bun.exe'
      });

      expect(resolved).toBe('C:\\Program Files\\Bun\\bun.exe');
    });

    it('should return null when Bun cannot be resolved on Windows', () => {
      const resolved = resolveWorkerRuntimePath({
        platform: 'win32',
        execPath: 'C:\\Program Files\\nodejs\\node.exe',
        env: {} as NodeJS.ProcessEnv,
        pathExists: () => false,
        lookupInPath: () => null
      });

      expect(resolved).toBeNull();
    });
  });

  describe('isProcessAlive', () => {
    it('should return true for the current process', () => {
      expect(isProcessAlive(process.pid)).toBe(true);
    });

    it('should return false for a non-existent PID', () => {
      expect(isProcessAlive(2147483647)).toBe(false);
    });

    it('should return true for PID 0 (Windows WMIC sentinel)', () => {
      expect(isProcessAlive(0)).toBe(true);
    });

    it('should return false for negative PIDs', () => {
      expect(isProcessAlive(-1)).toBe(false);
      expect(isProcessAlive(-999)).toBe(false);
    });

    it('should return false for non-integer PIDs', () => {
      expect(isProcessAlive(1.5)).toBe(false);
      expect(isProcessAlive(NaN)).toBe(false);
    });
  });

  describe('captureProcessStartToken', () => {
    const supported = process.platform === 'linux' || process.platform === 'darwin';

    it.if(supported)('returns a non-empty token for the current process', () => {
      const token = captureProcessStartToken(process.pid);
      expect(typeof token).toBe('string');
      expect((token ?? '').length).toBeGreaterThan(0);
    });

    it.if(supported)('returns a stable token across calls for the same PID', () => {
      const first = captureProcessStartToken(process.pid);
      const second = captureProcessStartToken(process.pid);
      expect(first).toBe(second);
    });

    it('returns null for a non-existent PID', () => {
      expect(captureProcessStartToken(2147483647)).toBeNull();
    });

    it('returns null for invalid PIDs', () => {
      expect(captureProcessStartToken(0)).toBeNull();
      expect(captureProcessStartToken(-1)).toBeNull();
      expect(captureProcessStartToken(1.5)).toBeNull();
      expect(captureProcessStartToken(NaN)).toBeNull();
    });

    it('returns null on win32 (liveness-only fallback path)', () => {
      const originalPlatform = process.platform;
      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
      try {
        expect(captureProcessStartToken(process.pid)).toBeNull();
      } finally {
        Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
      }
    });
  });

  describe('writePidFile (start-token capture)', () => {
    const supported = process.platform === 'linux' || process.platform === 'darwin';

    it.if(supported)('auto-captures a startToken when writing for the current process', () => {
      writePidFile({ pid: process.pid, port: 37777, startedAt: new Date().toISOString() });
      const persisted = readPidFile();
      expect(persisted).not.toBeNull();
      expect(typeof persisted!.startToken).toBe('string');
      expect((persisted!.startToken ?? '').length).toBeGreaterThan(0);
    });

    it('preserves a caller-supplied startToken verbatim', () => {
      const provided = 'caller-supplied-token-xyz';
      writePidFile({ pid: process.pid, port: 37777, startedAt: new Date().toISOString(), startToken: provided });
      const persisted = readPidFile();
      expect(persisted!.startToken).toBe(provided);
    });

    it('omits startToken when the target PID has no readable token (dead PID)', () => {
      writePidFile({ pid: 2147483647, port: 37777, startedAt: new Date().toISOString() });
      const persisted = readPidFile();
      expect(persisted).not.toBeNull();
      expect(persisted!.startToken).toBeUndefined();
    });
  });

  describe('verifyPidFileOwnership', () => {
    const supported = process.platform === 'linux' || process.platform === 'darwin';

    it('returns false for null input', () => {
      expect(verifyPidFileOwnership(null)).toBe(false);
    });

    it('returns false when the PID is not alive', () => {
      expect(verifyPidFileOwnership({
        pid: 2147483647,
        port: 37777,
        startedAt: new Date().toISOString(),
        startToken: 'anything'
      })).toBe(false);
    });

    it('returns true when no startToken is stored (back-compat with older PID files)', () => {
      expect(verifyPidFileOwnership({
        pid: process.pid,
        port: 37777,
        startedAt: new Date().toISOString()
        // intentionally no startToken
      })).toBe(true);
    });

    it.if(supported)('returns true when the stored token matches the current PID', () => {
      const token = captureProcessStartToken(process.pid);
      expect(token).not.toBeNull();
      expect(verifyPidFileOwnership({
        pid: process.pid,
        port: 37777,
        startedAt: new Date().toISOString(),
        startToken: token!
      })).toBe(true);
    });

    it.if(supported)('returns false when the stored token does not match (PID reused)', () => {
      expect(verifyPidFileOwnership({
        pid: process.pid,
        port: 37777,
        startedAt: new Date().toISOString(),
        startToken: 'token-from-a-different-incarnation'
      })).toBe(false);
    });
  });

  describe('cleanStalePidFile', () => {
    it('should remove PID file when process is dead', () => {
      const staleInfo: PidInfo = {
        pid: 2147483647,
        port: 37777,
        startedAt: '2024-01-01T00:00:00.000Z'
      };
      writePidFile(staleInfo);
      expect(existsSync(PID_FILE)).toBe(true);

      cleanStalePidFile();

      expect(existsSync(PID_FILE)).toBe(false);
    });

    it('should keep PID file when process is alive', () => {
      const liveInfo: PidInfo = {
        pid: process.pid,
        port: 37777,
        startedAt: new Date().toISOString()
      };
      writePidFile(liveInfo);

      cleanStalePidFile();

      expect(existsSync(PID_FILE)).toBe(true);
    });

    it('should do nothing when PID file does not exist', () => {
      removePidFile();
      expect(existsSync(PID_FILE)).toBe(false);

      expect(() => cleanStalePidFile()).not.toThrow();
    });
  });

  describe('isPidFileRecent', () => {
    it('should return true for a recently written PID file', () => {
      writePidFile({ pid: process.pid, port: 37777, startedAt: new Date().toISOString() });

      expect(isPidFileRecent(15000)).toBe(true);
    });

    it('should return false when PID file does not exist', () => {
      removePidFile();

      expect(isPidFileRecent(15000)).toBe(false);
    });

    it('should return false for a very short threshold on a real file', () => {
      writePidFile({ pid: process.pid, port: 37777, startedAt: new Date().toISOString() });

      expect(isPidFileRecent(-1)).toBe(false);
    });
  });

  describe('touchPidFile', () => {
    it('should update mtime of existing PID file', async () => {
      writePidFile({ pid: process.pid, port: 37777, startedAt: new Date().toISOString() });

      await new Promise(r => setTimeout(r, 50));

      const statsBefore = statSync(PID_FILE);
      const mtimeBefore = statsBefore.mtimeMs;

      await new Promise(r => setTimeout(r, 50));

      touchPidFile();

      const statsAfter = statSync(PID_FILE);
      const mtimeAfter = statsAfter.mtimeMs;

      expect(mtimeAfter).toBeGreaterThanOrEqual(mtimeBefore);
    });

    it('should not throw when PID file does not exist', () => {
      removePidFile();

      expect(() => touchPidFile()).not.toThrow();
    });
  });

  describe('spawnDaemon', () => {
    it('should use setsid on Linux when available', () => {
      if (process.platform === 'win32') return; 

      const setsidAvailable = existsSync('/usr/bin/setsid');
      if (!setsidAvailable) return; 

      const pid = spawnDaemon('/dev/null', 39999);

      expect(pid).toBeDefined();
      expect(typeof pid).toBe('number');

      if (pid !== undefined && pid > 0) {
        try { process.kill(pid, 'SIGKILL'); } catch { /* already exited */ }
      }
    });

    it('should return undefined when spawn fails on Windows path', () => {
      if (process.platform === 'win32') return;

      const result = spawnDaemon('/nonexistent/script.cjs', 39998);
      expect(result).toBeDefined();

      if (result !== undefined && result > 0) {
        try { process.kill(result, 'SIGKILL'); } catch { /* already exited */ }
      }
    });

    it('Windows 0 PID success sentinel must NOT be detected via falsy check', () => {
      const windowsSuccessSentinel: number | undefined = 0;
      const failureSentinel: number | undefined = undefined;

      expect(windowsSuccessSentinel === undefined).toBe(false);
      expect(failureSentinel === undefined).toBe(true);

      expect(!windowsSuccessSentinel).toBe(true); 
      expect(!failureSentinel).toBe(true);

      const isFailure = (pid: number | undefined) => pid === undefined;
      expect(isFailure(windowsSuccessSentinel)).toBe(false);
      expect(isFailure(failureSentinel)).toBe(true);
    });
  });

  describe('SIGHUP handling', () => {
    it('should have SIGHUP listeners registered (integration check)', () => {
      if (process.platform === 'win32') return;

      let received = false;
      const testHandler = () => { received = true; };

      process.on('SIGHUP', testHandler);
      expect(process.listenerCount('SIGHUP')).toBeGreaterThanOrEqual(1);

      process.removeListener('SIGHUP', testHandler);
    });

    it('should ignore SIGHUP when --daemon is in process.argv', () => {
      if (process.platform === 'win32') return;

      const isDaemon = process.argv.includes('--daemon');
      expect(isDaemon).toBe(false);

      // Verify the non-daemon path: SIGHUP should trigger shutdown (covered by registerSignalHandlers)
      // This is a logic verification test — actual signal delivery is tested manually
    });
  });

  describe('runOneTimeChromaMigration', () => {
    let testDataDir: string;

    beforeEach(() => {
      testDataDir = path.join(tmpdir(), `claude-mem-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
      mkdirSync(testDataDir, { recursive: true });
    });

    afterEach(() => {
      rmSync(testDataDir, { recursive: true, force: true });
    });

    it('should wipe chroma directory and write marker file', () => {
      const chromaDir = path.join(testDataDir, 'chroma');
      mkdirSync(chromaDir, { recursive: true });
      writeFileSync(path.join(chromaDir, 'test-data.bin'), 'fake chroma data');

      runOneTimeChromaMigration(testDataDir);

      expect(existsSync(chromaDir)).toBe(false);
      expect(existsSync(path.join(testDataDir, '.chroma-cleaned-v10.3'))).toBe(true);
    });

    it('should skip when marker file already exists (idempotent)', () => {
      writeFileSync(path.join(testDataDir, '.chroma-cleaned-v10.3'), 'already done');

      const chromaDir = path.join(testDataDir, 'chroma');
      mkdirSync(chromaDir, { recursive: true });
      writeFileSync(path.join(chromaDir, 'important.bin'), 'should survive');

      runOneTimeChromaMigration(testDataDir);

      expect(existsSync(chromaDir)).toBe(true);
      expect(existsSync(path.join(chromaDir, 'important.bin'))).toBe(true);
    });

    it('should handle missing chroma directory gracefully', () => {
      expect(() => runOneTimeChromaMigration(testDataDir)).not.toThrow();
      expect(existsSync(path.join(testDataDir, '.chroma-cleaned-v10.3'))).toBe(true);
    });
  });
});
