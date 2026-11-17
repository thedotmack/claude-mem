import React, { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { interpolate, useI18n } from '../../i18n';
import { renderUiMessage, uiMessage, type UiMessage } from '../../ui-message';
import { formatCount, formatShortTime } from '../utils/formatters';
import {
  LOG_COMPONENT_KEYS, LOG_LEVEL_KEYS, LOGS_VIEW_STATE_WORDS, countLevels, lineMatches, logFileName,
  logsViewState, parseLogText, timeOfDay, type LogComponent, type LogLevel, type ParsedLogLine,
} from '../utils/logs-display';
import { CopyButton } from './CopyButton';
import { InlineConfirm } from './InlineConfirm';
import { FEED_WINDOW_THRESHOLD } from './WindowedFeed';
import { useRowOverflow } from '../hooks/useRowOverflow';
import {
  ArrowDownToLineIcon, CheckIcon, ChevronRightIcon, MaximizeIcon, MinimizeIcon, RefreshIcon, SearchIcon, TrashIcon, WarningIcon, XIcon,
} from './icons';

type Translate = (english: string) => string;

/** Each chip's word. Literal t() keys, so tests/ui-i18n.test.ts sees each one. */
const LEVEL_WORDS: Record<LogLevel, (t: Translate) => string> = {
  DEBUG: t => t('Debug'),
  INFO: t => t('Info'),
  WARN: t => t('Warn'),
  ERROR: t => t('Error'),
};
const COMPONENT_WORDS: Record<LogComponent, (t: Translate) => string> = {
  HOOK: t => t('Hook'),
  WORKER: t => t('Worker'),
  SDK: t => t('SDK'),
  PARSER: t => t('Parser'),
  DB: t => t('DB'),
  SYSTEM: t => t('System'),
  HTTP: t => t('HTTP'),
  SESSION: t => t('Session'),
  CHROMA: t => t('Chroma'),
  OTHER: t => t('Other'),
};
/** Each level's dot and word colour (the log tokens are 4.5:1 or more on the page in both themes). */
const LEVEL_COLORS: Record<LogLevel, string> = {
  DEBUG: 'var(--color-log-debug)',
  INFO: 'var(--color-log-info)',
  WARN: 'var(--color-log-warn)',
  ERROR: 'var(--color-log-error)',
};
const ALL_LEVELS = (): Set<LogLevel> => new Set(LOG_LEVEL_KEYS);
const ALL_COMPONENTS = (): Set<LogComponent> => new Set(LOG_COMPONENT_KEYS);

/** Auto-refresh period. GET /api/logs answers in 4-6 ms for its 1,000 lines (about 300 KB, measured on the owner's worker on 2026-11-16), so a read every 2 s costs little and keeps the drawer close to live. */
const AUTO_REFRESH_MS = 2000;
/** The worker empties the file in one synchronous write; a clear with no answer in 5 s has lost its answer, so the drawer stops waiting and reads the file to see what happened. */
const CLEAR_TIMEOUT_MS = 5000;
/** The same 5 s limit for that follow-up read: the read answers in milliseconds when the worker is up. */
const RECONCILE_TIMEOUT_MS = 5000;
/**
 * The drawer never gets shorter than its resize bar, its header and one row of logs; the filter rows scroll in
 * what is left (.console-filters in viewer-template.html) down to their own padding and edges. Measured 2026-11-16:
 * 211px on a 390px phone, where the header's controls take a second row (the drawer's 1px top edge + bar 44 + header
 * 104 + filter padding and edges 18 + row 44); 167px on a touch screen at 1440px (1 + 44 + 54 + 24 + 44); 131px on a
 * desktop (1 + 24 + 46 + 24 + 36). The largest is the floor everywhere.
 */
export const MIN_DRAWER_HEIGHT = 211;
/** Nor taller than the window less 100px, so the viewer's 64px header and a margin stay above it. */
const DRAWER_TOP_MARGIN = 100;
/** Arrow keys on the resize bar move it one desktop row (36px) per press. */
const KEYBOARD_RESIZE_STEP = 36;
/** The token sheet's phone width (767px): below it the drawer opens taller, because its filter rows stack. */
const PHONE_MAX_WIDTH = 767;
/**
 * The first height. On a desktop the bar, header and filter rows take 197px (24 + 46 + 127, measured at 1440x900 on
 * 2026-11-16), so 55% of a 900px window leaves eight 36px rows of logs. On a phone they take 387px (44 + 104 + 239,
 * measured at 390x844), so the drawer opens at 70% (591px), which leaves four 44px rows, and stops there: the
 * viewer's 56px header and the top of the page stay in view above it.
 */
const DESKTOP_HEIGHT_SHARE = 0.55;
const PHONE_HEIGHT_SHARE = 0.7;

function maxDrawerHeight(): number {
  // On a phone the drawer stops at 70% of the screen (PHONE_HEIGHT_SHARE); elsewhere 100px below the window's top.
  const limit = window.innerWidth <= PHONE_MAX_WIDTH ? window.innerHeight * PHONE_HEIGHT_SHARE : window.innerHeight - DRAWER_TOP_MARGIN;
  return Math.max(MIN_DRAWER_HEIGHT, Math.round(limit));
}

function clampDrawerHeight(height: number): number {
  return Math.min(Math.max(MIN_DRAWER_HEIGHT, Math.round(height)), maxDrawerHeight());
}

function defaultDrawerHeight(): number {
  const share = window.innerWidth <= PHONE_MAX_WIDTH ? PHONE_HEIGHT_SHARE : DESKTOP_HEIGHT_SHARE;
  return clampDrawerHeight(window.innerHeight * share);
}

/** What GET /api/logs says about the file besides its lines; every field may be missing on an older worker. */
interface LogFileFacts {
  path?: string;
  /** The worker's count of lines in the whole file (an estimate when the file is larger than its read window). */
  totalLines?: number;
}

function readFacts(body: unknown): LogFileFacts {
  const record = body && typeof body === 'object' ? body as Record<string, unknown> : {};
  return {
    path: typeof record.path === 'string' ? record.path : undefined,
    totalLines: typeof record.totalLines === 'number' && Number.isFinite(record.totalLines) ? record.totalLines : undefined,
  };
}

interface LogsDrawerProps {
  isOpen: boolean;
  onClose: () => void;
}

/**
 * "Memory logs": the worker's log file in a drawer at the bottom of the viewer, read
 * through GET /api/logs (its last 1,000 lines). A named region, not a dialog: the page
 * stays usable beside it.
 */
export function LogsDrawer({ isOpen, onClose }: LogsDrawerProps) {
  // useI18n re-renders the drawer on a language switch, so the "updated" time follows the reader's language.
  const { t } = useI18n();
  const [logs, setLogs] = useState<string>('');
  const [facts, setFacts] = useState<LogFileFacts>({});
  // B3: the list says "No logs available yet." only after a read came back empty.
  const [hasRead, setHasRead] = useState(false);
  const [readFailed, setReadFailed] = useState(false);
  const [readAt, setReadAt] = useState<number | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isClearing, setIsClearing] = useState(false);
  const [askingClear, setAskingClear] = useState(false);
  const [error, setError] = useState<UiMessage | string | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [height, setHeight] = useState(defaultDrawerHeight);
  const [fullHeight, setFullHeight] = useState(false);
  const heightBeforeFullRef = useRef<number | null>(null);
  const [query, setQuery] = useState('');
  const [activeLevels, setActiveLevels] = useState<Set<LogLevel>>(ALL_LEVELS);
  const [activeComponents, setActiveComponents] = useState<Set<LogComponent>>(ALL_COMPONENTS);
  const [alignmentOnly, setAlignmentOnly] = useState(false);
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [jumpRequest, setJumpRequest] = useState(0);
  const requestSeqRef = useRef(0);
  const clearingRef = useRef(false);
  const clearButtonRef = useRef<HTMLButtonElement>(null);
  // On a phone each chip group is one sideways row with its scrollbar hidden; its cut edge fades out (M3), so the
  // Error chip past the edge still shows it is there.
  const levelRow = useRowOverflow();
  const componentRow = useRowOverflow();

  const parsedLines = useMemo(() => parseLogText(logs), [logs]);
  const levelCounts = useMemo(() => countLevels(parsedLines), [parsedLines]);
  const shownLines = useMemo(() => {
    const filters = { levels: activeLevels, components: activeComponents, alignmentOnly, query };
    return parsedLines.filter(line => lineMatches(line, filters));
  }, [parsedLines, activeLevels, activeComponents, alignmentOnly, query]);
  const searching = query.trim() !== '';
  const viewState = logsViewState({ hasRead, readFailed, isLoading, lineCount: parsedLines.length, shownCount: shownLines.length, searching });

  const fetchLogs = useCallback(async () => {
    if (clearingRef.current) return;
    const request = ++requestSeqRef.current;
    setIsLoading(true);
    setError(null);
    try {
      const response = await fetch('/api/logs');
      if (!response.ok) {
        if (request === requestSeqRef.current) {
          setError(uiMessage('Failed to fetch logs: {reason}', { reason: response.statusText }));
          setReadFailed(true);
        }
        return;
      }
      const data = await response.json();
      if (request === requestSeqRef.current) {
        setLogs(data.logs || '');
        setFacts(readFacts(data));
        setHasRead(true);
        setReadFailed(false);
        setReadAt(Date.now());
      }
    } catch (err) {
      if (request === requestSeqRef.current) {
        setError(err instanceof Error ? err.message : uiMessage('Unknown error'));
        setReadFailed(true);
      }
    } finally {
      if (request === requestSeqRef.current) setIsLoading(false);
    }
  }, []);

  /** Runs after the reader confirmed the question in the page (no browser confirm box). */
  const runClear = useCallback(async () => {
    setAskingClear(false);
    // The question's buttons go away; focus goes back to "Clear logs…", which says "Clearing…" until the worker answers.
    clearButtonRef.current?.focus();
    const request = ++requestSeqRef.current;
    clearingRef.current = true;
    setIsClearing(true);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), CLEAR_TIMEOUT_MS);
    setIsLoading(true);
    setError(null);
    try {
      const response = await fetch('/api/logs/clear', { method: 'POST', signal: controller.signal });
      if (!response.ok) {
        if (request === requestSeqRef.current) setError(uiMessage('Failed to clear logs: {reason}', { reason: response.statusText }));
        return;
      }
      if (request === requestSeqRef.current) {
        setLogs('');
        setFacts(previous => ({ ...previous, totalLines: 0 }));
        setHasRead(true);
        setReadFailed(false);
        setReadAt(Date.now());
        setOpenKey(null);
      }
    } catch (err) {
      if (controller.signal.aborted) {
        // Abort only says that the acknowledgment was lost: the worker may
        // already have cleared the file. Reconcile even with auto-refresh off,
        // keeping this operation's request ownership and a bounded read.
        const reconciliation = new AbortController();
        const reconciliationTimeout = setTimeout(() => reconciliation.abort(), RECONCILE_TIMEOUT_MS);
        try {
          const response = await fetch('/api/logs', { signal: reconciliation.signal });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const data = await response.json();
          if (request === requestSeqRef.current) {
            setLogs(data.logs || '');
            setFacts(readFacts(data));
            setHasRead(true);
            setReadAt(Date.now());
            setError(uiMessage('Clear request timed out; its outcome is unknown. Displaying current logs.'));
          }
        } catch {
          if (request === requestSeqRef.current) {
            setError(uiMessage('Clear request timed out; its outcome is unknown and current logs could not be refreshed. Try Refresh.'));
          }
        } finally {
          clearTimeout(reconciliationTimeout);
        }
      } else if (request === requestSeqRef.current) {
        setError(err instanceof Error ? err.message : uiMessage('Unknown error'));
      }
    } finally {
      clearTimeout(timeout);
      clearingRef.current = false;
      setIsClearing(false);
      if (request === requestSeqRef.current) setIsLoading(false);
    }
  }, []);

  const cancelClear = useCallback(() => {
    setAskingClear(false);
    clearButtonRef.current?.focus();
  }, []);

  const resizeTo = useCallback((next: number) => {
    setFullHeight(false);
    setHeight(clampDrawerHeight(next));
  }, []);

  const toggleFullHeight = useCallback(() => {
    if (fullHeight) {
      setHeight(clampDrawerHeight(heightBeforeFullRef.current ?? defaultDrawerHeight()));
      setFullHeight(false);
    } else {
      heightBeforeFullRef.current = height;
      setHeight(maxDrawerHeight());
      setFullHeight(true);
    }
  }, [fullHeight, height]);

  useEffect(() => {
    if (!isOpen) return;
    // A smaller window must not leave the drawer taller than it.
    const onResize = () => setHeight(current => (fullHeight ? maxDrawerHeight() : clampDrawerHeight(current)));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [isOpen, fullHeight]);

  useEffect(() => {
    if (isOpen) fetchLogs();
  }, [isOpen, fetchLogs]);

  useEffect(() => {
    if (!isOpen || !autoRefresh) return;
    const interval = setInterval(fetchLogs, AUTO_REFRESH_MS);
    return () => clearInterval(interval);
  }, [isOpen, autoRefresh, fetchLogs]);

  const toggleLevel = useCallback((level: LogLevel) => {
    setActiveLevels(previous => {
      const next = new Set(previous);
      if (next.has(level)) next.delete(level); else next.add(level);
      return next;
    });
  }, []);

  const toggleComponent = useCallback((component: LogComponent) => {
    setActiveComponents(previous => {
      const next = new Set(previous);
      if (next.has(component)) next.delete(component); else next.add(component);
      return next;
    });
  }, []);

  if (!isOpen) {
    return null;
  }

  const clearBusy = isLoading || isClearing;
  const allLevelsOn = activeLevels.size === LOG_LEVEL_KEYS.length;
  const allComponentsOn = activeComponents.size === LOG_COMPONENT_KEYS.length;
  const lineCount = parsedLines.length;
  const fileName = logFileName(facts.path);
  const totalLines = facts.totalLines;
  // What the in-page question says will be lost: the whole file, which is usually far longer than the lines shown.
  const clearQuestion = fileName && totalLines !== undefined && totalLines > lineCount
    ? interpolate(t('Clear the whole log file {file}? About {total} lines are erased, not only the {shown} shown here. This cannot be undone.'),
      { file: fileName, total: formatCount(totalLines), shown: formatCount(lineCount) })
    : fileName && totalLines !== undefined
      ? interpolate(t('Clear the whole log file {file}? Its {total} lines are erased. This cannot be undone.'), { file: fileName, total: formatCount(totalLines) })
      : t('Clear the whole log file? Every line in it is erased. This cannot be undone.');
  const stateWords = LOGS_VIEW_STATE_WORDS[viewState]?.(t) ?? null;
  const linesWords = interpolate(lineCount === 1 ? t('{count} line') : t('{count} lines'), { count: formatCount(lineCount) });
  const countsWindowWords = interpolate(lineCount === 1 ? t('in the last {count} line') : t('in the last {count} lines'), { count: formatCount(lineCount) });

  return (
    <section className="console-drawer" aria-labelledby="console-drawer-heading" style={{ height: `${height}px` }}>
      <div
        className="console-resize-handle"
        role="separator"
        tabIndex={0}
        aria-label={t('Resize memory logs')}
        aria-orientation="horizontal"
        aria-valuemin={MIN_DRAWER_HEIGHT}
        aria-valuemax={maxDrawerHeight()}
        aria-valuenow={height}
        onPointerDown={event => {
          if (event.button !== 0) return;
          event.preventDefault();
          const handle = event.currentTarget;
          const startY = event.clientY;
          const startHeight = height;
          handle.setPointerCapture?.(event.pointerId);
          const move = (moveEvent: PointerEvent) => resizeTo(startHeight + (startY - moveEvent.clientY));
          const stop = () => {
            handle.removeEventListener('pointermove', move);
            handle.removeEventListener('pointerup', stop);
            handle.removeEventListener('pointercancel', stop);
          };
          handle.addEventListener('pointermove', move);
          handle.addEventListener('pointerup', stop);
          handle.addEventListener('pointercancel', stop);
        }}
        onKeyDown={event => {
          const next = event.key === 'ArrowUp' ? height + KEYBOARD_RESIZE_STEP
            : event.key === 'ArrowDown' ? height - KEYBOARD_RESIZE_STEP
              : event.key === 'Home' ? MIN_DRAWER_HEIGHT
                : event.key === 'End' ? maxDrawerHeight() : null;
          if (next === null) return;
          event.preventDefault();
          resizeTo(next);
        }}
      >
        <div className="console-resize-bar" />
      </div>

      <div className="console-header">
        <div className="console-title">
          <h2 id="console-drawer-heading" className="console-heading">{t('Memory logs')}</h2>
          {hasRead && (
            <p className="console-meta">
              {linesWords}
              {readAt !== null && <> · {interpolate(t('updated {time}'), { time: formatShortTime(readAt, { seconds: true }) })}</>}
            </p>
          )}
        </div>
        <div className="console-controls">
          <label className="console-btn console-auto-refresh">
            <input
              type="checkbox"
              checked={autoRefresh}
              onChange={event => setAutoRefresh(event.target.checked)}
            />
            {t('Auto-refresh')}
          </label>
          {/* On a phone the three words below are read out but not drawn (.console-btn-word), so the row fits. */}
          <button type="button" className="console-btn" onClick={fetchLogs} title={t('Refresh logs')}>
            <RefreshIcon size={16} />
            <span className="console-btn-word">{t('Refresh')}</span>
          </button>
          <button type="button" className="console-btn" onClick={() => setJumpRequest(count => count + 1)} title={t('Jump to newest')}>
            <ArrowDownToLineIcon size={16} />
            <span className="console-btn-word">{t('Jump to newest')}</span>
          </button>
          <button type="button" className="console-btn" aria-pressed={fullHeight} onClick={toggleFullHeight} title={t('Full height')}>
            {fullHeight ? <MinimizeIcon size={16} /> : <MaximizeIcon size={16} />}
            <span className="console-btn-word">{t('Full height')}</span>
          </button>
        </div>
        <button type="button" className="console-btn console-close-btn" onClick={onClose} aria-label={t('Close memory logs')} title={t('Close memory logs')}>
          <XIcon size={18} />
        </button>
      </div>

      <div className="console-filters">
        <div className="console-filter-search">
          <label className="console-filter-label" htmlFor="console-search-input">{t('Find in logs')}</label>
          <div className="console-search">
            <SearchIcon size={16} />
            <input id="console-search-input" type="search" value={query} onChange={event => setQuery(event.target.value)} />
          </div>
        </div>
        <div className="console-filter-section console-filter-section--levels" role="group" aria-labelledby="console-levels-label" aria-describedby={hasRead ? 'console-levels-note' : undefined}>
          <span className="console-filter-label" id="console-levels-label">{t('Levels:')}</span>
          <div ref={levelRow.rowRef} className={`console-filter-chips${levelRow.className}`}>
            {LOG_LEVEL_KEYS.map(level => {
              const active = activeLevels.has(level);
              const word = LEVEL_WORDS[level](t);
              return (
                <button
                  key={level}
                  type="button"
                  className={`console-filter-chip${active ? ' active' : ''}`}
                  onClick={() => toggleLevel(level)}
                  title={word}
                  aria-pressed={active}
                >
                  {active && <CheckIcon size={14} />}
                  <span className="console-level-dot" style={{ '--console-level-color': LEVEL_COLORS[level] } as React.CSSProperties} aria-hidden="true" />
                  {/* The space keeps "Info 837" two words for screen readers; the chip's gap draws it.
                      No count before the first read: a 0 there would say something nobody measured. */}
                  {word}{' '}
                  {hasRead && <span className="console-chip-count">{formatCount(levelCounts[level])}</span>}
                </button>
              );
            })}
            <button
              type="button"
              className="console-filter-action"
              onClick={() => setActiveLevels(allLevelsOn ? new Set() : ALL_LEVELS())}
              title={allLevelsOn ? t('Select none') : t('Select all')}
            >
              {allLevelsOn ? t('Select none') : t('Select all')}
            </button>
          </div>
          {hasRead && <span className="console-filter-note" id="console-levels-note">{countsWindowWords}</span>}
        </div>
        <div className="console-filter-section console-filter-section--quick" role="group" aria-labelledby="console-quick-label">
          <span className="console-filter-label" id="console-quick-label">{t('Quick:')}</span>
          <div className="console-filter-chips">
            <button
              type="button"
              className={`console-filter-chip${alignmentOnly ? ' active' : ''}`}
              onClick={() => setAlignmentOnly(value => !value)}
              title={t('Show only session alignment logs')}
              aria-pressed={alignmentOnly}
            >
              {alignmentOnly && <CheckIcon size={14} />}
              {t('Alignment')}
            </button>
          </div>
        </div>
        <div className="console-filter-section console-filter-section--components" role="group" aria-labelledby="console-components-label">
          <span className="console-filter-label" id="console-components-label">{t('Components:')}</span>
          <div ref={componentRow.rowRef} className={`console-filter-chips${componentRow.className}`}>
            {LOG_COMPONENT_KEYS.map(component => {
              const active = activeComponents.has(component);
              const word = COMPONENT_WORDS[component](t);
              return (
                <button
                  key={component}
                  type="button"
                  className={`console-filter-chip${active ? ' active' : ''}`}
                  onClick={() => toggleComponent(component)}
                  title={word}
                  aria-pressed={active}
                >
                  {active && <CheckIcon size={14} />}
                  {word}
                </button>
              );
            })}
            <button
              type="button"
              className="console-filter-action"
              onClick={() => setActiveComponents(allComponentsOn ? new Set() : ALL_COMPONENTS())}
              title={allComponentsOn ? t('Select none') : t('Select all')}
            >
              {allComponentsOn ? t('Select none') : t('Select all')}
            </button>
          </div>
        </div>
        <div className="console-filter-danger">
          <button
            ref={clearButtonRef}
            type="button"
            className="console-btn console-clear-btn"
            aria-disabled={clearBusy || undefined}
            aria-expanded={askingClear}
            aria-controls={askingClear ? 'console-clear-question' : undefined}
            onClick={() => { if (!clearBusy) setAskingClear(value => !value); }}
          >
            <TrashIcon size={16} />
            {isClearing ? t('Clearing…') : t('Clear logs…')}
          </button>
        </div>
      </div>

      {askingClear && (
        <div className="console-clear-question" id="console-clear-question">
          <InlineConfirm
            question={clearQuestion}
            confirmLabel={t('Clear logs')}
            busyLabel={t('Clearing…')}
            busy={false}
            onConfirm={runClear}
            onCancel={cancelClear}
          />
        </div>
      )}

      {searching && hasRead && (
        <p className="console-search-note" role="status">
          {interpolate(t('{count} of the last {total} lines match. Older lines in the log file are not searched.'), {
            count: formatCount(shownLines.length), total: formatCount(lineCount),
          })}
        </p>
      )}

      {error && (
        <div className="console-error" role="alert">
          <WarningIcon size={16} />
          {renderUiMessage(error, t)}
        </div>
      )}

      <LogList
        lines={shownLines}
        openKey={openKey}
        onToggle={key => setOpenKey(current => (current === key ? null : key))}
        jumpRequest={jumpRequest}
        stateWords={stateWords}
        listLabel={t('Memory logs')}
        copyLabel={t('Copy line')}
      />
    </section>
  );
}

