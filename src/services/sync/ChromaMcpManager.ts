
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { execFile, execSync, spawn, type ChildProcess } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import os from 'os';
import fs from 'fs';
import { logger } from '../../utils/logger.js';
import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';
import { USER_SETTINGS_PATH, paths } from '../../shared/paths.js';
import { getUvxBinDirs } from '../../shared/uvx-bin-dirs.js';
import { killProcessTree, collectDescendantIdentities } from '../../shared/kill-process-tree.js';
import { stripForeignPythonEnv } from '../../shared/uvx-env.js';
import { sanitizeEnv } from '../../supervisor/env-sanitizer.js';
import { getSupervisor } from '../../supervisor/index.js';
import { captureProcessStartToken, isSameProcess, isPidAlive } from '../../supervisor/process-registry.js';
import { clearDependencyStatus, recordChromaVectorSearchUnavailable, recordUvxVectorSearchUnavailable } from '../../shared/dependency-health.js';
import { ChromaUnavailableError } from '../worker/search/errors.js';

const execFileAsync = promisify(execFile);

const CHROMA_MCP_CLIENT_NAME = 'claude-mem-chroma';
const CHROMA_MCP_CLIENT_VERSION = '1.0.0';
const MCP_CONNECTION_TIMEOUT_MS = 30_000;
const DEFAULT_CHROMA_PREWARM_TIMEOUT_MS = 120_000;
const CHROMA_PREWARM_TIMEOUT_SETTING = 'CLAUDE_MEM_CHROMA_PREWARM_TIMEOUT_MS';
const CHROMA_PREWARM_TIMEOUT_BOUNDS = { min: 1, max: 600_000 } as const;
const CHROMA_PREWARM_REAP_TIMEOUT_MS = 1_000;
// Bounded wait for the child's 'exit' after close() resolves. close() can
// return before Node processes the event, and treating that gap as "still
// alive" escalates to a hard kill against a process that already exited —
// which is what SIGKILLs `uv` mid-build and leaks its scratch dir (#3540).
const CHROMA_EXIT_OBSERVE_TIMEOUT_MS = 1_000;
const RECONNECT_BACKOFF_MS = 10_000;
const CHROMA_WRITER_LOCK_FILENAME = '.claude-mem-chroma-writer.lock';
const CHROMA_SUPERVISOR_ID = 'chroma-mcp';
const CHROMA_OUTPUT_TAIL_MAX_CHARS = 2048;
const DEFAULT_MAX_PENDING_MUTATIONS = 5_000;
const CHROMA_MUTATION_TOOL_PATTERN = /^chroma_(?:add|create|delete|modify|update|upsert)_/;

const CHROMA_MCP_PINNED_VERSION = '0.2.6';

// Override transitive dep resolutions for chroma-mcp 0.2.6 (issue #2371).
//
// Why onnxruntime>=1.20: the shipped all-MiniLM-L6-v2 model has pytorch-2.0
// IR. Older onnxruntime versions can't parse it and fail every embedding
// add with `[ONNXRuntimeError] : 7 : INVALID_PROTOBUF`. uv may otherwise
// resolve to a too-old onnxruntime on macOS arm64 / Python 3.13 depending
// on cache state, so we force a floor.
//
// Why protobuf<7: protobuf 7.x's stricter generated-file check rejects
// opentelemetry's _pb2 stubs (generated with protoc <3.19), throwing
// `TypeError: Descriptors cannot be created directly` at chromadb import.
// Capping below 7 lands on protobuf 6.x which opentelemetry tolerates.
//
// These pins are runtime-only (uvx --with) so we don't have to fork
// chroma-mcp upstream — they apply only to claude-mem's spawned subprocess.
const CHROMA_MCP_DEP_OVERRIDES: ReadonlyArray<string> = [
  'onnxruntime>=1.20',
  'protobuf<7',
];

// Issue #2696 (revised): chroma-mcp is now spawned by invoking uvx DIRECTLY on
// every platform — see ChromaMcpManager.resolveUvxCommand(). The previous
// `cmd.exe` shell-wrapper path, and the cmd.exe metacharacter-quoting helper that
// went with it, were removed: even with the dep-override specs wrapped in double
// quotes, Node's child_process arg-quoting for cmd.exe re-mangled the `>`/`<` in
// `onnxruntime>=1.20` / `protobuf<7`, so cmd.exe parsed them as redirection and
// died with "The directory name is invalid" in ~10ms — killing semantic search.

class ChromaMcpConnectionCancelledError extends Error {
  constructor(message = 'chroma-mcp connection cancelled during shutdown') {
    super(message);
    this.name = 'ChromaMcpConnectionCancelledError';
  }
}

