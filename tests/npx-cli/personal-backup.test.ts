import { describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { backupPersonalInstall } from '../../src/npx-cli/install/personal-backup.js';

describe('personal fork backup', () => {
  it('includes uncheckpointed WAL rows and protects configuration without changing its source', () => {
    const root = mkdtempSync(join(tmpdir(), 'mem-fork-backup-'));
    const data = join(root, 'memory');
    const config = join(root, 'claude');
    mkdirSync(data); mkdirSync(config);
    const db = new Database(join(data, 'claude-mem.db'));
    try {
      db.run('PRAGMA journal_mode=WAL');
      db.run('PRAGMA wal_autocheckpoint=0');
      db.run('CREATE TABLE observations (text TEXT)');
      db.run("INSERT INTO observations VALUES ('memory in WAL')");
      writeFileSync(join(data, '.env'), 'ANTHROPIC_AUTH_TOKEN=test-only\n');
      writeFileSync(join(config, 'settings.json'), '{"env":{"ANTHROPIC_BASE_URL":"http://localhost:8080"}}');
      const backup = backupPersonalInstall(data, config);
      const snapshot = new Database(join(backup, 'claude-mem.db'), { readonly: true });
      try { expect(snapshot.query('SELECT text FROM observations').get()).toEqual({ text: 'memory in WAL' }); }
      finally { snapshot.close(); }
      expect(readFileSync(join(backup, 'memory.env'), 'utf8')).toBe(readFileSync(join(data, '.env'), 'utf8'));
      expect(readFileSync(join(backup, 'claude-settings.json'), 'utf8')).toBe(readFileSync(join(config, 'settings.json'), 'utf8'));
      expect(statSync(backup).mode & 0o777).toBe(0o700);
      for (const name of ['claude-mem.db', 'memory.env', 'claude-settings.json']) expect(statSync(join(backup, name)).mode & 0o777).toBe(0o600);
      expect(db.query('SELECT COUNT(*) AS n FROM observations').get()).toEqual({ n: 1 });
    } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
  });
});
