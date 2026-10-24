import { Database } from 'bun:sqlite';
import { chmodSync, copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

/** Snapshot live SQLite (including WAL rows) and private configuration before cutover. */
export function backupPersonalInstall(dataDir: string, claudeConfigDir: string): string {
  const destination = join(dataDir, 'backups', `personal-fork-${new Date().toISOString().replaceAll(':', '-')}`);
  mkdirSync(destination, { recursive: true, mode: 0o700 });
  chmodSync(destination, 0o700);
  const databasePath = join(dataDir, 'claude-mem.db');
  if (existsSync(databasePath)) {
    const database = new Database(databasePath, { readonly: true });
    try {
      const snapshotPath = join(destination, 'claude-mem.db');
      database.query('VACUUM INTO ?').run(snapshotPath);
      chmodSync(snapshotPath, 0o600);
    } finally {
      database.close();
    }
  }
  for (const [source, name] of [
    [join(dataDir, 'settings.json'), 'memory-settings.json'],
    [join(dataDir, '.env'), 'memory.env'],
    [join(claudeConfigDir, 'settings.json'), 'claude-settings.json'],
    [join(claudeConfigDir, 'plugins', 'known_marketplaces.json'), 'known_marketplaces.json'],
    [join(claudeConfigDir, 'plugins', 'installed_plugins.json'), 'installed_plugins.json'],
  ]) {
    if (!existsSync(source)) continue;
    const target = join(destination, name);
    copyFileSync(source, target);
    chmodSync(target, 0o600);
  }
  return destination;
}
