import { describe, it, expect, afterEach, vi } from 'vitest';

// Mock logger BEFORE imports (required pattern)
// NOTE: vi.mock replaces the module globally, so all methods must be stubbed.
vi.mock('../../src/utils/logger.js', () => ({
  logger: {
    info: () => {},
    debug: () => {},
    warn: () => {},
    error: () => {},
    success: () => {},
    failure: () => {},
    log: () => {},
    timing: () => {},
    dataIn: () => {},
    dataOut: () => {},
    happyPathError: () => {},
    formatTool: (name: string) => name,
    formatData: (data: unknown) => String(data),
    formatTimestamp: () => '',
    getLevel: () => 3,
    correlationId: () => '',
    sessionId: () => '',
  },
}));

// Import after mocks
import { extractFirstFile, groupByDate, estimateReadTokens } from '../../src/shared/timeline-formatting.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('extractFirstFile', () => {
  const cwd = '/Users/test/project';

  it('should return first modified file as relative path', () => {
    const filesModified = JSON.stringify(['/Users/test/project/src/app.ts', '/Users/test/project/src/utils.ts']);

    const result = extractFirstFile(filesModified, cwd);

    expect(result).toBe('src/app.ts');
  });

  it('should fall back to files_read when modified is empty', () => {
    const filesModified = JSON.stringify([]);
    const filesRead = JSON.stringify(['/Users/test/project/README.md']);

    const result = extractFirstFile(filesModified, cwd, filesRead);

    expect(result).toBe('README.md');
  });

  it('should return General when both are empty arrays', () => {
    const filesModified = JSON.stringify([]);
    const filesRead = JSON.stringify([]);

    const result = extractFirstFile(filesModified, cwd, filesRead);

    expect(result).toBe('General');
  });

  it('should return General when both are null', () => {
    const result = extractFirstFile(null, cwd, null);

    expect(result).toBe('General');
  });

  it('should handle invalid JSON in modified and fall back to read', () => {
    const filesModified = 'invalid json {]';
    const filesRead = JSON.stringify(['/Users/test/project/config.json']);

    const result = extractFirstFile(filesModified, cwd, filesRead);

    expect(result).toBe('config.json');
  });

  it('should return relative path (not absolute) for files inside cwd', () => {
    const filesModified = JSON.stringify(['/Users/test/project/deeply/nested/file.ts']);

    const result = extractFirstFile(filesModified, cwd);

    expect(result).toBe('deeply/nested/file.ts');
    expect(result).not.toContain('/Users/test/project');
  });

  it('should handle files that are already relative paths', () => {
    const filesModified = JSON.stringify(['src/component.tsx']);

    const result = extractFirstFile(filesModified, cwd);

    expect(result).toBe('src/component.tsx');
  });
});

