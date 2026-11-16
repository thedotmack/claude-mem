import React, { useRef, useEffect, useState, useMemo, useCallback, useImperativeHandle, forwardRef } from 'react';
import { interpolate, useI18n } from '../../i18n';
import { translateViewerError } from '../../i18n/errors';
import { FeedItem } from '../types';
import type { DeletableItemType } from '../utils/feed-deletion';
import { useFeedDeletes } from '../hooks/useFeedItemDelete';
import { ObservationCard } from './ObservationCard';
import { SummaryCard, type SummarySectionMode } from './SummaryCard';
import { PromptCard } from './PromptCard';
import { ScrollToTop } from './ScrollToTop';
import { UI } from '../constants/ui';
import { WindowedFeed, type WindowedFeedHandle } from './WindowedFeed';
import type { ObservationViewMode } from './ObservationCard';
import { FEED_ENDING_WORDS, feedEnding, feedItemKey, foldPromptRepeats, memoriesBefore } from '../utils/feed-display';
import { formatCount, formatDayLabel, formatShortDate, formatShortTime, localDayKey } from '../utils/formatters';
import { ArrowUpIcon, StackIcon, WarningIcon } from './icons';

export interface FeedEmptyHint {
  /** What narrows the list, e.g. "Project filter: claude-mem". */
  detail?: string;
  /** Buttons that widen it again ("Show all projects", "Clear filters"). */
  actions: Array<{ label: string; onClick: () => void }>;
}

interface FeedProps {
  /** Newest first; build with buildFeedItems. */
  items: FeedItem[];
  /** Rendered at the top of the scrolling column (view tabs, session header). */
  header?: React.ReactNode;
  onLoadMore: () => void;
  onDeleted: (itemType: DeletableItemType, id: number) => void;
  /**
   * The cards' deletes, when the page keeps them across views (App does, so a refused
   * delete is still on its card after the reader leaves and comes back); otherwise the feed keeps its own.
   */
  deletes?: ReturnType<typeof useFeedDeletes>;
  isLoading: boolean;
  hasMore: boolean;
  loadError?: string | null;
  /** False when the server refused the request outright, so Retry would only repeat it. */
  canRetry?: boolean;
  /** The server's deepest allowed offset when it stopped this list there instead of running out. */
  offsetCapReachedAt?: number | null;
  /** Why an empty list is empty and how to widen it. */
  emptyHint?: FeedEmptyHint;
  /**
   * Load older rows when the end scrolls into view. Off while a filter or search
   * narrows the list: a filter that matches little would otherwise page through
   * the whole history on its own, so the reader asks with a button instead.
   */
  autoLoad?: boolean;
  /** Rows to recycle past (WindowedFeed's threshold); FEED_WINDOW_THRESHOLD unless the page says otherwise. */
  windowThreshold?: number;
}

/** Drop remembered row state (open facts, opened prompts) for rows no longer loaded. */
function keepLoaded<T>(previous: Record<string, T>, keys: Set<string>): Record<string, T> {
  const kept = Object.fromEntries(Object.entries(previous).filter(([key]) => keys.has(key)));
  return Object.keys(kept).length === Object.keys(previous).length ? previous : kept;
}

interface PositionBarHandle { show(index: number, atStart: boolean): void }

/**
 * The slim bar pinned over the list once it scrolls: the current row's day and time,
 * its place among the memories shown, and Top. Counts memories, as the kind chips and
 * the end line do (a folded repeat counts each time).
 */
const PositionBar = forwardRef<PositionBarHandle, { rows: FeedItem[]; before: number[]; memoryCount: number; onTop: () => void }>(
  function PositionBar({ rows, before, memoryCount, onTop }, ref) {
    const { t } = useI18n();
    const [position, setPosition] = useState<{ index: number; atStart: boolean }>({ index: 0, atStart: true });
    useImperativeHandle(ref, () => ({
      show: (index, atStart) => setPosition(previous => previous.index === index && previous.atStart === atStart ? previous : { index, atStart }),
    }), []);
    const index = Math.min(position.index, rows.length - 1);
    const row = rows[index];
    const hidden = position.atStart || !row;
    return (
      <div className="feed-position" aria-hidden={hidden || undefined}>
        <div className="feed-position-bar" hidden={hidden}>
          {row && <span className="feed-position-when">{formatDayLabel(row.created_at_epoch)} · {formatShortTime(row.created_at_epoch)}</span>}
          <span className="feed-position-count">
            {interpolate(t('{position} of {total} loaded'), {
              position: formatCount((before[index] ?? 0) + 1),
              total: formatCount(memoryCount),
            })}
          </span>
          <button type="button" className="feed-position-top" onClick={onTop} tabIndex={hidden ? -1 : undefined}>
            <ArrowUpIcon size={14} />{t('Top')}
          </button>
        </div>
      </div>
    );
  });

