import { describe, it, expect, beforeEach, afterEach, afterAll } from 'bun:test';
import { spawn, spawnSync } from 'child_process';
import { existsSync, readFileSync, mkdirSync, mkdtempSync, writeFileSync, rmSync, statSync, utimesSync } from 'fs';
import { homedir, tmpdir } from 'os';
import path from 'path';
import type { PidInfo } from '../../src/services/infrastructure/index.js';

// ── Data-dir isolation (Phase 6, worker-restart plan) ──────────────────────
// These tests write corrupt JSON and sentinel PIDs into the worker PID file,
// so that file must NEVER be the real ~/.claude-mem/worker.pid. paths.ts
// freezes DATA_DIR at first evaluation and ProcessManager freezes PID_FILE
// from it at import time — and ESM hoists static imports above any env
// assignment — so the env var is set FIRST and the code under test is loaded
// with dynamic imports below. (`import type` above is erased at compile time
// and loads nothing.)
const TEST_DATA_DIR = mkdtempSync(path.join(tmpdir(), 'claude-mem-pm-test-'));
const PREVIOUS_DATA_DIR = process.env.CLAUDE_MEM_DATA_DIR;
process.env.CLAUDE_MEM_DATA_DIR = TEST_DATA_DIR;

const {
  writePidFile,
  readPidFile,
  removePidFile,
  removePidFileIfOwner,
  getPlatformTimeout,
  cleanStalePidFile,
  isPidFileRecent,
  touchPidFile,
  spawnDetachedWorkerDaemon,
  getLastWorkerDaemonLaunchError,
  probeWorkerBootFailure,
  shouldRetryWorkerBootProbe,
  buildDetachedWorkerDaemonSpawn,
  daemonWorkingDirectory,
  pinDaemonWorkingDirectory,
  resolveWorkerRuntimePath,
  captureProcessStartToken,
  verifyPidFileOwnership,
} = await import('../../src/services/infrastructure/index.js');
const { paths } = await import('../../src/shared/paths.js');

// If an earlier test file in this bun process already evaluated paths.ts, the
// module cache wins and DATA_DIR stays frozen on that earlier value — which is
// the preload tripwire's per-run temp dir (tests/preload.ts), never the real
// ~/.claude-mem. Derive the paths the assertions use from the SAME frozen
// module the code under test uses, so test and code can never diverge.
const DATA_DIR = paths.dataDir();
const PID_FILE = paths.workerPid();

