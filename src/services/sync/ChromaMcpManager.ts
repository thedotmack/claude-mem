
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { execFile, execSync, type ChildProcess } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import os from 'os';
import fs from 'fs';
import { logger } from '../../utils/logger.js';
import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';
import { USER_SETTINGS_PATH, paths } from '../../shared/paths.js';
import { sanitizeEnv } from '../../supervisor/env-sanitizer.js';
import { getSupervisor } from '../../supervisor/index.js';

const execFileAsync = promisify(execFile);

const CHROMA_MCP_CLIENT_NAME = 'claude-mem-chroma';
const CHROMA_MCP_CLIENT_VERSION = '1.0.0';
const MCP_CONNECTION_TIMEOUT_MS = 30_000;
const RECONNECT_BACKOFF_MS = 10_000;
const DEFAULT_CHROMA_DATA_DIR = paths.chroma();
const CHROMA_SUPERVISOR_ID = 'chroma-mcp';

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

export class ChromaMcpManager {
  private static instance: ChromaMcpManager | null = null;
  private client: Client | null = null;
  private transport: StdioClientTransport | null = null;
  private connected: boolean = false;
  private lastConnectionFailureTimestamp: number = 0;
  private connecting: Promise<void> | null = null;

  private constructor() {}

  static getInstance(): ChromaMcpManager {
    if (!ChromaMcpManager.instance) {
      ChromaMcpManager.instance = new ChromaMcpManager();
    }
    return ChromaMcpManager.instance;
  }

  private async ensureConnected(): Promise<void> {
    if (this.connected && this.client) {
      return;
    }

    const timeSinceLastFailure = Date.now() - this.lastConnectionFailureTimestamp;
    if (this.lastConnectionFailureTimestamp > 0 && timeSinceLastFailure < RECONNECT_BACKOFF_MS) {
      throw new Error(`chroma-mcp connection in backoff (${Math.ceil((RECONNECT_BACKOFF_MS - timeSinceLastFailure) / 1000)}s remaining)`);
    }

    if (this.connecting) {
      await this.connecting;
      return;
    }

    this.connecting = this.connectInternal();
    try {
      await this.connecting;
    } catch (error) {
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
    // Singleton invariant (#2313): kill any pre-existing chroma-mcp subprocess
    // tree before spawning a new one. The MCP SDK's transport.close() only
    // signals the direct child (uvx); on Linux the grandchildren (uv, python,
    // chroma-mcp) get re-parented to init and survive, accumulating 20+
    // instances per session if reconnects fire repeatedly. Reuse the same
    // tree-kill primitive used by stop() so reconnect can never leave
    // orphans behind.
    await this.disposeCurrentSubprocess();

    const commandArgs = this.buildCommandArgs();
    const spawnEnvironment = this.getSpawnEnv();
    getSupervisor().assertCanSpawn('chroma mcp');

    const isWindows = process.platform === 'win32';
    const uvxSpawnCommand = isWindows ? (process.env.ComSpec || 'cmd.exe') : 'uvx';
    const uvxSpawnArgs = isWindows ? ['/c', 'uvx', ...commandArgs] : commandArgs;

    logger.info('CHROMA_MCP', 'Connecting to chroma-mcp via MCP stdio', {
      command: uvxSpawnCommand,
      args: uvxSpawnArgs.join(' ')
    });

    this.transport = new StdioClientTransport({
      command: uvxSpawnCommand,
      args: uvxSpawnArgs,
      env: spawnEnvironment,
      cwd: os.homedir(),
      stderr: 'pipe'
    });

    this.client = new Client(
      { name: CHROMA_MCP_CLIENT_NAME, version: CHROMA_MCP_CLIENT_VERSION },
      { capabilities: {} }
    );

    const mcpConnectionPromise = this.client.connect(this.transport);
    let timeoutId: ReturnType<typeof setTimeout>;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(
        () => reject(new Error(`MCP connection to chroma-mcp timed out after ${MCP_CONNECTION_TIMEOUT_MS}ms`)),
        MCP_CONNECTION_TIMEOUT_MS
      );
    });

    try {
      await Promise.race([mcpConnectionPromise, timeoutPromise]);
    } catch (connectionError) {
      clearTimeout(timeoutId!);
      logger.warn('CHROMA_MCP', 'Connection failed, killing subprocess tree to prevent zombie', {
        error: connectionError instanceof Error ? connectionError.message : String(connectionError)
      });
      // Tree-kill (not just transport.close) so failed-connect descendants
      // can't survive on Linux (#2313).
      await this.disposeCurrentSubprocess();
      throw connectionError;
    }
    clearTimeout(timeoutId!);

