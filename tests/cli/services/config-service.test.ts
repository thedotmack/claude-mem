import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { ConfigService, DEFAULT_SETTINGS } from '../../../src/cli/services/config-service';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

describe('ConfigService', () => {
  let service: ConfigService;
  let tempDir: string;
  let originalSettingsPath: string;

  beforeEach(() => {
    // Create temp directory for test files
    tempDir = mkdtempSync(join(tmpdir(), 'claude-mem-test-'));
    
    // Override the settings path for testing
    service = new ConfigService();
    originalSettingsPath = (service as any).settingsPath;
    (service as any).settingsPath = join(tempDir, 'settings.json');
  });

  afterEach(() => {
    // Cleanup temp directory
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch { /* ignore */ }
  });

  describe('getDefaultSettings', () => {
    it('should return all default settings', () => {
      const settings = (service as any).getDefaultSettings();
      
      expect(Object.keys(settings).length).toBeGreaterThan(0);
      expect(settings.CLAUDE_MEM_WORKER_PORT).toBeDefined();
      expect(settings.CLAUDE_MEM_LOG_LEVEL).toBeDefined();
    });
  });

  describe('DEFAULT_SETTINGS', () => {
    it('should have required settings defined', () => {
      const keys = DEFAULT_SETTINGS.map(s => s.key);
      
      expect(keys).toContain('CLAUDE_MEM_WORKER_PORT');
      expect(keys).toContain('CLAUDE_MEM_LOG_LEVEL');
      expect(keys).toContain('CLAUDE_MEM_MODEL');
    });

    it('should have valid types', () => {
      const validTypes = ['string', 'number', 'boolean'];
      
      for (const setting of DEFAULT_SETTINGS) {
        expect(validTypes).toContain(setting.type);
      }
    });
  });

  describe('getSettings', () => {
    it('should return defaults when file does not exist', () => {
      const settings = service.getSettings();
      
      expect(settings.CLAUDE_MEM_WORKER_PORT).toBeDefined();
      expect(settings.CLAUDE_MEM_LOG_LEVEL).toBeDefined();
    });
  });

  describe('get', () => {
    it('should return undefined for unknown key', () => {
      const value = service.get('UNKNOWN_KEY');
      expect(value).toBeUndefined();
    });

    it('should return value for known key', () => {
      const value = service.get('CLAUDE_MEM_WORKER_PORT');
      expect(value).toBeDefined();
    });
  });

  describe('set', () => {
    it('should set a value', () => {
      const result = service.set('TEST_KEY', 'test_value');
      
      expect(result).toBe(true);
      expect(service.get('TEST_KEY')).toBe('test_value');
    });
  });

  describe('validate', () => {
    it('should validate port number', () => {
      service.set('CLAUDE_MEM_WORKER_PORT', '99999');
      const result = service.validate();
      
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors[0]).toContain('port');
    });

    it('should validate log level', () => {
      service.set('CLAUDE_MEM_LOG_LEVEL', 'INVALID');
      const result = service.validate();
      
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('log level'))).toBe(true);
    });

    it('should pass for valid settings', () => {
      service.set('CLAUDE_MEM_WORKER_PORT', '37777');
      service.set('CLAUDE_MEM_LOG_LEVEL', 'INFO');
      const result = service.validate();
      
      expect(result.valid).toBe(true);
      expect(result.errors.length).toBe(0);
    });
  });

  describe('reset', () => {
    it('should reset to defaults', () => {
      service.set('CUSTOM_KEY', 'custom_value');
      service.reset();
      
      const settings = service.getSettings();
      expect(settings.CUSTOM_KEY).toBeUndefined();
      expect(settings.CLAUDE_MEM_WORKER_PORT).toBeDefined();
    });
  });
});
