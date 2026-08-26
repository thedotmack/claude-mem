
import { spawn, type ChildProcess } from 'child_process';
import path from 'path';
import os from 'os';
import fs from 'fs';
import { logger } from '../../utils/logger.js';
import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';
import { USER_SETTINGS_PATH } from '../../shared/paths.js';
import { getUvxBinDirs } from '../../shared/uvx-bin-dirs.js';
import { stripForeignPythonEnv } from '../../shared/uvx-env.js';
import { sanitizeEnv } from '../../supervisor/env-sanitizer.js';
import { getSupervisor } from '../../supervisor/index.js';
import { captureProcessStartToken } from '../../supervisor/process-registry.js';
import { killProcessTree } from '../../shared/kill-process-tree.js';
import { HeadroomService } from './HeadroomService.js';

const HEADROOM_SUPERVISOR_ID = 'headroom-proxy';
const DEFAULT_HEADROOM_PROXY_PORT = 8787;
const HEADROOM_PYTHON_VERSION = '3.13';
const HEADROOM_TOOL_SPEC = 'headroom-ai[proxy]';
/** `uv tool install` may resolve + build wheels on first run — same bound as the npx installer. */
const HEADROOM_INSTALL_TIMEOUT_MS = 5 * 60 * 1000;
/** How long to poll for the freshly spawned proxy to answer /health. */
const HEADROOM_STARTUP_HEALTH_TIMEOUT_MS = 30_000;
const HEADROOM_STARTUP_HEALTH_POLL_INTERVAL_MS = 1_000;
const HEADROOM_OUTPUT_TAIL_MAX_CHARS = 2048;

/**
 * A child PID paired with the start token captured WHILE IT WAS ALIVE — same
 * discipline as ChromaMcpManager's TrackedChild: deferred cleanups run after
 * the child may have exited, and killProcessTree's self-capture there would
 * bind to whatever process now owns the PID number.
 */
interface TrackedChild {
  pid: number;
  startToken: string | null;
}

/** Capture identity while the child is provably ours — call right after spawn. */
function trackChild(child: ChildProcess): TrackedChild | null {
  const pid = child.pid;
  if (!pid) return null;
  return { pid, startToken: captureProcessStartToken(pid) };
}

/**
 * HeadroomProxyManager — supervises the optional `headroom proxy` sidecar.
 *
 * Lifecycle (worker startup, always in the background — the SessionStart hook
 * path never waits on proxy readiness; HeadroomService's `fallback: true`
 * covers every window where the proxy is absent):
 *
 *   1. Disabled (`CLAUDE_MEM_HEADROOM_ENABLED` != 'true') → start() is a no-op.
 *   2. HeadroomService.healthCheck() resolves → a user-run proxy already owns
 *      the port; do not spawn (the user's proxy is authoritative).
 *   3. `headroom` binary absent → `uv tool install --python 3.13
 *      "headroom-ai[proxy]"` (lazy install at worker startup, never in hooks).
 *   4. Spawn `headroom proxy --port <port from CLAUDE_MEM_HEADROOM_URL>` as a
 *      managed child: supervisor-registered with pgid (ChromaMcpManager's
 *      registerManagedProcess pattern) and tree-killed on stop().
 *
 * The proxy is a sidecar, never a gate: an unexpected exit is logged and left
 * down until the next worker start — every Headroom call degrades to the
 * original payload while it is gone.
 */
export class HeadroomProxyManager {
  private static instance: HeadroomProxyManager | null = null;
  private child: ChildProcess | null = null;
  /** Identity of `child`, captured at spawn while it was alive. */
  private tracked: TrackedChild | null = null;
  private starting: Promise<void> | null = null;
  private stopping = false;

  // Test seams (ChromaMcpManager.setUvxAvailabilityProbeForTesting pattern):
  // unit tests must never spawn real Python processes or hit the network.
  private static spawnImplForTesting: typeof spawn | null = null;
  private static healthProbeForTesting: (() => Promise<unknown>) | null = null;
  private static commandResolverForTesting: ((env: Record<string, string>) => string | null) | null = null;

  private constructor() {}

  static getInstance(): HeadroomProxyManager {
    if (!HeadroomProxyManager.instance) {
      HeadroomProxyManager.instance = new HeadroomProxyManager();
    }
    return HeadroomProxyManager.instance;
  }

  /**
   * Reset the singleton instance (for testing).
   * Awaits stop() so a spawned child can never leak across tests.
   */
  static async reset(): Promise<void> {
    if (HeadroomProxyManager.instance) {
      await HeadroomProxyManager.instance.stop();
    }
    HeadroomProxyManager.instance = null;
  }

  static setSpawnForTesting(spawnImpl: typeof spawn | null): void {
    HeadroomProxyManager.spawnImplForTesting = spawnImpl;
  }

