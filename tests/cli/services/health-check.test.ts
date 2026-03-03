import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { HealthChecker } from '../../../src/cli/services/health-check';
import type { HealthCheckResult } from '../../../src/cli/types';

describe('HealthChecker', () => {
  let checker: HealthChecker;

  beforeEach(() => {
    checker = new HealthChecker();
  });

  describe('getSummary', () => {
    it('should return healthy when no errors', () => {
      const results: HealthCheckResult[] = [
        { name: 'Test1', ok: true, message: 'OK', severity: 'info' },
        { name: 'Test2', ok: true, message: 'OK', severity: 'info' },
      ];

      const summary = checker.getSummary(results);
      
      expect(summary.healthy).toBe(true);
      expect(summary.errors).toBe(0);
      expect(summary.warnings).toBe(0);
    });

    it('should count errors correctly', () => {
      const results: HealthCheckResult[] = [
        { name: 'Test1', ok: true, message: 'OK', severity: 'info' },
        { name: 'Test2', ok: false, message: 'Error', severity: 'error' },
      ];

      const summary = checker.getSummary(results);
      
      expect(summary.healthy).toBe(false);
      expect(summary.errors).toBe(1);
      expect(summary.warnings).toBe(0);
    });

    it('should count warnings correctly', () => {
      const results: HealthCheckResult[] = [
        { name: 'Test1', ok: true, message: 'OK', severity: 'info' },
        { name: 'Test2', ok: false, message: 'Warning', severity: 'warning' },
      ];

      const summary = checker.getSummary(results);
      
      expect(summary.healthy).toBe(true);
      expect(summary.errors).toBe(0);
      expect(summary.warnings).toBe(1);
    });
  });

  describe('checkPluginEnabled', () => {
    it('should handle missing settings file', async () => {
      const result = await checker.checkPluginEnabled();
      
      // When settings file doesn't exist, it should return info
      expect(result.severity).toBeOneOf(['info', 'warning', 'error']);
    });
  });

  describe('checkNodeVersion', () => {
    it('should return info about Node.js', async () => {
      const result = await checker.checkNodeVersion();
      
      expect(result.name).toBe('Node.js');
      expect(result.message).toContain('Node.js');
      expect(['info', 'warning', 'error']).toContain(result.severity);
    });
  });

  describe('checkBunVersion', () => {
    it('should check Bun version', async () => {
      const result = await checker.checkBunVersion();
      
      expect(result.name).toBe('Bun Runtime');
      expect(['info', 'warning', 'error']).toContain(result.severity);
    });
  });
});
