import { describe, it, expect, afterEach } from 'bun:test';

import {
  extractFirstFile,
  toRelativePath,
  groupByDate,
  formatDate,
  formatTime,
  formatDateTime,
  formatHeaderDateTime,
  formatSystemLocaleDateTime,
} from '../../src/shared/timeline-formatting.js';

describe('toRelativePath', () => {
  const home = '/Users/test';
  const cwd = '/Users/test/Code/org/team/repo/packages/app';

  it('keeps files inside the project relative to it', () => {
    expect(toRelativePath(`${cwd}/src/index.ts`, cwd, home)).toBe('src/index.ts');
  });

  it('labels files outside the project but under home as ~/...', () => {
    expect(toRelativePath('/Users/test/.ssh/config', cwd, home)).toBe('~/.ssh/config');
    expect(toRelativePath('/Users/test/.gemini/settings.json', cwd, home)).toBe('~/.gemini/settings.json');
  });

  it('keeps an absolute path for files outside both the project and home', () => {
    expect(toRelativePath('/etc/hosts', cwd, home)).toBe('/etc/hosts');
  });

  it('does not mistake a sibling directory with a shared prefix for home', () => {
    expect(toRelativePath('/Users/tester/notes.md', cwd, home)).toBe('/Users/tester/notes.md');
  });

  it('leaves relative input untouched', () => {
    expect(toRelativePath('src/app.ts', cwd, home)).toBe('src/app.ts');
  });
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
      { id: 1, date: new Date(2025, 0, 4, 10).toISOString() },
      { id: 2, date: new Date(2025, 0, 4, 14).toISOString() },
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
      { id: 1, date: new Date(2025, 0, 6, 10).toISOString() },
      { id: 2, date: new Date(2025, 0, 4, 10).toISOString() },
      { id: 3, date: new Date(2025, 0, 5, 10).toISOString() },
    ];

    const result = groupByDate(items, (item) => item.date);

    const dates = Array.from(result.keys());
    expect(dates).toHaveLength(3);
    expect(dates[0]).toContain('Jan 4');
    expect(dates[1]).toContain('Jan 5');
    expect(dates[2]).toContain('Jan 6');
  });

  it('should support descending date order', () => {
    const items: TestItem[] = [
      { id: 1, date: new Date(2025, 0, 6, 10).toISOString() },
      { id: 2, date: new Date(2025, 0, 4, 10).toISOString() },
      { id: 3, date: new Date(2025, 0, 5, 10).toISOString() },
    ];

    const result = groupByDate(items, (item) => item.date, { order: 'desc' });

    const dates = Array.from(result.keys());
    expect(dates).toHaveLength(3);
    expect(dates[0]).toContain('Jan 6');
    expect(dates[1]).toContain('Jan 5');
    expect(dates[2]).toContain('Jan 4');
  });

  it('should handle items from different days correctly', () => {
    const items: TestItem[] = [
      { id: 1, date: new Date(2025, 0, 4, 10).toISOString() },
      { id: 2, date: new Date(2025, 0, 5, 10).toISOString() },
      { id: 3, date: new Date(2025, 0, 4, 15).toISOString() },
      { id: 4, date: new Date(2025, 0, 5, 20).toISOString() },
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

  it('should preserve item order within each date group', () => {
    const items: TestItem[] = [
      { id: 3, date: new Date(2025, 0, 4, 8).toISOString() },
      { id: 1, date: new Date(2025, 0, 4, 9).toISOString() },
      { id: 2, date: new Date(2025, 0, 4, 10).toISOString() },
    ];

    const result = groupByDate(items, (item) => item.date);

    const dayItems = Array.from(result.values())[0];
    expect(dayItems.map(i => i.id)).toEqual([3, 1, 2]);
  });

  it('should keep day-group encounter order with order first-seen', () => {
    const items: TestItem[] = [
      { id: 1, date: new Date(2025, 0, 6, 10).toISOString() },
      { id: 2, date: new Date(2025, 0, 4, 10).toISOString() },
      { id: 3, date: new Date(2025, 0, 5, 10).toISOString() },
    ];

    const result = groupByDate(items, (item) => item.date, { order: 'first-seen' });

    const dates = Array.from(result.keys());
    expect(dates[0]).toContain('Jan 6');
    expect(dates[1]).toContain('Jan 4');
    expect(dates[2]).toContain('Jan 5');
  });
});

describe('locale formatter fallbacks', () => {
  // Reproduce the Bun/JavaScriptCore-on-Windows failure where the runtime cannot
  // build a date formatter and every toLocale* call throws. Without the guard,
  // this throw kills the whole session-start context injection.
  const ts = '2025-01-04T21:34:56.000Z';
  let original: {
    string: typeof Date.prototype.toLocaleString;
    date: typeof Date.prototype.toLocaleDateString;
    time: typeof Date.prototype.toLocaleTimeString;
  } | null = null;

  function breakFormatters() {
    original = {
      string: Date.prototype.toLocaleString,
      date: Date.prototype.toLocaleDateString,
      time: Date.prototype.toLocaleTimeString,
    };
    const boom = () => { throw new TypeError('failed to initialize DateTimeFormat'); };
    Date.prototype.toLocaleString = boom as typeof Date.prototype.toLocaleString;
    Date.prototype.toLocaleDateString = boom as typeof Date.prototype.toLocaleDateString;
    Date.prototype.toLocaleTimeString = boom as typeof Date.prototype.toLocaleTimeString;
  }

  afterEach(() => {
    if (original) {
      Date.prototype.toLocaleString = original.string;
      Date.prototype.toLocaleDateString = original.date;
      Date.prototype.toLocaleTimeString = original.time;
      original = null;
    }
  });

  it('formatDate falls back to an ISO date', () => {
    breakFormatters();
    expect(formatDate(ts)).toBe('2025-01-04');
  });

  it('formatTime falls back to an AM/PM time the timeline parser can read', () => {
    breakFormatters();
    expect(formatTime(ts)).toBe('9:34 PM');
  });

  it('formatTime fallback keeps midnight and noon as 12', () => {
    breakFormatters();
    expect(formatTime('2025-01-04T00:05:00.000Z')).toBe('12:05 AM');
    expect(formatTime('2025-01-04T12:00:00.000Z')).toBe('12:00 PM');
  });

  it('formatDateTime falls back to an ISO date with an AM/PM time', () => {
    breakFormatters();
    expect(formatDateTime(ts)).toBe('2025-01-04 9:34 PM');
  });

  it('formatHeaderDateTime falls back to a date-time with UTC', () => {
    breakFormatters();
    expect(formatHeaderDateTime(new Date(ts))).toBe('2025-01-04 9:34 PM UTC');
  });

  it('formatSystemLocaleDateTime prints what a bare toLocaleString prints while the formatter works', () => {
    expect(formatSystemLocaleDateTime(ts)).toBe(new Date(ts).toLocaleString());
  });

  it('formatSystemLocaleDateTime falls back to an ISO date and a UTC clock, keeping the year', () => {
    breakFormatters();
    expect(formatSystemLocaleDateTime(ts)).toBe('2025-01-04 9:34 PM UTC');
    expect(formatSystemLocaleDateTime(Date.parse(ts))).toBe('2025-01-04 9:34 PM UTC');
  });

  it('returns Invalid Date for unparseable input when the formatter throws', () => {
    breakFormatters();
    expect(formatDate('not a date')).toBe('Invalid Date');
  });
});