    this.connected = true;
    this.registerManagedProcess();

    logger.info('CHROMA_MCP', 'Connected to chroma-mcp successfully');

    const currentTransport = this.transport;
    const currentTrackedPid = (this.transport as unknown as { _process?: ChildProcess })._process?.pid;
    this.transport.onclose = () => {
      if (this.transport !== currentTransport) {
        logger.debug('CHROMA_MCP', 'Ignoring stale onclose from previous transport');
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
      if (currentTrackedPid) {
        ChromaMcpManager.killProcessTree(currentTrackedPid).catch((error) => {
          logger.debug('CHROMA_MCP', 'Background tree-kill after onclose finished (best-effort)', {
            pid: currentTrackedPid,
            error: error instanceof Error ? error.message : String(error)
          });
        });
      }
    };
  }

  private buildCommandArgs(): string[] {
    const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
    const chromaMode = settings.CLAUDE_MEM_CHROMA_MODE || 'local';
    const pythonVersion = process.env.CLAUDE_MEM_PYTHON_VERSION || settings.CLAUDE_MEM_PYTHON_VERSION || '3.13';

    const depOverrideFlags = CHROMA_MCP_DEP_OVERRIDES.flatMap(spec => ['--with', spec]);

    if (chromaMode === 'remote') {
      const chromaHost = settings.CLAUDE_MEM_CHROMA_HOST || '127.0.0.1';
      const chromaPort = settings.CLAUDE_MEM_CHROMA_PORT || '8000';
      const chromaSsl = settings.CLAUDE_MEM_CHROMA_SSL === 'true';
      const chromaTenant = settings.CLAUDE_MEM_CHROMA_TENANT || 'default_tenant';
      const chromaDatabase = settings.CLAUDE_MEM_CHROMA_DATABASE || 'default_database';
      const chromaApiKey = settings.CLAUDE_MEM_CHROMA_API_KEY || '';

      const args = [
        '--python', pythonVersion,
        ...depOverrideFlags,
        `chroma-mcp==${CHROMA_MCP_PINNED_VERSION}`,
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
      '--python', pythonVersion,
      ...depOverrideFlags,
      `chroma-mcp==${CHROMA_MCP_PINNED_VERSION}`,
      '--client-type', 'persistent',
      '--data-dir', DEFAULT_CHROMA_DATA_DIR.replace(/\\/g, '/')
    ];
  }

  async callTool(toolName: string, toolArguments: Record<string, unknown>): Promise<unknown> {
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

      // Tree-kill the dying subprocess before reconnect. Previously this path
      // just nulled the handle, which on Linux leaks the uv/python/chroma-mcp
      // descendants every time a transport error happens (#2313).
      await this.disposeCurrentSubprocess();

      try {
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
    const chromaProcess = (this.transport as unknown as { _process?: ChildProcess })?._process;
    const trackedPid = chromaProcess?.pid;

    if (trackedPid) {
      try {
        await ChromaMcpManager.killProcessTree(trackedPid);
      } catch (error) {
        logger.warn('CHROMA_MCP', 'failed to kill prior chroma-mcp tree (best-effort)', {
          pid: trackedPid,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }

    if (this.transport) {
      try { await this.transport.close(); } catch { /* already dead */ }
    }
    if (this.client) {
      try { await this.client.close(); } catch { /* already dead */ }
    }

    if (trackedPid) {
      getSupervisor().unregisterProcess(CHROMA_SUPERVISOR_ID);
    }

    this.client = null;
    this.transport = null;
    this.connected = false;
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
    if (!this.client && !this.transport) {
      logger.debug('CHROMA_MCP', 'No active MCP connection to stop');
      this.connecting = null;
      return;
    }

    logger.info('CHROMA_MCP', 'Stopping chroma-mcp MCP connection');

    await this.disposeCurrentSubprocess();
    this.connecting = null;

    logger.info('CHROMA_MCP', 'chroma-mcp MCP connection stopped');
  }

  /**
   * Kill a process and all its descendants (tree-kill).
   *
   * POSIX: Sends SIGTERM to the process, then uses `pkill -P` to signal
   * children recursively. Falls back to single-PID kill if pkill is unavailable.
   *
   * Windows: Uses `taskkill /T /F /PID` for full subtree teardown (same
   * pattern as shutdown.ts).
   *
   * Best-effort — swallows ESRCH (already dead) and logs other errors.
   */
  private static async killProcessTree(pid: number): Promise<void> {
    logger.debug('CHROMA_MCP', `Killing process tree rooted at PID ${pid}`);

    if (process.platform === 'win32') {
      try {
        await execFileAsync('taskkill', ['/PID', String(pid), '/T', '/F'], {
          timeout: 5_000,
          windowsHide: true
        });
      } catch (error) {
        // taskkill exits non-zero when the process is already dead — that's fine.
        logger.debug('CHROMA_MCP', `taskkill tree-kill finished (may already be dead)`, {
          pid,
          error: error instanceof Error ? error.message : String(error)
        });
      }
      return;
    }

    // POSIX: walk descendants recursively (bottom-up) and signal each.
    // `pkill -P <pid>` only reaches direct children, so `python` /
    // `chroma-mcp` under `uv` (grandchildren) get re-parented to init and
    // survive. We collect the full descendant set via `pgrep -P` walks before
    // signaling, so the SIGTERM phase reaches every layer
    // (CodeRabbit review on PR #2282).
    try {
      const descendantsBeforeTerm = await ChromaMcpManager.collectDescendantPids(pid);
      // Signal leaves first, then the root.
      for (const child of descendantsBeforeTerm) {
        try {
          process.kill(child, 'SIGTERM');
        } catch {
          // Already gone — fine.
        }
      }
      try {
        process.kill(pid, 'SIGTERM');
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'ESRCH') {
          logger.debug('CHROMA_MCP', `Failed to SIGTERM PID ${pid}`, { code });
        }
      }

      // Brief wait for SIGTERM to propagate, then SIGKILL stragglers.
      await new Promise(resolve => setTimeout(resolve, 500));

      // Re-collect descendants — some layers may have re-parented during the
      // SIGTERM grace window.
      //
      // SIGKILL targets the UNION of pre-TERM and post-wait descendant sets:
      // when the root exits between snapshots, children get re-parented to
      // init and drop out of `pgrep -P <root>`. Without the union, those
      // re-parented descendants would never receive SIGKILL even though they
      // were definitely children before SIGTERM (CodeRabbit review on PR
      // #2282). Dedupe via Set since `descendantsBeforeKill` typically
      // overlaps with `descendantsBeforeTerm`.
      const descendantsBeforeKill = await ChromaMcpManager.collectDescendantPids(pid);
      const killTargets = Array.from(new Set([...descendantsBeforeTerm, ...descendantsBeforeKill]));
      for (const child of killTargets) {
        try {
          process.kill(child, 'SIGKILL');
        } catch {
          // Already dead — fine.
        }
      }
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // Already dead — fine.
      }
    } catch (error) {
      logger.debug('CHROMA_MCP', `Process tree kill completed (best-effort)`, {
        pid,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  /**
   * Recursively collect all descendant PIDs of `rootPid` using `pgrep -P`.
   * Returned bottom-up (leaves first) so callers can signal leaves before
   * their ancestors. Best-effort: missing pgrep / non-zero exits return [].
   */
  private static async collectDescendantPids(rootPid: number): Promise<number[]> {
    const seen = new Set<number>();
    const collected: number[] = [];

    async function walk(pid: number): Promise<void> {
      let stdout = '';
      try {
        const result = await execFileAsync('pgrep', ['-P', String(pid)], { timeout: 2_000 });
        stdout = result.stdout;
      } catch {
        // pgrep exits 1 when no children match — that's fine, just return.
        return;
      }
      const children = stdout
        .split('\n')
        .map(line => line.trim())
        .filter(line => line.length > 0)
        .map(line => Number.parseInt(line, 10))
        .filter(n => Number.isFinite(n) && n > 0 && !seen.has(n));

      for (const child of children) {
        seen.add(child);
        await walk(child);
        // Bottom-up: push after recursion so leaves come first.
        collected.push(child);
      }
    }

    await walk(rootPid);
    return collected;
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

  private getSpawnEnv(): Record<string, string> {
    const baseEnv: Record<string, string> = {};
    for (const [key, value] of Object.entries(sanitizeEnv(process.env))) {
      if (value !== undefined) {
        baseEnv[key] = value;
      }
    }

    // Disable Chroma's anonymous telemetry — it issues background HTTP from
    // the embedding subprocess on every collection touch.
    if (!baseEnv.ANONYMIZED_TELEMETRY) baseEnv.ANONYMIZED_TELEMETRY = 'false';

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
