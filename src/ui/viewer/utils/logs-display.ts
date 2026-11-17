/**
 * The logs drawer's reading of the worker's log text (GET /api/logs): lines, their
 * level and component, the filters, the counts and what the list area shows.
 * Pure, so tests/viewer/logs-display.test.ts can check it without a browser.
 */
import { hasEveryWord } from './search';

/** The logger's levels (src/utils/logger.ts), lowest first. */
export const LOG_LEVEL_KEYS = ['DEBUG', 'INFO', 'WARN', 'ERROR'] as const;
export type LogLevel = (typeof LOG_LEVEL_KEYS)[number];

/**
 * The components with a chip of their own. The logger has more components than
 * this; every other one (QUEUE, INGEST, CHROMA_SYNC, …) is filtered by OTHER.
 */
export const LOG_COMPONENT_KEYS = ['HOOK', 'WORKER', 'SDK', 'PARSER', 'DB', 'SYSTEM', 'HTTP', 'SESSION', 'CHROMA', 'OTHER'] as const;
export type LogComponent = (typeof LOG_COMPONENT_KEYS)[number];

const LISTED_COMPONENTS = new Set<string>(LOG_COMPONENT_KEYS);

/** A message the logger marks with a leading arrow, tick, cross or clock, or the [HAPPY-PATH] tag. */
export type LogMessageMark = 'dataIn' | 'dataOut' | 'success' | 'failure' | 'timing' | 'happyPath';

export interface ParsedLogLine {
  /** Stable while the line stays in the loaded window, so an opened row stays open across refreshes. */
  key: string;
  raw: string;
  /** "2026-11-16 18:12:41.118"; absent on a line that continues the record above it (a stack or a payload). */
  timestamp?: string;
  /** The record's level and component; a continuation line takes its record's. */
  level?: string;
  component?: string;
  correlationId?: string;
  message?: string;
  mark?: LogMessageMark;
}

const RECORD_PATTERN = /^\[([^\]]+)\]\s+\[(\w+)\s*\]\s+\[(\w+)\s*\]\s+(?:\[([^\]]+)\]\s+)?(.*)$/;

function messageMark(message: string): LogMessageMark | undefined {
  if (message.startsWith('→')) return 'dataIn';
  if (message.startsWith('←')) return 'dataOut';
  if (message.startsWith('✓')) return 'success';
  if (message.startsWith('✗')) return 'failure';
  if (message.startsWith('⏱')) return 'timing';
  if (message.includes('[HAPPY-PATH]')) return 'happyPath';
  return undefined;
}

/**
 * Every line of the loaded text. A line without the `[time] [LEVEL] [COMPONENT]`
 * prefix belongs to the record above it and takes that record's level and
 * component; lines before the first record (a tail that starts inside a record)
 * have neither.
 */
export function parseLogText(text: string): ParsedLogLine[] {
  if (!text) return [];
  const seen = new Map<string, number>();
  let record: ParsedLogLine | undefined;
  let offset = 0;
  return text.split('\n').map((raw, index) => {
    const match = RECORD_PATTERN.exec(raw);
    let line: ParsedLogLine;
    if (match) {
      const [, timestamp, level, component, correlationId, message] = match;
      line = { key: raw, raw, timestamp, level: level.trim(), component: component.trim(), correlationId: correlationId || undefined, message, mark: messageMark(message) };
      record = line;
      offset = 0;
    } else if (record) {
      offset += 1;
      line = { key: `${record.key}\n+${offset}`, raw, level: record.level, component: record.component };
    } else {
      line = { key: `orphan:${index}`, raw };
    }
    // Two identical records in one millisecond would share a key; number the repeats.
    const repeats = seen.get(line.key) ?? 0;
    seen.set(line.key, repeats + 1);
    if (repeats) line.key = `${line.key}#${repeats}`;
    return line;
  });
}

/** The chip that filters a component: its own, or Other. */
export function componentChip(component: string): LogComponent {
  return (LISTED_COMPONENTS.has(component) ? component : 'OTHER') as LogComponent;
}

