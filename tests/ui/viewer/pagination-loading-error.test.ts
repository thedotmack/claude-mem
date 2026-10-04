import { afterEach, describe, expect, it } from 'bun:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { usePagination } from '../../../src/ui/viewer/hooks/usePagination.js';

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

describe('pagination after a failed HTTP page', () => {
  for (const kind of ['observations', 'summaries', 'prompts'] as const) {
    it(`allows the next ${kind} request at the same offset`, async () => {
      const offsets: string[] = [];
      const server = Bun.serve({
        hostname: '127.0.0.1', port: 0,
        fetch(request) {
          const url = new URL(request.url);
          offsets.push(url.searchParams.get('offset')!);
          return offsets.length === 1
            ? new Response('temporarily unavailable', { status: 503 })
            : Response.json({ items: [{ id: 7 }], hasMore: false });
        },
      });
      globalThis.fetch = ((input, init) => originalFetch(new URL(String(input), server.url), init)) as typeof fetch;
      try {
        const page = pagination()[kind];
        await expect(page.loadMore()).rejects.toThrow('Failed to load');
        expect(await page.loadMore()).toEqual([{ id: 7 }]);
        expect(await page.loadMore()).toEqual([]);
        expect(offsets).toEqual(['0', '0']);
      } finally {
        server.stop(true);
      }
    });
  }
});
