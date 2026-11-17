import { describe, expect, it } from 'bun:test';
import {
  LOG_COMPONENT_KEYS, LOG_LEVEL_KEYS, LOGS_VIEW_STATES, LOGS_VIEW_STATE_WORDS, componentChip, countLevels,
  lineMatches, logFileName, logsViewState, parseLogText, timeOfDay, type LogFilters,
} from '../../src/ui/viewer/utils/logs-display';
import { hasEveryWord } from '../../src/ui/viewer/utils/search';
import { formatShortTime } from '../../src/ui/viewer/utils/formatters';

const record = (time: string, level: string, component: string, message: string) => `[2026-11-16 ${time}] [${level.padEnd(5)}] [${component.padEnd(6)}] ${message}`;

const TEXT = [
  '    "OWNED_PAYLOAD_TAIL"', // a tail that starts inside a record: no record above it
  record('18:12:41.118', 'ERROR', 'WORKER', 'reviews: database is locked'),
  '  Error: database is locked',
  '    at step (db.ts:1:1)',
  record('18:12:42.001', 'WARN', 'QUEUE', '[session-151155] queue depth 69'),
  record('18:12:43.002', 'INFO', 'HOOK', '✓ Drained hook spool'),
  record('18:12:44.003', 'DEBUG', 'SDK', '→ request sent'),
].join('\n');

const allOn = (): LogFilters => ({ levels: new Set(LOG_LEVEL_KEYS), components: new Set(LOG_COMPONENT_KEYS), alignmentOnly: false, query: '' });

describe('logs drawer: reading the log text', () => {
  it('gives a stack or payload line its record\'s level and component, and leaves a line before any record without them', () => {
    const lines = parseLogText(TEXT);
    expect(lines).toHaveLength(7);
    expect([lines[0].raw, lines[0].level, lines[0].component, lines[0].timestamp]).toEqual(['    "OWNED_PAYLOAD_TAIL"', undefined, undefined, undefined]);
    expect(lines[1]).toMatchObject({ timestamp: '2026-11-16 18:12:41.118', level: 'ERROR', component: 'WORKER', message: 'reviews: database is locked' });
    for (const continued of [lines[2], lines[3]]) {
      expect([continued.level, continued.component, continued.timestamp]).toEqual(['ERROR', 'WORKER', undefined]);
    }
    expect(lines[4]).toMatchObject({ level: 'WARN', component: 'QUEUE', correlationId: 'session-151155', message: 'queue depth 69' });
    expect(lines[5].mark).toBe('success');
    expect(lines[6].mark).toBe('dataIn');
    expect(parseLogText('')).toEqual([]);
  });

  it('keys a line by its own text, so an opened row stays open when older lines leave the window', () => {
    const before = parseLogText(TEXT);
    const after = parseLogText(TEXT.split('\n').slice(2).join('\n') + '\n' + record('18:12:45.004', 'INFO', 'DB', 'later'));
    const key = before.find(line => line.message === 'queue depth 69')!.key;
    expect(after.some(line => line.key === key)).toBe(true);
    // Two identical records in one millisecond still get different keys.
    const twice = parseLogText([record('18:00:00.000', 'INFO', 'DB', 'same'), record('18:00:00.000', 'INFO', 'DB', 'same')].join('\n'));
    expect(new Set(twice.map(line => line.key)).size).toBe(2);
  });

  it('counts entries per level over every loaded line, not the stack lines under them and not only the shown ones', () => {
    expect(countLevels(parseLogText(TEXT))).toEqual({ DEBUG: 1, INFO: 1, WARN: 1, ERROR: 1 });
  });

  it('files a component without a chip of its own under Other', () => {
    expect(componentChip('QUEUE')).toBe('OTHER');
    expect(componentChip('CHROMA_SYNC')).toBe('OTHER');
    expect(componentChip('WORKER')).toBe('WORKER');
  });
});

