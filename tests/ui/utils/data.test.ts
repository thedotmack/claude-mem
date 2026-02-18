/**
 * Tests for data utility functions
 *
 * Tests the mergeAndDeduplicateByProject utility used for merging
 * real-time SSE items with paginated data.
 */

import { describe, it, expect } from 'vitest';
import { mergeAndDeduplicateByProject } from '../../../src/ui/viewer/utils/data';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

interface TestItem {
  id: number;
  project?: string;
  label: string;
}

function makeItem(id: number, project?: string, label?: string): TestItem {
  return { id, project, label: label ?? `item-${id}` };
}

// ---------------------------------------------------------------------------
// mergeAndDeduplicateByProject tests
// ---------------------------------------------------------------------------

describe('mergeAndDeduplicateByProject', () => {
  it('returns empty array when both inputs are empty', () => {
    const result = mergeAndDeduplicateByProject<TestItem>([], []);
    expect(result).toEqual([]);
  });

  it('returns live items when paginated is empty', () => {
    const live = [makeItem(1), makeItem(2)];
    const result = mergeAndDeduplicateByProject(live, []);
    expect(result).toEqual(live);
  });

  it('returns paginated items when live is empty', () => {
    const paginated = [makeItem(3), makeItem(4)];
    const result = mergeAndDeduplicateByProject([], paginated);
    expect(result).toEqual(paginated);
  });

  it('deduplicates by id, keeping live items over paginated', () => {
    const live = [makeItem(1, 'proj', 'live-1')];
    const paginated = [makeItem(1, 'proj', 'paginated-1'), makeItem(2, 'proj', 'paginated-2')];
    const result = mergeAndDeduplicateByProject(live, paginated);

    expect(result).toHaveLength(2);
    expect(result[0].label).toBe('live-1'); // live item wins
    expect(result[1].label).toBe('paginated-2');
  });

  it('handles items without project field', () => {
    const live = [makeItem(1, undefined, 'no-project')];
    const paginated = [makeItem(2, undefined, 'also-no-project')];
    const result = mergeAndDeduplicateByProject(live, paginated);

    expect(result).toHaveLength(2);
  });

  it('handles overlapping IDs across different projects', () => {
    // Same ID but different project — still deduplicated by ID only
    const live = [makeItem(1, 'project-a', 'live-a')];
    const paginated = [makeItem(1, 'project-b', 'paginated-b')];
    const result = mergeAndDeduplicateByProject(live, paginated);

    expect(result).toHaveLength(1);
    expect(result[0].label).toBe('live-a'); // live item wins by ID
  });

  it('preserves order: live items first, then paginated', () => {
    const live = [makeItem(3), makeItem(1)];
    const paginated = [makeItem(2), makeItem(4)];
    const result = mergeAndDeduplicateByProject(live, paginated);

    expect(result.map(r => r.id)).toEqual([3, 1, 2, 4]);
  });

  it('does not mutate input arrays', () => {
    const live = [makeItem(1)];
    const paginated = [makeItem(2)];
    const liveCopy = [...live];
    const paginatedCopy = [...paginated];

    mergeAndDeduplicateByProject(live, paginated);

    expect(live).toEqual(liveCopy);
    expect(paginated).toEqual(paginatedCopy);
  });

  it('handles large arrays without error', () => {
    const live = Array.from({ length: 500 }, (_, i) => makeItem(i));
    const paginated = Array.from({ length: 500 }, (_, i) => makeItem(i + 250));
    const result = mergeAndDeduplicateByProject(live, paginated);

    // 500 unique from live + 250 unique from paginated (250-749)
    expect(result).toHaveLength(750);
  });
});
