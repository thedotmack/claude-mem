/**
 * LaunchdManager - macOS launchd plist generation and service management
 *
 * Generates and manages a launchd plist for the claude-mem worker daemon.
 * Idempotent: safe to call on every `worker-service.cjs start`.
 *
 * Platform guard: all service management functions are no-ops on non-macOS platforms.
 */

import path from 'path';
import { homedir } from 'os';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { execSync } from 'child_process';
import { logger } from '../../utils/logger.js';

export interface LaunchdConfig {
  label: string;           // 'com.claude-mem.worker'
  executablePath: string;  // path to bun/node
  scriptPath: string;      // path to worker-service.cjs
  port: number;            // 37777
  dataDir: string;         // ~/.claude-mem
}

const LAUNCH_AGENTS_DIR = path.join(homedir(), 'Library', 'LaunchAgents');

/**
 * Resolve the plist file path for a given service label.
 */
function getPlistPath(label: string): string {
  return path.join(LAUNCH_AGENTS_DIR, `${label}.plist`);
}

/**
 * Generate plist XML content from a LaunchdConfig.
 *
 * The generated plist:
 * - Runs the worker daemon at login (RunAtLoad)
 * - Keeps it alive via launchd restart (KeepAlive)
 * - Redirects stdout/stderr to log files under dataDir/logs/
 * - Sets CLAUDE_MEM_WORKER_PORT in the environment
 */
export function generatePlist(config: LaunchdConfig): string {
  const { label, executablePath, scriptPath, port, dataDir } = config;
  const stdoutLog = path.join(dataDir, 'logs', 'worker-stdout.log');
  const stderrLog = path.join(dataDir, 'logs', 'worker-stderr.log');

  // Build PATH that includes Homebrew and bun — launchd starts with a
  // minimal PATH (/usr/bin:/bin:/usr/sbin:/sbin) so tools like node, bun,
  // and claude are invisible without this.
  const homeDir = homedir();
  const launchdPath = [
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin',
    path.join(homeDir, '.bun', 'bin'),
  ].join(':');

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${executablePath}</string>
    <string>${scriptPath}</string>
    <string>--daemon</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${stdoutLog}</string>
  <key>StandardErrorPath</key><string>${stderrLog}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>CLAUDE_MEM_WORKER_PORT</key><string>${port}</string>
    <key>PATH</key><string>${launchdPath}</string>
    <key>HOME</key><string>${homeDir}</string>
  </dict>
</dict>
</plist>
`;
}

/**
 * Check if a launchd service is currently loaded.
 *
 * Uses `launchctl list <label>` — exit code 0 means loaded.
 * Returns false if the command fails (not loaded, or launchctl unavailable).
 */
export function isServiceLoaded(label: string): boolean {
  try {
    execSync(`launchctl list ${label}`, {
      stdio: ['ignore', 'ignore', 'ignore']
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Ensure the launchd service is installed and running.
 *
 * Idempotent state machine:
 * 1. Generate expected plist content
 * 2. Compare with existing file at ~/Library/LaunchAgents/{label}.plist
 * 3. If identical + loaded    → no-op
 * 4. If identical + not loaded → launchctl load
 * 5. If different             → unload old + write new + load
 * 6. If absent                → write + load
 *
 * No-op on non-macOS platforms.
 */
export async function ensureLaunchdService(config: LaunchdConfig): Promise<void> {
  if (process.platform !== 'darwin') {
    logger.debug('SYSTEM', 'LaunchdManager: skipping on non-macOS platform', { platform: process.platform });
    return;
  }

  const { label, dataDir } = config;
  const plistPath = getPlistPath(label);
  const expectedContent = generatePlist(config);

  // Ensure ~/Library/LaunchAgents/ exists
  mkdirSync(LAUNCH_AGENTS_DIR, { recursive: true });

  // Ensure log directory exists
  mkdirSync(path.join(dataDir, 'logs'), { recursive: true });

  const alreadyLoaded = isServiceLoaded(label);

  if (existsSync(plistPath)) {
    const existingContent = readFileSync(plistPath, 'utf-8');

    if (existingContent === expectedContent) {
      // Plist is identical
      if (alreadyLoaded) {
        // Case 3: identical + loaded → no-op
        logger.debug('SYSTEM', 'LaunchdManager: service already loaded and up to date', { label });
        return;
      }

      // Case 4: identical + not loaded → just load
      logger.info('SYSTEM', 'LaunchdManager: loading existing plist (was not loaded)', { label, plistPath });
      _launchctlLoad(plistPath);
      return;
    }

    // Case 5: different → unload old, write new, load
    logger.info('SYSTEM', 'LaunchdManager: plist changed, reloading service', { label, plistPath });
    if (alreadyLoaded) {
      _launchctlUnload(plistPath);
    }
    writeFileSync(plistPath, expectedContent, 'utf-8');
    _launchctlLoad(plistPath);
    return;
  }

  // Case 6: absent → write + load
  logger.info('SYSTEM', 'LaunchdManager: installing new launchd service', { label, plistPath });
  writeFileSync(plistPath, expectedContent, 'utf-8');
  _launchctlLoad(plistPath);
}

/**
 * Remove the launchd service (when switching away from server mode).
 *
 * Unloads the service if loaded, then removes the plist file.
 * No-op on non-macOS platforms or if the service is not installed.
 */
export async function removeLaunchdService(label: string): Promise<void> {
  if (process.platform !== 'darwin') {
    logger.debug('SYSTEM', 'LaunchdManager: skipping on non-macOS platform', { platform: process.platform });
    return;
  }

  const plistPath = getPlistPath(label);

  if (!existsSync(plistPath)) {
    logger.debug('SYSTEM', 'LaunchdManager: plist not found, nothing to remove', { label, plistPath });
    return;
  }

  if (isServiceLoaded(label)) {
    logger.info('SYSTEM', 'LaunchdManager: unloading service before removal', { label });
    _launchctlUnload(plistPath);
  }

  try {
    const { unlinkSync } = await import('fs');
    unlinkSync(plistPath);
    logger.info('SYSTEM', 'LaunchdManager: plist removed', { label, plistPath });
  } catch (error) {
    logger.warn('SYSTEM', 'LaunchdManager: failed to remove plist file', { label, plistPath }, error as Error);
  }
}

// ---------------------------------------------------------------------------
// Internal helpers — thin wrappers around launchctl for testability
// ---------------------------------------------------------------------------

function _launchctlLoad(plistPath: string): void {
  try {
    execSync(`launchctl load "${plistPath}"`, { stdio: 'ignore' });
    logger.info('SYSTEM', 'LaunchdManager: launchctl load succeeded', { plistPath });
  } catch (error) {
    logger.error('SYSTEM', 'LaunchdManager: launchctl load failed', { plistPath }, error as Error);
    throw error;
  }
}

function _launchctlUnload(plistPath: string): void {
  try {
    execSync(`launchctl unload "${plistPath}"`, { stdio: 'ignore' });
    logger.info('SYSTEM', 'LaunchdManager: launchctl unload succeeded', { plistPath });
  } catch (error) {
    // Unload failure is non-fatal (service may already be unloaded)
    logger.warn('SYSTEM', 'LaunchdManager: launchctl unload failed (non-fatal)', { plistPath }, error as Error);
  }
}