describe('logs drawer: filters and search', () => {
  const lines = parseLogText(TEXT);
  const shown = (filters: Partial<LogFilters>) => lines.filter(line => lineMatches(line, { ...allOn(), ...filters })).map(line => line.raw);

  it('shows every line, the orphan too, while every chip is on', () => {
    expect(shown({})).toHaveLength(7);
  });

  it('keeps a record\'s stack lines with it and hides the orphan once a chip is off', () => {
    const errorsOnly = shown({ levels: new Set(['ERROR'] as const) });
    expect(errorsOnly).toEqual(lines.slice(1, 4).map(line => line.raw));
    expect(shown({ components: new Set(['OTHER'] as const) })).toEqual([lines[4].raw]);
  });

  it('finds lines with every word of the search, in any case', () => {
    expect(shown({ query: 'DATABASE locked' })).toEqual([lines[1].raw, lines[2].raw]);
    expect(shown({ query: 'nothing-like-this' })).toEqual([]);
    expect(hasEveryWord('Queue depth 69', '  depth   QUEUE ')).toBe(true);
  });

  it('the Alignment chip shows only [ALIGNMENT] lines, whatever the other chips say', () => {
    const text = [record('18:00:00.000', 'INFO', 'WORKER', '[ALIGNMENT] aligned'), record('18:00:00.001', 'INFO', 'WORKER', 'plain')].join('\n');
    const parsed = parseLogText(text);
    expect(parsed.filter(line => lineMatches(line, { ...allOn(), levels: new Set(), alignmentOnly: true })).map(line => line.raw)).toEqual([parsed[0].raw]);
  });
});

describe('logs drawer: what the list area shows (B3)', () => {
  const state = (overrides: Partial<Parameters<typeof logsViewState>[0]>) => logsViewState({
    hasRead: true, readFailed: false, isLoading: false, lineCount: 10, shownCount: 10, searching: false, ...overrides,
  });

  it('says it is loading, not "No logs available yet.", before the first read arrives', () => {
    expect(state({ hasRead: false, isLoading: true, lineCount: 0, shownCount: 0 })).toBe('loading');
    expect(state({ hasRead: false, isLoading: false, lineCount: 0, shownCount: 0 })).toBe('loading');
  });

  it('says the read failed only after it failed, and loading again while a retry runs', () => {
    expect(state({ hasRead: false, readFailed: true, lineCount: 0, shownCount: 0 })).toBe('failed');
    expect(state({ hasRead: false, readFailed: true, isLoading: true, lineCount: 0, shownCount: 0 })).toBe('loading');
  });

  it('says there are no logs only after a read came back empty', () => {
    expect(state({ lineCount: 0, shownCount: 0 })).toBe('empty');
  });

  it('tells a filter that hides everything from a search that finds nothing', () => {
    expect(state({ shownCount: 0 })).toBe('no-match');
    expect(state({ shownCount: 0, searching: true })).toBe('no-search-match');
    expect(state({})).toBe('loaded');
  });

  it('has words for every state but loaded, from the one list of states', () => {
    const english = (key: string) => key;
    for (const viewState of LOGS_VIEW_STATES) {
      const words = LOGS_VIEW_STATE_WORDS[viewState]?.(english) ?? null;
      expect(viewState === 'loaded' ? words === null : typeof words === 'string' && words.length > 0).toBe(true);
    }
    expect(LOGS_VIEW_STATE_WORDS.empty?.(english)).toBe('No logs available yet.');
    expect(LOGS_VIEW_STATE_WORDS.loading?.(english)).toBe('Loading logs…');
  });
});

describe('logs drawer: small words', () => {
  it('shows the time of day of a stamp and the file name of a path', () => {
    expect(timeOfDay('2026-11-16 18:12:41.118')).toBe('18:12:41.118');
    expect(logFileName('/Users/someone/.claude-mem/logs/claude-mem-2026-11-16.log')).toBe('claude-mem-2026-11-16.log');
    expect(logFileName('C:\\Users\\someone\\logs\\claude-mem-2026-11-16.log')).toBe('claude-mem-2026-11-16.log');
    expect(logFileName(undefined)).toBeNull();
  });

  it('reads the update time to the second with the viewer\'s one short-time formatter, in the reader\'s language', () => {
    const epoch = new Date(2026, 10, 16, 18, 12, 54).getTime();
    expect(formatShortTime(epoch, { seconds: true })).toBe('6:12:54\u202fpm');
    expect(formatShortTime(epoch)).toBe('6:12\u202fpm');
    // The reader's language comes from the page's saved choice (getLocale); a page that chose French reads 24-hour time.
    const page = globalThis as { window?: unknown };
    page.window = { localStorage: { getItem: () => 'fr' } };
    try {
      expect(formatShortTime(epoch, { seconds: true })).toContain('18:12:54');
    } finally { delete page.window; }
  });
});
