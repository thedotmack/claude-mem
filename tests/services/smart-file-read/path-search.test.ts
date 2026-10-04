import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { searchCodebase, formatSearchResults } from '../../../src/services/smart-file-read/search.js';

async function search(query: string, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'smart-search-path-'));
  try {
    mkdirSync(join(dir, 'billing'));
    writeFileSync(join(dir, 'billing', 'invoice-ledger.js'), 'export function salutation() { return 1; }\n');
    writeFileSync(join(dir, 'billing', 'receipt.js'), 'export function render() { return 2; }\n');
    return await searchCodebase(dir, query, options);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('smart search path matches', () => {
  test('retains filename matches when no symbol name matches', async () => {
    const result = await search('invoice-ledger');
    expect(result.foldedFiles.map(file => file.filePath)).toEqual(['billing/invoice-ledger.js']);
    expect(result.matchingSymbols).toEqual([]);
    expect(result.tokenEstimate).toBeGreaterThan(0);
    const output = formatSearchResults(result, "invoice-ledger");
    expect(output).toContain("── Folded File Views ──");
    expect(output).toContain("billing/invoice-ledger.js");
  }, 120000);
  test('retains directory matches within the requested result limit', async () => {
    const result = await search('billing', { maxResults: 1 });
    expect(result.foldedFiles).toHaveLength(1);
    expect(result.foldedFiles[0].filePath).toStartWith('billing/');
    expect(result.matchingSymbols).toEqual([]);
    expect(formatSearchResults(result, "billing")).toContain(result.foldedFiles[0].filePath);
  }, 120000);
  test('continues returning symbol matches and their folded files', async () => {
    const result = await search('salutation');
    expect(result.foldedFiles.map(file => file.filePath)).toEqual(['billing/invoice-ledger.js']);
    expect(result.matchingSymbols.map(symbol => symbol.symbolName)).toEqual(['salutation']);
  }, 120000);
  test('continues applying an explicit file pattern', async () => {
    const result = await search('invoice-ledger', { filePattern: 'receipt' });
    expect(result.foldedFiles).toEqual([]);
    expect(result.totalFilesScanned).toBe(1);
  }, 120000);
  test('does not return files for an unmatched query', async () => {
    const result = await search('zzzzqqqq');
    expect(result.foldedFiles).toEqual([]);
    expect(result.matchingSymbols).toEqual([]);
  }, 120000);
});