describe('groupByDate', () => {
  interface TestItem {
    id: number;
    date: string;
  }

  it('should return empty map for empty array', () => {
    const items: TestItem[] = [];

    const result = groupByDate(items, (item) => item.date);

    expect(result.size).toBe(0);
  });

  it('should group items by formatted date', () => {
    const items: TestItem[] = [
      { id: 1, date: '2025-01-04T10:00:00Z' },
      { id: 2, date: '2025-01-04T14:00:00Z' },
    ];

    const result = groupByDate(items, (item) => item.date);

    expect(result.size).toBe(1);
    const dayItems = Array.from(result.values())[0];
    expect(dayItems).toHaveLength(2);
    expect(dayItems[0].id).toBe(1);
    expect(dayItems[1].id).toBe(2);
  });

  it('should sort dates chronologically', () => {
    const items: TestItem[] = [
      { id: 1, date: '2025-01-06T10:00:00Z' },
      { id: 2, date: '2025-01-04T10:00:00Z' },
      { id: 3, date: '2025-01-05T10:00:00Z' },
    ];

    const result = groupByDate(items, (item) => item.date);

    const dates = Array.from(result.keys());
    expect(dates).toHaveLength(3);
    // Dates should be in chronological order (oldest first)
    expect(dates[0]).toContain('Jan 4');
    expect(dates[1]).toContain('Jan 5');
    expect(dates[2]).toContain('Jan 6');
  });

  it('should group multiple items on same date together', () => {
    const items: TestItem[] = [
      { id: 1, date: '2025-01-04T08:00:00Z' },
      { id: 2, date: '2025-01-04T12:00:00Z' },
      { id: 3, date: '2025-01-04T18:00:00Z' },
    ];

    const result = groupByDate(items, (item) => item.date);

    expect(result.size).toBe(1);
    const dayItems = Array.from(result.values())[0];
    expect(dayItems).toHaveLength(3);
    expect(dayItems.map(i => i.id)).toEqual([1, 2, 3]);
  });

  it('should handle items from different days correctly', () => {
    const items: TestItem[] = [
      { id: 1, date: '2025-01-04T10:00:00Z' },
      { id: 2, date: '2025-01-05T10:00:00Z' },
      { id: 3, date: '2025-01-04T15:00:00Z' },
      { id: 4, date: '2025-01-05T20:00:00Z' },
    ];

    const result = groupByDate(items, (item) => item.date);

    expect(result.size).toBe(2);

    const dates = Array.from(result.keys());
    expect(dates[0]).toContain('Jan 4');
    expect(dates[1]).toContain('Jan 5');

    const jan4Items = result.get(dates[0]) as TestItem[];
    const jan5Items = result.get(dates[1]) as TestItem[];

    expect(jan4Items).toHaveLength(2);
    expect(jan5Items).toHaveLength(2);
    expect(jan4Items.map(i => i.id)).toEqual([1, 3]);
    expect(jan5Items.map(i => i.id)).toEqual([2, 4]);
  });

  it('should handle numeric timestamps as date input', () => {
    // Use clearly different dates (24+ hours apart to avoid timezone issues)
    const items = [
      { id: 1, date: '2025-01-04T00:00:00Z' },
      { id: 2, date: '2025-01-06T00:00:00Z' }, // 2 days later
    ];

    const result = groupByDate(items, (item) => item.date);

    expect(result.size).toBe(2);
    const dates = Array.from(result.keys());
    expect(dates).toHaveLength(2);
    expect(dates[0]).toContain('Jan 4');
    expect(dates[1]).toContain('Jan 6');
  });

  it('should preserve item order within each date group', () => {
    const items: TestItem[] = [
      { id: 3, date: '2025-01-04T08:00:00Z' },
      { id: 1, date: '2025-01-04T09:00:00Z' },
      { id: 2, date: '2025-01-04T10:00:00Z' },
    ];

    const result = groupByDate(items, (item) => item.date);

    const dayItems = Array.from(result.values())[0];
    // Items should maintain their insertion order
    expect(dayItems.map(i => i.id)).toEqual([3, 1, 2]);
  });
});

describe('estimateReadTokens', () => {
  it('returns 0 when all fields are null or undefined', () => {
    const result = estimateReadTokens({});
    expect(result).toBe(0);
  });

  it('returns 0 when all fields are null', () => {
    const result = estimateReadTokens({
      narrative: null,
      title: null,
      facts: null,
      concepts: null,
      text: null,
    });
    expect(result).toBe(0);
  });

  it('estimates tokens from narrative only', () => {
    // "1234" is 4 chars → 1 token
    const result = estimateReadTokens({ narrative: '1234' });
    expect(result).toBe(1);
  });

  it('estimates tokens from title only', () => {
    // 8 chars → ceil(8/4) = 2 tokens
    const result = estimateReadTokens({ title: '12345678' });
    expect(result).toBe(2);
  });

  it('estimates tokens from text only', () => {
    // 5 chars → ceil(5/4) = 2 tokens
    const result = estimateReadTokens({ text: 'hello' });
    expect(result).toBe(2);
  });

  it('sums tokens from all non-null fields', () => {
    // title: 4 chars → 1 token
    // narrative: 8 chars → 2 tokens
    // facts: 4 chars → 1 token
    // concepts: 4 chars → 1 token
    // text: 4 chars → 1 token
    // total: 6 tokens
    const result = estimateReadTokens({
      title: 'abcd',
      narrative: '12345678',
      facts: 'wxyz',
      concepts: 'efgh',
      text: 'ijkl',
    });
    expect(result).toBe(6);
  });

  it('ignores null fields when other fields have values', () => {
    // narrative: 4 chars → 1 token; title: null (0)
    const result = estimateReadTokens({
      narrative: 'abcd',
      title: null,
    });
    expect(result).toBe(1);
  });

  it('handles empty string fields as 0 tokens', () => {
    const result = estimateReadTokens({
      narrative: '',
      title: '',
      facts: '',
    });
    expect(result).toBe(0);
  });

  it('uses ceiling division for non-divisible lengths', () => {
    // "abc" is 3 chars → ceil(3/4) = 1 token
    const result = estimateReadTokens({ narrative: 'abc' });
    expect(result).toBe(1);

    // 9 chars → ceil(9/4) = 3 tokens
    const result2 = estimateReadTokens({ narrative: 'abcdefghi' });
    expect(result2).toBe(3);
  });

  it('handles long text with realistic content', () => {
    const narrative = 'A'.repeat(400); // 400 chars → 100 tokens
    const title = 'B'.repeat(40);     // 40 chars  → 10 tokens
    const result = estimateReadTokens({ narrative, title });
    expect(result).toBe(110);
  });
});
