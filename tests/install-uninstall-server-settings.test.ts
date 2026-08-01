import { describe, it, expect } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { clearServerRuntimeSettings } from '../src/npx-cli/commands/uninstall.js';

describe('clearServerRuntimeSettings', () => {
  it('removes server keys from nested env while preserving root peers', () => {
    const dir = mkdtempSync(join(tmpdir(), 'claude-mem-uninstall-settings-'));
    const settingsPath = join(dir, 'settings.json');
    try {
      writeFileSync(settingsPath, JSON.stringify({
        theme: 'dark',
        permissions: { defaultMode: 'auto' },
        env: {
          CLAUDE_MEM_SERVER_API_KEY: 'cmem_old',
          CLAUDE_MEM_SERVER_PROJECT_ID: 'project-old',
          KEEP_ME: 'yes',
        },
      }));

      clearServerRuntimeSettings(
        ['CLAUDE_MEM_SERVER_API_KEY', 'CLAUDE_MEM_SERVER_PROJECT_ID'],
        settingsPath,
      );

      const written = JSON.parse(readFileSync(settingsPath, 'utf-8'));
      expect(written.theme).toBe('dark');
      expect(written.permissions).toEqual({ defaultMode: 'auto' });
      expect(written.env).toEqual({ KEEP_ME: 'yes' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
