import { describe, expect, it } from 'bun:test';
import { createCore } from '../../src/integrations/opencode-plugin/core.js';

describe('OpenCode Smart recall', () => {
  it('requests index, then anchor context, then only the selected IDs', async () => {
    const original = globalThis.fetch;
    const calls: Array<{ path: string; method: string; body?: unknown }> = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      calls.push({ path: url.pathname + url.search, method: init?.method || 'GET', ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
      if (url.pathname === '/api/search/observations') return Response.json({ content: [{ type: 'text', text: '#7 — Login decision' }] });
      if (url.pathname === '/api/timeline') return Response.json({ content: [{ type: 'text', text: '#7 — Login decision\n#8 — Later correction' }] });
      if (url.pathname === '/api/observations/batch') return Response.json([{ id: 8, title: 'Later correction', narrative: 'Use the corrected behavior.', internal: 'DO_NOT_EXPOSE' }]);
      return new Response('', { status: 404 });
    }) as typeof fetch;
    try {
      const core = createCore({ directory: '/tmp/smart-recall-fixture' });
      expect(await core.search('login')).toContain('#7');
      expect(await core.timeline(7)).toContain('#8');
      const details = await core.getObservations([8]);
      expect(details).toContain('Use the corrected behavior.');
      expect(details).not.toContain('DO_NOT_EXPOSE');
      expect(calls).toEqual([
        { path: '/api/search/observations?query=login&limit=10', method: 'GET' },
        { path: '/api/timeline?anchor=7', method: 'GET' },
        { path: '/api/observations/batch', method: 'POST', body: { ids: [8] } },
      ]);
    } finally { globalThis.fetch = original; }
  });
});
