/**
 * Backup Service - Create and manage backups
 */

import { existsSync, mkdirSync, createWriteStream } from 'fs';
import { join, basename } from 'path';
import archiver from 'archiver';
import { paths } from '../utils/paths';

export interface BackupOptions {
  output?: string;
  databaseOnly?: boolean;
  settingsOnly?: boolean;
}

export interface BackupResult {
  success: boolean;
  path?: string;
  size?: number;
  error?: string;
  files: string[];
}

export class BackupService {
  private backupDir = paths.backupDir;

  /**
   * Create a backup
   */
  async createBackup(options: BackupOptions = {}): Promise<BackupResult> {
    try {
      // Ensure backup directory exists
      if (!existsSync(this.backupDir)) {
        mkdirSync(this.backupDir, { recursive: true });
      }

      // Generate filename
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const filename = `claude-mem-backup-${timestamp}.zip`;
      const outputPath = options.output || join(this.backupDir, filename);

      // Create archive
      const output = createWriteStream(outputPath);
      const archive = archiver('zip', { zlib: { level: 9 } });

      const files: string[] = [];

      archive.on('entry', (entry) => {
        files.push(entry.name);
      });

      await new Promise<void>((resolve, reject) => {
        output.on('close', resolve);
        archive.on('error', reject);
        archive.on('warning', (err) => {
          console.warn('Archive warning:', err.message);
        });

        archive.pipe(output);

        // Add database
        if (!options.settingsOnly && existsSync(paths.database)) {
          archive.file(paths.database, { name: 'database/claude-mem.db' });
        }

        // Add settings
        if (!options.databaseOnly) {
          if (existsSync(paths.claudeMemSettings)) {
            archive.file(paths.claudeMemSettings, { name: 'settings/settings.json' });
          }
          if (existsSync(paths.claudeSettings)) {
            archive.file(paths.claudeSettings, { name: 'settings/claude-settings.json' });
          }
        }

        archive.finalize();
      });

      const stats = require('fs').statSync(outputPath);

      return {
        success: true,
        path: outputPath,
        size: stats.size,
        files
      };
    } catch (error) {
      return {
        success: false,
        error: (error as Error).message,
        files: []
      };
    }
  }

  /**
   * List available backups
   */
  listBackups(): { name: string; date: Date; size: number }[] {
    if (!existsSync(this.backupDir)) return [];

    const { readdirSync, statSync } = require('fs');
    
    return readdirSync(this.backupDir)
      .filter((f: string) => f.endsWith('.zip'))
      .map((f: string) => {
        const path = join(this.backupDir, f);
        const stats = statSync(path);
        return {
          name: f,
          date: stats.mtime,
          size: stats.size
        };
      })
      .sort((a: any, b: any) => b.date.getTime() - a.date.getTime());
  }

  /**
   * Get backup path
   */
  getBackupPath(name: string): string {
    return join(this.backupDir, name);
  }
}

export const backupService = new BackupService();