export function Feed({
  items, header, onLoadMore, onDeleted, deletes: pageDeletes, isLoading, hasMore, loadError, canRetry = true,
  offsetCapReachedAt = null, emptyHint, autoLoad = true, windowThreshold,
}: FeedProps) {
  const { t, locale } = useI18n();
  const loadMoreRef = useRef<HTMLDivElement>(null);
  const feedRef = useRef<HTMLDivElement>(null);
  const windowRef = useRef<WindowedFeedHandle>(null);
  const positionRef = useRef<PositionBarHandle>(null);
  const ownDeletes = useFeedDeletes(onDeleted);
  const deletes = pageDeletes ?? ownDeletes;
  const [observationModes, setObservationModes] = useState<Record<string, ObservationViewMode>>({});
  const [expandedPrompts, setExpandedPrompts] = useState<Record<string, boolean>>({});
  const [summaryModes, setSummaryModes] = useState<Record<string, SummarySectionMode>>({});
  const [openRepeats, setOpenRepeats] = useState<Record<string, boolean>>({});
  const [openSubtitles, setOpenSubtitles] = useState<Record<string, boolean>>({});
  const onLoadMoreRef = useRef(onLoadMore);
  const { rows, repeats } = useMemo(() => foldPromptRepeats(items), [items]);
  const before = useMemo(() => memoriesBefore(rows, repeats), [rows, repeats]);
  // The rail's dates are in the reader's language, so a language switch redraws them.
  const dayMarks = useMemo(() => rows.flatMap((row, index) =>
    index === 0 || localDayKey(rows[index - 1].created_at_epoch) !== localDayKey(row.created_at_epoch)
      ? [{ index, label: formatShortDate(row.created_at_epoch, locale) }] : []), [rows, locale]);
  const dayStarts = useMemo(() => new Set(dayMarks.map(mark => mark.index)), [dayMarks]);
  const ending = feedEnding({ rowCount: rows.length, isLoading, hasMore, loadError, autoLoad });

  useEffect(() => {
    const keys = new Set(items.map(feedItemKey));
    setObservationModes(previous => keepLoaded(previous, keys));
    setExpandedPrompts(previous => keepLoaded(previous, keys));
    setSummaryModes(previous => keepLoaded(previous, keys));
    setOpenRepeats(previous => keepLoaded(previous, keys));
    setOpenSubtitles(previous => keepLoaded(previous, keys));
  }, [items]);

  useEffect(() => {
    onLoadMoreRef.current = onLoadMore;
  }, [onLoadMore]);

  useEffect(() => {
    const element = loadMoreRef.current;
    if (!element) return;

    const observer = new IntersectionObserver(
      (entries) => {
        // On a slow frame the observer's first check (sentinel not yet in view)
        // and the check after a scroll that brought it into view arrive in one
        // callback, oldest first. Only the newest says where the sentinel is now.
        const latest = entries[entries.length - 1];
        // A notification can arrive after React removed this sentinel but before
        // this effect's cleanup ran, e.g. once the first page of an empty feed
        // started loading and failed. hasMore/isLoading/loadError are stale then,
        // so only a sentinel that is still rendered may load.
        if (latest.isIntersecting && latest.target.isConnected && hasMore && !isLoading && !loadError) {
          onLoadMoreRef.current?.();
        }
      },
      { threshold: UI.LOAD_MORE_THRESHOLD }
    );

    observer.observe(element);

    return () => {
      if (element) {
        observer.unobserve(element);
      }
      observer.disconnect();
    };
  }, [hasMore, isLoading, loadError, autoLoad]);

  const reportTop = useCallback((index: number, atStart: boolean) => positionRef.current?.show(index, atStart), []);
  const toStart = useCallback(() => windowRef.current?.scrollToEdge('start'), []);

  const renderRow = (item: FeedItem, index: number) => {
    const key = feedItemKey(item);
    const dayLabel = dayStarts.has(index) ? <h3 className="feed-day">{formatDayLabel(item.created_at_epoch)}</h3> : null;
    let card: React.ReactNode;
    if (item.itemType === 'observation') {
      card = <ObservationCard observation={item} onDeleted={onDeleted} deletion={deletes.forRow(key, 'observation', item.id)}
        viewMode={observationModes[key] ?? 'summary'} onViewModeChange={mode => setObservationModes(previous => ({ ...previous, [key]: mode }))}
        subtitleOpen={openSubtitles[key] ?? false} onSubtitleOpenChange={open => setOpenSubtitles(previous => ({ ...previous, [key]: open }))} />;
    } else if (item.itemType === 'summary') {
      card = <SummaryCard summary={item} onDeleted={onDeleted} deletion={deletes.forRow(key, 'summary', item.id)}
        sectionMode={summaryModes[key] ?? 'folded'} onSectionModeChange={mode => setSummaryModes(previous => ({ ...previous, [key]: mode }))} />;
    } else {
      card = <PromptCard prompt={item} expanded={expandedPrompts[key] ?? false} onExpandedChange={expanded => setExpandedPrompts(previous => ({ ...previous, [key]: expanded }))}
        repeats={repeats.get(key)} repeatsOpen={openRepeats[key] ?? false} onRepeatsOpenChange={open => setOpenRepeats(previous => ({ ...previous, [key]: open }))} />;
    }
    return <>{dayLabel}{card}</>;
  };

  return (
    <main className="feed" ref={feedRef} aria-label={t('Memory timeline')} style={{ overflowAnchor: 'none' }}>
      <ScrollToTop targetRef={feedRef} onTop={toStart} />
      <div className="feed-content">
        <PositionBar ref={positionRef} rows={rows} before={before} memoryCount={items.length} onTop={toStart} />
        {header}
        <WindowedFeed ref={windowRef} items={rows} scrollRef={feedRef} onTopIndexChange={reportTop} renderItem={renderRow}
          dayMarks={dayMarks} threshold={windowThreshold} keepMounted={deletes.active} />
        {ending === 'loading' && (rows.length === 0 ? (
          <div className="feed-skeleton" aria-busy="true">
            <span className="visually-hidden" role="status">{t(FEED_ENDING_WORDS.loading)}</span>
            {/* Three placeholder cards fill the first screen at 1440x900 (the heading takes about 300px, a card about 170px). */}
            {[0, 1, 2].map(index => (
              <div key={index} className="feed-skeleton-row" aria-hidden="true">
                <span className="feed-skeleton-line feed-skeleton-line--short" />
                <span className="feed-skeleton-line" />
                <span className="feed-skeleton-line feed-skeleton-line--mid" />
              </div>
            ))}
          </div>
        ) : (
          <div className="feed-ending feed-ending--loading" role="status">
            <span className="spinner" aria-hidden="true" />
            {t(FEED_ENDING_WORDS.loading)}
          </div>
        ))}
        {(ending === 'empty' || (ending === 'more' && rows.length === 0)) && (
          <div className="memory-empty-state">
            <StackIcon size={40} />
            <h3>{t(FEED_ENDING_WORDS.empty)}</h3>
            <p>{emptyHint
              ? t('Observations appear here as you work.')
              : t('Observations appear here as you work. If a filter is selected, try another project or category.')}</p>
            {emptyHint?.detail && <p className="memory-empty-detail">{emptyHint.detail}</p>}
            {((emptyHint && emptyHint.actions.length > 0) || ending === 'more') && (
              <div className="memory-empty-actions">
                {emptyHint?.actions.map(action => <button key={action.label} type="button" onClick={action.onClick}>{action.label}</button>)}
                {ending === 'more' && <button type="button" onClick={onLoadMore}>{t(FEED_ENDING_WORDS.more)}</button>}
              </div>
            )}
          </div>
        )}
        {ending === 'failed' && loadError && (
          // G17: the plain words, the raw reason folded under Details in monospace, then Retry.
          <div className="feed-ending feed-ending--failed" role="alert">
            <WarningIcon size={18} />
            <div className="feed-ending-text">
              <p className="feed-ending-plain">{t(FEED_ENDING_WORDS.failed)}</p>
              <details className="feed-ending-details">
                <summary>{t('Details')}</summary>
                <pre>{translateViewerError(loadError, t)}</pre>
              </details>
            </div>
            {canRetry && <button type="button" onClick={onLoadMore}>{t('Retry')}</button>}
          </div>
        )}
        {ending === null && <div ref={loadMoreRef} className="feed-sentinel" aria-hidden="true" />}
        {ending === 'more' && rows.length > 0 && (
          <div className="feed-ending feed-ending--more">
            <button type="button" onClick={onLoadMore}>{t(FEED_ENDING_WORDS.more)}</button>
          </div>
        )}
        {ending === 'end' && (
          <div className="feed-ending feed-ending--end">
            {offsetCapReachedAt !== null
              ? interpolate(t('This list stops at the newest {count} items. Filter by project to see older ones.'), { count: formatCount(offsetCapReachedAt) })
              : interpolate(t('{ending} · {count} shown'), { ending: t(FEED_ENDING_WORDS.end), count: formatCount(items.length) })}
          </div>
        )}
      </div>
    </main>
  );
}
