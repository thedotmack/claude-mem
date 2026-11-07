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

  it('sends contentSessionId when given and omits it otherwise', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    fetchSpy = spyOn(globalThis, 'fetch').mockImplementation((async (_url: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ context: '', count: 0 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch);
    const client = new ServerClient({ serverBaseUrl: 'http://server.test', apiKey: 'key' });
    await client.semanticContext({ projectId: 'p', query: 'a prompt long enough', contentSessionId: 'cc-session-1' });
    await client.semanticContext({ projectId: 'p', query: 'a prompt long enough' });
    expect(bodies[0].contentSessionId).toBe('cc-session-1');
    expect('contentSessionId' in bodies[1]).toBe(false);
  });
});
