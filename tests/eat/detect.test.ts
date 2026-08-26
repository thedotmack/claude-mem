import { describe, expect, it, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { detectSource } from '../../src/services/worker/eat/detect.js';

let tempDir: string;
let tempFile: string;

beforeAll(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'eat-detect-'));
  tempFile = join(tempDir, 'sample.txt');
  writeFileSync(tempFile, 'sample content');
});

afterAll(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe('detectSource', () => {
  it('detects explicit stdin via "-"', () => {
    expect(detectSource('-', false)).toEqual({ kind: 'stdin', locator: 'stdin' });
    expect(detectSource('-', true)).toEqual({ kind: 'stdin', locator: 'stdin' });
  });

  it('detects implicit stdin when input is undefined and stdin is present', () => {
    expect(detectSource(undefined, true)).toEqual({ kind: 'stdin', locator: 'stdin' });
  });

  it('throws when input is undefined and there is no stdin', () => {
    expect(() => detectSource(undefined, false)).toThrow('No input provided');
  });

  it('detects http and https URLs', () => {
    expect(detectSource('https://example.com/page', false)).toEqual({ kind: 'url', locator: 'https://example.com/page' });
    expect(detectSource('http://example.com/feed.xml', true)).toEqual({ kind: 'url', locator: 'http://example.com/feed.xml' });
  });

  it('detects an existing directory', () => {
    expect(detectSource(tempDir, false)).toEqual({ kind: 'directory', locator: tempDir });
  });

  it('detects an existing file', () => {
    expect(detectSource(tempFile, false)).toEqual({ kind: 'file', locator: tempFile });
  });

  it('falls back to text for anything else', () => {
    expect(detectSource('Bun 1.2 shipped native S3 support', false)).toEqual({ kind: 'text', locator: 'Bun 1.2 shipped native S3 support' });
    expect(detectSource(join(tempDir, 'does-not-exist.txt'), false).kind).toBe('text');
  });

  it('prefers URL detection over text for URL-shaped input even with stdin available', () => {
    expect(detectSource('https://example.com', true).kind).toBe('url');
  });
});