// Rows are recycled past FEED_WINDOW_THRESHOLD (50, UI UX Pro Max virtualize-lists), the timeline's own threshold:
// the review counted 5,522 page elements for 1,000 lines drawn at once.
/** Rows drawn above and below the view: 10 rows (360px at the 36px desktop row) cover a quick wheel flick (Chrome scrolls 100px per notch), so fast scrolling shows no blank space. */
const LOG_WINDOW_OVERSCAN = 10;
/** The row height assumed until the first row is drawn and measured: the template's desktop --console-row-height. */
const FALLBACK_ROW_HEIGHT = 36;
/** Within 50px (about one and a half rows) of the end counts as reading the newest lines, so new lines and filter changes keep the end in view. */
const FOLLOW_SLACK_PX = 50;

interface LogListProps {
  lines: ParsedLogLine[];
  openKey: string | null;
  onToggle: (key: string) => void;
  /** Bumped by "Jump to newest". */
  jumpRequest: number;
  /** The words shown instead of rows (loading, empty, nothing matches), or null when rows show. */
  stateWords: string | null;
  listLabel: string;
  copyLabel: string;
}

/**
 * The lines, one fixed-height row each (--console-row-height), so the window is
 * arithmetic: only the rows in view plus the overscan are in the page. The one
 * opened row adds its measured details height. Like a terminal, the list follows
 * the newest line while the reader is at the end.
 */
