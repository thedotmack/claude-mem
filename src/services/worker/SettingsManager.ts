
import { DatabaseManager } from './DatabaseManager.js';
import { logger } from '../../utils/logger.js';
import type { ViewerSettings } from '../worker-types.js';

export class SettingsManager {
  private dbManager: DatabaseManager;
  private readonly defaultSettings: ViewerSettings = {
    sidebarOpen: true,
    selectedProject: null,
    theme: 'system'
  };

  constructor(dbManager: DatabaseManager) {
    this.dbManager = dbManager;
  }

  getSettings(): ViewerSettings {
    const db = this.dbManager.getSessionStore().db;

    try {
      const stmt = db.prepare('SELECT key, value FROM viewer_settings');
      const rows = stmt.all() as Array<{ key: string; value: string }>;

      const settings: ViewerSettings = { ...this.defaultSettings };
      for (const row of rows) {
        const key = row.key as keyof ViewerSettings;
        if (key in settings) {
          Object.assign(settings, { [key]: JSON.parse(row.value) });
        }
      }

      return settings;
    } catch (error) {
      if (error instanceof Error) {
        logger.debug('WORKER', 'Failed to load settings, using defaults', {}, error);
      } else {
        logger.debug('WORKER', 'Failed to load settings, using defaults', { rawError: String(error) });
      }
      return { ...this.defaultSettings };
    }
  }

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
