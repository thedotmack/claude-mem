/**
 * ChromaServerManager - Singleton managing local Chroma HTTP server lifecycle
 *
 * Starts a persistent Chroma server via `npx chroma run` at worker startup
 * and manages its lifecycle. In 'remote' mode, skips server start and connects
 * to an existing server (future cloud support).
 *
 * Cross-platform: Linux, macOS, Windows
 */

import { spawn, ChildProcess, execSync } from 'child_process';
import path from 'path';
import os from 'os';
import fs, { existsSync } from 'fs';
import { logger } from '../../utils/logger.js';

export interface ChromaServerConfig {
  dataDir: string;
  host: string;
  port: number;
}

export class ChromaServerManager {
  private static instance: ChromaServerManager | null = null;
  private serverProcess: ChildProcess | null = null;
  private config: ChromaServerConfig;
  private starting: boolean = false;
  private ready: boolean = false;
  private startPromise: Promise<boolean> | null = null;

  private constructor(config: ChromaServerConfig) {
    this.config = config;
  }

  /**
   * Get or create the singleton instance
   */
  static getInstance(config?: ChromaServerConfig): ChromaServerManager {
    if (!ChromaServerManager.instance) {
      const defaultConfig: ChromaServerConfig = {
        dataDir: path.join(os.homedir(), '.claude-mem', 'vector-db'),
        host: '127.0.0.1',
        port: 8000
      };
      ChromaServerManager.instance = new ChromaServerManager(config || defaultConfig);
    }
    return ChromaServerManager.instance;
  }

  /**
   * Start the Chroma HTTP server
   * Reuses in-flight startup if already starting
   * Spawns `npx chroma run` as a background process
   * If a server is already running (from previous worker), reuses it
   */
  async start(timeoutMs: number = 60000): Promise<boolean> {
    if (this.ready) {
      logger.debug('CHROMA_SERVER', 'Server already started or starting', {
        ready: this.ready,
        starting: this.starting
      });
      return true;
    }

    if (this.startPromise) {
      logger.debug('CHROMA_SERVER', 'Awaiting existing startup', {
        host: this.config.host,
        port: this.config.port
      });
      return this.startPromise;
    }

    this.starting = true;
    this.startPromise = this.startInternal(timeoutMs);

    try {
      return await this.startPromise;
    } finally {
      this.startPromise = null;
      if (!this.ready) {
        this.starting = false;
      }
    }
  }

