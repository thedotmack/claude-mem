import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { searchCodebase, formatSearchResults } from '../../../src/services/smart-file-read/search.js';

async function searchFiles(files: Record<string, string>, query: string, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'smart-search-path-'));
  try {
    for (const [relativePath, content] of Object.entries(files)) {
      mkdirSync(join(dir, dirname(relativePath)), { recursive: true });
      writeFileSync(join(dir, relativePath), content);
    }
    return await searchCodebase(dir, query, options);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const billingFiles = {
  'billing/invoice-ledger.js': 'export function salutation() { return 1; }\n',
  'billing/receipt.js': 'export function render() { return 2; }\n',
};
const search = (query: string, options = {}) => searchFiles(billingFiles, query, options);

describe('smart search path matches', () => {
  test('lists a filename match on one line when no symbol name matches', async () => {
    const result = await search('invoice-ledger');
    expect(result.matchingFiles.map(file => file.filePath)).toEqual(['billing/invoice-ledger.js']);
    expect(result.foldedFiles).toEqual([]);
    expect(result.matchingSymbols).toEqual([]);
    expect(result.tokenEstimate).toBe(0);
    const [file] = result.matchingFiles;
    expect(file.language).toBe('javascript');
    expect(file.totalLines).toBe(2);
    expect(file.foldedTokenEstimate).toBeGreaterThan(0);
    const output = formatSearchResults(result, 'invoice-ledger');
    expect(output).toContain('0 symbol matches; 0 matched files (~0 tokens for folded view); 1 file matched by path only');
    expect(output).toContain('── Matching Files ──');
    expect(output).toContain(`  billing/invoice-ledger.js (javascript, 2 lines, ~${file.foldedTokenEstimate} tokens folded) — smart_outline to expand`);
    expect(output).not.toContain('── Folded File Views ──');
    expect(output).not.toContain('📁');
  }, 120000);
  test('lists directory matches within the requested result limit', async () => {
    const result = await search('billing', { maxResults: 1 });
    expect(result.matchingFiles).toHaveLength(1);
    expect(result.matchingFiles[0].filePath).toStartWith('billing/');
    expect(result.foldedFiles).toEqual([]);
    expect(result.matchingSymbols).toEqual([]);
    expect(formatSearchResults(result, 'billing')).toContain(result.matchingFiles[0].filePath);
  }, 120000);
  test('continues returning symbol matches and their folded files', async () => {
    const result = await search('salutation');
    expect(result.foldedFiles.map(file => file.filePath)).toEqual(['billing/invoice-ledger.js']);
    expect(result.matchingSymbols.map(symbol => symbol.symbolName)).toEqual(['salutation']);
    expect(result.matchingFiles).toEqual([]);
    expect(formatSearchResults(result, 'salutation')).not.toContain('── Matching Files ──');
  }, 120000);
  test('continues applying an explicit file pattern', async () => {
    const result = await search('invoice-ledger', { filePattern: 'receipt' });
    expect(result.foldedFiles).toEqual([]);
    expect(result.matchingFiles).toEqual([]);
    expect(result.totalFilesScanned).toBe(1);
  }, 120000);
  test('does not return files for an unmatched query', async () => {
    const result = await search('zzzzqqqq');
    expect(result.foldedFiles).toEqual([]);
    expect(result.matchingFiles).toEqual([]);
    expect(result.matchingSymbols).toEqual([]);
    expect(formatSearchResults(result, 'zzzzqqqq')).toContain('No matching symbols or files found.');
  }, 120000);
  // "bng" is a subsequence of "billing", not a substring. Fuzzy path hits would
  // flood common words ("store" fuzzily matches most paths in a large repo).
  test('a fuzzy-only path subsequence is not a path match', async () => {
    const result = await search('bng');
    expect(result.foldedFiles).toEqual([]);
    expect(result.matchingFiles).toEqual([]);
  }, 120000);
  test('a query with no searchable parts lists no files', async () => {
    const result = await search(' / ');
    expect(result.matchingFiles).toEqual([]);
  }, 120000);
});

test('keeps symbol files folded and lists other path hits on one line each', async () => {
  const files = {
    'billing/a.js': 'export function salutation() { return 1; }\n',
    'billing/z.js': 'export function billingReport() { return 2; }\n',
  };
  const one = await searchFiles(files, 'billing', { maxResults: 1 });
  expect(one.matchingSymbols.map(symbol => symbol.symbolName)).toEqual(['billingReport']);
  expect(one.foldedFiles.map(file => file.filePath)).toEqual(['billing/z.js']);
  expect(one.matchingFiles.map(file => file.filePath)).toEqual(['billing/a.js']);
  const two = await searchFiles(files, 'billing', { maxResults: 2 });
  expect(two.foldedFiles.map(file => file.filePath)).toEqual(['billing/z.js']);
  expect(two.matchingFiles.map(file => file.filePath)).toEqual(['billing/a.js']);
  const symbolFiles = new Set(two.matchingSymbols.map(symbol => symbol.filePath));
  expect(two.foldedFiles.every(file => symbolFiles.has(file.filePath))).toBe(true);
  expect(two.tokenEstimate).toBe(two.foldedFiles[0].foldedTokenEstimate);
  const output = formatSearchResults(two, 'billing');
  expect(output).toContain('1 symbol match; 1 matched file');
  expect(output).toContain('1 file matched by path only');
  expect(output.indexOf('── Folded File Views ──')).toBeLessThan(output.indexOf('── Matching Files ──'));
  expect(output.match(/📁/g)).toHaveLength(1);
}, 120000);

test('ranks file-name hits above directory-only hits before capping', async () => {
  const files = {
    'billing/a.js': 'export function render() { return 1; }\n',
    'reports/billing-summary.js': 'export function render() { return 2; }\n',
    'reports/billing.js': 'export function render() { return 3; }\n',
  };
  const all = await searchFiles(files, 'billing');
  expect(all.matchingFiles.map(file => file.filePath))
    .toEqual(['reports/billing.js', 'reports/billing-summary.js', 'billing/a.js']);
  const capped = await searchFiles(files, 'billing', { maxResults: 1 });
  expect(capped.matchingFiles.map(file => file.filePath)).toEqual(['reports/billing.js']);
}, 120000);
