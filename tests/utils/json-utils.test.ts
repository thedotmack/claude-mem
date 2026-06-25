import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { readJsonSafe, stripBom } from '../../src/utils/json-utils.js';

const BOM = '﻿';

describe('stripBom', () => {
  it('removes a leading UTF-8 BOM', () => {
    expect(stripBom(BOM + '{"a":1}')).toBe('{"a":1}');
  });

  it('leaves BOM-free strings untouched', () => {
    expect(stripBom('{"a":1}')).toBe('{"a":1}');
  });

  it('only strips a BOM at position 0', () => {
    expect(stripBom('{}' + BOM)).toBe('{}' + BOM);
  });
});

describe('readJsonSafe with a BOM-prefixed file', () => {
  let tempDir: string;
  let filePath: string;

  beforeEach(() => {
    tempDir = join(tmpdir(), `json-utils-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tempDir, { recursive: true });
    filePath = join(tempDir, 'settings.json');
  });

  afterEach(() => {
    try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  // Reproduces issue #3013: PowerShell-written settings.json carries a UTF-8 BOM
  // that Bun's JSON.parse rejects, breaking every settings reader on Windows.
  it('parses JSON that PowerShell wrote with a UTF-8 BOM', () => {
    writeFileSync(filePath, BOM + JSON.stringify({ CLAUDE_MEM_LOG_LEVEL: 'DEBUG' }), 'utf-8');
    const result = readJsonSafe<Record<string, unknown>>(filePath, {});
    expect(result.CLAUDE_MEM_LOG_LEVEL).toBe('DEBUG');
  });
});
