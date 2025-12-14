/**
 * Tests for project-level memory control via global settings
 */

import { describe, it, expect } from 'vitest';
import { join } from 'path';
import {
  isProjectIgnored,
  isMemoryEnabled,
  canCaptureObservations,
  canCaptureSessions,
  canCapturePrompts,
  clearConfigCache
} from '../src/shared/project-config.js';

describe('Project-Level Memory Control (Global Settings)', () => {
  // Test project directories
  const testProjectDir1 = join(process.cwd(), 'test-ignored-project');
  const testProjectDir2 = join(process.cwd(), 'test-allowed-project');

  describe('isProjectIgnored', () => {
    it('should return false when CLAUDE_MEM_IGNORED_PROJECTS is empty', () => {
      const ignored = isProjectIgnored(testProjectDir1);
      expect(ignored).toBe(false);
    });

    it('should return false when settings file does not exist', () => {
      const ignored = isProjectIgnored(testProjectDir1);
      expect(ignored).toBe(false);
    });
  });

  describe('Helper functions', () => {
    it('isMemoryEnabled should return true by default', () => {
      expect(isMemoryEnabled(testProjectDir2)).toBe(true);
    });

    it('canCaptureObservations should return true by default', () => {
      expect(canCaptureObservations(testProjectDir2)).toBe(true);
    });

    it('canCaptureSessions should return true by default', () => {
      expect(canCaptureSessions(testProjectDir2)).toBe(true);
    });

    it('canCapturePrompts should return true by default', () => {
      expect(canCapturePrompts(testProjectDir2)).toBe(true);
    });
  });

  describe('Cache management', () => {
    it('clearConfigCache should not throw', () => {
      expect(() => clearConfigCache()).not.toThrow();
    });
  });
});