describe('ProcessManager', () => {
  const REAL_DATA_DIR = path.join(homedir(), '.claude-mem');

  beforeEach(() => {
    mkdirSync(DATA_DIR, { recursive: true });
    removePidFile();
  });

  afterEach(() => {
    removePidFile();
  });

  afterAll(() => {
    if (PREVIOUS_DATA_DIR === undefined) {
      delete process.env.CLAUDE_MEM_DATA_DIR;
    } else {
      process.env.CLAUDE_MEM_DATA_DIR = PREVIOUS_DATA_DIR;
    }
    if (DATA_DIR === TEST_DATA_DIR) {
      // paths.ts froze on our per-file dir (this file evaluated it first):
      // empty it but keep the directory alive so later-loaded modules in this
      // process don't point at a deleted path.
      rmSync(TEST_DATA_DIR, { recursive: true, force: true });
      mkdirSync(TEST_DATA_DIR, { recursive: true });
    } else {
      rmSync(TEST_DATA_DIR, { recursive: true, force: true });
    }
  });

  describe('test isolation (Phase 6, worker-restart plan)', () => {
    it('resolves the PID file into a temp dir, never the real ~/.claude-mem', () => {
      expect(DATA_DIR).not.toBe(REAL_DATA_DIR);
      expect(PID_FILE.startsWith(REAL_DATA_DIR + path.sep)).toBe(false);
      expect(PID_FILE).toBe(path.join(DATA_DIR, 'worker.pid'));
      expect(paths.supervisorRegistry().startsWith(REAL_DATA_DIR + path.sep)).toBe(false);
    });
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
      expect(readPidFile()).toEqual(testInfo);
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

  // Phase 5 (worker-restart plan): owner-or-dead guarded deletion. The CLI
  // stop/restart cleanup and the dying worker's restart handoff must never
  // delete a live successor's PID file.
  describe('removePidFileIfOwner', () => {
    it('deletes the file when the recorded pid matches the expected owner (even if alive)', () => {
      writePidFile({ pid: process.pid, port: 37777, startedAt: new Date().toISOString() });

      removePidFileIfOwner(process.pid);

      expect(existsSync(PID_FILE)).toBe(false);
    });

    it('deletes the file when the recorded pid is dead, regardless of owner match', () => {
      writePidFile({ pid: 2147483647, port: 37777, startedAt: new Date().toISOString() });

      removePidFileIfOwner(null);

      expect(existsSync(PID_FILE)).toBe(false);
    });

    it('spares the file when the recorded pid is a live, different process (restart successor)', () => {
      // This test process stands in for the live successor; pid 1 (init,
      // never this process) stands in for the worker the caller shut down.
      writePidFile({ pid: process.pid, port: 37777, startedAt: new Date().toISOString() });

      removePidFileIfOwner(1);

      expect(existsSync(PID_FILE)).toBe(true);
      expect(readPidFile()!.pid).toBe(process.pid);
    });

    it('spares a corrupt file (ownership cannot be proven)', () => {
      writeFileSync(PID_FILE, 'not valid json {{{');

      removePidFileIfOwner(process.pid);

      expect(existsSync(PID_FILE)).toBe(true);
    });

    it('deletes a parseable file with no pid field (treated as dead owner)', () => {
      // Valid JSON, but no `pid`: recorded.pid is undefined, so
      // isProcessAlive() is false and the owner-or-dead guard falls through
      // to removal. This intentionally diverges from the supervisor-side
      // removeOwnedPidFile, which spares pid-less files — that guard only
      // ever deletes its own file, while this helper may clean dead
      // leftovers. The divergence is safe: a pid-less file can't belong to a
      // live successor (writePidFile always records a pid).
      writeFileSync(PID_FILE, JSON.stringify({ port: 37777 }));

      removePidFileIfOwner(null);

      expect(existsSync(PID_FILE)).toBe(false);
    });

    it('does not throw when the file is missing', () => {
      removePidFile();
      expect(existsSync(PID_FILE)).toBe(false);

      expect(() => removePidFileIfOwner(process.pid)).not.toThrow();
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

    it.each([
      ['darwin', 1000, 1000],
      ['win32', 1000, 2000],
      ['win32', 500, 1000],
      ['win32', 5000, 10000],
      ['win32', 100, 200],
      ['win32', 333, 666],
    ])('uses %s timeout %i → %i', (platform, timeout, expected) => {
      Object.defineProperty(process, 'platform', {
        value: platform,
        writable: true,
        configurable: true
      });

      expect(getPlatformTimeout(timeout)).toBe(expected);
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
      // path.join follows the host OS separator even when platform:'linux' is
      // injected, so expect the host-joined form (Windows CI runs this too).
      const expected = path.join('/home/alice', '.bun', 'bin', 'bun');
      const resolved = resolveWorkerRuntimePath({
        platform: 'linux',
        execPath: '/usr/bin/node',
        env: {} as NodeJS.ProcessEnv,
        homeDirectory: '/home/alice',
        pathExists: candidatePath => candidatePath === expected,
        lookupInPath: () => null
      });

      expect(resolved).toBe(expected);
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
        pathExists: candidatePath => candidatePath === '/custom/bin/bun',
        lookupInPath: () => '/custom/bin/bun',
        realpath: candidatePath => candidatePath
      });

      expect(resolved).toBe('/custom/bin/bun');
    });

    it('should reject a dangling PATH fallback that resolves to a missing binary', () => {
      // Reproduces the reported crash source: `which bun` returns an npm/nvm
      // shim that is on PATH but whose real binary never landed. The unguarded
      // fallback returned it verbatim; the guard now rejects it.
      const resolved = resolveWorkerRuntimePath({
        platform: 'linux',
        execPath: '/usr/bin/node',
        env: {} as NodeJS.ProcessEnv,
        homeDirectory: '/home/alice',
        pathExists: () => false,
        lookupInPath: () => '/home/alice/.config/nvm/versions/node/v24.16.0/lib/node_modules/bun/bin/bun',
        realpath: () => null
      });

      expect(resolved).toBeNull();
    });

    it('should reject a PATH fallback that is not a Bun executable', () => {
      const resolved = resolveWorkerRuntimePath({
        platform: 'linux',
        execPath: '/usr/bin/node',
        env: {} as NodeJS.ProcessEnv,
        homeDirectory: '/home/alice',
        pathExists: () => false,
        lookupInPath: () => '/usr/bin/node'
      });

      expect(resolved).toBeNull();
    });

    it('should return the resolved real path when the PATH fallback is a symlink', () => {
      const resolved = resolveWorkerRuntimePath({
        platform: 'linux',
        execPath: '/usr/bin/node',
        env: {} as NodeJS.ProcessEnv,
        homeDirectory: '/home/alice',
        pathExists: candidatePath => candidatePath === '/home/alice/.bun/bin/bun',
        lookupInPath: () => '/usr/local/bin/bun',
        realpath: () => '/home/alice/.bun/bin/bun'
      });

      expect(resolved).toBe('/home/alice/.bun/bin/bun');
    });

    it('should resolve an npm-global Bun from npm_config_prefix', () => {
      const resolved = resolveWorkerRuntimePath({
        platform: 'linux',
        execPath: '/usr/bin/node',
        env: { npm_config_prefix: '/home/alice/.npm-global' } as NodeJS.ProcessEnv,
        homeDirectory: '/home/alice',
        pathExists: candidatePath => candidatePath === '/home/alice/.npm-global/bin/bun',
        lookupInPath: () => null
      });

      expect(resolved).toBe('/home/alice/.npm-global/bin/bun');
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

    it('should resolve Bun from BUN_INSTALL on Windows when PATH is empty (#3224)', () => {
      // path.join follows the host OS separator even when platform:'win32' is
      // injected, so expect the host-joined form (Linux CI / T-Rex runs this too).
      const expected = path.join('D:\\custom\\bun-root', 'bin', 'bun.exe');
      const resolved = resolveWorkerRuntimePath({
        platform: 'win32',
        execPath: 'C:\\Program Files\\nodejs\\node.exe',
        env: { BUN_INSTALL: 'D:\\custom\\bun-root' } as NodeJS.ProcessEnv,
        homeDirectory: 'C:\\Users\\alice',
        pathExists: candidatePath => candidatePath === expected,
        lookupInPath: () => null
      });

      expect(resolved).toBe(expected);
    });

    it('should resolve Bun from BUN_INSTALL on Linux when PATH is empty (#3224)', () => {
      // path.join follows the host OS separator even when platform:'linux' is
      // injected, so expect the host-joined form (Windows CI runs this too).
      const expected = path.join('/opt/bun', 'bin', 'bun');
      const resolved = resolveWorkerRuntimePath({
        platform: 'linux',
        execPath: '/usr/bin/node',
        env: { BUN_INSTALL: '/opt/bun' } as NodeJS.ProcessEnv,
        homeDirectory: '/home/alice',
        pathExists: candidatePath => candidatePath === expected,
        lookupInPath: () => null
      });

      expect(resolved).toBe(expected);
    });

    it('should fall back to PATH lookup when no Bun candidate exists', () => {
      const resolved = resolveWorkerRuntimePath({
        platform: 'win32',
        execPath: 'C:\\Program Files\\nodejs\\node.exe',
        env: {} as NodeJS.ProcessEnv,
        pathExists: candidatePath => candidatePath === 'C:\\Program Files\\Bun\\bun.exe',
        lookupInPath: () => 'C:\\Program Files\\Bun\\bun.exe',
        realpath: candidatePath => candidatePath
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
    it.if(process.platform === 'linux')('treats a tokenless PID reused by an unrelated process as stale', () => {
      const commandLine = readFileSync(`/proc/${process.pid}/cmdline`, 'utf-8');
      expect(commandLine).not.toContain('worker-service.cjs');
      writeFileSync(PID_FILE, JSON.stringify({
        pid: process.pid,
        port: 37777,
        startedAt: new Date().toISOString()
      }));

      expect(cleanStalePidFile({ removeStale: false })).toBe('stale');
      expect(existsSync(PID_FILE)).toBe(true);
    });

    it.if(process.platform === 'linux')('accepts a tokenless worker identified by its command line', async () => {
      const workerDir = mkdtempSync(path.join(tmpdir(), 'claude-mem-legacy-worker-'));
      const workerScript = path.join(workerDir, 'worker-service.cjs');
      writeFileSync(workerScript, 'setInterval(() => {}, 1000);\n');
      const worker = spawn(process.execPath, [workerScript], { stdio: 'ignore' });

      try {
        await new Promise<void>((resolve, reject) => {
          worker.once('spawn', resolve);
          worker.once('error', reject);
        });
        if (!worker.pid) throw new Error('Worker test process did not receive a PID');
        writeFileSync(PID_FILE, JSON.stringify({
          pid: worker.pid,
          port: 37777,
          startedAt: new Date().toISOString()
        }));

        expect(cleanStalePidFile({ removeStale: false })).toBe('alive');
      } finally {
        // An exit that already happened never fires 'exit' again, so only wait
        // for a child still running, and never longer than five seconds.
        if (worker.exitCode === null && worker.signalCode === null) {
          const exited = new Promise<void>(resolve => worker.once('exit', () => resolve()));
          worker.kill('SIGTERM');
          let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
          await Promise.race([exited, new Promise<void>(resolve => { cleanupTimer = setTimeout(resolve, 5_000); })]);
          clearTimeout(cleanupTimer);
        }
        rmSync(workerDir, { recursive: true, force: true });
      }
    });

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
    it('should update mtime of existing PID file', () => {
      writePidFile({ pid: process.pid, port: 37777, startedAt: new Date().toISOString() });
      const past = new Date(Date.now() - 60_000);
      utimesSync(PID_FILE, past, past);
      const mtimeBefore = statSync(PID_FILE).mtimeMs;

      touchPidFile();

      expect(statSync(PID_FILE).mtimeMs).toBeGreaterThan(mtimeBefore);
    });

    it('should not throw when PID file does not exist', () => {
      removePidFile();

      expect(() => touchPidFile()).not.toThrow();
    });
  });

  describe('probeWorkerBootFailure', () => {
    // spawnDaemon detaches the worker with its stdio discarded, so a bundle
    // that dies during module resolution — the shape a truncated `bun install`
    // in the plugin cache takes — used to leave nothing behind but "worker
    // exited". These run real subprocesses against the same runtime resolution
    // the probe uses in production; a stub would only prove the stub.
    const PROBE_DIR = path.join(DATA_DIR, 'boot-probe');

    const writeProbeScript = (name: string, body: string): string => {
      mkdirSync(PROBE_DIR, { recursive: true });
      const scriptPath = path.join(PROBE_DIR, name);
      writeFileSync(scriptPath, body, 'utf-8');
      return scriptPath;
    };

    afterAll(() => {
      rmSync(PROBE_DIR, { recursive: true, force: true });
    });

    it('reports the error from a bundle that cannot resolve its dependencies', () => {
      const scriptPath = writeProbeScript(
        'unresolvable.cjs',
        `require('./this-dependency-was-never-installed.cjs');\n`
      );

      const failure = probeWorkerBootFailure(scriptPath);

      expect(failure).toBeDefined();
      expect(failure!).toMatch(/this-dependency-was-never-installed/);
    });

    it('stays silent when the bundle loads and exits cleanly', () => {
      const scriptPath = writeProbeScript(
        'healthy.cjs',
        `console.log('Worker is not running');\nprocess.exit(0);\n`
      );

      expect(probeWorkerBootFailure(scriptPath)).toBeUndefined();
    });

    it('stays silent when the bundle fails without saying anything', () => {
      const scriptPath = writeProbeScript('mute.cjs', `process.exit(1);\n`);

      expect(probeWorkerBootFailure(scriptPath)).toBeUndefined();
    });

    it('caps a runaway stack trace instead of pasting it whole into the log', () => {
      const scriptPath = writeProbeScript(
        'noisy.cjs',
        `for (let i = 0; i < 200; i++) console.error('boot noise line ' + i);\nprocess.exit(1);\n`
      );

      const failure = probeWorkerBootFailure(scriptPath);

      expect(failure).toBeDefined();
      expect(failure!.split('\n').length).toBeLessThanOrEqual(8);
      expect(failure!).toContain('boot noise line 0');
    });

    it('runs the bundle with Bun auto-install off, like the daemon it stands in for (#5601)', () => {
      const scriptPath = writeProbeScript(
        'exec-argv.cjs',
        `console.error('execArgv=' + JSON.stringify(process.execArgv));\nprocess.exit(1);\n`
      );

      const failure = probeWorkerBootFailure(scriptPath);

      expect(failure).toBeDefined();
      expect(failure!).toContain('execArgv=["--no-install"]');
    });

    it('returns rather than throwing when the script does not exist at all', () => {
      const missing = path.join(PROBE_DIR, 'no-such-worker-bundle.cjs');

      expect(() => probeWorkerBootFailure(missing)).not.toThrow();
    });

    describe('shouldRetryWorkerBootProbe', () => {
      const etimedout = (): Error => Object.assign(new Error('spawnSync ETIMEDOUT'), { code: 'ETIMEDOUT' });

      it('retries a window that expired far too early to be real', () => {
        // The measured shape of the bug: ETIMEDOUT after 25ms of a 5s window.
        expect(shouldRetryWorkerBootProbe(etimedout(), 25, 5000)).toBe(true);
      });

      it('does not retry a timeout that burned its whole window', () => {
        expect(shouldRetryWorkerBootProbe(etimedout(), 5001, 5000)).toBe(false);
        expect(shouldRetryWorkerBootProbe(etimedout(), 2500, 5000)).toBe(false);
      });

      it('does not retry failures that are not timeouts', () => {
        const enoent = Object.assign(new Error('spawnSync ENOENT'), { code: 'ENOENT' });

        expect(shouldRetryWorkerBootProbe(enoent, 5, 5000)).toBe(false);
        expect(shouldRetryWorkerBootProbe(undefined, 5, 5000)).toBe(false);
      });
    });
  });

  // A process holds an open handle on its working directory. On Windows that locks the
  // directory against rename and move for as long as the process lives, and a daemon
  // outlives the session that spawned it -- so a hook-spawned daemon inheriting the
  // project folder left it permanently locked (#3706).
  describe('daemon working directory (#3706)', () => {
    it('hands the daemon the data directory, never the caller cwd', () => {
      const plan = buildDetachedWorkerDaemonSpawn(
        String.raw`C:\bun\bun.exe`,
        String.raw`C:\plugin\worker-service.cjs`,
        {},
        'win32',
      );

      expect(plan.options.cwd).toBe(DATA_DIR);
      expect(plan.options.cwd).not.toBe(process.cwd());
    });

    it('defaults to the claude-mem data directory, never the caller cwd', () => {
      expect(daemonWorkingDirectory()).toBe(DATA_DIR);
      expect(daemonWorkingDirectory()).not.toBe(process.cwd());
    });

    // Passing a cwd that does not exist is worse than passing none: spawn fails with
    // ENOENT, so this fix would turn a first run on a fresh install into a launch
    // failure. paths.ts resolves DATA_DIR but never creates it — today some earlier
    // caller happens to, which is not a guarantee.
    it('creates the directory it hands out, so a fresh install can spawn', () => {
      const dataDir = mkdtempSync(path.join(tmpdir(), 'claude-mem-fresh-daemon-'));
      rmSync(dataDir, { recursive: true, force: true });
      const modulePath = path.resolve(import.meta.dir, '../../src/services/infrastructure/ProcessManager.ts');
      try {
        const result = spawnSync(process.execPath, ['-e', `
          import { existsSync, statSync } from 'fs';
          const { daemonWorkingDirectory } = await import(${JSON.stringify(modulePath)});
          const dir = daemonWorkingDirectory();
          if (!existsSync(dir) || !statSync(dir).isDirectory()) process.exit(1);
          console.log(dir);
        `], {
          encoding: 'utf-8',
          env: { ...process.env, CLAUDE_MEM_DATA_DIR: dataDir },
          timeout: 10_000,
        });
        expect(result.error).toBeUndefined();
        expect(result.status).toBe(0);
        expect(result.stdout.trim()).toBe(dataDir);
      } finally {
        rmSync(dataDir, { recursive: true, force: true });
      }
    });

    // A daemon launched by hand (or by an older launcher) can inherit the
    // user's project, a deleted directory, or an ACL-locked Store-app path;
    // the daemon boot moves it into the data dir regardless of how it started.
    it('pins a running daemon into the data directory by default', () => {
      const moves: string[] = [];
      expect(pinDaemonWorkingDirectory(undefined, (dir) => { moves.push(dir); })).toBe(DATA_DIR);
      expect(moves).toEqual([DATA_DIR]);
    });

    it('falls back to the next candidate when a chdir is refused', () => {
      const moves: string[] = [];
      const chdir = (dir: string) => {
        if (dir === '/locked') throw Object.assign(new Error('EPERM: operation not permitted, chdir'), { code: 'EPERM' });
        moves.push(dir);
      };
      expect(pinDaemonWorkingDirectory([() => '/locked', () => '/home/me', () => '/tmp'], chdir)).toBe('/home/me');
      expect(moves).toEqual(['/home/me']);
    });

    it('never throws when every candidate fails', () => {
      const refuse = () => { throw new Error('EACCES'); };
      expect(pinDaemonWorkingDirectory([() => '/a', () => { throw new Error('no home'); }], refuse)).toBeNull();
    });
  });

});

describe('spawnDetachedWorkerDaemon runtime flags (#5601)', () => {
  // A worker started from a plugin root without node_modules (the marketplace
  // clone) let Bun auto-install sharp's wasm32 build, whose first decode froze
  // the daemon for good. A real detached launch must reach the script with
  // auto-install off.
  it('starts the daemon with Bun auto-install off', async () => {
    const launchDir = mkdtempSync(path.join(tmpdir(), 'claude-mem-daemon-flags-'));
    const reportPath = path.join(launchDir, 'exec-argv.json');
    const scriptPath = path.join(launchDir, 'fake-worker.cjs');
    writeFileSync(scriptPath, `require('fs').writeFileSync(${JSON.stringify(reportPath)}, JSON.stringify({ execArgv: process.execArgv, argv: process.argv.slice(2) }));\n`);

    const pid = spawnDetachedWorkerDaemon(process.execPath, scriptPath, { ...process.env });
    expect(pid).toBeDefined();

    // 10 s: a cold Bun start on a loaded CI runner, not a product limit.
    const deadline = Date.now() + 10_000;
    while (!existsSync(reportPath) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
    expect(existsSync(reportPath)).toBe(true);
    const report = JSON.parse(readFileSync(reportPath, 'utf-8')) as { execArgv: string[]; argv: string[] };
    expect(report.execArgv).toEqual(['--no-install']);
    expect(report.argv).toEqual(['--daemon']);
    rmSync(launchDir, { recursive: true, force: true });
  }, 15_000); // above the 10 s wait, so the wait's own failure is what reports
});

describe('spawnDetachedWorkerDaemon launch error', () => {
  it('records why the daemon launch failed', () => {
    const missingRuntime = path.join(TEST_DATA_DIR, 'no-such-runtime', 'bun.exe');
    expect(spawnDetachedWorkerDaemon(missingRuntime, 'worker-service.cjs', {}, 'win32')).toBeUndefined();
    expect(getLastWorkerDaemonLaunchError()).toContain(missingRuntime);
  });
});
