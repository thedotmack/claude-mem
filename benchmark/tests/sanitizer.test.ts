import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { join } from 'node:path';
import { mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import {
  sanitizeContent,
  computeRawLogHash,
  sanitizeResults,
  SanitizationError,
} from '../src/analysis/sanitizer.js';

const TEMP_DIR = join(import.meta.dir, '..', '.test-tmp-sanitizer');

async function ensureTempDir(): Promise<void> {
  await mkdir(TEMP_DIR, { recursive: true });
}

async function cleanupTempDir(): Promise<void> {
  try {
    await rm(TEMP_DIR, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors
  }
}

describe('sanitizer', () => {
  beforeEach(async () => {
    await ensureTempDir();
  });

  afterEach(async () => {
    await cleanupTempDir();
  });

  describe('sanitizeContent', () => {
    test('strips Anthropic API keys', () => {
      const content = 'My key is sk-ant-api03-xxxYYY123 and it works.';
      const { sanitized, patternsStripped } = sanitizeContent(content);

      expect(sanitized).not.toContain('sk-ant-api03-xxxYYY123');
      expect(sanitized).toContain('REDACTED_API_KEY');
      expect(patternsStripped).toBeGreaterThanOrEqual(1);
    });

    test('strips environment variable assignments', () => {
      const content = 'ANTHROPIC_API_KEY_1=sk-ant-xxx-abc123 is set.';
      const { sanitized, patternsStripped } = sanitizeContent(content);

      expect(sanitized).not.toContain('sk-ant-xxx-abc123');
      expect(sanitized).not.toContain('ANTHROPIC_API_KEY_1=sk-ant');
      expect(patternsStripped).toBeGreaterThanOrEqual(1);
    });

    test('strips macOS file paths with usernames', () => {
      const content = 'File at /Users/alexnewman/projects/secret-project.ts';
      const { sanitized, patternsStripped } = sanitizeContent(content);

      expect(sanitized).not.toContain('alexnewman');
      expect(sanitized).toContain('/Users/REDACTED/');
      expect(patternsStripped).toBeGreaterThanOrEqual(1);
    });

    test('strips Linux file paths with usernames', () => {
      const content = 'Config at /home/developer/config/.env';
      const { sanitized, patternsStripped } = sanitizeContent(content);

      expect(sanitized).not.toContain('developer');
      expect(sanitized).toContain('/home/REDACTED/');
      expect(patternsStripped).toBeGreaterThanOrEqual(1);
    });

    test('strips Bearer tokens', () => {
      const content = 'Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.abc.def';
      const { sanitized, patternsStripped } = sanitizeContent(content);

      expect(sanitized).not.toContain('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9');
      expect(sanitized).toContain('Bearer REDACTED');
      expect(patternsStripped).toBeGreaterThanOrEqual(1);
    });

    test('strips generic token assignments', () => {
      const content = 'token=my_secret_token_value and token: another_secret';
      const { sanitized, patternsStripped } = sanitizeContent(content);

      expect(sanitized).not.toContain('my_secret_token_value');
      expect(sanitized).not.toContain('another_secret');
      expect(patternsStripped).toBeGreaterThanOrEqual(2);
    });

    test('strips Telegram bot tokens', () => {
      // Telegram tokens are in format: numeric_id:35_char_alphanumeric
      // Use a context that doesn't trigger the generic token= pattern
      const content = 'Bot credential 123456789:ABCDEFghijklmnopqrstuvwxyz_12345678 was leaked';
      const { sanitized, patternsStripped } = sanitizeContent(content);

      expect(sanitized).not.toContain('ABCDEFghijklmnopqrstuvwxyz_12345678');
      expect(sanitized).toContain('REDACTED_TELEGRAM_TOKEN');
      expect(patternsStripped).toBeGreaterThanOrEqual(1);
    });

    test('preserves non-secret content unchanged', () => {
      const content = 'This is a normal log line with no secrets.\nJust regular output from the agent.';
      const { sanitized, patternsStripped } = sanitizeContent(content);

      expect(sanitized).toBe(content);
      expect(patternsStripped).toBe(0);
    });

    test('counts patterns stripped correctly with multiple patterns', () => {
      const content = [
        'ANTHROPIC_API_KEY=sk-ant-api03-abc123',
        'Path: /Users/john/work/',
        'Path: /home/jane/code/',
        'Auth: Bearer xyz123token',
      ].join('\n');

      const { patternsStripped } = sanitizeContent(content);

      // At minimum: 1 env var, 1 api key within env, 1 macOS path, 1 Linux path, 1 Bearer
      expect(patternsStripped).toBeGreaterThanOrEqual(4);
    });

    test('handles content with multiple API keys', () => {
      const content = 'Key1: sk-ant-abc-def Key2: sk-ant-xyz-123';
      const { sanitized, patternsStripped } = sanitizeContent(content);

      expect(sanitized).not.toContain('sk-ant-abc');
      expect(sanitized).not.toContain('sk-ant-xyz');
      expect(patternsStripped).toBeGreaterThanOrEqual(2);
    });
  });

  describe('computeRawLogHash', () => {
    test('computes correct SHA-256 hash for known input', async () => {
      const knownContent = 'Hello, World!';
      const filePath = join(TEMP_DIR, 'known-content.txt');
      await writeFile(filePath, knownContent);

      const hash = await computeRawLogHash(filePath);

      // Known SHA-256 of "Hello, World!"
      const expectedHash = createHash('sha256')
        .update(knownContent)
        .digest('hex');
      expect(hash).toBe(expectedHash);
      expect(hash).toMatch(/^[a-f0-9]{64}$/);
    });

    test('produces different hashes for different content', async () => {
      const file1 = join(TEMP_DIR, 'file1.txt');
      const file2 = join(TEMP_DIR, 'file2.txt');
      await writeFile(file1, 'content one');
      await writeFile(file2, 'content two');

      const hash1 = await computeRawLogHash(file1);
      const hash2 = await computeRawLogHash(file2);

      expect(hash1).not.toBe(hash2);
    });

    test('produces consistent hash for same content', async () => {
      const filePath = join(TEMP_DIR, 'consistent.txt');
      await writeFile(filePath, 'consistent content');

      const hash1 = await computeRawLogHash(filePath);
      const hash2 = await computeRawLogHash(filePath);

      expect(hash1).toBe(hash2);
    });
  });

  describe('sanitizeResults', () => {
    test('sanitizes text files and writes to publishable directory', async () => {
      const resultsDir = join(TEMP_DIR, 'results');
      const outputDir = join(TEMP_DIR, 'output');
      const agentDir = join(resultsDir, 'cmem-01-1');

      await mkdir(agentDir, { recursive: true });
      await writeFile(
        join(agentDir, 'transcript.jsonl'),
        '{"key": "sk-ant-api03-secret123"}',
      );

      const results = await sanitizeResults(resultsDir, outputDir);

      expect(results.length).toBe(1);
      expect(results[0].patternsStripped).toBeGreaterThanOrEqual(1);
      expect(results[0].rawLogSha256).toMatch(/^[a-f0-9]{64}$/);

      // Verify sanitized file exists
      const sanitizedContent = await readFile(results[0].sanitizedPath, 'utf-8');
      expect(sanitizedContent).not.toContain('sk-ant-api03-secret123');
    });

    test('preserves directory structure in publishable output', async () => {
      const resultsDir = join(TEMP_DIR, 'results-struct');
      const outputDir = join(TEMP_DIR, 'output-struct');
      const agentDir = join(resultsDir, 'cmem-02-1');

      await mkdir(agentDir, { recursive: true });
      await writeFile(join(agentDir, 'smoke-results.json'), '{"passed": 5}');

      const results = await sanitizeResults(resultsDir, outputDir);

      expect(results.length).toBe(1);
      expect(results[0].sanitizedPath).toContain('publishable');
      expect(results[0].sanitizedPath).toContain('cmem-02-1');
    });
  });
});
