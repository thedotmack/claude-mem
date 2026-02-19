/**
 * LitestreamManager
 *
 * Singleton that manages the Litestream child process lifecycle:
 * - Auto-downloads the Litestream binary if missing
 * - Generates litestream.yml from user settings
 * - Starts/stops the `litestream replicate` subprocess
 * - Exposes status and point-in-time restore
 */

import { ChildProcess, spawn, execFile } from 'child_process';
import { existsSync, writeFileSync, chmodSync, unlinkSync } from 'fs';
import { join, dirname } from 'path';
import { arch, platform } from 'os';
import {
  LITESTREAM_DIR,
  LITESTREAM_CONFIG_PATH,
  LITESTREAM_BINARY_DIR,
  DB_PATH,
  ensureDir
} from '../../shared/paths.js';
import { SettingsDefaultsManager, SettingsDefaults } from '../../shared/SettingsDefaultsManager.js';
import { USER_SETTINGS_PATH } from '../../shared/paths.js';
import { logger } from '../../utils/logger.js';

const LITESTREAM_VERSION = '0.3.13';

export interface BackupStatus {
  enabled: boolean;
  running: boolean;
  provider: string;
  bucket: string;
  path: string;
  pid: number | null;
  error: string | null;
}

export class LitestreamManager {
  private static instance: LitestreamManager | null = null;

  private process: ChildProcess | null = null;
  private lastError: string | null = null;

  private constructor() {}

  static getInstance(): LitestreamManager {
    if (!LitestreamManager.instance) {
      LitestreamManager.instance = new LitestreamManager();
    }
    return LitestreamManager.instance;
  }

  /**
   * Start Litestream replication if backup is enabled in settings.
   * Called after DB initialization in the worker lifecycle.
   */
  async start(): Promise<void> {
    const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);

    if (settings.CLAUDE_MEM_BACKUP_ENABLED !== 'true') {
      logger.info('BACKUP', 'Cloud backup disabled (CLAUDE_MEM_BACKUP_ENABLED != true)');
      return;
    }

    if (!settings.CLAUDE_MEM_BACKUP_BUCKET) {
      logger.warn('BACKUP', 'Cloud backup enabled but CLAUDE_MEM_BACKUP_BUCKET is empty, skipping');
      return;
    }

