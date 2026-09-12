/**
 * ToastNotifier: macOS native toast notifications for saved observations
 *
 * Responsibility:
 * - Send macOS native notifications when observations are saved
 * - Respect the CLAUDE_MEM_TOAST_NOTIFICATIONS_ENABLED setting (default: false)
 * - Fire-and-forget: never throw, never crash the pipeline
 * - macOS only (darwin platform check)
 */

import notifier from 'node-notifier';
import { logger } from '../../../utils/logger.js';
import { SettingsDefaultsManager } from '../../../shared/SettingsDefaultsManager.js';
import { USER_SETTINGS_PATH } from '../../../shared/paths.js';

/**
 * Send a macOS toast notification for a saved observation
 *
 * @param title - Observation title (nullable)
 * @param subtitle - Observation subtitle (nullable)
 */
export function sendObservationToast(title: string | null, subtitle: string | null): void {
  try {
    // macOS only
    if (process.platform !== 'darwin') {
      return;
    }

    // Check if toast notifications are enabled
    const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
    const settingValue = settings.CLAUDE_MEM_TOAST_NOTIFICATIONS_ENABLED;
    // Handle both string 'true' and boolean true from JSON settings
    if (settingValue !== 'true' && settingValue !== true) {
      return;
    }

    notifier.notify({
      title: title || 'Observation saved',
      message: subtitle || '',
      sound: false,
    });
  } catch (error) {
    logger.warn('TOAST', 'Failed to send toast notification', {
      title: title || '(untitled)',
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
