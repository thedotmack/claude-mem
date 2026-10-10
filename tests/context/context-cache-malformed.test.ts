import { afterAll, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const dataDir = mkdtempSync(join(tmpdir(), 'cmem-cache-shape-'));
const originalDataDir = process.env.CLAUDE_MEM_DATA_DIR;
process.env.CLAUDE_MEM_DATA_DIR = dataDir;
const { contextCacheDir, contextCacheFilePath, contextCacheKeys, readContextCache } =
  await import('../../src/shared/context-cache.js');
const keys = contextCacheKeys(['fixture'], 'claude-code', false);
const now = 1_790_000_000_000;
mkdirSync(contextCacheDir(), { recursive: true });

afterAll(() => {
  if (originalDataDir === undefined) delete process.env.CLAUDE_MEM_DATA_DIR;
  else process.env.CLAUDE_MEM_DATA_DIR = originalDataDir;
  rmSync(dataDir, { recursive: true, force: true });
});

describe('malformed context cache falls back to live rendering', () => {
  it('keeps a valid fresh cache usable', () => {
    const payload = { body: 'cached', renderedAtEpochMs: now, placeholderNonce: '123456789abc', keys };
    writeFileSync(contextCacheFilePath(keys), JSON.stringify(payload));
    expect(readContextCache(keys, now)).toEqual(payload);
  });
  for (const [label, payload] of [
    ['null envelope', null],
    ['invalid projects', { body: 'cached', renderedAtEpochMs: now, placeholderNonce: '123456789abc', keys: { ...keys, projects: null } }],
    ['non-finite timestamp', { body: 'cached', renderedAtEpochMs: Infinity, placeholderNonce: '123456789abc', keys }],
  ] as const) {
    it(label, () => {
      // JSON.stringify(Infinity) becomes null; use a valid JSON numeric overflow
      // to exercise the non-finite number a JSON reader can actually produce.
      const json = label === 'non-finite timestamp'
        ? JSON.stringify(payload).replace('"renderedAtEpochMs":null', '"renderedAtEpochMs":1e400')
        : JSON.stringify(payload);
      writeFileSync(contextCacheFilePath(keys), json);
      expect(readContextCache(keys, now)).toBeNull();
    });
  }
});
