import { describe, expect, it } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SettingsDefaultsManager } from '../../../../src/shared/SettingsDefaultsManager.js';

describe('Work View language settings', () => {
  it('defaults to empty string', () => {
    const defaults = SettingsDefaultsManager.getAllDefaults();
    expect(defaults.CLAUDE_MEM_WORK_VIEW_LANGUAGE).toBe('');
  });

  it('reads CLAUDE_MEM_WORK_VIEW_LANGUAGE from settings.json', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lang-test-'));
    const settingsPath = join(dir, 'settings.json');
    try {
      writeFileSync(settingsPath, JSON.stringify({ CLAUDE_MEM_WORK_VIEW_LANGUAGE: 'zh-CN' }));
      const loaded = SettingsDefaultsManager.loadFromFile(settingsPath, false, { readOnly: true });
      expect(loaded.CLAUDE_MEM_WORK_VIEW_LANGUAGE).toBe('zh-CN');
    } finally {
      try { rmSync(dir, { recursive: true, force: true }); } catch {}
    }
  });

  it('reads workView.language dotted config from settings.json', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lang-test-'));
    const settingsPath = join(dir, 'settings.json');
    try {
      writeFileSync(settingsPath, JSON.stringify({ 'workView.language': 'zh-CN' }));
      const loaded = SettingsDefaultsManager.loadFromFile(settingsPath, false, { readOnly: true });
      expect(loaded.CLAUDE_MEM_WORK_VIEW_LANGUAGE).toBe('zh-CN');
    } finally {
      try { rmSync(dir, { recursive: true, force: true }); } catch {}
    }
  });

  it('reads workView.language nested config from settings.json', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lang-test-'));
    const settingsPath = join(dir, 'settings.json');
    try {
      writeFileSync(settingsPath, JSON.stringify({ workView: { language: 'zh-CN' } }));
      const loaded = SettingsDefaultsManager.loadFromFile(settingsPath, false, { readOnly: true });
      expect(loaded.CLAUDE_MEM_WORK_VIEW_LANGUAGE).toBe('zh-CN');
    } finally {
      try { rmSync(dir, { recursive: true, force: true }); } catch {}
    }
  });

  it('populates language in snapshot when configured', async () => {
    const { WorkViewRoutes } = await import('../../../../src/services/worker/http/routes/WorkViewRoutes.js');
    const dir = mkdtempSync(join(tmpdir(), 'lang-test-'));
    const settingsPath = join(dir, 'settings.json');
    try {
      writeFileSync(settingsPath, JSON.stringify({ CLAUDE_MEM_WORK_VIEW_LANGUAGE: 'zh-CN' }));
      const mockThis = {
        source: { localDeviceId: '', read: () => ({ agentView: { revision: 'rev1', humanRequests: [] } }) },
        humanCopy: null,
        settingsPath,
        getLocalDeviceId: () => 'dev-1',
        rulesFileStatus: () => 'clean',
        setupView: () => ({ active: false }),
      };
      const snapshot = WorkViewRoutes.prototype.snapshot.call(mockThis as any);
      expect(snapshot.language).toBe('zh-CN');
    } finally {
      try { rmSync(dir, { recursive: true, force: true }); } catch {}
    }
  });

  it('omits language in snapshot when not configured', async () => {
    const { WorkViewRoutes } = await import('../../../../src/services/worker/http/routes/WorkViewRoutes.js');
    const dir = mkdtempSync(join(tmpdir(), 'lang-test-'));
    const settingsPath = join(dir, 'settings.json');
    try {
      writeFileSync(settingsPath, JSON.stringify({}));
      const mockThis = {
        source: { localDeviceId: '', read: () => ({ agentView: { revision: 'rev1', humanRequests: [] } }) },
        humanCopy: null,
        settingsPath,
        getLocalDeviceId: () => 'dev-1',
        rulesFileStatus: () => 'clean',
        setupView: () => ({ active: false }),
      };
      const snapshot = WorkViewRoutes.prototype.snapshot.call(mockThis as any);
      expect(snapshot.language).toBeUndefined();
    } finally {
      try { rmSync(dir, { recursive: true, force: true }); } catch {}
    }
  });
});
