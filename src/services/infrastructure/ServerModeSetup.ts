/**
 * ServerModeSetup - Server mode initialization logic
 *
 * Extracted from worker-service.ts so it can be unit-tested without
 * pulling in the entire worker-service dependency chain (DB, MCP, agents).
 *
 * Responsibilities:
 * - Auto-generate CLAUDE_MEM_AUTH_TOKEN when missing
 * - Change bind address from 127.0.0.1 to 0.0.0.0
 * - Install/update launchd service on macOS
 */

import path from 'path';
import { readFileSync, writeFileSync } from 'fs';
import { randomBytes } from 'crypto';
import { logger } from '../../utils/logger.js';
import { clearPortCache, getWorkerPort } from '../../shared/worker-utils.js';
import { ensureLaunchdService } from './LaunchdManager.js';
import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';

/**
 * Prepare settings for server mode:
 * - Auto-generate auth token if missing
 * - Change bind address from 127.0.0.1 to 0.0.0.0
 * - Install/update launchd service on macOS
 *
 * @param settingsPath  Override for the settings file path (used in tests).
 *                      Defaults to ~/.claude-mem/settings.json.
 * @param workerScript  The worker script path for launchd registration.
 *                      Required on macOS for launchd service setup.
 */
export async function ensureServerModeReady(
  settingsPath?: string,
  workerScript?: string
): Promise<void> {
  const resolvedPath = settingsPath ?? path.join(SettingsDefaultsManager.get('CLAUDE_MEM_DATA_DIR'), 'settings.json');
  const raw = readFileSync(resolvedPath, 'utf-8');
  const settings = JSON.parse(raw);
  let changed = false;

  // Auto-generate auth token if empty
  if (!settings.CLAUDE_MEM_AUTH_TOKEN) {
    settings.CLAUDE_MEM_AUTH_TOKEN = randomBytes(32).toString('hex');
    changed = true;
    logger.info('SYSTEM', 'Auto-generated auth token for server mode', {
      tokenPreview: settings.CLAUDE_MEM_AUTH_TOKEN.substring(0, 8) + '...',
      note: 'Full token saved in settings.json — copy to client machines'
    });
  }

  // Ensure bind address is 0.0.0.0 (not localhost)
  if (!settings.CLAUDE_MEM_WORKER_HOST || settings.CLAUDE_MEM_WORKER_HOST === '127.0.0.1') {
    settings.CLAUDE_MEM_WORKER_HOST = '0.0.0.0';
    changed = true;
    logger.info('SYSTEM', 'Server mode: changed bind address from 127.0.0.1 to 0.0.0.0');
  }

  if (changed) {
    writeFileSync(resolvedPath, JSON.stringify(settings, null, 2));
    clearPortCache(); // Force re-read of host/port from updated settings
  }

  // Setup launchd on macOS
  if (process.platform === 'darwin') {
    if (!workerScript) {
      logger.warn('SYSTEM', 'workerScript not provided — skipping launchd setup');
      return;
    }
    const scriptPath = workerScript;
    await ensureLaunchdService({
      label: 'com.claude-mem.worker',
      executablePath: process.execPath,
      scriptPath,
      port: getWorkerPort(),
      dataDir: SettingsDefaultsManager.get('CLAUDE_MEM_DATA_DIR')
    });
  }
}
