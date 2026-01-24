/**
 * ChromaServerManager - Singleton managing local Chroma HTTP server lifecycle
 *
 * Starts a persistent Chroma server via `npx chroma run` at worker startup
 * and manages its lifecycle. In 'remote' mode, skips server start and connects
 * to an existing server (future cloud support).
 *
 * Cross-platform: Linux, macOS, Windows
 */

import { spawn, ChildProcess } from 'child_process';
import path from 'path';
import os from 'os';
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
   * Spawns `npx chroma run` as a background process
   */
  async start(): Promise<void> {
    if (this.ready || this.starting) {
      logger.debug('CHROMA_SERVER', 'Server already started or starting', {
        ready: this.ready,
        starting: this.starting
      });
      return;
    }
    this.starting = true;

    // Cross-platform: use npx.cmd on Windows
    const isWindows = process.platform === 'win32';
    const command = isWindows ? 'npx.cmd' : 'npx';

    const args = [
      'chroma', 'run',
      '--path', this.config.dataDir,
      '--host', this.config.host,
      '--port', String(this.config.port)
    ];

    logger.info('CHROMA_SERVER', 'Starting Chroma server', {
      command,
      args: args.join(' '),
      dataDir: this.config.dataDir
    });

    this.serverProcess = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: !isWindows,  // Don't detach on Windows (no process groups)
      windowsHide: true      // Hide console window on Windows
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
  }

  /**
   * Wait for the server to become ready
   * Polls the heartbeat endpoint until success or timeout
   */
  async waitForReady(timeoutMs: number = 60000): Promise<boolean> {
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
          `http://${this.config.host}:${this.config.port}/api/v1/heartbeat`
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
   */
  isRunning(): boolean {
    return this.ready && this.serverProcess !== null;
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
