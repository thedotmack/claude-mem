// Local API token mode (#5141), browser side: what the viewer does with `?token=`.
import { describe, expect, it } from 'bun:test';
import { LOCAL_API_TOKEN_HEADER, installLocalApiToken, type TokenWindow } from '../../src/ui/local-api-token-client.js';

const TOKEN = 'ui-test-token';
const ORIGIN = 'http://localhost:37777';

function fakeWindow(href: string, stored?: string, storageBlocked = false) {
  const store = new Map<string, string>();
  if (stored !== undefined) store.set('claude-mem.local-api-token', stored);
  const seen = { requests: [] as Request[], replaced: [] as string[], streams: [] as Array<{ url: string; init: unknown }> };
  class FakeEventSource {
    constructor(readonly url: string, readonly init?: unknown) { seen.streams.push({ url, init }); }
  }
  const nativeFetch = async (request: Request): Promise<Response> => { seen.requests.push(request); return new Response('ok'); };
  const win = {
    location: new URL(href),
    history: { state: null, replaceState: (_state: unknown, _unused: string, url: string) => { seen.replaced.push(url); } },
    sessionStorage: {
      getItem: (key: string) => { if (storageBlocked) throw new Error('blocked'); return store.get(key) ?? null; },
      setItem: (key: string, value: string) => { if (storageBlocked) throw new Error('blocked'); store.set(key, value); },
    },
    fetch: nativeFetch,
    EventSource: FakeEventSource,
  };
  return { win: win as unknown as TokenWindow, raw: win, seen, store, nativeFetch, NativeEventSource: FakeEventSource };
}

describe('reading the token', () => {
  it('takes the single ?token= of the page URL, keeps it for the tab, and removes it from the address bar', () => {
    const { win, seen, store } = fakeWindow(`${ORIGIN}/viewer?tab=feed&token=${TOKEN}#top`);
    expect(installLocalApiToken(win)).toBe(TOKEN);
    expect(store.get('claude-mem.local-api-token')).toBe(TOKEN);
    expect(seen.replaced).toEqual(['/viewer?tab=feed#top']);
  });

  it('keeps the token across a reload that dropped it from the URL', () => {
    const { win, seen } = fakeWindow(`${ORIGIN}/viewer`, TOKEN);
    expect(installLocalApiToken(win)).toBe(TOKEN);
    expect(seen.replaced).toEqual([]);
  });

  it('ignores a repeated token and a blank one, falling back to what the tab kept', () => {
    expect(installLocalApiToken(fakeWindow(`${ORIGIN}/?token=a&token=b`).win)).toBe('');
    expect(installLocalApiToken(fakeWindow(`${ORIGIN}/?token=`).win)).toBe('');
    expect(installLocalApiToken(fakeWindow(`${ORIGIN}/?token=a&token=b`, TOKEN).win)).toBe(TOKEN);
  });

  it('still works when storage is blocked', () => {
    const { win } = fakeWindow(`${ORIGIN}/?token=${TOKEN}`, undefined, true);
    expect(installLocalApiToken(win)).toBe(TOKEN);
    expect(installLocalApiToken(fakeWindow(`${ORIGIN}/`, undefined, true).win)).toBe('');
  });

  it('changes nothing when the page has no token', () => {
    const { win, raw, nativeFetch, NativeEventSource } = fakeWindow(`${ORIGIN}/`);
    expect(installLocalApiToken(win)).toBe('');
    expect(raw.fetch).toBe(nativeFetch);
    expect(raw.EventSource).toBe(NativeEventSource);
  });
});

describe('fetch', () => {
  it('sends the header on a request to its own origin, whatever shape the request has', async () => {
    const { win, raw, seen } = fakeWindow(`${ORIGIN}/?token=${TOKEN}`);
    installLocalApiToken(win);

    await raw.fetch(`${ORIGIN}/api/settings`);
    await raw.fetch(new URL(`${ORIGIN}/api/logs`));
    await raw.fetch(new Request(`${ORIGIN}/api/observation/1`, { method: 'DELETE' }));
    await raw.fetch(`${ORIGIN}/api/settings`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"a":1}' });

    expect(seen.requests.map(r => r.headers.get(LOCAL_API_TOKEN_HEADER))).toEqual([TOKEN, TOKEN, TOKEN, TOKEN]);
    expect(seen.requests[2].method).toBe('DELETE');
    expect(seen.requests[3].method).toBe('POST');
    expect(seen.requests[3].headers.get('content-type')).toBe('application/json');
    expect(await seen.requests[3].text()).toBe('{"a":1}');
  });

  it('never sends the token to another origin', async () => {
    const { win, raw, seen } = fakeWindow(`${ORIGIN}/?token=${TOKEN}`);
    installLocalApiToken(win);
    await raw.fetch('https://api.github.com/repos/thedotmack/claude-mem');
    await raw.fetch('http://localhost:3000/api/settings');
    expect(seen.requests.map(r => r.headers.has(LOCAL_API_TOKEN_HEADER))).toEqual([false, false]);
  });

  it('keeps a token header the caller already set', async () => {
    const { win, raw, seen } = fakeWindow(`${ORIGIN}/?token=${TOKEN}`);
    installLocalApiToken(win);
    await raw.fetch(`${ORIGIN}/api/settings`, { headers: { [LOCAL_API_TOKEN_HEADER]: 'explicit' } });
    expect(seen.requests[0].headers.get(LOCAL_API_TOKEN_HEADER)).toBe('explicit');
  });
});

describe('EventSource', () => {
  it('adds ?token= to a stream on its own origin, relative or absolute, and passes the options on', () => {
    const { win, raw, seen } = fakeWindow(`${ORIGIN}/?token=${TOKEN}`);
    installLocalApiToken(win);
    const init = { withCredentials: true };
    new raw.EventSource('/stream', init);
    new raw.EventSource(`${ORIGIN}/api/events?since=3`);
    expect(seen.streams.map(s => s.url)).toEqual([
      `${ORIGIN}/stream?token=${TOKEN}`,
      `${ORIGIN}/api/events?since=3&token=${TOKEN}`,
    ]);
    expect(seen.streams[0].init).toBe(init);
  });

  it('leaves another origin alone, and a stream that already names a token', () => {
    const { win, raw, seen } = fakeWindow(`${ORIGIN}/?token=${TOKEN}`);
    installLocalApiToken(win);
    new raw.EventSource('https://example.com/stream');
    new raw.EventSource(`${ORIGIN}/stream?token=other`);
    expect(seen.streams.map(s => s.url)).toEqual(['https://example.com/stream', `${ORIGIN}/stream?token=other`]);
  });

  it('is still an EventSource', () => {
    const { win, raw, NativeEventSource } = fakeWindow(`${ORIGIN}/?token=${TOKEN}`);
    installLocalApiToken(win);
    expect(new raw.EventSource('/stream') instanceof NativeEventSource).toBe(true);
  });
});
