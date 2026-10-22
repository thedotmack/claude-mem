import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { ServerClient } from '../../../src/services/hooks/server-client.js';

let fetchSpy: ReturnType<typeof spyOn> | null = null;
afterEach(() => fetchSpy?.mockRestore());

describe('ServerClient.semanticContext', () => {
  it('keeps <private> sections of the prompt out of the request', async () => {
    let sent: { query?: string } = {};
    fetchSpy = spyOn(globalThis, 'fetch').mockImplementation((async (_url: unknown, init?: RequestInit) => {
      sent = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ observations: [], context: '', count: 0 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch);
    const client = new ServerClient({ serverBaseUrl: 'http://server.test', apiKey: 'key' });
    await client.semanticContext({
      projectId: 'p',
      query: 'Why does login fail? <private>the password is hunter2</private> It started today.',
    });
    expect(sent.query).toContain('Why does login fail?');
    expect(sent.query).toContain('It started today.');
    expect(sent.query).not.toContain('hunter2');
  });
});
