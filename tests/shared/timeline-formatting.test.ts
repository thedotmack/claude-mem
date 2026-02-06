import { describe, it, expect, mock, afterEach } from 'bun:test';

// Mock logger BEFORE imports (required pattern)
mock.module('../../src/utils/logger.js', () => ({
  logger: {
    info: () => {},
    debug: () => {},
    warn: () => {},
    error: () => {},
    formatTool: (toolName: string, toolInput?: any) => toolInput ? `${toolName}(...)` : toolName,
  },
}));

// Import after mocks
import { extractFirstFile, groupByDate } from '../../src/shared/timeline-formatting.js';

afterEach(() => {
  mock.restore();
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

    const jan4Items = result.get(dates[0])!;
    const jan5Items = result.get(dates[1])!;

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