  /**
   * Internal startup path used behind a single shared startPromise lock
   */
  private async startInternal(timeoutMs: number): Promise<boolean> {
    // Check if a server is already running (from previous worker or manual start)
    try {
      const response = await fetch(
        `http://${this.config.host}:${this.config.port}/api/v2/heartbeat`,
        { signal: AbortSignal.timeout(3000) }
      );
      if (response.ok) {
        logger.info('CHROMA_SERVER', 'Existing server detected, reusing', {
          host: this.config.host,
          port: this.config.port
        });
        this.ready = true;
        this.starting = false;
        return true;
      }
    } catch {
      // No server running, proceed to start one
    }

    // Cross-platform: use npx.cmd on Windows
    const isWindows = process.platform === 'win32';

    // Resolve chroma binary absolutely — npx fails when spawned from cache dirs (#1120)
    let command: string;
    let args: string[];
    try {
      // chromadb package installs a 'chroma' bin entry
      const chromaBinDir = path.dirname(require.resolve('chromadb/package.json'));
      // Check project-level .bin first (most common npm/bun installation layout)
      const projectBin = path.join(chromaBinDir, '..', '.bin', isWindows ? 'chroma.cmd' : 'chroma');
      // Fallback: nested node_modules .bin (rare — pnpm or workspace hoisting)
      const nestedBin = path.join(chromaBinDir, 'node_modules', '.bin', isWindows ? 'chroma.cmd' : 'chroma');

      if (existsSync(projectBin)) {
        command = projectBin;
      } else if (existsSync(nestedBin)) {
        command = nestedBin;
      } else {
        // Last resort: npx with explicit cwd
        command = isWindows ? 'npx.cmd' : 'npx';
      }
    } catch {
      command = isWindows ? 'npx.cmd' : 'npx';
    }

    if (command.includes('npx')) {
      args = ['chroma', 'run', '--path', this.config.dataDir, '--host', this.config.host, '--port', String(this.config.port)];
    } else {
      args = ['run', '--path', this.config.dataDir, '--host', this.config.host, '--port', String(this.config.port)];
    }

    logger.info('CHROMA_SERVER', 'Starting Chroma server', {
      command,
      args: args.join(' '),
      dataDir: this.config.dataDir
    });

    const spawnEnv = this.getSpawnEnv();

    // Resolve cwd for npx fallback — ensures node_modules is findable (#1120)
    let spawnCwd: string | undefined;
    try {
      spawnCwd = path.dirname(require.resolve('chromadb/package.json'));
    } catch {
      // If chromadb isn't resolvable, omit cwd and let npx handle it
    }

    this.serverProcess = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: !isWindows,  // Don't detach on Windows (no process groups)
      windowsHide: true,     // Hide console window on Windows
      env: spawnEnv,
      ...(spawnCwd && { cwd: spawnCwd })
    });

    // Log server output for debugging
    this.serverProcess.stdout?.on('data', (data) => {
      const msg = data.toString().trim();
      if (msg) {
        logger.debug('CHROMA_SERVER', msg);
      }
    });

    this.serverProcess.stderr?.on('data', (data) => {
      const msg = data.toString().trim();
      if (msg) {
        // Filter out noisy startup messages
        if (!msg.includes('Chroma') || msg.includes('error') || msg.includes('Error')) {
          logger.debug('CHROMA_SERVER', msg);
        }
      }
    });

    this.serverProcess.on('error', (err) => {
      logger.error('CHROMA_SERVER', 'Server process error', {}, err);
      this.ready = false;
      this.starting = false;
    });

    this.serverProcess.on('exit', (code, signal) => {
      logger.info('CHROMA_SERVER', 'Server process exited', { code, signal });
      this.ready = false;
      this.starting = false;
      this.serverProcess = null;
    });

    return this.waitForReady(timeoutMs);
  }

  /**
   * Wait for the server to become ready
   * Polls the heartbeat endpoint until success or timeout
   */
  async waitForReady(timeoutMs: number = 60000): Promise<boolean> {
    if (this.ready) {
      return true;
    }

    const startTime = Date.now();
    const checkInterval = 500;

    logger.info('CHROMA_SERVER', 'Waiting for server to be ready', {
      host: this.config.host,
      port: this.config.port,
      timeoutMs
    });

    while (Date.now() - startTime < timeoutMs) {
      try {
        const response = await fetch(
          `http://${this.config.host}:${this.config.port}/api/v2/heartbeat`
        );
        if (response.ok) {
          this.ready = true;
          this.starting = false;
          logger.info('CHROMA_SERVER', 'Server ready', {
            host: this.config.host,
            port: this.config.port,
            startupTimeMs: Date.now() - startTime
          });
          return true;
        }
      } catch {
        // Server not ready yet, continue polling
      }
      await new Promise(resolve => setTimeout(resolve, checkInterval));
    }

    this.starting = false;
    logger.error('CHROMA_SERVER', 'Server failed to start within timeout', {
      timeoutMs,
      elapsedMs: Date.now() - startTime
    });
    return false;
  }

  /**
   * Check if the server is running and ready
   * Returns true if we manage the process OR if a server is responding
   */
  isRunning(): boolean {
    return this.ready;
  }

  /**
   * Async check if server is running by pinging heartbeat
   * Use this when you need to verify server is actually reachable
   */
  async isServerReachable(): Promise<boolean> {
    try {
      const response = await fetch(
        `http://${this.config.host}:${this.config.port}/api/v2/heartbeat`
      );
      if (response.ok) {
        this.ready = true;
        return true;
      }
    } catch {
      // Server not reachable
    }
    return false;
  }

  /**
   * Get the server URL for client connections
   */
  getUrl(): string {
    return `http://${this.config.host}:${this.config.port}`;
  }

  /**
   * Get the server configuration
   */
  getConfig(): ChromaServerConfig {
    return { ...this.config };
  }

  /**
   * Stop the Chroma server
   * Gracefully terminates the server process
   */
  async stop(): Promise<void> {
    if (!this.serverProcess) {
      logger.debug('CHROMA_SERVER', 'No server process to stop');
      return;
    }

    logger.info('CHROMA_SERVER', 'Stopping server', { pid: this.serverProcess.pid });

    return new Promise((resolve) => {
      const proc = this.serverProcess!;
      const pid = proc.pid;

      const cleanup = () => {
        this.serverProcess = null;
        this.ready = false;
        this.starting = false;
        this.startPromise = null;
        logger.info('CHROMA_SERVER', 'Server stopped', { pid });
        resolve();
      };

      // Set up exit handler
      proc.once('exit', cleanup);

      // Cross-platform graceful shutdown
      if (process.platform === 'win32') {
        // Windows: just send SIGTERM
        proc.kill('SIGTERM');
      } else {
        // Unix: kill the process group to ensure all children are killed
        if (pid !== undefined) {
          try {
            process.kill(-pid, 'SIGTERM');
          } catch (err) {
            // Process group kill failed, try direct kill
            proc.kill('SIGTERM');
          }
        } else {
          proc.kill('SIGTERM');
        }
      }

      // Force kill after timeout if still running
      setTimeout(() => {
        if (this.serverProcess) {
          logger.warn('CHROMA_SERVER', 'Force killing server after timeout', { pid });
          try {
            proc.kill('SIGKILL');
          } catch {
            // Already dead
          }
          cleanup();
        }
      }, 5000);
    });
  }

  /**
   * Get or create combined SSL certificate bundle for Zscaler/corporate proxy environments.
   * This ports previous MCP SSL handling so local `npx chroma run` works behind enterprise proxies.
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

      logger.info('CHROMA_SERVER', 'Created combined SSL certificate bundle for Zscaler', {
        path: combinedCertPath
      });

      return combinedCertPath;
    } catch (error) {
      logger.debug('CHROMA_SERVER', 'Could not create combined cert bundle', {}, error as Error);
      return undefined;
    }
  }

  /**
   * Build subprocess env and preserve Zscaler compatibility from previous architecture.
   */
  private getSpawnEnv(): NodeJS.ProcessEnv {
    const combinedCertPath = this.getCombinedCertPath();
    if (!combinedCertPath) {
      return process.env;
    }

    logger.info('CHROMA_SERVER', 'Using combined SSL certificates for enterprise compatibility', {
      certPath: combinedCertPath
    });

    return {
      ...process.env,
      SSL_CERT_FILE: combinedCertPath,
      REQUESTS_CA_BUNDLE: combinedCertPath,
      CURL_CA_BUNDLE: combinedCertPath,
      NODE_EXTRA_CA_CERTS: combinedCertPath
    };
  }

  /**
   * Reset the singleton instance (for testing)
   */
  static reset(): void {
    if (ChromaServerManager.instance) {
      // Don't await - just trigger stop
      ChromaServerManager.instance.stop().catch(() => {});
    }
    ChromaServerManager.instance = null;
  }
}
