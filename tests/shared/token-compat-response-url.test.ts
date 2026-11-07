import { expect, it } from 'bun:test';
import { fetchWithOpenRouterTokenCompatibility } from '../../src/shared/openrouter-token-compatibility.js';

it('preserves native fetch URL and redirect metadata after a non-retry reply', async () => {
  const server = Bun.serve({
    hostname: '127.0.0.1', port: 0,
    fetch(request) {
      if (new URL(request.url).pathname === '/redirect') return Response.redirect(new URL('/complete', request.url), 307);
      return Response.json({ choices: [{ message: { content: 'answer' } }] });
    },
  });
  try {
    const response = await fetchWithOpenRouterTokenCompatibility(fetch, new URL('/redirect', server.url), { method: 'POST' }, {}, 42);
    expect(response.url).toBe(new URL('/complete', server.url).href);
    expect(response.redirected).toBe(true);
    expect(response.bodyUsed).toBe(false);
    expect((await response.json() as { choices: unknown[] }).choices).toHaveLength(1);
  } finally {
    server.stop(true);
  }
});
