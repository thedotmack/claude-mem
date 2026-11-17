import React, { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { interpolate, useI18n } from '../../i18n';
import type { FeedItem } from '../types';
import { feedItemKey } from '../utils/feed-display';
import { scrollBehaviorForReader } from './ScrollToTop';

export { feedItemKey };

/** UI UX Pro Max `virtualize-lists`: recycle rows once a list passes 50 items. */
export const FEED_WINDOW_THRESHOLD = 50;
// Mean drawn row height on the owner's timeline with the folded cards (205px over 146 rows on 2026-11-16;
// medians: observations 170, summaries 335, prompts 84). Rows are measured as soon as they are drawn.
const ESTIMATED_HEIGHT = 205;
// Five rows above and below the window (about 850px at the 170px median row): Tab and the arrow keys
// land in drawn rows, and a fast flick shows rows rather than blank space before the next frame.
const OVERSCAN = 5;
/**
 * React stops with error 185 once one update chain nests more than 50 synchronous
 * commits (NESTED_UPDATE_LIMIT in react-dom 19), and each layout pass below asks for
 * at most one more. The longest chains measured while the list settled were 8 passes
 * (the owner's 5,600-row history at 390px) and 5 (6,200 rows at 1440px; the 4,200-row
 * scroll test), on 2026-11-16. 20 is 2.5 times the longest and well under React's 50,
 * which leaves room for the cards' own one-pass measurements in the same chain. Past
 * it the list stops correcting itself and says so in the console; it starts again
 * when the reader scrolls, resizes, presses a key or the pointer, or rows change, so
 * a row that never settles costs one bounded chain per such event, never a loop.
 */
const MAX_NESTED_LAYOUT_PASSES = 20;
// A drawn row whose height changed by less than half a pixel has not changed (subpixel layout).
const HEIGHT_EPSILON_PX = 0.5;
// Day marks closer than one mark's own height (24px, 44px on touch) plus this gap are merged. 4px is the token
// sheet's smallest spacing step (4 / 8 / 16 / 24, viewer-template.html), so two marks never touch: each keeps its
// own target and hover fill instead of reading as one taller button.
const RAIL_MARK_SPACING_PX = 4;

function firstAt(offsets: number[], position: number): number {
  let lo = 0, hi = Math.max(0, offsets.length - 2);
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (offsets[mid + 1] <= position) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

type Edge = 'start' | 'end';

/** Home and End (Ctrl too), and Command+Up and Command+Down on a Mac: the keys that jump a page to its start or end. */
function edgeForKey(event: KeyboardEvent): Edge | null {
  if (event.altKey || event.shiftKey) return null;
  if (!event.metaKey && event.key === 'Home') return 'start';
  if (!event.metaKey && event.key === 'End') return 'end';
  if (event.metaKey && !event.ctrlKey && event.key === 'ArrowUp') return 'start';
  if (event.metaKey && !event.ctrlKey && event.key === 'ArrowDown') return 'end';
  return null;
}

/** A field, or a widget that moves within itself on Home and End, keeps those keys. */
function keepsItsOwnKeys(target: Element): boolean {
  return target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"]), '
    + '[role="menu"], [role="menubar"], [role="listbox"], [role="combobox"], [role="grid"], [role="tree"], '
    + '[role="tablist"], [role="radiogroup"], [role="slider"], [role="spinbutton"]') !== null;
}

export interface WindowedFeedHandle {
  /**
   * Top, Home and End: scroll to the list's start or end, smoothly unless the reader
   * asked for reduced motion, and stay on course while rows are drawn and measured.
   */
  scrollToEdge(edge: Edge): void;
}

interface DayMark { index: number; label: string }

interface WindowedFeedProps<T> {
  items: T[];
  scrollRef: React.RefObject<HTMLElement | null>;
  renderItem: (item: T, index: number) => React.ReactNode;
  /**
   * A stable key per row: feedItemKey for timeline rows, sessionKey for Sessions rows. Pass a function defined
   * outside the component. Required: a list of anything but timeline rows once fell back to feedItemKey, which gave
   * every row the key "undefined-undefined", so the rows collapsed into one key and shared one measured height.
   */
  itemKey: (item: T) => string;
  /** A row's height before it is first drawn and measured; the timeline's mean card unless the list's rows differ. */
  estimatedHeight?: number;
  /** The list's accessible name; "Loaded memories" unless the list holds something else. */
  listLabel?: string;
  /** The row at the top of the scroll view, and whether the list is still at its start, reported once per frame while scrolling. */
  onTopIndexChange?: (index: number, atStart: boolean) => void;
  /** The first row of each day, for the thin day rail beside a long list. */
  dayMarks?: DayMark[];
  /** Rows that stay drawn wherever the reader scrolls (a delete on its way, or the reason it did not finish). */
  keepMounted?: ReadonlySet<string>;
}

/**
 * The thin rail along the right edge of a wide window: where each loaded day starts,
 * and where the reader is now. Days too close to show apart are merged into the mark
 * above them, and that mark says how many more days it holds ("Oct 30 +2").
 */
function DayRail({ marks, offsets, total, viewportTop, onJump }: {
  marks: DayMark[]; offsets: number[]; total: number; viewportTop: number; onJump: (index: number) => void;
}) {
  const { t } = useI18n();
  const railRef = useRef<HTMLElement>(null);
  // The rail is shorter than the list's view (fixed 96px from the top and bottom), and its marks are 24px
  // tall, 44px on touch: both are read from the page after each render instead of being assumed here.
  const [box, setBox] = useState({ height: 0, mark: 24 });
  useLayoutEffect(() => {
    const rail = railRef.current;
    if (!rail) return;
    const mark = rail.querySelector<HTMLElement>('.feed-day-rail-mark');
    const next = { height: rail.clientHeight, mark: mark?.offsetHeight || box.mark };
    if (next.height !== box.height || next.mark !== box.mark) setBox(next);
  });
  const groups: Array<{ mark: DayMark; more: number }> = [];
  let lastPixel = -Infinity;
  for (const mark of marks) {
    const pixel = (offsets[mark.index] / total) * box.height;
    if (groups.length && pixel - lastPixel < box.mark + RAIL_MARK_SPACING_PX) groups[groups.length - 1].more++;
    else { groups.push({ mark, more: 0 }); lastPixel = pixel; }
  }
  return (
    <nav ref={railRef} className="feed-day-rail" aria-label={t('Jump to a day')}>
      {box.height > 0 && groups.map(({ mark, more }) => {
        const name = more ? interpolate(more === 1 ? t('{day} and {count} more day') : t('{day} and {count} more days'), { day: mark.label, count: more }) : undefined;
        return (
          <button key={mark.index} type="button" className="feed-day-rail-mark" style={{ top: `${(offsets[mark.index] / total) * 100}%` }}
            aria-label={name} title={name} onClick={() => onJump(mark.index)}>
            {mark.label}
            {more > 0 && <span className="feed-day-rail-more" aria-hidden="true">+{more}</span>}
          </button>
        );
      })}
      <span className="feed-day-rail-here" aria-hidden="true" style={{ top: `${Math.min(100, (viewportTop / total) * 100)}%` }} />
    </nav>
  );
}

/** Keeps loaded records in memory while mounting only the visible cards on long histories. */
function WindowedFeedList<T>({
  items, scrollRef, renderItem, onTopIndexChange, dayMarks, keepMounted,
  itemKey, estimatedHeight = ESTIMATED_HEIGHT, listLabel,
}: WindowedFeedProps<T>, ref: React.ForwardedRef<WindowedFeedHandle>) {
  const { t } = useI18n();
  const sectionRef = useRef<HTMLDivElement>(null);
  const rows = useRef(new Map<string, HTMLDivElement>());
  const heights = useRef(new Map<string, number>());
  const resizeObserver = useRef<ResizeObserver | null>(null);
  const [revision, setRevision] = useState(0);
  // Before the first measurement: a laptop window's height, replaced by the real one in the first layout pass.
  const [viewport, setViewport] = useState({ top: 0, height: 900 });
  const [focusedKey, setFocusedKey] = useState<string | null>(null);
  const windowed = items.length > FEED_WINDOW_THRESHOLD;
  const keys = useMemo(() => items.map(itemKey), [items, itemKey]);
  const positions = useMemo(() => new Map(keys.map((key, index) => [key, index])), [keys]);
  const offsets = useMemo(() => {
    const values = [0];
    for (const key of keys) values.push(values.at(-1)! + (heights.current.get(key) ?? estimatedHeight));
    return values;
  }, [keys, revision, estimatedHeight]);
  const geometry = useRef({ keys, positions, offsets, top: 0, windowed, viewport });
  const anchor = useRef<{ key: string; index: number; within: number; atStart: boolean; scrollTop: number } | null>(null);
  /**
   * A Top, Home or End on its way. While it is set the list never re-pins a row: writing
   * scrollTop would cancel a smooth scroll partway. "start" ends at the top; "end" follows
   * the end as rows are measured, and ends there, at the reader's next scroll, or when rows
   * are added at the end (that end was reached; older pages are not chased).
   */
  const edgeIntent = useRef<{ edge: Edge; target: number; lastKey: string | undefined; behavior: ScrollBehavior } | null>(null);
  // The previous layout pass asked React for another commit, so the next pass is nested in the same chain.
  const correctionPending = useRef(false);
  const nestedPasses = useRef(0);
  // Stopped after MAX_NESTED_LAYOUT_PASSES; `holdReported` says it once until the list settles again.
  const holding = useRef(false);
  const holdReported = useRef(false);
  // The last scrollTop this list wrote, to tell its own scroll events from the reader's.
  const lastWrittenTop = useRef<number | null>(null);
  const reportTopIndex = useRef(onTopIndexChange);
  reportTopIndex.current = onTopIndexChange;

  const recordHeight = (key: string, node: HTMLElement): boolean => {
    const height = node.getBoundingClientRect().height;
    if (height <= 0 || Math.abs((heights.current.get(key) ?? estimatedHeight) - height) <= HEIGHT_EPSILON_PX) return false;
    heights.current.set(key, height);
    return true;
  };

  const captureAnchor = () => {
    const feed = scrollRef.current;
    const previous = geometry.current;
    if (!feed || !previous.keys.length) return;
    const localTop = Math.max(0, feed.scrollTop - previous.top);
    let index = firstAt(previous.offsets, localTop);
    let within = localTop - previous.offsets[index];
    const feedTop = feed.getBoundingClientRect().top;
    // Estimates can differ substantially from the full list's real height at
    // the windowing threshold. Capture the visible row, not its estimate.
    let visible: { key: string; top: number } | undefined;
    if (!previous.windowed) {
      // All rows are mounted; binary search avoids measuring the entire list
      // on every scroll event.
      let lo = 0, hi = previous.keys.length;
      while (lo < hi) {
        const mid = Math.floor((lo + hi) / 2);
        const node = rows.current.get(previous.keys[mid]);
        if (!node) break;
        if (node.getBoundingClientRect().bottom <= feedTop) lo = mid + 1;
        else hi = mid;
      }
      const key = previous.keys[Math.min(lo, previous.keys.length - 1)];
      const node = rows.current.get(key);
      if (node) visible = { key, top: node.getBoundingClientRect().top };
    } else {
      for (const [key, node] of rows.current) {
        const rect = node.getBoundingClientRect();
        if (rect.bottom > feedTop && (!visible || rect.top < visible.top)) visible = { key, top: rect.top };
      }
    }
    if (visible && previous.positions.has(visible.key)) {
      index = previous.positions.get(visible.key)!;
      within = feedTop - visible.top;
    }
    anchor.current = { key: previous.keys[index], index, within, atStart: feed.scrollTop <= previous.top + 2, scrollTop: feed.scrollTop };
  };

  /** The reader scrolled, pressed a key or the pointer: any Top, Home or End gives way, and a stopped list tries again. */
  const releaseForReader = useCallback(() => {
    edgeIntent.current = null;
    holding.current = false;
  }, []);

  const scrollToEdge = useCallback((edge: Edge) => {
    const feed = scrollRef.current;
    if (!feed) return;
    holding.current = false;
    const behavior = scrollBehaviorForReader();
    const target = edge === 'start' ? 0 : Math.max(0, feed.scrollHeight - feed.clientHeight);
    // Already at the top: nothing is on its way (and no scroll event would end it).
    edgeIntent.current = edge === 'start' && feed.scrollTop <= 1 ? null : { edge, target, lastKey: geometry.current.keys.at(-1), behavior };
    feed.scrollTo({ top: target, behavior });
  }, [scrollRef]);
  useImperativeHandle(ref, () => ({ scrollToEdge }), [scrollToEdge]);

  useEffect(() => {
    const feed = scrollRef.current, section = sectionRef.current;
    if (!feed || !section) return;
    const updateViewport = () => {
      captureAnchor();
      const top = section.getBoundingClientRect().top - feed.getBoundingClientRect().top + feed.scrollTop;
      setViewport(previous => {
        const next = { top: Math.max(0, feed.scrollTop - top), height: feed.clientHeight };
        return next.top === previous.top && next.height === previous.height ? previous : next;
      });
      if (anchor.current) reportTopIndex.current?.(anchor.current.index, anchor.current.atStart);
    };
    let frame = 0;
    const onScroll = () => {
      if (holding.current) {
        // The scroll event of the list's own last write keeps it stopped; any other scroll is the reader's.
        if (lastWrittenTop.current !== null && Math.abs(feed.scrollTop - lastWrittenTop.current) <= HEIGHT_EPSILON_PX) return;
        holding.current = false;
      }
      if (edgeIntent.current?.edge === 'start' && feed.scrollTop <= 1) edgeIntent.current = null;
      captureAnchor();
      if (!frame) frame = requestAnimationFrame(() => { frame = 0; updateViewport(); });
    };
    const observer = new ResizeObserver(entries => {
      if (holding.current) return;
      let changed = false;
      captureAnchor();
      for (const entry of entries) {
        const node = entry.target as HTMLElement;
        const key = node.dataset.feedKey;
        if (key && recordHeight(key, node)) changed = true;
      }
      // The header above the list can change height without changing a card.
      const top = section.getBoundingClientRect().top - feed.getBoundingClientRect().top + feed.scrollTop;
      if (Math.abs(top - geometry.current.top) > HEIGHT_EPSILON_PX) changed = true;
      if (changed) setRevision(value => value + 1);
      updateViewport();
    });
    resizeObserver.current = observer;
    for (const node of rows.current.values()) observer.observe(node);
    if (section.parentElement) observer.observe(section.parentElement);
    observer.observe(feed);
    const onResize = () => {
      holding.current = false;
      captureAnchor();
      heights.current.clear();
      setRevision(value => value + 1);
      updateViewport();
    };
    feed.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onResize);
    updateViewport();
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      resizeObserver.current = null;
      feed.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onResize);
    };
  }, [scrollRef]);

  useEffect(() => {
    const feed = scrollRef.current;
    if (!feed) return;
    // The list is the page's main scroller, so keys pressed on the page itself reach it (as the
    // browser's own Home and End do) until the reader presses the pointer somewhere else.
    let pointerInFeed = true;
    const onPointerDown = (event: PointerEvent) => {
      pointerInFeed = event.target instanceof Node && feed.contains(event.target);
      if (pointerInFeed) releaseForReader();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      const inFeed = target !== null && feed.contains(target);
      const onPage = target === null || target === document.body || target === document.documentElement;
      if (!inFeed && !(onPage && pointerInFeed)) return;
      const edge = edgeForKey(event);
      // Runs after the page's own handlers (a menu's Home and End call preventDefault).
      if (!edge || event.defaultPrevented || (target && keepsItsOwnKeys(target))) { releaseForReader(); return; }
      event.preventDefault();
      scrollToEdge(edge);
    };
    feed.addEventListener('wheel', releaseForReader, { passive: true });
    feed.addEventListener('touchstart', releaseForReader, { passive: true });
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      feed.removeEventListener('wheel', releaseForReader);
      feed.removeEventListener('touchstart', releaseForReader);
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [scrollRef, releaseForReader, scrollToEdge]);

  useLayoutEffect(() => {
    const feed = scrollRef.current, section = sectionRef.current;
    if (!feed || !section) return;
    const previous = geometry.current;
    const top = section.getBoundingClientRect().top - feed.getBoundingClientRect().top + feed.scrollTop;
    const nextGeometry = { keys, positions, offsets, top, windowed, viewport };
    // Count only the passes of one synchronous chain (each asked for by the pass before it),
    // never separate updates: live rows in a background tab must not add up to a stop.
    nestedPasses.current = correctionPending.current ? nestedPasses.current + 1 : 1;
    correctionPending.current = false;
    if (previous.keys !== keys) holding.current = false;
    if (!holding.current && nestedPasses.current > MAX_NESTED_LAYOUT_PASSES) {
      holding.current = true;
      if (!holdReported.current) {
        holdReported.current = true;
        console.warn(`[viewer] The memory list did not settle in ${MAX_NESTED_LAYOUT_PASSES} layout passes; it stops adjusting until you scroll or the list changes.`);
      }
    }
    if (holding.current) {
      geometry.current = nextGeometry;
      return;
    }
    // Measure the rows this commit mounted before using any position. Spacers
    // hold estimates for rows never drawn; if the anchor restore below worked
    // from estimates, moving the window would swap rows between estimated and
    // real heights, move the anchor, move the window back, and repeat inside
    // one commit until React stopped with error 185 (B1: jumping to the end of
    // a long timeline). ResizeObserver cannot break that loop: it only reports
    // after the synchronous commit chain ends.
    let measured = false;
    for (const [key, node] of rows.current) if (recordHeight(key, node)) measured = true;
    const wanted = anchor.current;
    const maxScrollTop = Math.max(0, feed.scrollHeight - feed.clientHeight);
    const clampedByShrink = wanted && wanted.scrollTop > maxScrollTop && Math.abs(feed.scrollTop - maxScrollTop) < 1;
    // Rows added at the end mean the end that End aimed at was reached; older pages are not chased.
    if (edgeIntent.current?.edge === 'end' && keys.at(-1) !== edgeIntent.current.lastKey) edgeIntent.current = null;
    const intent = edgeIntent.current;
    if (intent) {
      // Top, Home or End on its way: never re-pin a row. The start is fixed; the end moves as rows are measured.
      // A smooth scroll toward the estimated end is left alone until it stops (a new scrollTo starts again from
      // rest, so steering at every measured row made End crawl), then the list jumps the rest of the way:
      // a short distance, as only the rows drawn on the way changed the end.
      if (intent.edge === 'end') {
        const arrived = Math.abs(feed.scrollTop - Math.min(intent.target, maxScrollTop)) <= 1;
        if (arrived && maxScrollTop - feed.scrollTop > 1) {
          intent.target = maxScrollTop;
          intent.behavior = 'auto';
          feed.scrollTo({ top: maxScrollTop, behavior: 'auto' });
          lastWrittenTop.current = feed.scrollTop;
        }
      } else if (feed.scrollTop <= 1) {
        edgeIntent.current = null;
      }
    } else if (wanted && Math.abs(feed.scrollTop - wanted.scrollTop) > HEIGHT_EPSILON_PX && !clampedByShrink) {
      // scrollIntoView, keyboard focus or a user scroll can precede its native
      // scroll event. Do not undo that newer intent with the last saved anchor.
      geometry.current = nextGeometry;
      captureAnchor();
    } else if (wanted && !wanted.atStart && (previous.keys !== keys || previous.offsets !== offsets || previous.viewport !== viewport)) {
      let index = positions.get(wanted.key);
      let within = wanted.within;
      if (index === undefined) {
        // If the anchor itself was deleted, keep its next surviving neighbour
        // at the same edge instead of jumping a whole viewport forward.
        const next = previous.keys.slice(wanted.index + 1).find(key => positions.has(key))
          ?? previous.keys.slice(0, wanted.index).reverse().find(key => positions.has(key));
        index = next === undefined ? undefined : positions.get(next);
        within = 0;
      }
      if (index !== undefined) {
        const row = rows.current.get(keys[index]);
        const rowTop = row
          ? row.getBoundingClientRect().top - feed.getBoundingClientRect().top + feed.scrollTop
          : top + offsets[index];
        // Write only a real move: even an unchanged scrollTop write cancels a smooth scroll in progress.
        if (Math.abs(feed.scrollTop - (rowTop + within)) > HEIGHT_EPSILON_PX) {
          feed.scrollTop = rowTop + within;
          lastWrittenTop.current = feed.scrollTop;
        }
        anchor.current = { key: keys[index], index, within, atStart: false, scrollTop: feed.scrollTop };
      }
    }
    geometry.current = nextGeometry;
    const present = new Set(keys);
    for (const key of heights.current.keys()) if (!present.has(key)) heights.current.delete(key);
    const nextViewport = { top: Math.max(0, feed.scrollTop - top), height: feed.clientHeight };
    const viewportChanged = nextViewport.top !== viewport.top || nextViewport.height !== viewport.height;
    // End has arrived once the window is drawn where the reader is and nothing in it changed size.
    if (edgeIntent.current?.edge === 'end' && !measured && !viewportChanged
      && Math.abs(feed.scrollTop - Math.max(0, feed.scrollHeight - feed.clientHeight)) <= 1) {
      edgeIntent.current = null;
    }
    if (measured || viewportChanged) {
      correctionPending.current = true;
      queueMicrotask(() => { correctionPending.current = false; });
    } else {
      // Settled: a later stop is a new episode, worth saying again.
      holdReported.current = false;
    }
    if (measured) setRevision(value => value + 1);
    if (viewportChanged) setViewport(nextViewport);
  }, [keys, offsets, positions, scrollRef, windowed, viewport]);

  const first = Math.max(0, firstAt(offsets, viewport.top) - OVERSCAN);
  const last = Math.min(items.length, firstAt(offsets, viewport.top + viewport.height) + OVERSCAN + 1);
  const selected = windowed ? Array.from({ length: Math.max(0, last - first) }, (_, index) => first + index) : items.map((_, index) => index);
  const focusedIndex = focusedKey === null ? -1 : positions.get(focusedKey) ?? -1;
  const includeNeighbours = (position: number) => {
    for (let index = Math.max(0, position - OVERSCAN); index < Math.min(items.length, position + OVERSCAN + 1); index++) {
      if (!selected.includes(index)) selected.push(index);
    }
  };
  if (windowed) {
    // A full-list -> window transition must mount the actual previous anchor
    // even before the newly introduced spacer estimates have converged.
    const anchorIndex = anchor.current && positions.get(anchor.current.key);
    if (geometry.current.keys !== keys && anchorIndex !== null && anchorIndex !== undefined) includeNeighbours(anchorIndex);
    // Keep neighbours too: Tab from the focused card must reach the next
    // loaded card, not skip directly to a distant viewport window.
    if (focusedIndex >= 0) includeNeighbours(focusedIndex);
    for (const key of keepMounted ?? []) {
      const index = positions.get(key);
      if (index !== undefined && !selected.includes(index)) selected.push(index);
    }
    selected.sort((a, b) => a - b);
  }
  const children: React.ReactNode[] = [];
  let cursor = 0;
  for (const index of selected) {
    const key = keys[index];
    if (windowed && offsets[index] > cursor) children.push(<div key={`space-before-${key}`} aria-hidden="true" style={{ height: offsets[index] - cursor }} />);
    children.push(<div key={key} data-feed-key={key} role="listitem" aria-posinset={index + 1} aria-setsize={items.length}
      style={{ display: 'flow-root' }}
      ref={node => {
        const old = rows.current.get(key);
        if (old) resizeObserver.current?.unobserve(old);
        if (node) { rows.current.set(key, node); resizeObserver.current?.observe(node); }
        else rows.current.delete(key);
      }}
      onFocusCapture={() => setFocusedKey(key)}
      onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocusedKey(current => current === key ? null : current); }}>
      {renderItem(items[index], index)}
    </div>);
    cursor = offsets[index + 1];
  }
  if (windowed && offsets.at(-1)! > cursor) children.push(<div key="space-after" aria-hidden="true" style={{ height: offsets.at(-1)! - cursor }} />);

  const total = offsets.at(-1)!;
  const jumpToDay = (index: number) => {
    const feed = scrollRef.current;
    if (feed) feed.scrollTop = geometry.current.top + offsets[index];
  };
  return (
    <>
      <div ref={sectionRef} role="list" aria-label={listLabel ?? t('Loaded memories')} data-windowed={windowed ? 'true' : 'false'}>{children}</div>
      {windowed && dayMarks && dayMarks.length > 1 && total > 0 && (
        <DayRail marks={dayMarks} offsets={offsets} total={total} viewportTop={viewport.top} onJump={jumpToDay} />
      )}
    </>
  );
}

/** The windowed list for any rows: timeline rows (FeedItem) by default, each list keyed by its own `itemKey`. */
export const WindowedFeed = forwardRef(WindowedFeedList) as <T = FeedItem>(
  props: WindowedFeedProps<T> & React.RefAttributes<WindowedFeedHandle>,
) => React.ReactElement | null;

// Fails the viewer typecheck if `itemKey` becomes optional again (the "undefined-undefined" key hole above).
const ITEM_KEY_IS_REQUIRED: undefined extends WindowedFeedProps<unknown>['itemKey'] ? never : true = true;
void ITEM_KEY_IS_REQUIRED;