    try {
      // Ensure directories
      ensureDir(LITESTREAM_DIR);
      ensureDir(LITESTREAM_BINARY_DIR);

      // Install binary if needed
      const binaryPath = this.getBinaryPath();
      if (!existsSync(binaryPath)) {
        logger.info('BACKUP', 'Litestream binary not found, downloading...');
        await this.downloadBinary();
      }

      // Generate config
      this.writeConfig(settings);

      // Start replication
      this.spawnReplicate(binaryPath);
      logger.info('BACKUP', 'Litestream replication started', {
        provider: settings.CLAUDE_MEM_BACKUP_PROVIDER,
        bucket: settings.CLAUDE_MEM_BACKUP_BUCKET,
        path: settings.CLAUDE_MEM_BACKUP_PATH,
      });
    } catch (error) {
      this.lastError = (error as Error).message;
      logger.error('BACKUP', 'Failed to start Litestream', {}, error as Error);
    }
  }

  /**
   * Stop the Litestream child process gracefully.
   */
  async stop(): Promise<void> {
    if (!this.process) return;

    return new Promise<void>((resolve) => {
      const proc = this.process!;
      const timeout = setTimeout(() => {
        proc.kill('SIGKILL');
        resolve();
      }, 5000);

      proc.once('exit', () => {
        clearTimeout(timeout);
        this.process = null;
        logger.info('BACKUP', 'Litestream stopped');
        resolve();
      });

      proc.kill('SIGTERM');
    });
  }

  /**
   * Restore the database from the latest cloud replica.
   * The worker should be stopped (or at least the DB closed) before calling this.
   */
  async restore(targetPath?: string): Promise<{ success: boolean; message: string }> {
    const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);

    if (!settings.CLAUDE_MEM_BACKUP_BUCKET) {
      return { success: false, message: 'CLAUDE_MEM_BACKUP_BUCKET is not configured' };
    }

    const binaryPath = this.getBinaryPath();
    if (!existsSync(binaryPath)) {
      return { success: false, message: 'Litestream binary not installed. Enable backup first.' };
    }

    this.writeConfig(settings);

    const restoreTo = targetPath || DB_PATH;

    try {
      const env = this.buildEnv(settings);
      await new Promise<void>((resolve, reject) => {
        execFile(binaryPath, [
          'restore',
          '-config', LITESTREAM_CONFIG_PATH,
          '-o', restoreTo,
          DB_PATH
        ], {
          env: { ...process.env, ...env },
          timeout: 120_000,
        }, (error) => {
          if (error) reject(error);
          else resolve();
        });
      });

      return { success: true, message: `Database restored to ${restoreTo}` };
    } catch (error) {
      const msg = (error as Error).message;
      logger.error('BACKUP', 'Restore failed', {}, error as Error);
      return { success: false, message: msg };
    }
  }

  /**
   * Return current backup status.
   */
  getStatus(): BackupStatus {
    const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
    const enabled = settings.CLAUDE_MEM_BACKUP_ENABLED === 'true';

    return {
      enabled,
      running: this.process !== null && this.process.exitCode === null,
      provider: settings.CLAUDE_MEM_BACKUP_PROVIDER,
      bucket: settings.CLAUDE_MEM_BACKUP_BUCKET,
      path: settings.CLAUDE_MEM_BACKUP_PATH,
      pid: this.process?.pid ?? null,
      error: this.lastError,
    };
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private getBinaryPath(): string {
    const ext = platform() === 'win32' ? '.exe' : '';
    return join(LITESTREAM_BINARY_DIR, `litestream${ext}`);
  }

  /**
   * Download and extract the Litestream binary for the current platform.
   */
  private async downloadBinary(): Promise<void> {
    const os = platform();
    const cpuArch = arch();

    let osStr: string;
    let archStr: string;
    let ext: string;

    switch (os) {
      case 'linux':   osStr = 'linux'; break;
      case 'darwin':  osStr = 'darwin'; break;
      case 'win32':   osStr = 'windows'; break;
      default: throw new Error(`Unsupported platform: ${os}`);
    }

    switch (cpuArch) {
      case 'x64':   archStr = 'amd64'; break;
      case 'arm64': archStr = 'arm64'; break;
      default: throw new Error(`Unsupported architecture: ${cpuArch}`);
    }

    ext = os === 'win32' ? 'zip' : 'tar.gz';
    const filename = `litestream-v${LITESTREAM_VERSION}-${osStr}-${archStr}.${ext}`;
    const url = `https://github.com/benbjohnson/litestream/releases/download/v${LITESTREAM_VERSION}/${filename}`;

    logger.info('BACKUP', `Downloading Litestream from ${url}`);

    // Use fetch (available in Node 18+ / Bun)
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to download Litestream: HTTP ${response.status}`);
    }

    const tmpFile = join(LITESTREAM_DIR, filename);

    // Write to disk
    const arrayBuf = await response.arrayBuffer();
    writeFileSync(tmpFile, Buffer.from(arrayBuf));

    // Extract (async to avoid blocking event loop)
    await new Promise<void>((resolve, reject) => {
      const args = ext === 'tar.gz'
        ? ['tar', ['xzf', tmpFile, '-C', LITESTREAM_BINARY_DIR]]
        : ['unzip', ['-o', tmpFile, '-d', LITESTREAM_BINARY_DIR]];
      const proc = spawn(args[0] as string, args[1] as string[], { stdio: 'pipe' });
      proc.on('close', (code) => code === 0 ? resolve() : reject(new Error(`${args[0]} exited with code ${code}`)));
      proc.on('error', reject);
    });

    // Make executable on Unix
    if (os !== 'win32') {
      chmodSync(this.getBinaryPath(), 0o755);
    }

    // Cleanup archive
    try { unlinkSync(tmpFile); } catch { /* best-effort */ }

    logger.info('BACKUP', 'Litestream binary installed', { path: this.getBinaryPath() });
  }

  /**
   * Write litestream.yml config from user settings.
   */
  private writeConfig(settings: SettingsDefaults): void {
    const provider = settings.CLAUDE_MEM_BACKUP_PROVIDER;
    const bucket = settings.CLAUDE_MEM_BACKUP_BUCKET;
    const pathPrefix = settings.CLAUDE_MEM_BACKUP_PATH;
    const endpoint = settings.CLAUDE_MEM_BACKUP_ENDPOINT;
    const region = settings.CLAUDE_MEM_BACKUP_REGION;

    let replicaUrl: string;
    let extraYaml = '';

    switch (provider) {
      case 'gcs':
        replicaUrl = `gcs://${bucket}/${pathPrefix}`;
        break;
      case 's3':
        replicaUrl = `s3://${bucket}/${pathPrefix}`;
        if (endpoint) {
          extraYaml += `      endpoint: "${endpoint}"\n`;
        }
        if (region) {
          extraYaml += `      region: "${region}"\n`;
        }
        break;
      case 'abs':
        replicaUrl = `abs://${bucket}/${pathPrefix}`;
        break;
      case 'sftp':
        replicaUrl = `sftp://${bucket}/${pathPrefix}`;
        break;
      default:
        replicaUrl = `gcs://${bucket}/${pathPrefix}`;
    }

    const yaml = `# Auto-generated by claude-mem LitestreamManager
# Do not edit manually — changes will be overwritten on next start.
dbs:
  - path: "${DB_PATH}"
    replicas:
      - url: "${replicaUrl}"
${extraYaml}`;

    ensureDir(dirname(LITESTREAM_CONFIG_PATH));
    writeFileSync(LITESTREAM_CONFIG_PATH, yaml, 'utf-8');
    logger.debug('BACKUP', 'Wrote litestream config', { path: LITESTREAM_CONFIG_PATH });
  }

  /**
   * Build environment variables for Litestream based on the provider.
   */
  private buildEnv(settings: SettingsDefaults): Record<string, string> {
    const env: Record<string, string> = {};

    switch (settings.CLAUDE_MEM_BACKUP_PROVIDER) {
      case 'gcs':
        if (settings.CLAUDE_MEM_BACKUP_GCS_CREDENTIALS_PATH) {
          env.GOOGLE_APPLICATION_CREDENTIALS = settings.CLAUDE_MEM_BACKUP_GCS_CREDENTIALS_PATH;
        }
        break;
      case 's3':
        if (settings.CLAUDE_MEM_BACKUP_ACCESS_KEY_ID) {
          env.AWS_ACCESS_KEY_ID = settings.CLAUDE_MEM_BACKUP_ACCESS_KEY_ID;
        }
        if (settings.CLAUDE_MEM_BACKUP_SECRET_ACCESS_KEY) {
          env.AWS_SECRET_ACCESS_KEY = settings.CLAUDE_MEM_BACKUP_SECRET_ACCESS_KEY;
        }
        break;
      case 'abs':
        // Azure uses AZURE_STORAGE_ACCOUNT / AZURE_STORAGE_KEY (user sets via env directly)
        break;
    }

    return env;
  }

  /**
   * Spawn `litestream replicate` as a child process.
   */
  private spawnReplicate(binaryPath: string): void {
    const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
    const env = this.buildEnv(settings);

    this.process = spawn(binaryPath, [
      'replicate',
      '-config', LITESTREAM_CONFIG_PATH,
    ], {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false,
    });

    this.lastError = null;

    this.process.stdout?.on('data', (data: Buffer) => {
      logger.debug('BACKUP', data.toString().trim());
    });

    this.process.stderr?.on('data', (data: Buffer) => {
      const msg = data.toString().trim();
      if (msg) {
        this.lastError = msg;
        logger.warn('BACKUP', `Litestream stderr: ${msg}`);
      }
    });

    this.process.on('exit', (code, signal) => {
      logger.info('BACKUP', 'Litestream process exited', { code, signal });
      this.process = null;
    });
  }
}
