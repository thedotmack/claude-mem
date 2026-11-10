import { afterEach, expect, it } from 'bun:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { PAGINATION_REQUEST_TIMEOUT_MS, usePagination } from '../../../src/ui/viewer/hooks/usePagination';
import { retainLiveRow, LIVE_ITEMS_PER_KIND } from '../../../src/ui/viewer/utils/live-cache';

const originalFetch = globalThis.fetch;
const originalSetTimeout = globalThis.setTimeout;
afterEach(() => { globalThis.fetch = originalFetch; globalThis.setTimeout = originalSetTimeout; });

function pagination() {
  let result!: ReturnType<typeof usePagination>;
  function Probe() { result = usePagination('owned-project', { platformSource: 'codex', contentSessionId: 'owned-session' }); return null; }
  renderToStaticMarkup(React.createElement(Probe));
  return result.observations;
}
const row = (id: number, at = 10_000 - id) => ({ id, created_at_epoch: at });

it('refreshes the loaded boundary without adding a page suffix or skipping the next page', async () => {
  let rows = Array.from({ length: 150 }, (_, index) => row(index + 1));
  const offsets: number[] = [];
  globalThis.fetch = (async (input) => {
    const url = new URL(String(input), 'http://fixture');
    expect(url.searchParams.get('project')).toBe('owned-project');
    expect(url.searchParams.get('platformSource')).toBe('codex');
    expect(url.searchParams.get('contentSessionId')).toBe('owned-session');
    const offset = Number(url.searchParams.get('offset')); offsets.push(offset);
    return Response.json({ items: rows.slice(offset, offset + 50), hasMore: rows.length > offset + 50 });
  }) as typeof fetch;
  const pages = pagination();
  expect((await pages.loadMore()).length).toBe(50);
  expect((await pages.loadMore()).at(-1)?.id).toBe(100);
  for (let round = 0; round < 3; round++) {
    rows = [row(1000 + round, 20_000 + round), ...rows];
    const refreshed = await pages.refresh();
    expect(refreshed.length).toBe(101 + round);
    expect(refreshed.at(-1)?.id).toBe(100);
  }
  expect((await pages.loadMore()).map(item => item.id)).toEqual(Array.from({ length: 50 }, (_, index) => index + 101));
  expect(offsets.at(-1)).toBe(103);
});

it('handles deleted boundaries and tied timestamps without skipping the next older row', async () => {
  let rows = Array.from({ length: 200 }, (_, index) => row(200 - index, 10_000));
  globalThis.fetch = (async input => {
    const offset = Number(new URL(String(input), 'http://fixture').searchParams.get('offset'));
    return Response.json({ items: rows.slice(offset, offset + 50), hasMore: rows.length > offset + 50 });
  }) as typeof fetch;
  const pages = pagination();
  expect((await pages.loadMore()).at(-1)?.id).toBe(151);
  rows = [row(1000, 10_000), ...rows.filter(item => item.id !== 151)];
  expect((await pages.refresh()).map(item => item.id)).toEqual([1000, ...Array.from({ length: 49 }, (_, index) => 200 - index)]);
  expect((await pages.loadMore())[0].id).toBe(150);
});

it('leaves the previous cursor intact when a multi-page refresh fails', async () => {
  const rows = Array.from({ length: 150 }, (_, index) => row(index + 1));
  let fail = false;
  const offsets: number[] = [];
  globalThis.fetch = (async input => {
    const offset = Number(new URL(String(input), 'http://fixture').searchParams.get('offset')); offsets.push(offset);
    if (fail && offset === 50) return new Response('failed', { status: 503, statusText: 'Unavailable' });
    return Response.json({ items: rows.slice(offset, offset + 50), hasMore: rows.length > offset + 50 });
  }) as typeof fetch;
  const pages = pagination(); await pages.loadMore(); await pages.loadMore();
  fail = true;
  await expect(pages.refresh()).rejects.toThrow('Failed to load');
  fail = false;
  expect((await pages.loadMore())[0].id).toBe(101);
  expect(offsets.at(-1)).toBe(100);
});

it('bounds pages that keep shifting under insert/delete commits and retains the last committed cursor', async () => {
  let moving = false;
  let calls = 0;
  let nextId = 1000;
  let dataset = Array.from({ length: 150 }, (_, index) => row(index + 1));
  const offsets: number[] = [];
  globalThis.fetch = (async input => {
    const offset = Number(new URL(String(input), 'http://fixture').searchParams.get('offset')); offsets.push(offset); calls++;
    if (moving) {
      // Each separate HTTP read sees a later committed server state: inserts
      // keep the old boundary moving back while an old row is deleted.
      const added = Array.from({ length: 50 }, () => row(++nextId, 20_000 + nextId)).reverse();
      dataset = [...added, ...dataset.slice(0, -1)];
    }
    return Response.json({ items: dataset.slice(offset, offset + 50), hasMore: dataset.length > offset + 50 });
  }) as typeof fetch;
  const pages = pagination(); await pages.loadMore();
  moving = true;
  await expect(pages.refresh()).rejects.toThrow('Memory changed too much');
  expect(calls).toBeLessThanOrEqual(22);
  expect((await pages.refreshLatest()).length).toBe(50);
  moving = false;
  await pages.loadMore();
  expect(offsets.at(-1)).toBe(50);
});

it('aborts a hung page, releases loading, and retries without advancing', async () => {
  const offsets: number[] = [];
  let first = true;
  globalThis.setTimeout = ((callback, delay, ...args) => originalSetTimeout(callback, delay === PAGINATION_REQUEST_TIMEOUT_MS ? 5 : delay, ...args)) as typeof setTimeout;
  globalThis.fetch = ((input, init) => {
    offsets.push(Number(new URL(String(input), 'http://fixture').searchParams.get('offset')));
    if (!first) return Promise.resolve(Response.json({ items: [row(1)], hasMore: false }));
    first = false;
    return new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true }));
  }) as typeof fetch;
  const pages = pagination();
  await expect(pages.loadMore()).rejects.toThrow('timed out');
  expect((await pages.loadMore())[0].id).toBe(1);
  expect(offsets).toEqual([0, 0]);
});

it('does not let a superseded page publish after an authoritative refresh', async () => {
  let resolve!: (value: Response) => void;
  let first = true;
  globalThis.fetch = (() => first ? (first = false, new Promise<Response>(done => { resolve = done; }))
    : Promise.resolve(Response.json({ items: [row(99)], hasMore: false }))) as typeof fetch;
  const pages = pagination();
  const old = pages.loadMore(); pages.invalidate();
  expect((await pages.refresh())[0].id).toBe(99);
  resolve(Response.json({ items: [row(1)], hasMore: true }));
  expect(await old).toEqual([]);
  expect(await pages.loadMore()).toEqual([]);
});

it('bounds and deduplicates transient live rows', () => {
  let live: Array<ReturnType<typeof row>> = [];
  for (let id = 1; id <= 5000; id++) live = retainLiveRow(live, row(id));
  expect(live).toHaveLength(LIVE_ITEMS_PER_KIND);
  live = retainLiveRow(live, row(5000, 99_999));
  expect(live).toHaveLength(LIVE_ITEMS_PER_KIND);
  expect(live[0].created_at_epoch).toBe(99_999);
});
