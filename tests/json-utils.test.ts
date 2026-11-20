import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, writeFileSync, existsSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { readJsonSafe } from '../src/utils/json-utils';

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

    it('parses UTF-8 BOM prefixed JSON (Windows PowerShell 5.1)', () => {
      const filePath = join(tempDir, 'settings.json');
      const payload = { CLAUDE_MEM_MODEL: 'bom-model', nested: { ok: true } };
      // EF BB BF is the UTF-8 BOM PowerShell 5.1 writes; decode becomes U+FEFF.
      writeFileSync(filePath, Buffer.from([0xEF, 0xBB, 0xBF, ...Buffer.from(JSON.stringify(payload), 'utf-8')]));

      const result = readJsonSafe(filePath, {});

      expect(result).toEqual(payload);
    });

  });
});