  static setHealthProbeForTesting(probe: (() => Promise<unknown>) | null): void {
    HeadroomProxyManager.healthProbeForTesting = probe;
  }

  static setCommandResolverForTesting(resolver: ((env: Record<string, string>) => string | null) | null): void {
    HeadroomProxyManager.commandResolverForTesting = resolver;
  }

  /**
   * Ensure the proxy sidecar is available. Serialized: concurrent calls share
   * one in-flight startup. Resolves without throwing on every degradation
   * path (disabled, install failed, binary missing) — failures are logged,
   * never propagated, because compression falls back to original payloads.
   */
  async start(): Promise<void> {
    if (this.starting) {
      return this.starting;
    }
    this.starting = this.startInternal().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  private async startInternal(): Promise<void> {
    const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
    if (settings.CLAUDE_MEM_HEADROOM_ENABLED !== 'true') {
      logger.debug('HEADROOM', 'Headroom disabled, proxy manager start is a no-op');
      return;
    }

    if (this.child) {
      logger.debug('HEADROOM', 'Headroom proxy already supervised, skipping start', { pid: this.child.pid });
      return;
    }

    // A user-run proxy takes precedence: healthCheck() has NO fallback path
    // and REJECTS when nothing answers, so a resolution here means the port
    // is already served and spawning a second proxy would just fail the bind.
    if (await HeadroomProxyManager.probeHealth()) {
      logger.info('HEADROOM', 'Headroom proxy already healthy (user-run), not spawning a managed one', {
        baseUrl: settings.CLAUDE_MEM_HEADROOM_URL,
      });
      return;
    }

    const spawnEnv = HeadroomProxyManager.buildSpawnEnv();
    let headroomCommand = HeadroomProxyManager.resolveHeadroomCommand(spawnEnv);
    if (!headroomCommand) {
      const installed = await this.installHeadroomTool(spawnEnv);
      if (!installed) {
        return;
      }
      headroomCommand = HeadroomProxyManager.resolveHeadroomCommand(spawnEnv);
      if (!headroomCommand) {
        logger.warn('HEADROOM', 'headroom binary still not found after uv tool install — proxy unavailable, compression falls back', {
          spec: HEADROOM_TOOL_SPEC,
        });
        return;
      }
    }

    await this.spawnProxy(headroomCommand, spawnEnv, settings.CLAUDE_MEM_HEADROOM_URL);
  }

  /**
   * Health probe mapped to a boolean. healthCheck() returns a RAW promise
   * that rejects on network failure (Phase 2 finding) — the two-arg then()
   * owns that degradation: resolve → proxy answering, reject → nothing there.
   */
  private static probeHealth(): Promise<boolean> {
    const probe = HeadroomProxyManager.healthProbeForTesting
      ?? (() => HeadroomService.getInstance().healthCheck());
    return probe().then(() => true, () => false);
  }

  /**
   * Install the Python proxy engine: `uv tool install --python 3.13
   * "headroom-ai[proxy]"`. Spawned shell-less with the same sanitized env
   * discipline as the chroma-mcp prewarm (sanitizeEnv + uv bin dirs on PATH +
   * foreign-Python vars stripped). Resolves false (never throws) on failure.
   */
  private async installHeadroomTool(spawnEnvironment: Record<string, string>): Promise<boolean> {
    const uvCommand = HeadroomProxyManager.resolveUvCommand(spawnEnvironment);
    const args = ['tool', 'install', '--python', HEADROOM_PYTHON_VERSION, HEADROOM_TOOL_SPEC];

    logger.info('HEADROOM', 'Installing headroom proxy engine via uv tool install', {
      command: uvCommand,
      args: args.join(' '),
      timeoutMs: HEADROOM_INSTALL_TIMEOUT_MS,
    });

    const spawnImpl = HeadroomProxyManager.spawnImplForTesting ?? spawn;
    const child = spawnImpl(uvCommand, args, {
      cwd: os.homedir(),
      env: spawnEnvironment,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: process.platform === 'win32',
    });
    const stderrTail = HeadroomProxyManager.captureOutputTail(child.stderr);

    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    const exitPromise = new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code: number | null) => resolve(code));
    });
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(
        () => reject(new Error(`uv tool install timed out after ${HEADROOM_INSTALL_TIMEOUT_MS}ms`)),
        HEADROOM_INSTALL_TIMEOUT_MS
      );
    });

    try {
      const code = await Promise.race([exitPromise, timeoutPromise]);
      if (code === 0) {
        logger.info('HEADROOM', 'headroom proxy engine installed');
        return true;
      }
      logger.warn('HEADROOM', 'uv tool install for headroom failed — proxy unavailable, compression falls back', {
        exitCode: code,
        stderrTail: stderrTail(),
      });
      return false;
    } catch (error) {
      logger.warn('HEADROOM', 'uv tool install for headroom failed — proxy unavailable, compression falls back', {
        error: error instanceof Error ? error.message : String(error),
        stderrTail: stderrTail(),
      });
      try { child.kill('SIGKILL'); } catch { /* already dead */ }
      return false;
    } finally {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    }
  }

  private async spawnProxy(command: string, spawnEnvironment: Record<string, string>, baseUrl: string): Promise<void> {
    getSupervisor().assertCanSpawn('headroom proxy');

    const port = HeadroomProxyManager.resolveProxyPort(baseUrl);
    // `headroom proxy` binds 127.0.0.1 by default — localhost only, never
    // exposed; only the port is configurable (from CLAUDE_MEM_HEADROOM_URL).
    const args = ['proxy', '--port', String(port)];

    logger.info('HEADROOM', 'Spawning managed headroom proxy', { command, args: args.join(' ') });

    const spawnImpl = HeadroomProxyManager.spawnImplForTesting ?? spawn;
    const child = spawnImpl(command, args, {
      cwd: os.homedir(),
      env: spawnEnvironment,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: process.platform === 'win32',
    });
    this.child = child;
    this.tracked = trackChild(child);
    const stderrTail = HeadroomProxyManager.captureOutputTail(child.stderr);

    child.once('error', (error) => {
      logger.warn('HEADROOM', 'headroom proxy failed to spawn — compression falls back', {
        command,
        error: error instanceof Error ? error.message : String(error),
      });
      if (this.child === child) {
        this.child = null;
        this.tracked = null;
      }
    });

    child.once('exit', (code: number | null, signal: NodeJS.Signals | null) => {
      getSupervisor().unregisterProcess(HEADROOM_SUPERVISOR_ID);
      if (this.child !== child) {
        return;
      }
      this.child = null;
      this.tracked = null;
      if (!this.stopping) {
        // Sidecar, never a gate: no restart loop — every Headroom call
        // degrades to the original payload until the next worker start.
        logger.warn('HEADROOM', 'headroom proxy exited unexpectedly — compression falls back until worker restart', {
          exitCode: code,
          ...(signal ? { signal } : {}),
          stderrTail: stderrTail(),
        });
      }
    });

    if (child.pid) {
      // Register with pgid so the supervisor's shutdown cascade can tear the
      // proxy down via process-group signaling — same registration shape as
      // ChromaMcpManager.registerManagedProcess().
      getSupervisor().registerProcess(HEADROOM_SUPERVISOR_ID, {
        pid: child.pid,
        type: 'headroom',
        startedAt: new Date().toISOString(),
        pgid: child.pid,
      }, child);
    }

    await this.waitUntilHealthy(baseUrl);
  }

  /** Bounded health poll on the freshly spawned proxy — logs, never throws. */
  private async waitUntilHealthy(baseUrl: string): Promise<void> {
    const deadline = Date.now() + HEADROOM_STARTUP_HEALTH_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (!this.child) {
        return; // spawn error / early exit already logged by the listeners
      }
      if (await HeadroomProxyManager.probeHealth()) {
        logger.info('HEADROOM', 'Managed headroom proxy is healthy', { baseUrl, pid: this.child?.pid });
        return;
      }
      await new Promise(resolve => setTimeout(resolve, HEADROOM_STARTUP_HEALTH_POLL_INTERVAL_MS));
    }
    logger.warn('HEADROOM', 'headroom proxy did not become healthy within startup timeout — compression falls back until it does', {
      baseUrl,
      timeoutMs: HEADROOM_STARTUP_HEALTH_TIMEOUT_MS,
    });
  }

  /**
   * Stop the managed proxy (no-op when nothing was spawned — a user-run
   * proxy is never ours to kill). Tree-kill with the spawn-time start token,
   * same identity discipline as ChromaMcpManager.disposeActivePrewarm().
   */
  async stop(): Promise<void> {
    this.stopping = true;
    const child = this.child;
    const tracked = this.tracked;
    this.child = null;
    this.tracked = null;

    if (!child) {
      logger.debug('HEADROOM', 'No managed headroom proxy to stop');
      return;
    }

    logger.info('HEADROOM', 'Stopping managed headroom proxy', { pid: child.pid });

    if (tracked) {
      try {
        // Spawn-time identity: this handle may already have exited.
        await killProcessTree(tracked.pid, { expectedStartToken: tracked.startToken });
      } catch (error) {
        logger.warn('HEADROOM', 'failed to kill headroom proxy tree (best-effort)', {
          pid: tracked.pid,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    try {
      child.kill('SIGKILL');
    } catch {
      // Already dead.
    }

    getSupervisor().unregisterProcess(HEADROOM_SUPERVISOR_ID);
    logger.info('HEADROOM', 'Managed headroom proxy stopped');
  }

  /** Port from CLAUDE_MEM_HEADROOM_URL, defaulting to the proxy's own 8787. */
  static resolveProxyPort(baseUrl: string): number {
    if (URL.canParse(baseUrl)) {
      const port = Number.parseInt(new URL(baseUrl).port, 10);
      if (Number.isInteger(port) && port > 0) {
        return port;
      }
    }
    return DEFAULT_HEADROOM_PROXY_PORT;
  }

  /**
   * Absolute path to the `headroom` entry point installed by `uv tool
   * install` (uv's bin dirs are already prepended to the env PATH by
   * buildSpawnEnv), or null when it is not installed anywhere on that PATH.
   * File-existence scan, not a shell `command -v` — same technique as
   * ChromaMcpManager.isUvxAvailable().
   */
  static resolveHeadroomCommand(
    env: Record<string, string>,
    platform: NodeJS.Platform = process.platform,
  ): string | null {
    if (HeadroomProxyManager.commandResolverForTesting) {
      return HeadroomProxyManager.commandResolverForTesting(env);
    }

    const names = platform === 'win32' ? ['headroom.exe', 'headroom'] : ['headroom'];
    const sep = platform === 'win32' ? ';' : ':';
    const pathKey = Object.keys(env).find(k => k.toLowerCase() === 'path') ?? 'PATH';
    for (const dir of (env[pathKey] ?? '').split(sep).filter(Boolean)) {
      for (const name of names) {
        const candidate = path.join(dir, name);
        try {
          if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
            return candidate;
          }
        } catch {
          // Try the next PATH entry.
        }
      }
    }
    return null;
  }

  /**
   * Resolve the `uv` launcher the same way ChromaMcpManager.resolveUvxCommand
   * resolves uvx: bare name on POSIX (PATH already carries uv's bin dirs),
   * absolute .exe on Windows (Node's shell-less spawn won't PATHEXT-resolve).
   */
  static resolveUvCommand(
    env: Record<string, string>,
    platform: NodeJS.Platform = process.platform,
  ): string {
    if (platform !== 'win32') {
      return 'uv';
    }
    const sep = ';';
    const pathKey = Object.keys(env).find(k => k.toLowerCase() === 'path') ?? 'PATH';
    for (const dir of (env[pathKey] ?? '').split(sep).filter(Boolean)) {
      const candidate = path.join(dir, 'uv.exe');
      try {
        if (fs.existsSync(candidate)) {
          return candidate;
        }
      } catch {
        // ignore and try the next candidate
      }
    }
    return 'uv.exe';
  }

  /**
   * Sanitized spawn env for the headroom children — same discipline as
   * ChromaMcpManager.getUvxPreflightEnv(): sanitizeEnv strips host CLI
   * bleed-through and credentials, uv's bin dirs are prepended so `uv` and
   * the `headroom` entry point resolve even when the worker's inherited PATH
   * omits ~/.local/bin (#2790), and activated-venv Python vars are stripped
   * so the tool env never inherits a foreign interpreter (#3552).
   */
  private static buildSpawnEnv(): Record<string, string> {
    const baseEnv: Record<string, string> = {};
    for (const [key, value] of Object.entries(sanitizeEnv(process.env))) {
      if (value !== undefined) {
        baseEnv[key] = value;
      }
    }
    HeadroomProxyManager.ensureUvOnPath(baseEnv);
    stripForeignPythonEnv(baseEnv);
    return baseEnv;
  }

  private static ensureUvOnPath(env: Record<string, string>): void {
    const sep = process.platform === 'win32' ? ';' : ':';
    const pathKey = Object.keys(env).find(k => k.toLowerCase() === 'path') ?? 'PATH';
    const current = env[pathKey] ? env[pathKey].split(sep).filter(Boolean) : [];
    const have = new Set(current.map(p => (process.platform === 'win32' ? p.toLowerCase() : p)));
    const additions = getUvxBinDirs().filter(dir => {
      try {
        if (!fs.existsSync(dir)) return false;
      } catch {
        return false;
      }
      const key = process.platform === 'win32' ? dir.toLowerCase() : dir;
      return !have.has(key);
    });
    if (additions.length > 0) {
      env[pathKey] = [...additions, ...current].join(sep);
    }
  }

  private static captureOutputTail(
    stream: { on(event: 'data', listener: (chunk: Buffer | string | Uint8Array) => void): unknown } | null | undefined,
  ): () => string {
    let tail = '';
    stream?.on('data', (chunk: Buffer | string | Uint8Array) => {
      const text = Buffer.isBuffer(chunk)
        ? chunk.toString()
        : chunk instanceof Uint8Array
          ? Buffer.from(chunk).toString()
          : String(chunk);
      tail = (tail + text).slice(-HEADROOM_OUTPUT_TAIL_MAX_CHARS);
    });
    return () => tail.trim();
  }
}
