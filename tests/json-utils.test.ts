import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, writeFileSync, existsSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { readJsonSafe } from '../src/utils/json-utils';

/**
 * Tests for the shared JSON file utilities.
 *
 * readJsonSafe is used across the CLI and services to safely read JSON
 * files with fallback to defaults when files are missing or corrupt.
 */

describe('JSON Utils', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = join(tmpdir(), `json-utils-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tempDir, { recursive: true });
  });

  afterEach(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('readJsonSafe', () => {
    it('returns default value when file does not exist', () => {
      const nonExistentPath = join(tempDir, 'does-not-exist.json');

      const result = readJsonSafe(nonExistentPath, { fallback: true });

      expect(result).toEqual({ fallback: true });
    });

    it('returns parsed content for valid JSON file', () => {
      const filePath = join(tempDir, 'valid.json');
      const data = { name: 'test', count: 42, nested: { key: 'value' } };
      writeFileSync(filePath, JSON.stringify(data));

      const result = readJsonSafe(filePath, {});

      expect(result).toEqual(data);
    });

    it('throws on corrupt JSON file to prevent data loss', () => {
      const filePath = join(tempDir, 'corrupt.json');
      writeFileSync(filePath, 'this is not valid json {{{');

      expect(() => readJsonSafe(filePath, { recovered: true })).toThrow(
        /Corrupt JSON file, refusing to overwrite/
      );
    });

    it('throws on empty file to prevent data loss', () => {
      const filePath = join(tempDir, 'empty.json');
      writeFileSync(filePath, '');

      expect(() => readJsonSafe(filePath, [])).toThrow(
        /Corrupt JSON file, refusing to overwrite/
      );
    });

    it('works with array default values', () => {
      const nonExistentPath = join(tempDir, 'missing.json');

      const result = readJsonSafe<string[]>(nonExistentPath, ['a', 'b']);

      expect(result).toEqual(['a', 'b']);
    });

    it('works with string default values', () => {
      const nonExistentPath = join(tempDir, 'missing.json');

      const result = readJsonSafe<string>(nonExistentPath, 'default');

      expect(result).toBe('default');
    });

    it('works with number default values', () => {
      const nonExistentPath = join(tempDir, 'missing.json');

      const result = readJsonSafe<number>(nonExistentPath, 0);

      expect(result).toBe(0);
    });

    it('reads JSON arrays correctly', () => {
      const filePath = join(tempDir, 'array.json');
      writeFileSync(filePath, JSON.stringify([1, 2, 3]));

      const result = readJsonSafe<number[]>(filePath, []);

      expect(result).toEqual([1, 2, 3]);
    });

    it('reads deeply nested JSON correctly', () => {
      const filePath = join(tempDir, 'nested.json');
      const deepData = {
        level1: {
          level2: {
            level3: {
              value: 'deep',
            },
          },
        },
      };
      writeFileSync(filePath, JSON.stringify(deepData));

      const result = readJsonSafe<typeof deepData>(filePath, { level1: { level2: { level3: { value: '' } } } });

      expect(result.level1.level2.level3.value).toBe('deep');
    });

    it('handles JSON with trailing newline', () => {
      const filePath = join(tempDir, 'trailing-newline.json');
      writeFileSync(filePath, JSON.stringify({ ok: true }) + '\n');

      const result = readJsonSafe(filePath, {});

      expect(result).toEqual({ ok: true });
    });
  });
});
