import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { FeedItem } from '../types';

export const FEED_WINDOW_THRESHOLD = 500;
const ESTIMATED_HEIGHT = 230;
const OVERSCAN = 5;

export const feedItemKey = (item: FeedItem): string => `${item.itemType}-${item.id}`;

function firstAt(offsets: number[], position: number): number {
  let lo = 0, hi = Math.max(0, offsets.length - 2);
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (offsets[mid + 1] <= position) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

interface WindowedFeedProps {
  items: FeedItem[];
  scrollRef: React.RefObject<HTMLDivElement | null>;
  renderItem: (item: FeedItem) => React.ReactNode;
}

/** Keeps loaded records in memory while mounting only the visible cards on long histories. */
export function WindowedFeed({ items, scrollRef, renderItem }: WindowedFeedProps) {
  const sectionRef = useRef<HTMLDivElement>(null);
  const rows = useRef(new Map<string, HTMLDivElement>());
  const heights = useRef(new Map<string, number>());
  const resizeObserver = useRef<ResizeObserver | null>(null);
  const [revision, setRevision] = useState(0);
  const [viewport, setViewport] = useState({ top: 0, height: 900 });
  const [focusedKey, setFocusedKey] = useState<string | null>(null);
  const windowed = items.length > FEED_WINDOW_THRESHOLD;
  const keys = useMemo(() => items.map(feedItemKey), [items]);
  const positions = useMemo(() => new Map(keys.map((key, index) => [key, index])), [keys]);
  const offsets = useMemo(() => {
    const values = [0];
    for (const key of keys) values.push(values.at(-1)! + (heights.current.get(key) ?? ESTIMATED_HEIGHT));
    return values;
  }, [keys, revision]);
  const geometry = useRef({ keys, positions, offsets, top: 0, windowed, viewport });
  const anchor = useRef<{ key: string; index: number; within: number; atStart: boolean; scrollTop: number } | null>(null);

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
    };
    let frame = 0;
    const onScroll = () => {
      captureAnchor();
      if (!frame) frame = requestAnimationFrame(() => { frame = 0; updateViewport(); });
    };
    const observer = new ResizeObserver(entries => {
      let changed = false;
      captureAnchor();
      for (const entry of entries) {
        const node = entry.target as HTMLElement;
        const key = node.dataset.feedKey;
        if (!key) continue;
        const height = node.getBoundingClientRect().height;
        if (height > 0 && Math.abs((heights.current.get(key) ?? ESTIMATED_HEIGHT) - height) > 0.5) {
          heights.current.set(key, height);
          changed = true;
        }
      }
      // The header above the list can change height without changing a card.
      const top = section.getBoundingClientRect().top - feed.getBoundingClientRect().top + feed.scrollTop;
      if (Math.abs(top - geometry.current.top) > 0.5) changed = true;
      if (changed) setRevision(value => value + 1);
      updateViewport();
    });
    resizeObserver.current = observer;
    for (const node of rows.current.values()) observer.observe(node);
    if (section.parentElement) observer.observe(section.parentElement);
    observer.observe(feed);
    const onResize = () => {
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

  useLayoutEffect(() => {
    const feed = scrollRef.current, section = sectionRef.current;
    if (!feed || !section) return;
    const top = section.getBoundingClientRect().top - feed.getBoundingClientRect().top + feed.scrollTop;
    const previous = geometry.current;
    const wanted = anchor.current;
    const nextGeometry = { keys, positions, offsets, top, windowed, viewport };
    const maxScrollTop = Math.max(0, feed.scrollHeight - feed.clientHeight);
    const clampedByShrink = wanted && wanted.scrollTop > maxScrollTop && Math.abs(feed.scrollTop - maxScrollTop) < 1;
    if (wanted && Math.abs(feed.scrollTop - wanted.scrollTop) > 0.5 && !clampedByShrink) {
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
        feed.scrollTop = rowTop + within;
        anchor.current = { key: keys[index], index, within, atStart: false, scrollTop: feed.scrollTop };
      }
    }
    geometry.current = nextGeometry;
    const present = new Set(keys);
    for (const key of heights.current.keys()) if (!present.has(key)) heights.current.delete(key);
    setViewport(previousViewport => {
      const next = { top: Math.max(0, feed.scrollTop - top), height: feed.clientHeight };
      return next.top === previousViewport.top && next.height === previousViewport.height ? previousViewport : next;
    });
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
      {renderItem(items[index])}
    </div>);
    cursor = offsets[index + 1];
  }
  if (windowed && offsets.at(-1)! > cursor) children.push(<div key="space-after" aria-hidden="true" style={{ height: offsets.at(-1)! - cursor }} />);
  return <div ref={sectionRef} role="list" aria-label="Loaded memories" data-windowed={windowed ? 'true' : 'false'}>{children}</div>;
}
