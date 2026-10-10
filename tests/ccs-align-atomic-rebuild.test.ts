import { test, expect, spyOn } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { landObservationsInMiddleCache, rebuildMiddleCache, readMiddleCache } from '../src/services/integrations/CcsAlignMiddleCache';

test('a failed replacement write preserves the previous middle cache', () => {
  const root = mkdtempSync(join(tmpdir(), 'align-rebuild-'));
  const input = { dataRoot: root, viewerId: 'test', observations: [{ id: 1, type: 'discovery', title: 'Original' }] };
  const first = landObservationsInMiddleCache(input);
  const original = readFileSync(first.cachePath, 'utf8');
  const clock = spyOn(Date, 'now').mockReturnValue(123456);
  // A real filesystem error at the temporary-write boundary (EISDIR).
  mkdirSync(`${first.cachePath}.${process.pid}.123456.tmp`);
  try {
    const result = rebuildMiddleCache({ ...input, observations: [{ id: 2, type: 'discovery', title: 'New' }] });
    expect(result.appended).toEqual([]);
    expect(readFileSync(first.cachePath, 'utf8')).toBe(original);
  } finally { clock.mockRestore(); rmSync(root, { recursive: true, force: true }); }
});

test('rebuild replaces prior IDs and an empty rebuild clears prior records', () => {
  const root = mkdtempSync(join(tmpdir(), 'align-rebuild-'));
  const input = { dataRoot: root, viewerId: 'test', observations: [{ id: 1, type: 'discovery', title: 'Original' }] };
  try {
    const first = landObservationsInMiddleCache(input);
    rebuildMiddleCache({ ...input, observations: [{ id: 1, type: 'discovery', title: 'Updated' }] });
    expect(readMiddleCache(first.cachePath).map(row => row.title)).toEqual(['Updated']);
    rebuildMiddleCache({ ...input, observations: [] });
    expect(readMiddleCache(first.cachePath)).toEqual([]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
