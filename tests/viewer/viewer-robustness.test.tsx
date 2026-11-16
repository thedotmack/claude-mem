import { describe, expect, it, jest } from 'bun:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ShortTime } from '../../src/ui/viewer/components/ShortTime';
import { GITHUB_STARS_TIMEOUT_MS, readStarCount } from '../../src/ui/viewer/hooks/useGitHubStars';
import { SessionDetailPage, SESSION_PAGE_WINDOW_THRESHOLD } from '../../src/ui/viewer/components/SessionDetailPage';
import { FEED_WINDOW_THRESHOLD } from '../../src/ui/viewer/components/WindowedFeed';
import type { FeedItem } from '../../src/ui/viewer/types';

describe('a time stamp that is not a time', () => {
  it('reads "Unknown time" instead of stopping the list', () => {
    for (const epoch of [Number.NaN, Number.POSITIVE_INFINITY, 8.64e15 + 1]) {
      const html = renderToStaticMarkup(<ShortTime epoch={epoch} detail="claude · #7" />);
      expect(html).toContain('Unknown time');
      expect(html).toContain('claude · #7');
      expect(html).not.toContain('<time');
    }
    expect(renderToStaticMarkup(<ShortTime epoch={Date.UTC(2026, 10, 15, 18, 7)} />)).toContain('dateTime="2026-11-15T18:07:00.000Z"');
  });
});

describe('the GitHub star count', () => {
  const answering = (body: unknown, status = 200) => {
    let calls = 0;
    const fetchImpl = (async () => { calls++; return new Response(JSON.stringify(body), { status }); }) as typeof fetch;
    return { fetchImpl, calls: () => calls };
  };

  it('is read once for the page and kept', async () => {
    const github = answering({ stargazers_count: 117_400 });
    expect(await readStarCount('owner', 'kept-repo', github.fetchImpl)).toBe(117_400);
    expect(await readStarCount('owner', 'kept-repo', github.fetchImpl)).toBe(117_400);
    expect(github.calls()).toBe(1);
  });

  it('shows no count when GitHub answers without one, or refuses', async () => {
    const original = console.error;
    console.error = () => {};
    try {
      expect(await readStarCount('owner', 'no-field', answering({ message: 'API rate limit exceeded' }).fetchImpl)).toBeNull();
      expect(await readStarCount('owner', 'not-a-number', answering({ stargazers_count: '117k' }).fetchImpl)).toBeNull();
      expect(await readStarCount('owner', 'not-json', (async () => new Response('<html>', { status: 200 })) as typeof fetch)).toBeNull();
      expect(await readStarCount('owner', 'refused', answering({}, 403).fetchImpl)).toBeNull();
    } finally { console.error = original; }
  });

  it('gives up at GitHub\'s own 10 second request limit', async () => {
    expect(GITHUB_STARS_TIMEOUT_MS).toBe(10_000);
    let signal: AbortSignal | undefined;
    const fetchImpl = (async (_url: string, init?: RequestInit) => { signal = init?.signal ?? undefined; return new Response('{"stargazers_count":1}'); }) as typeof fetch;
    await readStarCount('owner', 'timed', fetchImpl);
    expect(signal).toBeInstanceOf(AbortSignal);
  });

  it('aborts a request GitHub never answers once the 10 seconds pass, and shows no count', async () => {
    const original = console.error;
    console.error = () => {};
    jest.useFakeTimers();
    try {
      let signal: AbortSignal | undefined;
      // A request that ends only when its signal aborts, as fetch does.
      const fetchImpl = ((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
        signal = init?.signal ?? undefined;
        signal?.addEventListener('abort', () => reject(signal!.reason));
      })) as typeof fetch;
      const count = readStarCount('owner', 'never-answers', fetchImpl);
      expect(signal).toBeInstanceOf(AbortSignal);
      jest.advanceTimersByTime(GITHUB_STARS_TIMEOUT_MS - 1);
      expect(signal!.aborted).toBe(false);
      jest.advanceTimersByTime(1);
      expect(signal!.aborted).toBe(true);
      expect(await count).toBeNull();
    } finally {
      jest.useRealTimers();
      console.error = original;
    }
  });
});

describe('session pages', () => {
  it('keep every row drawn up to 500, so the browser\'s find still sees them', () => {
    expect(SESSION_PAGE_WINDOW_THRESHOLD).toBe(500);
    expect(FEED_WINDOW_THRESHOLD).toBe(50);
    const items: FeedItem[] = Array.from({ length: 120 }, (_, index) => ({
      itemType: 'prompt', id: index + 1, project: 'p', platform_source: 'claude', content_session_id: 's',
      prompt_number: index + 1, prompt_text: `prompt ${index + 1}`, created_at_epoch: 1_793_800_000_000 - index * 1000,
    }));
    const html = renderToStaticMarkup(<SessionDetailPage tabs={null} title="A session" session={{ platformSource: 'claude', contentSessionId: 's' }}
      items={items} isLoading={false} hasMore={false} onLoadMore={() => {}} onDeleted={() => {}} onBack={() => {}} />);
    expect(html).toContain('data-windowed="false"');
    expect(html.match(/role="listitem"/g)?.length).toBe(120);
  });
});