function LogList({ lines, openKey, onToggle, jumpRequest, stateWords, listLabel, copyLabel }: LogListProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const followRef = useRef(true);
  const [view, setView] = useState({ top: 0, height: 0, rowHeight: FALLBACK_ROW_HEIGHT });
  const [openExtra, setOpenExtra] = useState(0);
  // The row with keyboard focus. It stays drawn, with the rows on either side of it, wherever the list scrolls, so
  // focus never falls to the page and Tab moves on to the next line (the timeline's WindowedFeed does the same).
  const [focusedKey, setFocusedKey] = useState<string | null>(null);

  const readView = useCallback(() => {
    const element = scrollRef.current;
    if (!element) return;
    // The real height of a drawn row (the stylesheet's --console-row-height, 36px or 44px on touch), so the
    // spacers match the rows even where the stylesheet is missing.
    const sample = element.querySelector<HTMLElement>('.console-row-toggle');
    const measured = sample ? sample.getBoundingClientRect().height : 0;
    setView(previous => {
      const rowHeight = measured > 0 ? measured : previous.rowHeight;
      return previous.top === element.scrollTop && previous.height === element.clientHeight && previous.rowHeight === rowHeight
        ? previous
        : { top: element.scrollTop, height: element.clientHeight, rowHeight };
    });
  }, []);

  const scrollToEnd = useCallback(() => {
    const element = scrollRef.current;
    if (!element) return;
    element.scrollTop = element.scrollHeight;
    readView();
  }, [readView]);

  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const onScroll = () => {
      followRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < FOLLOW_SLACK_PX;
      readView();
    };
    readView();
    element.addEventListener('scroll', onScroll, { passive: true });
    const observer = new ResizeObserver(readView);
    observer.observe(element);
    return () => {
      element.removeEventListener('scroll', onScroll);
      observer.disconnect();
    };
  }, [readView]);

  // New lines or other filters: stay at the end if the reader was there (before paint, so no blank frame). The first
  // drawn row's measured height counts too: on a touch screen it is 44px, not the 36px the first scroll assumed, and
  // the end moves about 8px per line further down. A reader who scrolled away is not following and stays put.
  useLayoutEffect(() => {
    if (followRef.current) scrollToEnd();
  }, [lines, view.rowHeight, scrollToEnd]);

  useLayoutEffect(() => {
    if (!jumpRequest) return;
    followRef.current = true;
    scrollToEnd();
  }, [jumpRequest, scrollToEnd]);

  const count = lines.length;
  const openIndex = openKey === null ? -1 : lines.findIndex(line => line.key === openKey);
  const extra = openIndex >= 0 ? openExtra : 0;
  const rowHeight = view.rowHeight;
  const windowed = count > FEED_WINDOW_THRESHOLD;
  const rowTop = (index: number) => index * rowHeight + (openIndex >= 0 && index > openIndex ? extra : 0);
  const indexAt = (y: number) => {
    if (openIndex < 0 || y < openIndex * rowHeight) return Math.floor(y / rowHeight);
    const openBottom = (openIndex + 1) * rowHeight + extra;
    return y < openBottom ? openIndex : openIndex + 1 + Math.floor((y - openBottom) / rowHeight);
  };
  const start = windowed ? Math.min(count, Math.max(0, indexAt(view.top) - LOG_WINDOW_OVERSCAN)) : 0;
  const end = windowed ? Math.min(count, indexAt(view.top + view.height) + 1 + LOG_WINDOW_OVERSCAN) : count;
  const drawn = new Set<number>();
  for (let index = start; index < end; index++) drawn.add(index);
  const focusedIndex = focusedKey === null ? -1 : lines.findIndex(line => line.key === focusedKey);
  if (focusedIndex >= 0) {
    for (let index = Math.max(0, focusedIndex - 1); index <= Math.min(count - 1, focusedIndex + 1); index++) drawn.add(index);
  }
  // Rows in order, with a spacer for each run of rows that are not drawn, so the list keeps its full height.
  const children: React.ReactNode[] = [];
  let cursor = 0;
  for (const index of [...drawn].sort((a, b) => a - b)) {
    const top = rowTop(index);
    if (top > cursor) children.push(<div key={`space-${index}`} className="console-spacer" aria-hidden="true" style={{ height: `${top - cursor}px` }} />);
    const line = lines[index];
    children.push(
      <LogRow
        key={line.key}
        line={line}
        position={index + 1}
        count={count}
        open={line.key === openKey}
        onToggle={onToggle}
        onDetailsHeight={setOpenExtra}
        copyLabel={copyLabel}
        onFocusIn={setFocusedKey}
        onFocusOut={key => setFocusedKey(current => (current === key ? null : current))}
      />,
    );
    cursor = rowTop(index + 1);
  }
  if (rowTop(count) > cursor) children.push(<div key="space-end" className="console-spacer" aria-hidden="true" style={{ height: `${rowTop(count) - cursor}px` }} />);

  return (
    <div className="console-content" ref={scrollRef}>
      {stateWords !== null ? (
        <div className="log-line log-line-empty" role="status">{stateWords}</div>
      ) : (
        <div className="console-logs" role="list" aria-label={listLabel}>{children}</div>
      )}
    </div>
  );
}

