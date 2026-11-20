import { afterEach, describe, expect, it } from 'bun:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { PageRejectedError, usePagination } from '../../../src/ui/viewer/hooks/usePagination.js';
import { Feed } from '../../../src/ui/viewer/components/Feed.js';
import { SessionList } from '../../../src/ui/viewer/components/SessionList.js';

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

// React's real hook dispatcher supplies the callback and refs without a DOM.
function pagination() {
  let result: ReturnType<typeof usePagination> | undefined;
  function Probe() {
    result = usePagination('owned-project');
    return null;
  }
  renderToStaticMarkup(React.createElement(Probe));
  return result!;
}

function serve(answer: () => Response) {
  const offsets: string[] = [];
  const server = Bun.serve({
    hostname: '127.0.0.1', port: 0,
    fetch(request) {
      offsets.push(new URL(request.url).searchParams.get('offset')!);
      return answer();
    },
  });
  globalThis.fetch = ((input, init) => originalFetch(new URL(String(input), server.url), init)) as typeof fetch;
  return { offsets, stop: () => server.stop(true) };
}

// The server runtime caps the feed offset; its last allowed page says so
// instead of hasMore, and a refused request must not be offered for retry.
describe('viewer pagination at the server offset cap', () => {
  it('stops paging after a page that reports offsetCapReached', async () => {
    const server = serve(() => Response.json({ items: [{ id: 1 }], hasMore: false, offsetCapReached: true, maxOffset: 10_000 }));
    try {
      const page = pagination().observations;
      expect(await page.loadMore()).toEqual([{ id: 1 }]);
      expect(await page.loadMore()).toEqual([]);
      expect(server.offsets).toEqual(['0']);
    } finally {
      server.stop();
    }
  });

  it('rejects a refused page with the server message and does not request it again', async () => {
    const message = 'offset must be at most 10000; narrow the listing with filters to reach older rows';
    const server = serve(() => Response.json({ error: 'BadRequest', message }, { status: 400 }));
    try {
      const page = pagination().observations;
      const failure = await page.loadMore().catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(PageRejectedError);
      expect((failure as Error).message).toBe(`Failed to load observations: ${message}`);
      expect(await page.loadMore()).toEqual([]);
      expect(server.offsets).toEqual(['0']);
    } finally {
      server.stop();
    }
  });

  it('keeps a rate-limited page retryable', async () => {
    const server = serve(() => new Response('slow down', { status: 429, statusText: 'Too Many Requests' }));
    try {
      const page = pagination().summaries;
      const failure = await page.loadMore().catch((error: unknown) => error);
      expect(failure).not.toBeInstanceOf(PageRejectedError);
      await page.loadMore().catch(() => {});
      expect(server.offsets).toEqual(['0', '0']);
    } finally {
      server.stop();
    }
  });
});

describe('viewer list endings at the offset cap', () => {
  const feedItem = { itemType: 'prompt', id: 1, prompt_text: 'hi', created_at_epoch: 1 } as never;

  it('shows a closing line instead of "No more items" when the feed hit the cap', () => {
    const html = renderToStaticMarkup(React.createElement(Feed, {
      items: [feedItem], isLoading: false, hasMore: false, offsetCapReachedAt: 10_000, onLoadMore() {}, onDeleted() {},
    }));
    expect(html).toContain('This list stops at the newest 10,000 items.');
    expect(html).not.toContain('No more items to load');
  });

  it('hides Retry for a refused feed request and keeps it otherwise', () => {
    const render = (canRetry: boolean) => renderToStaticMarkup(React.createElement(Feed, {
      items: [], isLoading: false, hasMore: false, loadError: 'Failed to load observations: offset must be at most 10000',
      canRetry, onLoadMore() {}, onDeleted() {},
    }));
    expect(render(false)).not.toContain('Retry');
    expect(render(true)).toContain('Retry');
  });

  it('ends the session catalog with the cap line and no Retry for a refusal', () => {
    const session = { content_session_id: 's', project: 'p', platform_source: 'claude', custom_title: null, started_at_epoch: 1, item_count: 1 };
    const html = renderToStaticMarkup(React.createElement(SessionList, {
      header: null, sessions: [session], isLoading: false, hasMore: false, loadError: null,
      offsetCapReachedAt: 10_000, onOpen() {}, onDelete: async () => {}, onLoadMore() {},
    }));
    expect(html).toContain('This list stops at the newest 10,000 items.');
    const refused = renderToStaticMarkup(React.createElement(SessionList, {
      header: null, sessions: [session], isLoading: false, hasMore: false, loadError: 'Could not load sessions: HTTP 400',
      canRetry: false, onOpen() {}, onDelete: async () => {}, onLoadMore() {},
    }));
    expect(refused).not.toContain('Retry');
  });
});
