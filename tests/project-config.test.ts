/**
 * Tests for project-level configuration (.claude-mem.json)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, writeFileSync, unlinkSync, mkdirSync, rmdirSync } from 'fs';
import { join } from 'path';
import {
  loadProjectConfig,
  isMemoryEnabled,
  canCaptureObservations,
  canCaptureSessions,
  canCapturePrompts,
  clearConfigCache
} from '../src/shared/project-config.js';

describe('Project Configuration (.claude-mem.json)', () => {
  const testProjectDir = join(process.cwd(), 'test-project-config');
  const configPath = join(testProjectDir, '.claude-mem.json');

  beforeEach(() => {
    // Create test directory
    if (!existsSync(testProjectDir)) {
      mkdirSync(testProjectDir, { recursive: true });
    }
    clearConfigCache();
  });

  afterEach(() => {
    // Clean up test directory
    if (existsSync(configPath)) {
      unlinkSync(configPath);
    }
    if (existsSync(testProjectDir)) {
      rmdirSync(testProjectDir);
    }
    clearConfigCache();
  });

  describe('loadProjectConfig', () => {
    it('should return default config when no .claude-mem.json exists', () => {
      const config = loadProjectConfig(testProjectDir);
      expect(config.enabled).toBe(true);
      expect(config.captureObservations).toBe(true);
      expect(config.captureSessions).toBe(true);
      expect(config.capturePrompts).toBe(true);
    });

    it('should load config with enabled: false', () => {
      writeFileSync(configPath, JSON.stringify({
        enabled: false,
        reason: 'Sensitive project'
      }), 'utf-8');

      const config = loadProjectConfig(testProjectDir);
      expect(config.enabled).toBe(false);
      expect(config.captureObservations).toBe(false);
      expect(config.captureSessions).toBe(false);
      expect(config.capturePrompts).toBe(false);
      expect(config.reason).toBe('Sensitive project');
    });

    it('should load config with granular controls', () => {
      writeFileSync(configPath, JSON.stringify({
        enabled: true,
        captureObservations: false,
        captureSessions: true,
        capturePrompts: true
      }), 'utf-8');

      const config = loadProjectConfig(testProjectDir);
      expect(config.enabled).toBe(true);
      expect(config.captureObservations).toBe(false);
      expect(config.captureSessions).toBe(true);
      expect(config.capturePrompts).toBe(true);
    });

    it('should cache config for repeated calls', () => {
      writeFileSync(configPath, JSON.stringify({
        enabled: false
      }), 'utf-8');

      const config1 = loadProjectConfig(testProjectDir);
      
      // Delete file after first load
      unlinkSync(configPath);

      // Should still return cached config
      const config2 = loadProjectConfig(testProjectDir);
      expect(config2.enabled).toBe(false);
    });

    it('should handle invalid JSON gracefully', () => {
      writeFileSync(configPath, '{ invalid json }', 'utf-8');

      const config = loadProjectConfig(testProjectDir);
      // Should fallback to defaults
      expect(config.enabled).toBe(true);
    });

    it('should override all capture settings when enabled: false', () => {
      writeFileSync(configPath, JSON.stringify({
        enabled: false,
        captureObservations: true,  // Should be overridden
        captureSessions: true,       // Should be overridden
        capturePrompts: true         // Should be overridden
      }), 'utf-8');

      const config = loadProjectConfig(testProjectDir);
      expect(config.enabled).toBe(false);
      expect(config.captureObservations).toBe(false);
      expect(config.captureSessions).toBe(false);
      expect(config.capturePrompts).toBe(false);
    });
  });

  describe('Helper functions', () => {
    it('isMemoryEnabled should return false when disabled', () => {
      writeFileSync(configPath, JSON.stringify({ enabled: false }), 'utf-8');
      expect(isMemoryEnabled(testProjectDir)).toBe(false);
    });

    it('isMemoryEnabled should return true by default', () => {
      expect(isMemoryEnabled(testProjectDir)).toBe(true);
    });

    it('canCaptureObservations should respect granular control', () => {
      writeFileSync(configPath, JSON.stringify({
        enabled: true,
        captureObservations: false
      }), 'utf-8');
      expect(canCaptureObservations(testProjectDir)).toBe(false);
    });

    it('canCaptureSessions should respect granular control', () => {
      writeFileSync(configPath, JSON.stringify({
        enabled: true,
        captureSessions: false
      }), 'utf-8');
      expect(canCaptureSessions(testProjectDir)).toBe(false);
    });

    it('canCapturePrompts should respect granular control', () => {
      writeFileSync(configPath, JSON.stringify({
        enabled: true,
        capturePrompts: false
      }), 'utf-8');
      expect(canCapturePrompts(testProjectDir)).toBe(false);
    });

    it('all capture functions should return false when enabled: false', () => {
      writeFileSync(configPath, JSON.stringify({ enabled: false }), 'utf-8');
      expect(canCaptureObservations(testProjectDir)).toBe(false);
      expect(canCaptureSessions(testProjectDir)).toBe(false);
      expect(canCapturePrompts(testProjectDir)).toBe(false);
    });
  });

  describe('Cache management', () => {
    it('clearConfigCache should invalidate cache', () => {
      writeFileSync(configPath, JSON.stringify({ enabled: false }), 'utf-8');

      const config1 = loadProjectConfig(testProjectDir);
      expect(config1.enabled).toBe(false);

      // Update config file
      writeFileSync(configPath, JSON.stringify({ enabled: true }), 'utf-8');

      // Should still be cached
      const config2 = loadProjectConfig(testProjectDir);
      expect(config2.enabled).toBe(false);

      // Clear cache
      clearConfigCache();

      // Should now read new value
      const config3 = loadProjectConfig(testProjectDir);
      expect(config3.enabled).toBe(true);
    });
  });
});
