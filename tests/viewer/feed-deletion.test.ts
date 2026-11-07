import { describe, it, expect } from 'bun:test';
import {
  deleteFeedItem,
  describeDeleteFailure,
  itemDeletedTarget,
  removeLoadedRow,
} from '../../src/ui/viewer/utils/feed-deletion';
import type { StreamEvent } from '../../src/ui/viewer/types';

describe('viewer delete flow', () => {
  it('DELETEs through the sync-safe endpoint for the item type', async () => {
    const calls: Array<{ url: string; method?: string }> = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method });
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    }) as typeof fetch;

    await deleteFeedItem('observation', 42, fetchImpl);
    await deleteFeedItem('summary', 7, fetchImpl);

    expect(calls).toEqual([
      { url: '/api/observation/42', method: 'DELETE' },
      { url: '/api/summary/7', method: 'DELETE' },
    ]);
  });

  it('explains a 404: synced from another device, or already gone', async () => {
    const fetchImpl = (async () => new Response('{"error":"observation #42 not found"}', { status: 404 })) as typeof fetch;
    await expect(deleteFeedItem('observation', 42, fetchImpl)).rejects.toThrow('synced from another device');
  });

  it('explains a 503: cloud sync cannot record the delete right now', async () => {
    const fetchImpl = (async () => new Response('{"error":"cloud sync unavailable; refusing an unreplicated delete"}', { status: 503 })) as typeof fetch;
    await expect(deleteFeedItem('summary', 3, fetchImpl)).rejects.toThrow('cloud sync is unavailable');
  });

  it('explains an unreachable worker instead of surfacing a raw fetch error', async () => {
    const fetchImpl = (async () => { throw new TypeError('Failed to fetch'); }) as typeof fetch;
    await expect(deleteFeedItem('observation', 1, fetchImpl)).rejects.toThrow('worker could not be reached');
  });

  it('names the status for any other refusal', () => {
    expect(describeDeleteFailure(500)).toBe('Not deleted: the worker answered HTTP 500.');
  });
});

describe('item_deleted SSE events', () => {
  it('names the deleted row', () => {
    const event: StreamEvent = { type: 'item_deleted', itemType: 'observation', id: 42 };
    expect(itemDeletedTarget(event)).toEqual({ itemType: 'observation', id: 42 });
    expect(itemDeletedTarget({ type: 'item_deleted', itemType: 'prompt', id: 9 })).toEqual({ itemType: 'prompt', id: 9 });
  });

  it('ignores other event types and malformed payloads', () => {
    expect(itemDeletedTarget({ type: 'new_observation' })).toBeNull();
    expect(itemDeletedTarget({ type: 'item_deleted', itemType: 'observation' })).toBeNull();
    expect(itemDeletedTarget({ type: 'item_deleted', itemType: 'observation', id: '42' as unknown as number })).toBeNull();
    expect(itemDeletedTarget({ type: 'item_deleted', itemType: 'session' as never, id: 1 })).toBeNull();
  });
});

describe('loaded page bookkeeping after a delete', () => {
  it('reports a removed loaded row so the page offset can move back by one', () => {
    const rows = [{ id: 3 }, { id: 2 }, { id: 1 }];
    expect(removeLoadedRow(rows, 2)).toEqual({ rows: [{ id: 3 }, { id: 1 }], wasLoaded: true });
  });

  it('reports a row that was never loaded (live-only or beyond the loaded pages)', () => {
    const rows = [{ id: 3 }, { id: 1 }];
    expect(removeLoadedRow(rows, 2)).toEqual({ rows, wasLoaded: false });
  });
});