/**
 * Entries per level in the loaded lines, whatever the filters, so the chips say
 * how many errors there are before anyone looks for them. A record counts once;
 * the stack or payload lines under it do not count again.
 */
export function countLevels(lines: ParsedLogLine[]): Record<LogLevel, number> {
  const counts: Record<LogLevel, number> = { DEBUG: 0, INFO: 0, WARN: 0, ERROR: 0 };
  for (const line of lines) {
    if (line.timestamp && line.level && line.level in counts) counts[line.level as LogLevel] += 1;
  }
  return counts;
}

export interface LogFilters {
  levels: ReadonlySet<LogLevel>;
  components: ReadonlySet<LogComponent>;
  /** The Alignment chip: only lines tagged [ALIGNMENT], whatever the level and component chips say. */
  alignmentOnly: boolean;
  query: string;
}

export function lineMatches(line: ParsedLogLine, filters: LogFilters): boolean {
  if (filters.alignmentOnly) {
    if (!line.raw.includes('[ALIGNMENT]')) return false;
  } else if (!line.level || !line.component) {
    // A line with no record above it cannot be placed: it shows only while every chip is on.
    if (filters.levels.size !== LOG_LEVEL_KEYS.length || filters.components.size !== LOG_COMPONENT_KEYS.length) return false;
  } else if (!filters.levels.has(line.level as LogLevel) || !filters.components.has(componentChip(line.component))) {
    return false;
  }
  return hasEveryWord(line.raw, filters.query);
}

/**
 * What the drawer's list area shows. One writer: logsViewState() below.
 *
 *   loading ──first read arrives──> loaded | empty
 *   loading ──first read fails────> failed ──Refresh──> loading
 *   loaded ──filters hide every line──> no-match ──filters widen──> loaded
 *   loaded ──the search finds no line──> no-search-match ──search changes──> loaded
 *   loaded ──Clear logs──> empty
 *
 * Before 16.0 the drawer said "No logs available yet." while its first read was
 * still on the way (B3). A refresh while lines are shown keeps them; a failed
 * refresh keeps them too, with its reason in the error line above the list.
 */
export const LOGS_VIEW_STATES = ['loading', 'failed', 'empty', 'no-match', 'no-search-match', 'loaded'] as const;
export type LogsViewState = (typeof LOGS_VIEW_STATES)[number];

/**
 * The words in the list area for each state, in the reader's language; `loaded` draws rows instead.
 * Literal t() keys, so tests/ui-i18n.test.ts checks each one has its translations.
 */
export const LOGS_VIEW_STATE_WORDS: Record<LogsViewState, ((t: (english: string) => string) => string) | null> = {
  loading: t => t('Loading logs…'),
  failed: t => t('The logs could not be read.'),
  empty: t => t('No logs available yet.'),
  'no-match': t => t('No logs match these filters. Select more levels or components.'),
  'no-search-match': t => t('No loaded line has these words. Change the search or clear it.'),
  loaded: null,
};

export function logsViewState({ hasRead, readFailed, isLoading, lineCount, shownCount, searching }: {
  /** A read has succeeded since the drawer was first opened (or the logs were cleared). */
  hasRead: boolean;
  /** The last read failed. */
  readFailed: boolean;
  /** A read is on its way (a retry after a failure shows as loading again). */
  isLoading: boolean;
  lineCount: number;
  shownCount: number;
  searching: boolean;
}): LogsViewState {
  if (!hasRead) return readFailed && !isLoading ? 'failed' : 'loading';
  if (lineCount === 0) return 'empty';
  if (shownCount > 0) return 'loaded';
  return searching ? 'no-search-match' : 'no-match';
}

/** "18:12:41.118" out of "2026-11-16 18:12:41.118": the day is the log file's own (today's). */
export function timeOfDay(timestamp: string): string {
  const space = timestamp.lastIndexOf(' ');
  return space === -1 ? timestamp : timestamp.slice(space + 1);
}

/** "claude-mem-2026-11-16.log" out of the file path the worker reports. */
export function logFileName(path: string | undefined): string | null {
  if (!path) return null;
  const name = path.split(/[\\/]/).pop();
  return name || null;
}
