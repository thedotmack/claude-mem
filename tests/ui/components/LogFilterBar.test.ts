/**
 * Tests for LogFilterBar — filter configuration constants and exports.
 */
import { describe, it, expect } from 'vitest';
import { LOG_LEVELS, LOG_COMPONENTS } from '../../../src/ui/viewer/components/LogFilterBar';

describe('LOG_LEVELS', () => {
  it('contains 4 log levels', () => {
    expect(LOG_LEVELS).toHaveLength(4);
  });

  it('includes all expected level keys', () => {
    const keys = LOG_LEVELS.map(l => l.key);
    expect(keys).toContain('DEBUG');
    expect(keys).toContain('INFO');
    expect(keys).toContain('WARN');
    expect(keys).toContain('ERROR');
  });

  it('each level has key, label, icon, and color', () => {
    for (const level of LOG_LEVELS) {
      expect(level.key).toBeTruthy();
      expect(level.label).toBeTruthy();
      expect(level.icon).toBeTruthy();
      expect(level.color).toMatch(/^#[0-9a-f]{6}$/);
    }
  });
});

describe('LOG_COMPONENTS', () => {
  it('contains 9 component types', () => {
    expect(LOG_COMPONENTS).toHaveLength(9);
  });

  it('includes all expected component keys', () => {
    const keys = LOG_COMPONENTS.map(c => c.key);
    expect(keys).toContain('HOOK');
    expect(keys).toContain('WORKER');
    expect(keys).toContain('SDK');
    expect(keys).toContain('PARSER');
    expect(keys).toContain('DB');
    expect(keys).toContain('SYSTEM');
    expect(keys).toContain('HTTP');
    expect(keys).toContain('SESSION');
    expect(keys).toContain('CHROMA');
  });

  it('each component has key, label, icon, and color', () => {
    for (const comp of LOG_COMPONENTS) {
      expect(comp.key).toBeTruthy();
      expect(comp.label).toBeTruthy();
      expect(comp.icon).toBeTruthy();
      expect(comp.color).toMatch(/^#[0-9a-f]{6}$/);
    }
  });
});

describe('LogFilterBar module', () => {
  it('exports LogFilterBar function', async () => {
    const mod = await import('../../../src/ui/viewer/components/LogFilterBar');
    expect(typeof mod.LogFilterBar).toBe('function');
  });
});
