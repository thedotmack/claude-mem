
import path from 'path';
import { logger } from '../utils/logger.js';

export function parseJsonArray(json: string | null): string[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err: unknown) {
    logger.debug('PARSER', 'Failed to parse JSON array, using empty fallback', {
      preview: json?.substring(0, 50)
    }, err instanceof Error ? err : new Error(String(err)));
    return [];
  }
}

// Some runtimes (Bun/JavaScriptCore on Windows with an unresolvable system time
// zone) throw `failed to initialize DateTimeFormat` from toLocale* calls. These
// helpers run inside the session-start context build, so a throw there loses the
// whole memory injection. Fall back to a fixed date/time instead of failing.
function guardInvalid(date: Date, build: (date: Date) => string): string {
  if (Number.isNaN(date.getTime())) return 'Invalid Date';
  return build(date);
}

// The 12-hour clock the folder-timeline parser (claude-md-utils) reads back: it
// matches only `H:MM AM/PM`, so a 24-hour fallback would drop the row's time and
// leave it at the day header's midnight. Uses UTC because the local zone is the
// thing that failed.
function isoClock(date: Date): string {
  const hours = date.getUTCHours();
  const period = hours < 12 ? 'AM' : 'PM';
  const minutes = date.getUTCMinutes().toString().padStart(2, '0');
  return `${hours % 12 || 12}:${minutes} ${period}`;
}

function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function safeFormat(format: () => string, fallback: () => string): string {
  try {
    return format();
  } catch (err: unknown) {
    logger.debug('PARSER', 'Locale date formatter unavailable, using ISO fallback', {},
      err instanceof Error ? err : new Error(String(err)));
    return fallback();
  }
}

export function formatDateTime(dateInput: string | number): string {
  const date = new Date(dateInput);
  return safeFormat(
    () => date.toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true
    }),
    () => guardInvalid(date, d => `${isoDay(d)} ${isoClock(d)}`)
  );
}

export function formatTime(dateInput: string | number): string {
  const date = new Date(dateInput);
  return safeFormat(
    () => date.toLocaleString('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      hour12: true
    }),
    () => guardInvalid(date, isoClock)
  );
}

export function formatDate(dateInput: string | number): string {
  const date = new Date(dateInput);
  return safeFormat(
    () => date.toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric'
    }),
    () => guardInvalid(date, isoDay)
  );
}

export function formatHeaderDateTime(now: Date = new Date()): string {
  return safeFormat(
    () => {
      const date = now.toLocaleDateString('en-CA');
      const time = now.toLocaleTimeString('en-US', {
        hour: 'numeric',
        minute: '2-digit',
        hour12: true
      }).toLowerCase().replace(' ', '');
      const tz = now.toLocaleTimeString('en-US', { timeZoneName: 'short' }).split(' ').pop();
      return `${date} ${time} ${tz}`;
    },
    () => guardInvalid(now, d => `${isoDay(d)} ${isoClock(d)} UTC`)
  );
}

export function toRelativePath(filePath: string, cwd: string): string {
  if (path.isAbsolute(filePath)) {
    return path.relative(cwd, filePath);
  }
  return filePath;
}

export function extractFirstFile(
  filesModified: string | null,
  cwd: string,
  filesRead?: string | null
): string {
  const modified = parseJsonArray(filesModified);
  if (modified.length > 0) {
    return toRelativePath(modified[0], cwd);
  }

  if (filesRead) {
    const read = parseJsonArray(filesRead);
    if (read.length > 0) {
      return toRelativePath(read[0], cwd);
    }
  }

  return 'General';
}

export function estimateTokens(text: string | null): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

export function groupByDate<T>(
  items: T[],
  getDate: (item: T) => string
): Map<string, T[]> {
  const itemsByDay = new Map<string, T[]>();
  for (const item of items) {
    const itemDate = getDate(item);
    const day = formatDate(itemDate);
    if (!itemsByDay.has(day)) {
      itemsByDay.set(day, []);
    }
    itemsByDay.get(day)!.push(item);
  }

  const sortedEntries = Array.from(itemsByDay.entries()).sort((a, b) => {
    const aDate = new Date(a[0]).getTime();
    const bDate = new Date(b[0]).getTime();
    return aDate - bDate;
  });

  return new Map(sortedEntries);
}
