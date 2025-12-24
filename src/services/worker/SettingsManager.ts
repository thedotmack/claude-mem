/**
 * SettingsManager: DRY settings CRUD utility
 *
 * Responsibility:
 * - DRY helper for viewer settings CRUD
 * - Eliminates duplication in settings read/write logic
 * - Type-safe settings management
 */

import { DatabaseManager } from './DatabaseManager.js';
import { logger } from '../../utils/logger.js';
import type { ViewerSettings } from '../worker-types.js';

export class SettingsManager {
  private dbManager: DatabaseManager;
  private readonly defaultSettings: ViewerSettings = {
    sidebarOpen: true,
    selectedProject: null,
    theme: 'system',
    // Surprise filtering defaults (Phase 2: Titans concepts)
    surpriseEnabled: true,
    surpriseThreshold: 0.3,      // Filter out observations with < 30% surprise
    surpriseLookbackDays: 30,    // Compare against last 30 days
    momentumEnabled: true,
    momentumDurationMinutes: 5,  // Boost topics for 5 minutes after high surprise
  };

  constructor(dbManager: DatabaseManager) {
    this.dbManager = dbManager;
  }

  /**
   * Get current viewer settings (with defaults)
   */
  getSettings(): ViewerSettings {
    const db = this.dbManager.getSessionStore().db;

    try {
      const stmt = db.prepare('SELECT key, value FROM viewer_settings');
      const rows = stmt.all() as Array<{ key: string; value: string }>;

      const settings: ViewerSettings = { ...this.defaultSettings };
      for (const row of rows) {
        const key = row.key as keyof ViewerSettings;
        if (key in settings) {
          settings[key] = JSON.parse(row.value) as ViewerSettings[typeof key];
        }
      }

      return settings;
    } catch (error) {
      logger.debug('WORKER', 'Failed to load settings, using defaults', {}, error as Error);
      return { ...this.defaultSettings };
    }
  }

  /**
   * Update viewer settings (partial update)
   */
  updateSettings(updates: Partial<ViewerSettings>): ViewerSettings {
    const db = this.dbManager.getSessionStore().db;

    const stmt = db.prepare(`
      INSERT OR REPLACE INTO viewer_settings (key, value)
      VALUES (?, ?)
    `);

    for (const [key, value] of Object.entries(updates)) {
      stmt.run(key, JSON.stringify(value));
    }

    return this.getSettings();
  }
}