/**
 * A child PID paired with the start token captured WHILE IT WAS ALIVE.
 *
 * killProcessTree self-captures the root token when a caller does not supply
 * one, which is safe only if the process is still alive at the moment of the
 * call. Every deferred cleanup in this class violates that: `onclose` fires
 * BECAUSE the child died, and the prewarm paths kill a handle that may have
 * exited already. Self-capture there reads whatever now owns the number — so
 * it would bind to a replacement and then validate it against itself.
 *
 * Pairing the token with the PID at spawn time makes that structural: the two
 * travel together, so no cleanup path in this class can forget to carry it.
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

interface ChromaWriterLockPayload {
  pid: number;
  ownerId: string;
  dataDir: string;
  acquiredAt: string;
  startToken?: string | null;
}

export class ChromaMcpManager {
  private static instance: ChromaMcpManager | null = null;
  private client: Client | null = null;
  private transport: StdioClientTransport | null = null;
  private connected: boolean = false;
  private lastConnectionFailureTimestamp: number = 0;
  private connecting: Promise<void> | null = null;
  private activePrewarmChild: ChildProcess | null = null;
  /** Identity of activePrewarmChild, captured at spawn while it was alive. */
  private activePrewarmTracked: TrackedChild | null = null;
  private connectionGeneration: number = 0;
  private intentionallyClosingTransports = new WeakSet<object>();
  private readonly chromaWriterOwnerId = `${process.pid}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
  private chromaWriterLock: { path: string; dataDir: string; ownerId: string } | null = null;
  private unexpectedCloseCleanup: Promise<void> | null = null;
  private mutationTail: Promise<void> = Promise.resolve();
  private pendingMutationCalls = 0;
  private readonly maxPendingMutationCalls: number;
  private readonly serializeMutations: boolean;
  private acceptingLocalMutations = true;
  private static uvxAvailabilityProbe: ((command: string, env: Record<string, string>, platform: NodeJS.Platform) => boolean) | null = null;

  private constructor() {
    const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
    const configuredLimit = Number.parseInt(settings.CLAUDE_MEM_CHROMA_MAX_PENDING_MUTATIONS, 10);
    this.maxPendingMutationCalls = Number.isInteger(configuredLimit) && configuredLimit > 0
      ? configuredLimit
      : DEFAULT_MAX_PENDING_MUTATIONS;
    this.serializeMutations = (settings.CLAUDE_MEM_CHROMA_MODE || 'local') !== 'remote';
  }

  static getInstance(): ChromaMcpManager {
    if (!ChromaMcpManager.instance) {
      ChromaMcpManager.instance = new ChromaMcpManager();
    }
    return ChromaMcpManager.instance;
  }

  private async ensureConnected(): Promise<void> {
    await this.waitForUnexpectedCloseCleanup();

    if (this.connected && this.client) {
      return;
    }

    const timeSinceLastFailure = Date.now() - this.lastConnectionFailureTimestamp;
    if (this.lastConnectionFailureTimestamp > 0 && timeSinceLastFailure < RECONNECT_BACKOFF_MS) {
      throw new ChromaUnavailableError(`chroma-mcp connection in backoff (${Math.ceil((RECONNECT_BACKOFF_MS - timeSinceLastFailure) / 1000)}s remaining)`);
    }

    if (this.connecting) {
      await this.connecting;
      return;
    }

    this.connecting = this.connectInternal();
    try {
      await this.connecting;
    } catch (error) {
      if (error instanceof ChromaMcpConnectionCancelledError) {
        logger.debug('CHROMA_MCP', 'Connection attempt cancelled during shutdown');
        throw error;
      }
      this.lastConnectionFailureTimestamp = Date.now();
      if (error instanceof Error) {
        logger.error('CHROMA_MCP', 'Connection attempt failed', {}, error);
      } else {
        logger.error('CHROMA_MCP', 'Connection attempt failed with non-Error value', { error: String(error) });
      }
      throw error;
    } finally {
      this.connecting = null;
    }
  }

  private async connectInternal(): Promise<void> {
    const connectionGeneration = this.connectionGeneration;

    // Singleton invariant (#2313): kill any pre-existing chroma-mcp subprocess
    // tree before spawning a new one. The MCP SDK's transport.close() only
    // signals the direct child (uvx); on Linux the grandchildren (uv, python,
    // chroma-mcp) get re-parented to init and survive, accumulating 20+
    // instances per session if reconnects fire repeatedly. Reuse the same
    // tree-kill primitive used by stop() so reconnect can never leave
    // orphans behind.
    await this.disposeCurrentSubprocess();
    this.assertConnectionNotCancelled(connectionGeneration);

    const localChromaDataDir = this.getLocalPersistentChromaDataDir();
    const commandArgs = this.buildCommandArgs(localChromaDataDir);
    const uvxPreflightEnv = ChromaMcpManager.getUvxPreflightEnv();
    getSupervisor().assertCanSpawn('chroma mcp');

    // Spawn uvx DIRECTLY (no `cmd.exe` shell wrapper). On Windows, routing through
    // cmd.exe makes it parse the `>`/`<` in the dep-override specs as shell
    // redirection before uvx sees them; a shell-less spawn passes them literally.
    // resolveUvxCommand returns the absolute uvx.exe path on Windows (Node won't
    // PATHEXT-resolve a bare `uvx`) and bare `uvx` elsewhere (#2696).
    const uvxSpawnCommand = ChromaMcpManager.resolveUvxCommand();
    const uvxSpawnArgs = commandArgs;

    if (!ChromaMcpManager.isUvxAvailable(uvxSpawnCommand, uvxPreflightEnv, process.platform)) {
      const message = `uvx executable not found for chroma-mcp (${uvxSpawnCommand})`;
      recordUvxVectorSearchUnavailable(message);
      throw new ChromaUnavailableError(message);
    }

    const spawnEnvironment = this.getSpawnEnv(uvxPreflightEnv);

    await this.prewarmChromaMcp(uvxSpawnCommand, uvxSpawnArgs, spawnEnvironment, connectionGeneration);
    this.assertConnectionNotCancelled(connectionGeneration);

    clearDependencyStatus('uvx');

    logger.info('CHROMA_MCP', 'Connecting to chroma-mcp via MCP stdio', {
      command: uvxSpawnCommand,
      args: uvxSpawnArgs.join(' ')
    });

    try {
      if (localChromaDataDir) {
        this.acquireChromaWriterLock(localChromaDataDir);
      }

      this.transport = new StdioClientTransport({
        command: uvxSpawnCommand,
        args: uvxSpawnArgs,
        env: spawnEnvironment,
        cwd: os.homedir(),
        stderr: 'pipe'
      });
    } catch (error) {
      this.releaseChromaWriterLock();
      throw error;
    }
    const transportStderrTail = ChromaMcpManager.captureOutputTail(this.transport.stderr);

    let mcpConnectionPromise: Promise<void>;
    try {
      this.client = new Client(
        { name: CHROMA_MCP_CLIENT_NAME, version: CHROMA_MCP_CLIENT_VERSION },
        { capabilities: {} }
      );
      mcpConnectionPromise = this.client.connect(this.transport);
    } catch (error) {
      await this.disposeCurrentSubprocess();
      throw error;
    }
    let timeoutId: ReturnType<typeof setTimeout>;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(
        () => reject(new Error(`MCP connection to chroma-mcp timed out after ${MCP_CONNECTION_TIMEOUT_MS}ms`)),
        MCP_CONNECTION_TIMEOUT_MS
      );
    });

    try {
      await Promise.race([mcpConnectionPromise, timeoutPromise]);
      this.assertConnectionNotCancelled(connectionGeneration);
    } catch (connectionError) {
      clearTimeout(timeoutId!);
      if (
        connectionError instanceof ChromaMcpConnectionCancelledError ||
        this.connectionGeneration !== connectionGeneration
      ) {
        logger.debug('CHROMA_MCP', 'MCP connection cancelled during shutdown');
        await this.disposeCurrentSubprocess();
        throw connectionError instanceof ChromaMcpConnectionCancelledError
          ? connectionError
          : new ChromaMcpConnectionCancelledError();
      }
      const stderrTail = transportStderrTail();
      logger.warn('CHROMA_MCP', 'Connection failed, killing subprocess tree to prevent zombie', {
        error: connectionError instanceof Error ? connectionError.message : String(connectionError),
        ...(stderrTail ? { stderrTail } : {})
      });
      // Tree-kill (not just transport.close) so failed-connect descendants
      // can't survive on Linux (#2313).
      await this.disposeCurrentSubprocess();
      throw connectionError;
    }
    clearTimeout(timeoutId!);

    this.connected = true;
    this.registerManagedProcess();
    clearDependencyStatus('chroma');

    logger.info('CHROMA_MCP', 'Connected to chroma-mcp successfully');

    const currentTransport = this.transport;
    // Captured HERE, while the child is alive and attached — not in the
    // onclose handler below, which by definition runs after it has died.
    const transportChild = (this.transport as unknown as { _process?: ChildProcess })._process;
    const currentTracked = transportChild ? trackChild(transportChild) : null;
    const currentTrackedPid = currentTracked?.pid;
    this.transport.onclose = () => {
      if (this.transport !== currentTransport) {
        logger.debug('CHROMA_MCP', 'Ignoring stale onclose from previous transport');
        return;
      }
      if (
        this.connectionGeneration !== connectionGeneration ||
        this.intentionallyClosingTransports.has(currentTransport as unknown as object)
      ) {
        logger.debug('CHROMA_MCP', 'Ignoring onclose from intentionally closed transport');
        return;
      }
      logger.warn('CHROMA_MCP', 'chroma-mcp subprocess closed unexpectedly, applying reconnect backoff');
      this.connected = false;
      getSupervisor().unregisterProcess(CHROMA_SUPERVISOR_ID);
      this.client = null;
      this.transport = null;
      this.lastConnectionFailureTimestamp = Date.now();

      // Direct child (uvx) emitted close, but on Linux the grandchildren
      // (uv/python/chroma-mcp) often outlive their parent because MCP SDK
      // does not use process groups. Sweep the descendant tree using the
      // captured PID — best-effort; pgrep returns nothing if everything
      // already exited (#2313).
      this.scheduleUnexpectedCloseCleanup(currentTracked);
    };
  }

  private scheduleUnexpectedCloseCleanup(tracked: TrackedChild | null): void {
    let cleanup: Promise<void>;
    cleanup = this.cleanupUnexpectedCloseSubprocess(tracked).finally(() => {
      if (this.unexpectedCloseCleanup === cleanup) {
        this.unexpectedCloseCleanup = null;
      }
    });
    this.unexpectedCloseCleanup = cleanup;
  }

  private async cleanupUnexpectedCloseSubprocess(tracked: TrackedChild | null): Promise<void> {
    const pid = tracked?.pid;
    try {
      if (tracked) {
        // The spawn-time token is REQUIRED here, not an optimisation. This
        // path runs because the child already exited, so killProcessTree's
        // self-capture would read whatever now holds that PID and validate the
        // replacement against itself — then `taskkill /T /F` would take that
        // stranger and its whole subtree down.
        await killProcessTree(tracked.pid, { expectedStartToken: tracked.startToken });
      }
    } catch (error) {
      logger.debug('CHROMA_MCP', 'Background tree-kill after onclose finished (best-effort)', {
        pid,
        error: error instanceof Error ? error.message : String(error)
      });
    } finally {
      this.releaseChromaWriterLock();
    }
  }

  private async waitForUnexpectedCloseCleanup(): Promise<void> {
    const cleanup = this.unexpectedCloseCleanup;
    if (cleanup) {
      await cleanup;
    }
  }

  private assertConnectionNotCancelled(connectionGeneration: number): void {
    if (this.connectionGeneration !== connectionGeneration) {
      throw new ChromaMcpConnectionCancelledError();
    }
  }

  private getLocalPersistentChromaDataDir(): string | null {
    const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
    const chromaMode = settings.CLAUDE_MEM_CHROMA_MODE || 'local';
    return chromaMode === 'remote' ? null : paths.chroma();
  }

  private buildCommandArgs(localChromaDataDir: string | null = this.getLocalPersistentChromaDataDir()): string[] {
    const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
    const pythonVersion = process.env.CLAUDE_MEM_PYTHON_VERSION || settings.CLAUDE_MEM_PYTHON_VERSION || '3.13';
    const launcherPrefix = ChromaMcpManager.buildLauncherPrefix(pythonVersion);

    if (!localChromaDataDir) {
      const chromaHost = settings.CLAUDE_MEM_CHROMA_HOST || '127.0.0.1';
      const chromaPort = settings.CLAUDE_MEM_CHROMA_PORT || '8000';
      const chromaSsl = settings.CLAUDE_MEM_CHROMA_SSL === 'true';
      const chromaTenant = settings.CLAUDE_MEM_CHROMA_TENANT || 'default_tenant';
      const chromaDatabase = settings.CLAUDE_MEM_CHROMA_DATABASE || 'default_database';
      const chromaApiKey = settings.CLAUDE_MEM_CHROMA_API_KEY || '';

      const args = [
        ...launcherPrefix,
        '--client-type', 'http',
        '--host', chromaHost,
        '--port', chromaPort
      ];

      args.push('--ssl', chromaSsl ? 'true' : 'false');

      if (chromaTenant !== 'default_tenant') {
        args.push('--tenant', chromaTenant);
      }

      if (chromaDatabase !== 'default_database') {
        args.push('--database', chromaDatabase);
      }

      if (chromaApiKey) {
        args.push('--api-key', chromaApiKey);
      }

      return args;
    }

    return [
      ...launcherPrefix,
      '--client-type', 'persistent',
      '--data-dir', localChromaDataDir.replace(/\\/g, '/')
    ];
  }

  private acquireChromaWriterLock(dataDir: string): void {
    const normalizedDataDir = path.resolve(dataDir);
    if (this.chromaWriterLock?.dataDir === normalizedDataDir) {
      return;
    }
    if (this.chromaWriterLock) {
      this.releaseChromaWriterLock();
    }

    fs.mkdirSync(normalizedDataDir, { recursive: true });
    const lockPath = path.join(normalizedDataDir, CHROMA_WRITER_LOCK_FILENAME);
    const payload: ChromaWriterLockPayload = {
      pid: process.pid,
      ownerId: this.chromaWriterOwnerId,
      dataDir: normalizedDataDir,
      acquiredAt: new Date().toISOString(),
      startToken: captureProcessStartToken(process.pid),
    };

    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        fs.writeFileSync(lockPath, JSON.stringify(payload, null, 2), {
          encoding: 'utf-8',
          flag: 'wx',
        });
        this.chromaWriterLock = { path: lockPath, dataDir: normalizedDataDir, ownerId: this.chromaWriterOwnerId };
        logger.debug('CHROMA_MCP', 'Acquired Chroma writer lock', { lockPath, dataDir: normalizedDataDir });
        return;
      } catch (error) {
        const errno = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
        if (errno !== 'EEXIST') {
          const message = `Unable to acquire Chroma writer lock at ${lockPath}: ${error instanceof Error ? error.message : String(error)}`;
          recordChromaVectorSearchUnavailable(message);
          throw new ChromaUnavailableError(message, error instanceof Error ? error : undefined);
        }

        const existing = ChromaMcpManager.readChromaWriterLock(lockPath);
        if (!existing) {
          const message = `Chroma writer lock at ${lockPath} is unreadable; refusing to start a second writer`;
          recordChromaVectorSearchUnavailable(message);
          throw new ChromaUnavailableError(message);
        }

        if (existing.pid === process.pid && existing.ownerId === this.chromaWriterOwnerId) {
          this.chromaWriterLock = { path: lockPath, dataDir: normalizedDataDir, ownerId: this.chromaWriterOwnerId };
          return;
        }

        if (!ChromaMcpManager.isChromaWriterLockLive(existing)) {
          try {
            fs.rmSync(lockPath, { force: true });
            logger.info('CHROMA_MCP', 'Removed stale Chroma writer lock', {
              lockPath,
              priorPid: existing.pid,
              priorStartedAt: existing.acquiredAt,
            });
            continue;
          } catch (removeError) {
            const message = `Unable to remove stale Chroma writer lock at ${lockPath}: ${removeError instanceof Error ? removeError.message : String(removeError)}`;
            recordChromaVectorSearchUnavailable(message);
            throw new ChromaUnavailableError(message, removeError instanceof Error ? removeError : undefined);
          }
        }

        const message = `Chroma data dir ${normalizedDataDir} is already owned by PID ${existing.pid}; refusing to start a second writer`;
        recordChromaVectorSearchUnavailable(message);
        throw new ChromaUnavailableError(message);
      }
    }

    const message = `Unable to acquire Chroma writer lock at ${lockPath} after removing stale lock`;
    recordChromaVectorSearchUnavailable(message);
    throw new ChromaUnavailableError(message);
  }

  private releaseChromaWriterLock(): void {
    const lock = this.chromaWriterLock;
    if (!lock) {
      return;
    }
    this.chromaWriterLock = null;

    const existing = ChromaMcpManager.readChromaWriterLock(lock.path);
    if (!existing) {
      logger.debug('CHROMA_MCP', 'Chroma writer lock already missing or unreadable during release', {
        lockPath: lock.path,
      });
      return;
    }

    if (existing.pid !== process.pid || existing.ownerId !== lock.ownerId) {
      logger.debug('CHROMA_MCP', 'Chroma writer lock not owned by this manager, leaving it in place', {
        lockPath: lock.path,
        recordedPid: existing.pid,
        currentPid: process.pid,
      });
      return;
    }

    try {
      fs.rmSync(lock.path, { force: true });
      logger.debug('CHROMA_MCP', 'Released Chroma writer lock', { lockPath: lock.path });
    } catch (error) {
      logger.debug('CHROMA_MCP', 'Failed to release Chroma writer lock', {
        lockPath: lock.path,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private static readChromaWriterLock(lockPath: string): ChromaWriterLockPayload | null {
    try {
      const raw = JSON.parse(fs.readFileSync(lockPath, 'utf-8')) as Partial<ChromaWriterLockPayload>;
      if (
        typeof raw.pid !== 'number' ||
        typeof raw.ownerId !== 'string' ||
        typeof raw.dataDir !== 'string' ||
        typeof raw.acquiredAt !== 'string'
      ) {
        return null;
      }
      return {
        pid: raw.pid,
        ownerId: raw.ownerId,
        dataDir: raw.dataDir,
        acquiredAt: raw.acquiredAt,
        startToken: typeof raw.startToken === 'string' || raw.startToken === null ? raw.startToken : undefined,
      };
    } catch {
      return null;
    }
  }

  private static isChromaWriterLockLive(lock: ChromaWriterLockPayload): boolean {
    if (!isPidAlive(lock.pid)) {
      return false;
    }
    if (!lock.startToken) {
      return true;
    }
    const currentStartToken = captureProcessStartToken(lock.pid);
    return currentStartToken === null || currentStartToken === lock.startToken;
  }

  private static buildLauncherPrefix(pythonVersion: string): string[] {
    const depOverrideFlags = CHROMA_MCP_DEP_OVERRIDES.flatMap(spec => ['--with', spec]);
    return [
      '--python', pythonVersion,
      ...depOverrideFlags,
      '--from', `chroma-mcp==${CHROMA_MCP_PINNED_VERSION}`,
      'chroma-mcp',
    ];
  }

  private static buildPrewarmCommandArgs(commandArgs: string[]): string[] {
    const executableIndex = commandArgs.indexOf('chroma-mcp');
    const launcherPrefix = executableIndex >= 0
      ? commandArgs.slice(0, executableIndex + 1)
      : commandArgs;
    return [...launcherPrefix, '--help'];
  }

  private static parseBoundedTimeoutMs(rawValue: string | undefined): number | null {
    if (!rawValue) {
      return null;
    }
    const parsed = Number.parseInt(rawValue, 10);
    if (
      Number.isFinite(parsed) &&
      parsed >= CHROMA_PREWARM_TIMEOUT_BOUNDS.min &&
      parsed <= CHROMA_PREWARM_TIMEOUT_BOUNDS.max
    ) {
      return parsed;
    }
    return null;
  }

  private static getChromaPrewarmTimeoutMs(): number {
    const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
    const envValue = process.env[CHROMA_PREWARM_TIMEOUT_SETTING];
    const settingsValue = settings[CHROMA_PREWARM_TIMEOUT_SETTING];

    const parsed = ChromaMcpManager.parseBoundedTimeoutMs(envValue ?? settingsValue);
    if (parsed !== null) {
      return parsed;
    }

    if (envValue !== undefined || settingsValue) {
      logger.warn('CHROMA_MCP', `Invalid ${CHROMA_PREWARM_TIMEOUT_SETTING}, using default`, {
        value: envValue ?? settingsValue,
        min: CHROMA_PREWARM_TIMEOUT_BOUNDS.min,
        max: CHROMA_PREWARM_TIMEOUT_BOUNDS.max
      });
    }
    return DEFAULT_CHROMA_PREWARM_TIMEOUT_MS;
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
      tail = (tail + text).slice(-CHROMA_OUTPUT_TAIL_MAX_CHARS);
    });
    return () => tail.trim();
  }

  private async prewarmChromaMcp(
    command: string,
    commandArgs: string[],
    env: Record<string, string>,
    connectionGeneration: number,
  ): Promise<void> {
    this.assertConnectionNotCancelled(connectionGeneration);

    const args = ChromaMcpManager.buildPrewarmCommandArgs(commandArgs);
    const timeoutMs = ChromaMcpManager.getChromaPrewarmTimeoutMs();

    logger.info('CHROMA_MCP', 'Prewarming chroma-mcp uvx environment', {
      command,
      args: args.join(' '),
      timeoutMs
    });

    const child = spawn(command, args, {
      cwd: os.homedir(),
      env,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: process.platform === 'win32',
    });
    this.activePrewarmChild = child;
    const prewarmTracked = trackChild(child);
    this.activePrewarmTracked = prewarmTracked;

    const stdoutTail = ChromaMcpManager.captureOutputTail(child.stdout);
    const stderrTail = ChromaMcpManager.captureOutputTail(child.stderr);

    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    const exitPromise = new Promise<void>((resolve, reject) => {
      child.once('error', (error) => {
        if (this.connectionGeneration !== connectionGeneration) {
          reject(new ChromaMcpConnectionCancelledError());
          return;
        }
        reject(error);
      });
      child.once('close', (code: number | null, signal: NodeJS.Signals | null) => {
        if (this.connectionGeneration !== connectionGeneration) {
          reject(new ChromaMcpConnectionCancelledError());
          return;
        }
        if (code === 0) {
          resolve();
          return;
        }
        reject(new Error(`chroma-mcp prewarm exited with code ${code ?? 'null'}${signal ? ` signal ${signal}` : ''}`));
      });
    });
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(
        () => reject(new Error(`chroma-mcp prewarm timed out after ${timeoutMs}ms`)),
        timeoutMs
      );
    });

    try {
      await Promise.race([exitPromise, timeoutPromise]);
      this.assertConnectionNotCancelled(connectionGeneration);
      logger.debug('CHROMA_MCP', 'chroma-mcp uvx prewarm completed');
    } catch (error) {
      if (error instanceof ChromaMcpConnectionCancelledError) {
        logger.debug('CHROMA_MCP', 'chroma-mcp uvx prewarm cancelled during shutdown');
        throw error;
      }
      this.assertConnectionNotCancelled(connectionGeneration);
      const errorMessage = error instanceof Error ? error.message : String(error);
      const pid = child.pid;
      const stdout = stdoutTail();
      const stderr = stderrTail();
      logger.warn('CHROMA_MCP', 'chroma-mcp uvx prewarm failed', {
        command,
        args: args.join(' '),
        timeoutMs,
        ...(pid ? { pid } : {}),
        error: errorMessage,
        ...(stdout ? { stdoutTail: stdout } : {}),
        ...(stderr ? { stderrTail: stderr } : {})
      });

      if (pid) {
        try {
          // Token from spawn time: by here the prewarm may already have exited
          // (that is often WHY we are in this branch), so self-capture would
          // read a replacement rather than the child we spawned.
          await killProcessTree(pid, { expectedStartToken: prewarmTracked?.startToken ?? null });
        } catch (killError) {
          logger.debug('CHROMA_MCP', 'prewarm process tree kill finished (best-effort)', {
            pid,
            error: killError instanceof Error ? killError.message : String(killError)
          });
        }
      } else {
        try { child.kill('SIGKILL'); } catch { /* already dead */ }
      }

      const unavailableMessage = `chroma-mcp prewarm failed: ${errorMessage}`;
      recordUvxVectorSearchUnavailable(unavailableMessage);
      throw new ChromaUnavailableError(unavailableMessage, error instanceof Error ? error : undefined);
    } finally {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      if (this.activePrewarmChild === child) {
        this.activePrewarmChild = null;
        this.activePrewarmTracked = null;
      }
    }
  }

  async callTool(toolName: string, toolArguments: Record<string, unknown>): Promise<unknown> {
    if (!this.serializeMutations || !ChromaMcpManager.isMutationTool(toolName)) {
      return this.callToolUnqueued(toolName, toolArguments);
    }
    if (!this.acceptingLocalMutations) {
      throw new ChromaUnavailableError('Local Chroma mutations are unavailable after shutdown begins');
    }

    return this.enqueueMutation(() => this.callToolUnqueued(toolName, toolArguments), toolName);
  }

  private async callToolUnqueued(toolName: string, toolArguments: Record<string, unknown>): Promise<unknown> {
    const callGeneration = this.connectionGeneration;
    await this.ensureConnected();

    logger.debug('CHROMA_MCP', `Calling tool: ${toolName}`, {
      arguments: JSON.stringify(toolArguments).slice(0, 200)
    });

    let result;
    try {
      result = await this.client!.callTool({
        name: toolName,
        arguments: toolArguments
      });
    } catch (transportError) {
      logger.warn('CHROMA_MCP', `Transport error during "${toolName}", reconnecting and retrying once`, {
        error: transportError instanceof Error ? transportError.message : String(transportError)
      });

      if (callGeneration !== this.connectionGeneration) {
        throw new ChromaMcpConnectionCancelledError('chroma-mcp call cancelled during shutdown');
      }

      // Tree-kill the dying subprocess before reconnect. Previously this path
      // just nulled the handle, which on Linux leaks the uv/python/chroma-mcp
      // descendants every time a transport error happens (#2313).
      await this.disposeCurrentSubprocess();

      try {
        if (callGeneration !== this.connectionGeneration) {
          throw new ChromaMcpConnectionCancelledError('chroma-mcp call cancelled during shutdown');
        }
        await this.ensureConnected();
        result = await this.client!.callTool({
          name: toolName,
          arguments: toolArguments
        });
      } catch (retryError) {
        this.connected = false;
        throw new Error(`chroma-mcp transport error during "${toolName}" (retry failed): ${retryError instanceof Error ? retryError.message : String(retryError)}`);
      }
    }

    if (result.isError) {
      const errorText = (result.content as Array<{ type: string; text?: string }>)
        ?.find(item => item.type === 'text')?.text || 'Unknown chroma-mcp error';
      throw new Error(`chroma-mcp tool "${toolName}" returned error: ${errorText}`);
    }

    const contentArray = result.content as Array<{ type: string; text?: string }>;
    if (!contentArray || contentArray.length === 0) {
      return null;
    }

    const firstTextContent = contentArray.find(item => item.type === 'text' && item.text);
    if (!firstTextContent || !firstTextContent.text) {
      return null;
    }

    try {
      return JSON.parse(firstTextContent.text);
    } catch (parseError: unknown) {
      if (parseError instanceof Error) {
        logger.debug('CHROMA_MCP', 'Non-JSON response from tool, returning null', {
          toolName,
          textPreview: firstTextContent.text.slice(0, 100)
        });
      }
      return null;
    }
  }

  private async enqueueMutation<T>(operation: () => Promise<T>, toolName: string): Promise<T> {
    if (this.pendingMutationCalls >= this.maxPendingMutationCalls) {
      const message = `Chroma mutation queue is full (${this.pendingMutationCalls}/${this.maxPendingMutationCalls}); deferring "${toolName}" to a later backfill`;
      logger.warn('CHROMA_MCP', message, {
        toolName,
        pendingMutations: this.pendingMutationCalls,
        maxPendingMutations: this.maxPendingMutationCalls
      });
      throw new ChromaUnavailableError(message);
    }

    this.pendingMutationCalls += 1;
    const enqueuedGeneration = this.connectionGeneration;
    const run = this.mutationTail
      .catch(() => undefined)
      .then(async () => {
        if (enqueuedGeneration !== this.connectionGeneration) {
          throw new ChromaMcpConnectionCancelledError('queued chroma-mcp mutation cancelled during shutdown');
        }
        return operation();
      });

    this.mutationTail = run.then(() => undefined, () => undefined);

    try {
      return await run;
    } finally {
      this.pendingMutationCalls -= 1;
    }
  }

  private static isMutationTool(toolName: string): boolean {
    return CHROMA_MUTATION_TOOL_PATTERN.test(toolName);
  }

  async isHealthy(): Promise<boolean> {
    try {
      await this.callTool('chroma_list_collections', { limit: 1 });
      return true;
    } catch (error) {
      logger.warn('CHROMA_MCP', 'Health check failed', {
        error: error instanceof Error ? error.message : String(error)
      });
      return false;
    }
  }

  async probeSemanticSearch(): Promise<{
    ok: boolean;
    stage: 'connect' | 'list' | 'query' | 'done';
    error?: string;
    collections?: number;
    queryLatencyMs?: number;
  }> {
    let collections: number | undefined;

    try {
      const listResult: any = await this.callTool('chroma_list_collections', { limit: 100 });
      if (Array.isArray(listResult)) {
        collections = listResult.length;
      } else if (listResult && Array.isArray(listResult.collections)) {
        collections = listResult.collections.length;
      } else if (listResult && typeof listResult === 'object' && 'length' in listResult) {
        collections = (listResult as { length: number }).length;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn('CHROMA_MCP', 'Deep probe failed at list stage', { error: message });
      return { ok: false, stage: 'list', error: message };
    }

    const queryStartedAt = Date.now();
    try {
      await this.callTool('chroma_query_documents', {
        collection_name: 'cm__claude-mem',
        query_texts: ['ping'],
        n_results: 1
      });
      const queryLatencyMs = Date.now() - queryStartedAt;
      return { ok: true, stage: 'done', collections, queryLatencyMs };
    } catch (error) {
      const queryLatencyMs = Date.now() - queryStartedAt;
      const rawMessage = error instanceof Error ? error.message : String(error);
      const isMissingOrEmpty = /not exist|missing|empty|no such/i.test(rawMessage);
      const errorMessage = isMissingOrEmpty
        ? `collection cm__claude-mem missing or empty (${rawMessage})`
        : rawMessage;
      logger.warn('CHROMA_MCP', 'Deep probe failed at query stage', {
        error: rawMessage,
        queryLatencyMs
      });
      return {
        ok: false,
        stage: 'query',
        error: errorMessage,
        collections,
        queryLatencyMs
      };
    }
  }

  /**
   * Singleton enforcement helper (#2313): tree-kill the currently tracked
   * chroma-mcp subprocess and reset all state so the next spawn starts clean.
   *
   * Why this is the singleton invariant: every code path that intends to
   * abandon `this.transport` / `this.client` (reconnect, transport error,
   * connect-timeout, onclose, stop()) MUST funnel through here. The MCP
   * SDK's transport.close() only signals the direct child (uvx); on Linux
   * the grandchildren (uv, python, chroma-mcp) re-parent to init and
   * accumulate. Calling killProcessTree() against the captured PID before
   * we drop the reference is the only way to guarantee at most one
   * chroma-mcp subprocess tree exists per worker process.
   *
   * Idempotent and best-effort — safe to call when there is no active
   * subprocess (no-op in that case).
   */
  private async disposeCurrentSubprocess(): Promise<void> {
    await this.disposeActivePrewarm();

    const closingTransport = this.transport;
    if (closingTransport) {
      this.intentionallyClosingTransports.add(closingTransport as unknown as object);
    }

    const chromaProcess = (this.transport as unknown as { _process?: ChildProcess })?._process;
    const trackedPid = chromaProcess?.pid;

    // #3540 — graceful FIRST, hard tree-kill only as escalation.
    //
    // The previous order tree-killed before closing, so `uv` was always
    // SIGKILLed mid-build and never unlinked its builds-v0/.tmp* scratch dir.
    // StdioClientTransport.close() already implements exactly the escalation
    // this needs — stdin EOF, wait 2s, SIGTERM, wait 2s, SIGKILL — so the
    // grace period is the SDK's, not a new timer scheme of ours.
    //
    // The #2313 singleton invariant is preserved, but it needs the descendant
    // set captured BEFORE the close: once the root exits, its children
    // re-parent and drop out of the walk, so a post-mortem scan finds nothing
    // to reap. collectDescendantPids() enumerates on Windows too — a
    // POSIX-only walk returned [] there and left the chain untracked.
    // The ROOT's identity, captured BEFORE close(). uvx can exit during the
    // close, and on Windows the escalation below is unconditional — so without
    // this, a reused PID would be handed to `taskkill /PID <pid> /T /F`, force
    // terminating an unrelated process AND its entire descendant tree.
    const rootStartToken = trackedPid ? captureProcessStartToken(trackedPid) : null;
    const descendantsBeforeClose = trackedPid
      ? await ChromaMcpManager.snapshotDescendantIdentities(trackedPid)
      : [];

    if (closingTransport) {
      try { await closingTransport.close(); } catch { /* already dead */ }
    }
    if (this.client) {
      try { await this.client.close(); } catch { /* already dead */ }
    }

    // Both directions of the close/exit race have to be handled, and they pull
    // opposite ways:
    //
    //   - Escalate too eagerly and `uv` gets SIGKILLed mid-build, which is
    //     #3540 (leaked builds-v0/.tmp* scratch). close() can resolve before
    //     Node has processed the child's 'exit', so exitCode is briefly still
    //     null for a process that is already gone — hence the bounded wait
    //     below rather than reading exitCode the instant close() returns.
    //   - Escalate too reluctantly and the chain is orphaned, which is #3482.
    //
    // On Windows the second risk dominates and cannot be handled by the
    // exitCode check at all: close() ends in TerminateProcess against ONE pid,
    // so uvx.exe dies while uv -> python -> chroma-mcp keep running. Reading
    // exitCode there would skip the `taskkill /T /F` that is the only thing
    // able to reach them. So win32 always escalates; taskkill against an
    // already-dead pid is the tolerated not-found case, not an error.
    const exitedCleanly = chromaProcess
      ? await ChromaMcpManager.waitForChildExit(chromaProcess, CHROMA_EXIT_OBSERVE_TIMEOUT_MS)
      : true;
    const mustEscalate = process.platform === 'win32' || !exitedCleanly;

    if (trackedPid && mustEscalate) {
      try {
        // expectedStartToken makes this a no-op if the PID was reused; the
        // identity-validated descendant reap below still runs, which is the
        // part that matters once the real root is gone.
        await killProcessTree(trackedPid, { expectedStartToken: rootStartToken });
      } catch (error) {
        logger.warn('CHROMA_MCP', 'failed to kill prior chroma-mcp tree (best-effort)', {
          pid: trackedPid,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }

    // Re-scan AFTER the close and union with the pre-close snapshot.
    //
    // The pre-close snapshot alone leaves a hole: if the walk ran before uvx
    // had forked `uv`, the snapshot is empty. Re-collecting here catches any
    // layer that became visible after the first walk and is still reachable
    // from the root. Descendants re-parent once the root is gone, so this
    // second walk is not guaranteed to see everything — which is exactly why
    // it UNIONS with the pre-close set rather than replacing it. Between the
    // two, a descendant has to be invisible at BOTH sample points to escape.
    // Only re-scan when the root is still the process we recorded — walking a
    // reused PID would enumerate a stranger's children and then reap them.
    const descendantsAfterClose = trackedPid && isSameProcess(trackedPid, rootStartToken)
      ? await ChromaMcpManager.snapshotDescendantIdentities(trackedPid)
      : [];
    ChromaMcpManager.reapOrphanedDescendants([...descendantsBeforeClose, ...descendantsAfterClose]);

    if (trackedPid) {
      getSupervisor().unregisterProcess(CHROMA_SUPERVISOR_ID);
    }
    this.releaseChromaWriterLock();

    this.client = null;
    this.transport = null;
    this.connected = false;
  }

  /**
   * Wait (bounded) for a child's 'exit' to be observed.
   *
   * close() can resolve before Node has processed the exit event, so reading
   * `exitCode` the instant it returns reports a live process that is already
   * gone — and escalating on that false negative is what SIGKILLs `uv`
   * mid-build (#3540). Resolves true when the child is known to have exited.
   */
  private static waitForChildExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
    if (child.exitCode !== null || child.signalCode !== null) {
      return Promise.resolve(true);
    }
    return new Promise<boolean>(resolve => {
      const onExit = () => {
        clearTimeout(timer);
        resolve(true);
      };
      const timer = setTimeout(() => {
        child.off('exit', onExit);
        resolve(child.exitCode !== null || child.signalCode !== null);
      }, timeoutMs);
      child.once('exit', onExit);
    });
  }

  /**
   * Descendants of `rootPid` with their start tokens captured.
   *
   * The token is what makes the later reap safe: a bare PID can be recycled by
   * the OS between snapshot and teardown, and SIGKILLing a recycled PID kills
   * an unrelated process. Captured here, at snapshot time, so it describes the
   * process we actually intend to reap.
   */
  private static async snapshotDescendantIdentities(
    rootPid: number
  ): Promise<Array<{ pid: number; startToken: string | null }>> {
    // Identity comes from the SAME process-table read that discovered the PID.
    // Enumerating first and probing each PID afterwards would let a reissued
    // number have the REPLACEMENT's token captured, which the later check would
    // then happily validate — certifying a stranger as a legitimate target.
    return collectDescendantIdentities(rootPid);
  }

  /**
   * SIGKILL descendants that outlived their parent, verifying identity first.
   *
   * These have already had the full graceful window (stdin EOF -> SIGTERM ->
   * SIGKILL against their parent); surviving it means they re-parented and
   * nothing else will ever reap them.
   *
   * A PID alone is not sufficient authority to kill: if the descendant died
   * and the OS reissued its number, the start token no longer matches and the
   * entry is skipped rather than killing a stranger. When no token could be
   * captured at snapshot time we fall back to liveness — the pre-existing
   * behavior — because refusing to reap would resurrect #2313.
   */
  private static reapOrphanedDescendants(
    entries: Array<{ pid: number; startToken: string | null }>
  ): void {
    const seen = new Set<number>();

    for (const { pid, startToken } of entries) {
      if (seen.has(pid)) continue;
      seen.add(pid);
      if (!isPidAlive(pid)) continue;

      if (!isSameProcess(pid, startToken)) {
        logger.debug('CHROMA_MCP', 'Skipping reap: PID was recycled since the snapshot', { pid });
        continue;
      }

      try {
        process.kill(pid, 'SIGKILL');
        logger.debug('CHROMA_MCP', 'Reaped orphaned chroma-mcp descendant', { pid });
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'ESRCH') {
          logger.warn('CHROMA_MCP', 'Failed to reap orphaned chroma-mcp descendant', {
            pid,
            code,
          });
        }
      }
    }
  }

  private async disposeActivePrewarm(): Promise<void> {
    const prewarmChild = this.activePrewarmChild;
    const tracked = this.activePrewarmTracked;
    if (!prewarmChild) {
      return;
    }
    if (this.activePrewarmChild === prewarmChild) {
      this.activePrewarmChild = null;
      this.activePrewarmTracked = null;
    }

    const pid = prewarmChild.pid;
    if (pid) {
      try {
        // Spawn-time identity: this handle may already have exited.
        await killProcessTree(pid, { expectedStartToken: tracked?.startToken ?? null });
      } catch (error) {
        logger.warn('CHROMA_MCP', 'failed to kill in-flight chroma-mcp prewarm tree (best-effort)', {
          pid,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }

    try {
      prewarmChild.kill('SIGKILL');
    } catch {
      // Already dead.
    }

    await ChromaMcpManager.waitForChildClose(prewarmChild, CHROMA_PREWARM_REAP_TIMEOUT_MS);
  }

  private static async waitForChildClose(child: ChildProcess, timeoutMs: number): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null) {
      return;
    }

    await new Promise<void>((resolve) => {
      let timeoutId: ReturnType<typeof setTimeout> | null = null;
      const finish = () => {
        if (timeoutId) {
          clearTimeout(timeoutId);
          timeoutId = null;
        }
        child.off('close', finish);
        child.off('exit', finish);
        resolve();
      };

      timeoutId = setTimeout(finish, timeoutMs);
      child.once('close', finish);
      child.once('exit', finish);
    });
  }

  /**
   * Gracefully stop the MCP connection and kill the chroma-mcp subprocess tree.
   *
   * The MCP SDK's client.close() sends stdin close -> SIGTERM -> SIGKILL to the
   * direct child (uvx), but the spawn chain (uvx -> uv -> python -> chroma-mcp)
   * can leave descendants orphaned because MCP SDK does not use process groups.
   *
   * Fix: kill the entire process tree rooted at the direct child PID BEFORE
   * closing the MCP client, ensuring no orphan python/chroma-mcp processes
   * accumulate across reconnects or worker restarts. Matches the tree-kill
   * pattern from shutdown.ts (Principle 5: OS-supervised teardown).
   */
  async stop(): Promise<void> {
    this.acceptingLocalMutations = false;
    this.connectionGeneration += 1;
    await this.waitForUnexpectedCloseCleanup();

    if (!this.client && !this.transport && !this.activePrewarmChild) {
      logger.debug('CHROMA_MCP', 'No active MCP connection to stop');
      this.releaseChromaWriterLock();
      this.connecting = null;
      return;
    }

    logger.info('CHROMA_MCP', 'Stopping chroma-mcp MCP connection');

    await this.disposeCurrentSubprocess();
    this.connecting = null;

    logger.info('CHROMA_MCP', 'chroma-mcp MCP connection stopped');
  }

  /**
   * Reset the singleton instance (for testing).
   * Awaits stop() to prevent dual subprocesses.
   */
  static async reset(): Promise<void> {
    if (ChromaMcpManager.instance) {
      await ChromaMcpManager.instance.stop();
    }
    ChromaMcpManager.instance = null;
  }

  private getCombinedCertPath(): string | undefined {
    const combinedCertPath = paths.combinedCerts();

    if (fs.existsSync(combinedCertPath)) {
      const stats = fs.statSync(combinedCertPath);
      const ageMs = Date.now() - stats.mtimeMs;
      if (ageMs < 24 * 60 * 60 * 1000) {
        return combinedCertPath;
      }
    }

    if (process.platform !== 'darwin') {
      return undefined;
    }

    try {
      let certifiPath: string | undefined;
      try {
        certifiPath = execSync(
          'uvx --with certifi python -c "import certifi; print(certifi.where())"',
          { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 10000 }
        ).trim();
      } catch (error) {
        logger.debug('CHROMA_MCP', 'Failed to resolve certifi path via uvx', {
          error: error instanceof Error ? error.message : String(error)
        });
        return undefined;
      }

      if (!certifiPath || !fs.existsSync(certifiPath)) {
        return undefined;
      }

      let zscalerCert = '';
      try {
        zscalerCert = execSync(
          'security find-certificate -a -c "Zscaler" -p /Library/Keychains/System.keychain',
          { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 5000 }
        );
      } catch (error) {
        logger.debug('CHROMA_MCP', 'No Zscaler certificate found in system keychain', {
          error: error instanceof Error ? error.message : String(error)
        });
        return undefined;
      }

      if (!zscalerCert ||
          !zscalerCert.includes('-----BEGIN CERTIFICATE-----') ||
          !zscalerCert.includes('-----END CERTIFICATE-----')) {
        return undefined;
      }

      const certifiContent = fs.readFileSync(certifiPath, 'utf8');
      const tempPath = combinedCertPath + '.tmp';
      fs.writeFileSync(tempPath, certifiContent + '\n' + zscalerCert);
      fs.renameSync(tempPath, combinedCertPath);

      logger.info('CHROMA_MCP', 'Created combined SSL certificate bundle for Zscaler', {
        path: combinedCertPath
      });

      return combinedCertPath;
    } catch (error) {
      logger.debug('CHROMA_MCP', 'Could not create combined cert bundle', {}, error as Error);
      return undefined;
    }
  }

  /**
   * uv installs `uvx` to a per-user bin dir that is often NOT on the PATH the
   * worker inherited (the worker is spawned by the host with a minimal env that
   * predates the user adding uv to PATH). Without it, `uvx`/`cmd /c uvx` dies
   * with "not recognized" in ~25ms and semantic search silently falls back to
   * keyword (#2790). Prepend uv's known bin dirs and the macOS Homebrew bins so
   * the chroma child can always resolve uvx. Only dirs that exist are added.
   */
  private static uvBinDirs(): string[] {
    return getUvxBinDirs({
      homedir: os.homedir,
      override: process.env.CLAUDE_MEM_CHROMA_UVX_PATH,
      platform: process.platform,
      isFile: dir => {
        try {
          return fs.existsSync(dir) && fs.statSync(dir).isFile();
        } catch (error) {
          logger.debug('CHROMA_MCP', 'Failed to stat uv bin dir candidate, using as-is', { dir }, error instanceof Error ? error : new Error(String(error)));
          return false;
        }
      },
    });
  }

  /**
   * Resolve the command used to launch uvx.
   *
   * On Windows we MUST spawn uvx.exe DIRECTLY rather than via a `cmd.exe` wrapper:
   * cmd.exe parses the `>`/`<` in the dep-override specs (onnxruntime>=1.20,
   * protobuf<7) as shell redirection before uvx sees them, and Node's
   * child_process arg-quoting for cmd.exe re-mangles even pre-quoted args, so
   * cmd.exe dies with "The directory name is invalid" in ~10ms. The MCP
   * transport then reports "Connection closed", the manager backs off, and
   * semantic search silently degrades to keyword-only (#2696 follow-up).
   *
   * Node's shell-less spawn won't resolve a bare `uvx` via PATHEXT on Windows,
   * so we resolve the absolute path to uvx.exe from the same uv bin dirs that
   * ensureUvOnPath() adds to the child PATH (honouring CLAUDE_MEM_CHROMA_UVX_PATH
   * when it points straight at a binary), falling back to bare 'uvx.exe'.
   */
  static resolveUvxCommand(platform: NodeJS.Platform = process.platform): string {
    if (platform !== 'win32') {
      return 'uvx';
    }
    const override = process.env.CLAUDE_MEM_CHROMA_UVX_PATH;
    if (override) {
      try {
        if (fs.existsSync(override) && fs.statSync(override).isFile()) {
          return override;
        }
      } catch {
        // fall through to scanning the known uv bin dirs
      }
    }
    for (const dir of ChromaMcpManager.uvBinDirs()) {
      const candidate = path.join(dir, 'uvx.exe');
      try {
        if (fs.existsSync(candidate)) {
          return candidate;
        }
      } catch {
        // ignore and try the next candidate
      }
    }
    return 'uvx.exe';
  }

  private static isUvxAvailable(
    command: string,
    env: Record<string, string>,
    platform: NodeJS.Platform,
  ): boolean {
    if (ChromaMcpManager.uvxAvailabilityProbe) {
      return ChromaMcpManager.uvxAvailabilityProbe(command, env, platform);
    }

    const executableNames = platform === 'win32' && !command.toLowerCase().endsWith('.exe')
      ? [command, `${command}.exe`]
      : [command];

    if (command.includes('/') || command.includes('\\')) {
      return executableNames.some(candidate => {
        try {
          return fs.existsSync(candidate) && fs.statSync(candidate).isFile();
        } catch (error) {
          logger.debug('CHROMA_MCP', 'Failed to stat uvx candidate path', { candidate }, error instanceof Error ? error : new Error(String(error)));
          return false;
        }
      });
    }

    const sep = platform === 'win32' ? ';' : ':';
    const pathKey = Object.keys(env).find(k => k.toLowerCase() === 'path') ?? 'PATH';
    const dirs = (env[pathKey] ?? '').split(sep).filter(Boolean);

    for (const dir of dirs) {
      for (const name of executableNames) {
        const candidate = path.join(dir, name);
        try {
          if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
            return true;
          }
        } catch {
          // Try the next PATH entry.
        }
      }
    }
    return false;
  }

  static setUvxAvailabilityProbeForTesting(
    probe: ((command: string, env: Record<string, string>, platform: NodeJS.Platform) => boolean) | null,
  ): void {
    ChromaMcpManager.uvxAvailabilityProbe = probe;
  }

  private static ensureUvOnPath(env: Record<string, string>): void {
    const sep = process.platform === 'win32' ? ';' : ':';
    const pathKey = Object.keys(env).find(k => k.toLowerCase() === 'path') ?? 'PATH';
    const current = env[pathKey] ? env[pathKey].split(sep).filter(Boolean) : [];
    const have = new Set(current.map(p => (process.platform === 'win32' ? p.toLowerCase() : p)));
    const additions = ChromaMcpManager.uvBinDirs().filter(dir => {
      try {
        if (!fs.existsSync(dir)) return false;
      } catch (error) {
        logger.debug('CHROMA_MCP', 'Failed to check uv bin dir existence', { dir }, error instanceof Error ? error : new Error(String(error)));
        return false;
      }
      const key = process.platform === 'win32' ? dir.toLowerCase() : dir;
      return !have.has(key);
    });
    if (additions.length > 0) {
      env[pathKey] = [...additions, ...current].join(sep);
      logger.debug('CHROMA_MCP', 'Prepended uv bin dir(s) to chroma child PATH', { added: additions });
    }
  }

  private static getUvxPreflightEnv(): Record<string, string> {
    const baseEnv: Record<string, string> = {};
    for (const [key, value] of Object.entries(sanitizeEnv(process.env))) {
      if (value !== undefined) {
        baseEnv[key] = value;
      }
    }

    // Ensure uvx is resolvable even if the worker's inherited PATH omits uv's
    // bin dir (#2790).
    ChromaMcpManager.ensureUvOnPath(baseEnv);

    // Never let an activated venv / conda shell leak its interpreter into the
    // uvx child (#3552). This is THE spawn env for chroma-mcp, so this is the
    // call that actually fixes the numpy ABI clash.
    stripForeignPythonEnv(baseEnv);

    // Disable Chroma's anonymous telemetry — it issues background HTTP from
    // the embedding subprocess on every collection touch.
    if (!baseEnv.ANONYMIZED_TELEMETRY) baseEnv.ANONYMIZED_TELEMETRY = 'false';

    // Force UTF-8 on the Python child's stdio. Without this, a non-UTF-8 ANSI
    // code page (e.g. cp936) makes Python encode JSON-RPC stdout in the locale
    // encoding, which Node then decodes as UTF-8 — the bad bytes become U+FFFD
    // and JSON.parse throws. These vars govern both directions of the pipe.
    baseEnv.PYTHONUTF8 = '1';
    baseEnv.PYTHONIOENCODING = 'utf-8';
    return baseEnv;
  }

  private getSpawnEnv(preflightEnv?: Record<string, string>): Record<string, string> {
    const baseEnv = preflightEnv ? { ...preflightEnv } : ChromaMcpManager.getUvxPreflightEnv();

    const combinedCertPath = this.getCombinedCertPath();
    if (!combinedCertPath) {
      return baseEnv;
    }

    logger.info('CHROMA_MCP', 'Using combined SSL certificates for enterprise compatibility', {
      certPath: combinedCertPath
    });

    return {
      ...baseEnv,
      SSL_CERT_FILE: combinedCertPath,
      REQUESTS_CA_BUNDLE: combinedCertPath,
      CURL_CA_BUNDLE: combinedCertPath,
      NODE_EXTRA_CA_CERTS: combinedCertPath
    };
  }

  private registerManagedProcess(): void {
    const chromaProcess = (this.transport as unknown as { _process?: ChildProcess })._process;
    if (!chromaProcess?.pid) {
      return;
    }

    // Register with pgid so the supervisor's shutdown cascade can use
    // process-group signaling (kill(-pgid, signal)) to tear down the
    // entire spawn chain (uvx -> uv -> python -> chroma-mcp) in one
    // syscall, matching the SDK subprocess pattern in process-registry.ts.
    //
    // Note: MCP SDK's StdioClientTransport does NOT use detached:true,
    // so the child shares our process group — setting pgid here enables
    // tree-kill via signalProcess() in shutdown.ts which falls back to
    // taskkill /T on Windows when pgid is present but group signal fails.
    // On POSIX the pgid recorded here is used by killProcessTree() in
    // stop() for explicit tree teardown rather than negative-PID signaling.
    getSupervisor().registerProcess(CHROMA_SUPERVISOR_ID, {
      pid: chromaProcess.pid,
      type: 'chroma',
      startedAt: new Date().toISOString(),
      // Store pid as pgid — shutdown.ts will attempt kill(-pgid) on POSIX.
      // If the child isn't actually its own group leader, the ESRCH is caught
      // and shutdown falls back to single-PID kill (see signalProcess()).
      pgid: chromaProcess.pid
    }, chromaProcess);

    chromaProcess.once('exit', () => {
      getSupervisor().unregisterProcess(CHROMA_SUPERVISOR_ID);
    });
  }
}
