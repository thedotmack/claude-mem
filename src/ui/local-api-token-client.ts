// Local API token mode (#5141), browser side.
//
// With CLAUDE_MEM_LOCAL_API_TOKEN set, the worker refuses a request that does not carry
// the token. The viewer is opened as `http://localhost:37777/?token=...`. This reads the
// token from that URL once, keeps it for the tab in sessionStorage, drops it from the
// address bar, and from then on sends it on every request the page makes to its own
// origin: as a header on `fetch` (a write must send the header), and as `?token=` on an
// `EventSource`, which cannot set one. An `<img>` or a link cannot send a header either, so
// the URL builders for worker media wrap their URLs in `withLocalApiTokenQuery`. The page's
// own scripts, styles and fonts need no token: the worker serves those data-free files
// without one.
//
// Self-contained on purpose: the viewer and My Work are separate bundles and both load it.

export const LOCAL_API_TOKEN_HEADER = 'X-Claude-Mem-Token';
const STORAGE_KEY = 'claude-mem.local-api-token';

// The token installLocalApiToken found for this tab; '' when the page has none.
let installedToken = '';

type EventSourceConstructor = new (url: string | URL, init?: { withCredentials?: boolean }) => object;

/** The parts of `window` this uses, so the module also compiles in a project without the DOM lib. */
export interface TokenWindow {
  location: { href: string; origin: string };
  history: { state: unknown; replaceState(data: unknown, unused: string, url?: string | null): void };
  sessionStorage: { getItem(key: string): string | null; setItem(key: string, value: string): void };
  fetch: typeof fetch;
  EventSource?: EventSourceConstructor;
}

/** The token for this tab: the page URL's single `token`, else the one kept from earlier. */
function readToken(win: TokenWindow): string {
  const url = new URL(win.location.href);
  const given = url.searchParams.getAll('token');
  // A repeated `token` names no token; the worker refuses it too.
  if (given.length === 1 && given[0] !== '') {
    try {
      win.sessionStorage.setItem(STORAGE_KEY, given[0]);
    } catch {
      // Storage can be blocked; the token then lasts until the page reloads.
    }
    url.searchParams.delete('token');
    win.history.replaceState(win.history.state, '', `${url.pathname}${url.search}${url.hash}`);
    return given[0];
  }
  try {
    return win.sessionStorage.getItem(STORAGE_KEY) ?? '';
  } catch {
    return '';
  }
}

/** Wrap `fetch` and `EventSource` so a request to this page's own origin carries the token. Returns the token, or '' when there is none. */
export function installLocalApiToken(win: TokenWindow = globalThis as unknown as TokenWindow): string {
  const token = readToken(win);
  installedToken = token;
  if (token === '') return '';

  const sameOrigin = (target: string | URL): URL | null => {
    const url = new URL(String(target), win.location.href);
    return url.origin === win.location.origin ? url : null;
  };

  const nativeFetch = win.fetch.bind(win);
  win.fetch = ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]): Promise<Response> => {
    const given = input instanceof URL ? input.href : input;
    // Two calls because Request's constructor takes a string or a Request, not their union.
    const request = typeof given === 'string' ? new Request(given, init) : new Request(given, init);
    if (sameOrigin(request.url) !== null && !request.headers.has(LOCAL_API_TOKEN_HEADER)) {
      request.headers.set(LOCAL_API_TOKEN_HEADER, token);
    }
    return nativeFetch(request);
  }) as typeof fetch;

  const NativeEventSource = win.EventSource;
  if (typeof NativeEventSource === 'function') {
    win.EventSource = class extends NativeEventSource {
      constructor(target: string | URL, init?: { withCredentials?: boolean }) {
        const url = sameOrigin(target);
        if (url !== null && !url.searchParams.has('token')) url.searchParams.set('token', token);
        super(url === null ? target : url.toString(), init);
      }
    } as EventSourceConstructor;
  }
  return token;
}

/**
 * `url` with `?token=` added, for a same-origin worker URL that an element loads itself (an
 * `<img src>` or a link), which cannot send the header. Unchanged when the page has no token.
 */
export function withLocalApiTokenQuery(url: string): string {
  if (installedToken === '') return url;
  return `${url}${url.includes('?') ? '&' : '?'}token=${encodeURIComponent(installedToken)}`;
}