function LogRow({ line, position, count, open, onToggle, onDetailsHeight, copyLabel, onFocusIn, onFocusOut }: {
  line: ParsedLogLine;
  position: number;
  count: number;
  open: boolean;
  onToggle: (key: string) => void;
  onDetailsHeight: (height: number) => void;
  copyLabel: string;
  /** Keyboard focus came into the row, or left it for something outside it. */
  onFocusIn: (key: string) => void;
  onFocusOut: (key: string) => void;
}) {
  const detailsId = useId();
  const detailsRef = useRef<HTMLDivElement>(null);
  // A row drawn again while already open (scrolled back into the window) must not pull the list to itself.
  const wasOpenRef = useRef(open);
  useLayoutEffect(() => {
    const opening = open && !wasOpenRef.current;
    wasOpenRef.current = open;
    const details = detailsRef.current;
    if (!open || !details) return;
    const measure = () => onDetailsHeight(details.getBoundingClientRect().height);
    measure();
    // A row opened near the bottom would open out of sight: bring its full line into the drawer.
    if (opening) details.scrollIntoView?.({ block: 'nearest' });
    const observer = new ResizeObserver(measure);
    observer.observe(details);
    return () => observer.disconnect();
  }, [open, onDetailsHeight]);

  const level = LOG_LEVEL_KEYS.includes(line.level as LogLevel) ? line.level as LogLevel : null;
  const levelStyle = level ? { '--console-level-color': LEVEL_COLORS[level] } as React.CSSProperties : undefined;
  const classes = ['console-row'];
  if (!line.timestamp) classes.push('console-row--continued');
  if (open) classes.push('console-row--open');
  if (line.timestamp && level === 'ERROR') classes.push('console-row--error');
  return (
    <div role="listitem" aria-setsize={count} aria-posinset={position} className={classes.join(' ')}
      onFocusCapture={() => onFocusIn(line.key)}
      onBlurCapture={event => {
        // Focus moving to another row of the list: that row's focus names the new row. Clearing here would re-render
        // first (focus events flush at once) and unmount the row focus is moving to, dropping focus to the page.
        const next = event.relatedTarget as Node | null;
        if (next && event.currentTarget.parentElement?.contains(next)) return;
        onFocusOut(line.key);
      }}>
      <button type="button" className="console-row-toggle" aria-expanded={open} aria-controls={open ? detailsId : undefined} onClick={() => onToggle(line.key)}>
        <span className="console-row-chevron" aria-hidden="true"><ChevronRightIcon size={14} /></span>
        {line.timestamp ? (
          <>
            <span className="console-cell console-cell-time log-timestamp" title={line.timestamp}>{timeOfDay(line.timestamp)}</span>
            <span className="console-cell console-cell-level log-level" style={levelStyle}>
              <span className="console-level-dot" aria-hidden="true" />
              {line.level}
            </span>
            <span className="console-cell console-cell-component log-component">{line.component}</span>
            <span className="console-cell console-cell-message">
              {line.correlationId && <span className="log-correlation">{line.correlationId}</span>}
              <span className={`log-message${line.mark ? ` log-message--${line.mark}` : ''}`}>{line.message}</span>
            </span>
          </>
        ) : (
          <span className="console-cell console-cell-continued"><span className="log-line-raw">{line.raw}</span></span>
        )}
      </button>
      {open && (
        <div className="console-row-details" id={detailsId} ref={detailsRef}>
          <pre className="console-row-full">{line.raw}</pre>
          <CopyButton text={() => line.raw} label={copyLabel} className="console-btn" />
        </div>
      )}
    </div>
  );
}
