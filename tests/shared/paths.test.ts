import { describe, it, expect } from 'bun:test';
import { paths, DATA_DIR } from '../../src/shared/paths.js';

describe('paths namespace', () => {
  it('exposes at least the known core accessors', () => {
    const keys = Object.keys(paths);
    const required = [
      'dataDir',
      'workerPid',
      'settings',
      'database',
      'chroma',
      'transcriptsConfig',
    ];
    for (const key of required) {
      expect(keys).toContain(key);
    }
  });

  it('every accessor returns a string starting with DATA_DIR', () => {
    for (const key of Object.keys(paths) as Array<keyof typeof paths>) {
      const value = paths[key]();
      expect(typeof value).toBe('string');
      expect(value.startsWith(DATA_DIR)).toBe(true);
    }
  });

  it('every accessor is a callable function', () => {
    for (const key of Object.keys(paths) as Array<keyof typeof paths>) {
      expect(typeof paths[key]).toBe('function');
    }
  });
});
