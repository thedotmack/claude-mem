import { describe, expect, it } from 'bun:test';
import {
  applyViewerSettings,
  settingsForViewer,
} from '../../../../src/services/worker/http/routes/SettingsRoutes.js';

describe('SettingsRoutes backup encryption key handling', () => {
  it('returns key presence to the viewer without returning the key', () => {
    const response = settingsForViewer({
      CLAUDE_MEM_BACKUP_ENABLED: 'true',
      CLAUDE_MEM_BACKUP_ENCRYPTION_KEY: 'secret-base64-key',
    });

    expect(response.CLAUDE_MEM_BACKUP_ENABLED).toBe('true');
    expect(response.CLAUDE_MEM_BACKUP_ENCRYPTION_KEY_PRESENT).toBe(true);
    expect('CLAUDE_MEM_BACKUP_ENCRYPTION_KEY' in response).toBe(false);
  });

  it('reports an absent key without synthesizing a key setting', () => {
    const response = settingsForViewer({
      CLAUDE_MEM_BACKUP_ENCRYPTION_KEY: '',
    });

    expect(response.CLAUDE_MEM_BACKUP_ENCRYPTION_KEY_PRESENT).toBe(false);
    expect('CLAUDE_MEM_BACKUP_ENCRYPTION_KEY' in response).toBe(false);
  });

  it('preserves the server-owned key while applying normal backup updates', () => {
    const settings: Record<string, unknown> = {
      CLAUDE_MEM_BACKUP_ENABLED: 'false',
      CLAUDE_MEM_BACKUP_ENCRYPTION_KEY: 'original-secret',
    };

    applyViewerSettings(settings, {
      CLAUDE_MEM_BACKUP_ENABLED: 'true',
      CLAUDE_MEM_BACKUP_ENCRYPTION_KEY: 'attacker-replacement',
      CLAUDE_MEM_BACKUP_ENCRYPTION_KEY_PRESENT: false,
    });

    expect(settings.CLAUDE_MEM_BACKUP_ENABLED).toBe('true');
    expect(settings.CLAUDE_MEM_BACKUP_ENCRYPTION_KEY).toBe('original-secret');
    expect(settings.CLAUDE_MEM_BACKUP_ENCRYPTION_KEY_PRESENT).toBeUndefined();
  });
});
