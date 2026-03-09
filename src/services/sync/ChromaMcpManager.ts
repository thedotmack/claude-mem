/**
 * ChromaMcpManager - Singleton managing a persistent MCP connection to chroma-mcp via uvx
 *
 * Replaces ChromaServerManager (which spawned `npx chroma run`) with a stdio-based
 * MCP client that communicates with chroma-mcp as a subprocess. The chroma-mcp server
 * handles its own embedding and persistent storage, eliminating the need for a separate
 * HTTP server, chromadb npm package, and ONNX/WASM embedding dependencies.
 *
 * Lifecycle: lazy-connects on first callTool() use, maintains a single persistent
 * connection per worker lifetime, and auto-reconnects if the subprocess dies.
 *
 * Cross-platform: Linux, macOS, Windows
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { execSync } from 'child_process';
import path from 'path';
import os from 'os';
import fs from 'fs';
import { logger } from '../../utils/logger.js';
import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';
import { USER_SETTINGS_PATH } from '../../shared/paths.js';

const CHROMA_MCP_CLIENT_NAME = 'claude-mem-chroma';
const CHROMA_MCP_CLIENT_VERSION = '1.0.0';
const MCP_CONNECTION_TIMEOUT_MS = 30_000;
const RECONNECT_BACKOFF_MS = 10_000; // Don't retry connections faster than this after failure
const DEFAULT_CHROMA_DATA_DIR = path.join(os.homedir(), '.claude-mem', 'chroma');

export class ChromaMcpManager {
  private static instance: ChromaMcpManager | null = null;
  private client: Client | null = null;
  private transport: StdioClientTransport | null = null;
  private connected: boolean = false;
  private lastConnectionFailureTimestamp: number = 0;
  private connecting: Promise<void> | null = null;

  private constructor() {}

  /**
   * Get or create the singleton instance
   */
  static getInstance(): ChromaMcpManager {
    if (!ChromaMcpManager.instance) {
      ChromaMcpManager.instance = new ChromaMcpManager();
    }
    return ChromaMcpManager.instance;
  }

  /**
   * Ensure the MCP client is connected to chroma-mcp.
   * Uses a connection lock to prevent concurrent connection attempts.
   * If the subprocess has died since the last use, reconnects transparently.
   */
  private async ensureConnected(): Promise<void> {
    if (this.connected && this.client) {
      return;
    }

    // Backoff: don't retry connections too fast after a failure
    const timeSinceLastFailure = Date.now() - this.lastConnectionFailureTimestamp;
    if (this.lastConnectionFailureTimestamp > 0 && timeSinceLastFailure < RECONNECT_BACKOFF_MS) {
      throw new Error(`chroma-mcp connection in backoff (${Math.ceil((RECONNECT_BACKOFF_MS - timeSinceLastFailure) / 1000)}s remaining)`);
    }

    // If another caller is already connecting, wait for that attempt
    if (this.connecting) {
      await this.connecting;
      return;
    }

    this.connecting = this.connectInternal();
    try {
      await this.connecting;
    } catch (error) {
      this.lastConnectionFailureTimestamp = Date.now();
      throw error;
    } finally {
      this.connecting = null;
    }
  }

  /**
   * Internal connection logic - spawns uvx chroma-mcp and performs MCP handshake.
   * Called behind the connection lock to ensure only one connection attempt at a time.
   */
  private async connectInternal(): Promise<void> {
    // Clean up any stale client/transport from a dead subprocess.
    // Close transport first (kills subprocess via SIGTERM) before client
    // to avoid hanging on a stuck process.
    if (this.transport) {
      try { await this.transport.close(); } catch { /* already dead */ }
    }
    if (this.client) {
      try { await this.client.close(); } catch { /* already dead */ }
    }
    this.client = null;
    this.transport = null;
    this.connected = false;

    const commandArgs = this.buildCommandArgs();
    const spawnEnvironment = this.getSpawnEnv();

    // On Windows, .cmd files require shell resolution. Since MCP SDK's
    // StdioClientTransport doesn't support `shell: true`, route through
    // cmd.exe which resolves .cmd/.bat extensions and PATH automatically.
    // This also fixes Git Bash compatibility (#1062) since cmd.exe handles
    // Windows-native command resolution regardless of the calling shell.
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
      // Connection failed or timed out - kill the subprocess to prevent zombies
      clearTimeout(timeoutId!);
      logger.warn('CHROMA_MCP', 'Connection failed, killing subprocess to prevent zombie', {
        error: connectionError instanceof Error ? connectionError.message : String(connectionError)
      });
      try { await this.transport.close(); } catch { /* best effort */ }
      try { await this.client.close(); } catch { /* best effort */ }
      this.client = null;
      this.transport = null;
      this.connected = false;
      throw connectionError;
    }
    clearTimeout(timeoutId!);

    this.connected = true;

    logger.info('CHROMA_MCP', 'Connected to chroma-mcp successfully');

    // Listen for transport close to mark connection as dead and apply backoff.
    // CRITICAL: Guard with reference check to prevent stale onclose handlers from
    // previous transports overwriting the current connection (race condition).
    const currentTransport = this.transport;
    this.transport.onclose = () => {
      if (this.transport !== currentTransport) {
        logger.debug('CHROMA_MCP', 'Ignoring stale onclose from previous transport');
        return;
      }
      logger.warn('CHROMA_MCP', 'chroma-mcp subprocess closed unexpectedly, applying reconnect backoff');
      this.connected = false;
      this.client = null;
      this.transport = null;
      this.lastConnectionFailureTimestamp = Date.now();
    };
  }

  /**
   * Build the uvx command arguments based on current settings.
   * In local mode: uses persistent client with local data directory.
   * In remote mode: uses http client with configured host/port/auth.
   */
  private buildCommandArgs(): string[] {
    const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
    const chromaMode = settings.CLAUDE_MEM_CHROMA_MODE || 'local';
    const pythonVersion = process.env.CLAUDE_MEM_PYTHON_VERSION || settings.CLAUDE_MEM_PYTHON_VERSION || '3.13';

    if (chromaMode === 'remote') {
      const chromaHost = settings.CLAUDE_MEM_CHROMA_HOST || '127.0.0.1';
      const chromaPort = settings.CLAUDE_MEM_CHROMA_PORT || '8000';
      const chromaSsl = settings.CLAUDE_MEM_CHROMA_SSL === 'true';
      const chromaTenant = settings.CLAUDE_MEM_CHROMA_TENANT || 'default_tenant';
      const chromaDatabase = settings.CLAUDE_MEM_CHROMA_DATABASE || 'default_database';
      const chromaApiKey = settings.CLAUDE_MEM_CHROMA_API_KEY || '';

      const args = [
        '--python', pythonVersion,
        'chroma-mcp',
        '--client-type', 'http',
        '--host', chromaHost,
        '--port', chromaPort
      ];

      if (chromaSsl) {
        args.push('--ssl');
      }

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

    // Local mode: persistent client with data directory
    return [
      '--python', pythonVersion,
      'chroma-mcp',
      '--client-type', 'persistent',
      '--data-dir', DEFAULT_CHROMA_DATA_DIR.replace(/\\/g, '/')
    ];
  }

  /**
   * Call a chroma-mcp tool by name with the given arguments.
   * Lazily connects on first call. Reconnects if the subprocess has died.
   *
   * @param toolName - The chroma-mcp tool name (e.g. 'chroma_query_documents')
   * @param toolArguments - The tool arguments as a plain object
   * @returns The parsed JSON result from the tool's text output
   */
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
      // Transport error: chroma-mcp subprocess likely died (e.g., killed by orphan reaper,
      // HNSW index corruption). Mark connection dead and retry once after reconnect (#1131).
      // Without this retry, callers see a one-shot error even though reconnect would succeed.
      this.connected = false;
      this.client = null;
      this.transport = null;

      logger.warn('CHROMA_MCP', `Transport error during "${toolName}", reconnecting and retrying once`, {
        error: transportError instanceof Error ? transportError.message : String(transportError)
      });

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

    // MCP tools signal errors via isError flag on the CallToolResult
    if (result.isError) {
      const errorText = (result.content as Array<{ type: string; text?: string }>)
        ?.find(item => item.type === 'text')?.text || 'Unknown chroma-mcp error';
      throw new Error(`chroma-mcp tool "${toolName}" returned error: ${errorText}`);
    }

    // Extract text from MCP CallToolResult: { content: Array<{ type, text? }> }
    const contentArray = result.content as Array<{ type: string; text?: string }>;
    if (!contentArray || contentArray.length === 0) {
      return null;
    }

    const firstTextContent = contentArray.find(item => item.type === 'text' && item.text);
    if (!firstTextContent || !firstTextContent.text) {
      return null;
    }

    // chroma-mcp returns JSON for query/get results, but plain text for
    // mutating operations (e.g. "Successfully created collection ...").
    // Try JSON parse first; if it fails, return the raw text for non-error responses.
    try {
      return JSON.parse(firstTextContent.text);
    } catch {
      // Plain text response (e.g. "Successfully created collection cm__foo")
      // Return null for void-like success messages, callers don't need the text
      return null;
    }
  }

  /**
   * Check if the MCP connection is alive by calling chroma_list_collections.
   * Returns true if the connection is healthy, false otherwise.
   */
  async isHealthy(): Promise<boolean> {
    try {
      await this.callTool('chroma_list_collections', { limit: 1 });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Gracefully stop the MCP connection and kill the chroma-mcp subprocess.
   * client.close() sends stdin close -> SIGTERM -> SIGKILL to the subprocess.
   */
  async stop(): Promise<void> {
    if (!this.client) {
      logger.debug('CHROMA_MCP', 'No active MCP connection to stop');
      return;
    }

    logger.info('CHROMA_MCP', 'Stopping chroma-mcp MCP connection');

    try {
      await this.client.close();
    } catch (error) {
      logger.debug('CHROMA_MCP', 'Error during client close (subprocess may already be dead)', {}, error as Error);
    }

    this.client = null;
    this.transport = null;
    this.connected = false;
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

  /**
   * Get or create a combined SSL certificate bundle for Zscaler/corporate proxy environments.
   * On macOS, combines the Python certifi CA bundle with any Zscaler certificates from
   * the system keychain. Caches the result for 24 hours at ~/.claude-mem/combined_certs.pem.
   *
   * Returns the path to the combined cert file, or undefined if not needed/available.
   */
  private getCombinedCertPath(): string | undefined {
    const combinedCertPath = path.join(os.homedir(), '.claude-mem', 'combined_certs.pem');

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
      } catch {
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
      } catch {
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
   * Build subprocess environment with SSL certificate overrides for enterprise proxy compatibility.
   * If a combined cert bundle exists (Zscaler), injects SSL_CERT_FILE, REQUESTS_CA_BUNDLE, etc.
   * Otherwise returns a plain string-keyed copy of process.env.
   */
  private getSpawnEnv(): Record<string, string> {
    const baseEnv: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined) {
        baseEnv[key] = value;
      }
    }

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
}
