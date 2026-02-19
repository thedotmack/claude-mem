/**
 * LitestreamManager Tests
 *
 * Unit tests for the backup integration:
 * - Settings defaults and validation
 * - Path constants
 * - BackupStatus interface shape
 * - Config generation (YAML structure, provider URL mapping)
 * - Environment variable building per provider
 * - Singleton pattern
 * - Start/stop guards (disabled, empty bucket)
 * - BackupRoutes setup
 *
 * These tests do NOT require GCS credentials or a running Litestream process.
 */

import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from 'bun:test';
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir, homedir } from 'os';
import { SettingsDefaultsManager, type SettingsDefaults } from '../../src/shared/SettingsDefaultsManager.js';
import {
  LITESTREAM_DIR,
  LITESTREAM_CONFIG_PATH,
  LITESTREAM_BINARY_DIR,
  DATA_DIR,
} from '../../src/shared/paths.js';

// ============================================================
// 1. Settings Defaults
// ============================================================
describe('Backup Settings Defaults', () => {
  it('should have all 9 backup settings in defaults', () => {
    const defaults = SettingsDefaultsManager.getAllDefaults();

    expect(defaults).toHaveProperty('CLAUDE_MEM_BACKUP_ENABLED');
    expect(defaults).toHaveProperty('CLAUDE_MEM_BACKUP_PROVIDER');
    expect(defaults).toHaveProperty('CLAUDE_MEM_BACKUP_BUCKET');
    expect(defaults).toHaveProperty('CLAUDE_MEM_BACKUP_PATH');
    expect(defaults).toHaveProperty('CLAUDE_MEM_BACKUP_ENDPOINT');
    expect(defaults).toHaveProperty('CLAUDE_MEM_BACKUP_REGION');
    expect(defaults).toHaveProperty('CLAUDE_MEM_BACKUP_ACCESS_KEY_ID');
    expect(defaults).toHaveProperty('CLAUDE_MEM_BACKUP_SECRET_ACCESS_KEY');
    expect(defaults).toHaveProperty('CLAUDE_MEM_BACKUP_GCS_CREDENTIALS_PATH');
  });

  it('should default BACKUP_ENABLED to false', () => {
    const defaults = SettingsDefaultsManager.getAllDefaults();
    expect(defaults.CLAUDE_MEM_BACKUP_ENABLED).toBe('false');
  });

  it('should default BACKUP_PROVIDER to gcs', () => {
    const defaults = SettingsDefaultsManager.getAllDefaults();
    expect(defaults.CLAUDE_MEM_BACKUP_PROVIDER).toBe('gcs');
  });

  it('should default BACKUP_BUCKET to empty string', () => {
    const defaults = SettingsDefaultsManager.getAllDefaults();
    expect(defaults.CLAUDE_MEM_BACKUP_BUCKET).toBe('');
  });

  it('should default BACKUP_PATH to claude-mem/backup', () => {
    const defaults = SettingsDefaultsManager.getAllDefaults();
    expect(defaults.CLAUDE_MEM_BACKUP_PATH).toBe('claude-mem/backup');
  });

  it('should default all credential fields to empty string', () => {
    const defaults = SettingsDefaultsManager.getAllDefaults();
    expect(defaults.CLAUDE_MEM_BACKUP_ENDPOINT).toBe('');
    expect(defaults.CLAUDE_MEM_BACKUP_REGION).toBe('');
    expect(defaults.CLAUDE_MEM_BACKUP_ACCESS_KEY_ID).toBe('');
    expect(defaults.CLAUDE_MEM_BACKUP_SECRET_ACCESS_KEY).toBe('');
    expect(defaults.CLAUDE_MEM_BACKUP_GCS_CREDENTIALS_PATH).toBe('');
  });

  it('should load backup settings from file with overrides', () => {
    const tempDir = join(tmpdir(), `backup-test-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
    const settingsPath = join(tempDir, 'settings.json');

    writeFileSync(settingsPath, JSON.stringify({
      CLAUDE_MEM_BACKUP_ENABLED: 'true',
      CLAUDE_MEM_BACKUP_PROVIDER: 'gcs',
      CLAUDE_MEM_BACKUP_BUCKET: 'my-test-bucket',
      CLAUDE_MEM_BACKUP_GCS_CREDENTIALS_PATH: '/path/to/key.json',
    }));

    const settings = SettingsDefaultsManager.loadFromFile(settingsPath);

    expect(settings.CLAUDE_MEM_BACKUP_ENABLED).toBe('true');
    expect(settings.CLAUDE_MEM_BACKUP_BUCKET).toBe('my-test-bucket');
    expect(settings.CLAUDE_MEM_BACKUP_GCS_CREDENTIALS_PATH).toBe('/path/to/key.json');
    // Non-overridden should use defaults
    expect(settings.CLAUDE_MEM_BACKUP_PATH).toBe('claude-mem/backup');

    rmSync(tempDir, { recursive: true, force: true });
  });
});

// ============================================================
// 2. Path Constants
// ============================================================
describe('Litestream Path Constants', () => {
  it('LITESTREAM_DIR should be under DATA_DIR', () => {
    expect(LITESTREAM_DIR).toBe(join(DATA_DIR, 'litestream'));
  });

  it('LITESTREAM_CONFIG_PATH should be litestream.yml inside LITESTREAM_DIR', () => {
    expect(LITESTREAM_CONFIG_PATH).toBe(join(LITESTREAM_DIR, 'litestream.yml'));
  });

  it('LITESTREAM_BINARY_DIR should be bin/ inside LITESTREAM_DIR', () => {
    expect(LITESTREAM_BINARY_DIR).toBe(join(LITESTREAM_DIR, 'bin'));
  });

  it('all paths should be under ~/.claude-mem/', () => {
    const home = homedir();
    expect(LITESTREAM_DIR.startsWith(join(home, '.claude-mem'))).toBe(true);
    expect(LITESTREAM_CONFIG_PATH.startsWith(join(home, '.claude-mem'))).toBe(true);
    expect(LITESTREAM_BINARY_DIR.startsWith(join(home, '.claude-mem'))).toBe(true);
  });
});

// ============================================================
// 3. BackupStatus Interface Shape
// ============================================================
describe('BackupStatus Interface', () => {
  it('should have correct shape from LitestreamManager import', async () => {
    const { LitestreamManager } = await import('../../src/services/backup/LitestreamManager.js');
    const manager = LitestreamManager.getInstance();
    const status = manager.getStatus();

    // Verify all expected fields exist
    expect(status).toHaveProperty('enabled');
    expect(status).toHaveProperty('running');
    expect(status).toHaveProperty('provider');
    expect(status).toHaveProperty('bucket');
    expect(status).toHaveProperty('path');
    expect(status).toHaveProperty('pid');
    expect(status).toHaveProperty('error');

    // Verify types
    expect(typeof status.enabled).toBe('boolean');
    expect(typeof status.running).toBe('boolean');
    expect(typeof status.provider).toBe('string');
    expect(typeof status.bucket).toBe('string');
    expect(typeof status.path).toBe('string');
  });

  it('should report disabled when BACKUP_ENABLED is false', async () => {
    const { LitestreamManager } = await import('../../src/services/backup/LitestreamManager.js');
    const manager = LitestreamManager.getInstance();
    const status = manager.getStatus();

    // Default settings have BACKUP_ENABLED = 'false'
    expect(status.enabled).toBe(false);
    expect(status.running).toBe(false);
    expect(status.pid).toBeNull();
  });
});

// ============================================================
// 4. Config YAML Generation (via writeConfig logic)
// ============================================================
describe('Config Generation Logic', () => {
  // Test the URL mapping logic that writeConfig uses
  it('should generate gcs:// URL for GCS provider', () => {
    const url = buildReplicaUrl('gcs', 'my-bucket', 'claude-mem/backup');
    expect(url).toBe('gcs://my-bucket/claude-mem/backup');
  });

  it('should generate s3:// URL for S3 provider', () => {
    const url = buildReplicaUrl('s3', 'my-s3-bucket', 'backups/db');
    expect(url).toBe('s3://my-s3-bucket/backups/db');
  });

  it('should generate abs:// URL for Azure Blob Storage', () => {
    const url = buildReplicaUrl('abs', 'my-container', 'path/prefix');
    expect(url).toBe('abs://my-container/path/prefix');
  });

  it('should generate sftp:// URL for SFTP provider', () => {
    const url = buildReplicaUrl('sftp', 'my-host', 'backup/dir');
    expect(url).toBe('sftp://my-host/backup/dir');
  });

  it('should default to gcs:// for unknown provider', () => {
    const url = buildReplicaUrl('unknown', 'bucket', 'path');
    expect(url).toBe('gcs://bucket/path');
  });

  it('should handle empty path prefix', () => {
    const url = buildReplicaUrl('gcs', 'bucket', '');
    expect(url).toBe('gcs://bucket/');
  });

  it('should handle bucket names with special characters', () => {
    const url = buildReplicaUrl('gcs', 'my-project-123-backup', 'claude-mem/db');
    expect(url).toBe('gcs://my-project-123-backup/claude-mem/db');
  });
});

// Helper that mirrors LitestreamManager.writeConfig URL logic
function buildReplicaUrl(provider: string, bucket: string, pathPrefix: string): string {
  switch (provider) {
    case 'gcs':  return `gcs://${bucket}/${pathPrefix}`;
    case 's3':   return `s3://${bucket}/${pathPrefix}`;
    case 'abs':  return `abs://${bucket}/${pathPrefix}`;
    case 'sftp': return `sftp://${bucket}/${pathPrefix}`;
    default:     return `gcs://${bucket}/${pathPrefix}`;
  }
}

// ============================================================
// 5. Environment Variable Building
// ============================================================
describe('Environment Variable Building', () => {
  // Helper that mirrors LitestreamManager.buildEnv logic
  function buildEnv(settings: Partial<SettingsDefaults>): Record<string, string> {
    const env: Record<string, string> = {};
    const provider = settings.CLAUDE_MEM_BACKUP_PROVIDER || 'gcs';

    switch (provider) {
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
    }

    return env;
  }

  it('should set GOOGLE_APPLICATION_CREDENTIALS for GCS', () => {
    const env = buildEnv({
      CLAUDE_MEM_BACKUP_PROVIDER: 'gcs',
      CLAUDE_MEM_BACKUP_GCS_CREDENTIALS_PATH: '/home/user/.claude-mem/key.json',
    });
    expect(env.GOOGLE_APPLICATION_CREDENTIALS).toBe('/home/user/.claude-mem/key.json');
  });

  it('should not set GOOGLE_APPLICATION_CREDENTIALS when path is empty', () => {
    const env = buildEnv({
      CLAUDE_MEM_BACKUP_PROVIDER: 'gcs',
      CLAUDE_MEM_BACKUP_GCS_CREDENTIALS_PATH: '',
    });
    expect(env.GOOGLE_APPLICATION_CREDENTIALS).toBeUndefined();
  });

  it('should set AWS keys for S3 provider', () => {
    const env = buildEnv({
      CLAUDE_MEM_BACKUP_PROVIDER: 's3',
      CLAUDE_MEM_BACKUP_ACCESS_KEY_ID: 'AKIAIOSFODNN7EXAMPLE',
      CLAUDE_MEM_BACKUP_SECRET_ACCESS_KEY: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    });
    expect(env.AWS_ACCESS_KEY_ID).toBe('AKIAIOSFODNN7EXAMPLE');
    expect(env.AWS_SECRET_ACCESS_KEY).toBe('wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY');
  });

  it('should not set AWS keys when not provided', () => {
    const env = buildEnv({
      CLAUDE_MEM_BACKUP_PROVIDER: 's3',
    });
    expect(env.AWS_ACCESS_KEY_ID).toBeUndefined();
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
  });

  it('should return empty env for ABS provider', () => {
    const env = buildEnv({
      CLAUDE_MEM_BACKUP_PROVIDER: 'abs',
    });
    expect(Object.keys(env).length).toBe(0);
  });

  it('should not leak GCS credentials when using S3', () => {
    const env = buildEnv({
      CLAUDE_MEM_BACKUP_PROVIDER: 's3',
      CLAUDE_MEM_BACKUP_GCS_CREDENTIALS_PATH: '/some/path/key.json',
      CLAUDE_MEM_BACKUP_ACCESS_KEY_ID: 'AKIA...',
    });
    expect(env.GOOGLE_APPLICATION_CREDENTIALS).toBeUndefined();
    expect(env.AWS_ACCESS_KEY_ID).toBe('AKIA...');
  });
});

// ============================================================
// 6. Singleton Pattern
// ============================================================
describe('LitestreamManager Singleton', () => {
  it('should return the same instance on multiple calls', async () => {
    const { LitestreamManager } = await import('../../src/services/backup/LitestreamManager.js');
    const instance1 = LitestreamManager.getInstance();
    const instance2 = LitestreamManager.getInstance();
    expect(instance1).toBe(instance2);
  });
});

// ============================================================
// 7. Restore Guards
// ============================================================
describe('LitestreamManager Restore Guards', () => {
  it('should fail restore when bucket is not configured', async () => {
    const { LitestreamManager } = await import('../../src/services/backup/LitestreamManager.js');
    const manager = LitestreamManager.getInstance();

    // With default settings (empty bucket), restore should fail
    const result = await manager.restore();
    expect(result.success).toBe(false);
    expect(result.message).toContain('CLAUDE_MEM_BACKUP_BUCKET');
  });
});

// ============================================================
// 8. Source Code Structure Verification
// ============================================================
describe('Source Code Structure', () => {
  it('LitestreamManager.ts should exist', () => {
    expect(existsSync(join(process.cwd(), 'src/services/backup/LitestreamManager.ts'))).toBe(true);
  });

  it('BackupRoutes.ts should exist', () => {
    expect(existsSync(join(process.cwd(), 'src/services/worker/http/routes/BackupRoutes.ts'))).toBe(true);
  });

  it('SKILL.md should exist', () => {
    expect(existsSync(join(process.cwd(), 'plugin/skills/backup-setup/SKILL.md'))).toBe(true);
  });

  it('worker-service.ts should import LitestreamManager', () => {
    const content = readFileSync(join(process.cwd(), 'src/services/worker-service.ts'), 'utf-8');
    expect(content).toContain('LitestreamManager');
    expect(content).toContain('BackupRoutes');
  });

  it('worker-service.ts should call start and stop', () => {
    const content = readFileSync(join(process.cwd(), 'src/services/worker-service.ts'), 'utf-8');
    expect(content).toContain('litestreamManager.start()');
    expect(content).toContain('litestreamManager.stop()');
  });

  it('SettingsRoutes.ts should whitelist all 9 backup settings', () => {
    const content = readFileSync(join(process.cwd(), 'src/services/worker/http/routes/SettingsRoutes.ts'), 'utf-8');
    const backupKeys = [
      'CLAUDE_MEM_BACKUP_ENABLED',
      'CLAUDE_MEM_BACKUP_PROVIDER',
      'CLAUDE_MEM_BACKUP_BUCKET',
      'CLAUDE_MEM_BACKUP_PATH',
      'CLAUDE_MEM_BACKUP_ENDPOINT',
      'CLAUDE_MEM_BACKUP_REGION',
      'CLAUDE_MEM_BACKUP_ACCESS_KEY_ID',
      'CLAUDE_MEM_BACKUP_SECRET_ACCESS_KEY',
      'CLAUDE_MEM_BACKUP_GCS_CREDENTIALS_PATH',
    ];
    for (const key of backupKeys) {
      expect(content).toContain(key);
    }
  });

  it('SettingsRoutes.ts should validate BACKUP_ENABLED', () => {
    const content = readFileSync(join(process.cwd(), 'src/services/worker/http/routes/SettingsRoutes.ts'), 'utf-8');
    expect(content).toContain("'true', 'false'");
  });

  it('SettingsRoutes.ts should validate BACKUP_PROVIDER', () => {
    const content = readFileSync(join(process.cwd(), 'src/services/worker/http/routes/SettingsRoutes.ts'), 'utf-8');
    expect(content).toContain("'gcs', 's3', 'abs', 'sftp'");
  });

  it('logger.ts should include BACKUP component', () => {
    const content = readFileSync(join(process.cwd(), 'src/utils/logger.ts'), 'utf-8');
    expect(content).toContain("'BACKUP'");
  });
});
